// Standard GSF LLE emulator boundary.
//
// This file is where CPU, memory-map, IO hooks, hot patches, and diagnostics
// belong. For now it builds a decoded GBA memory image and exposes reports that
// the future emulator can run against.

(function () {
  const tools = window.GsfTools;
  if (!tools) throw new Error('gsf_emulator.js requires gsf.js to be loaded first');

  function createMemoryImage(size = tools.GBA_ROM_LIMIT) {
    return {
      rom: new Uint8Array(size),
      segments: [],
      warnings: [],
      patches: [],
    };
  }

  function applyDecodedProgram(memory, decoded, label = decoded?.program?.name || 'program') {
    const program = decoded?.program || decoded;
    if (!program?.data) return false;
    const region = program.region || tools.gbaRegionFor(program.loadAddr, program.clippedSize);
    const segment = {
      label,
      region: region?.id || 'unknown',
      loadAddr: program.loadAddr,
      dataSize: program.clippedSize,
      endAddr: program.endAddr,
    };
    memory.segments.push(segment);
    if (region?.id !== 'rom') {
      memory.warnings.push(`${label} loads into ${region?.label || 'unknown memory'}, not ROM; stored as segment only`);
      return false;
    }
    const romOffset = program.loadAddr - tools.GBA_ROM_BASE;
    if (romOffset < 0 || romOffset + program.clippedSize > memory.rom.length) {
      memory.warnings.push(`${label} ROM write ${tools.hex(program.loadAddr)} +${program.clippedSize} is out of range`);
      return false;
    }
    memory.rom.set(program.data, romOffset);
    return true;
  }

  const CPSR_N = 0x80000000;
  const CPSR_Z = 0x40000000;
  const CPSR_C = 0x20000000;
  const CPSR_V = 0x10000000;
  const CPSR_T = 0x00000020;
  const MODE_SYSTEM = 0x1f;
  const IO_SOUND_START = 0x04000060;
  const IO_SOUND_END = 0x040000a8;
  const IO_TIMER_START = 0x04000100;
  const IO_TIMER_END = 0x04000110;
  const IO_DMA_START = 0x040000b0;
  const IO_DMA_END = 0x040000e0;

  function signExtend24(v) {
    return (v & 0x00800000) ? (v | 0xff000000) : v;
  }

  function ror32(value, amount) {
    amount &= 31;
    value >>>= 0;
    return amount ? ((value >>> amount) | (value << (32 - amount))) >>> 0 : value;
  }

  function addOverflow(a, b, r) {
    return (~(a ^ b) & (a ^ r) & 0x80000000) !== 0;
  }

  function subOverflow(a, b, r) {
    return ((a ^ b) & (a ^ r) & 0x80000000) !== 0;
  }

  class GbaMemoryBus {
    constructor(memory) {
      this.memory = memory;
      this.ewram = new Uint8Array(256 * 1024);
      this.iwram = new Uint8Array(32 * 1024);
      this.io = new Uint8Array(1024);
      this.palette = new Uint8Array(1024);
      this.vram = new Uint8Array(96 * 1024);
      this.oam = new Uint8Array(1024);
      this.sram = new Uint8Array(64 * 1024);
      this.events = [];
      this.unmappedReads = 0;
      this.unmappedWrites = 0;
    }

    region(addr) {
      addr >>>= 0;
      if (addr >= 0x02000000 && addr < 0x02040000) return { id: 'ewram', data: this.ewram, off: addr - 0x02000000 };
      if (addr >= 0x03000000 && addr < 0x03008000) return { id: 'iwram', data: this.iwram, off: addr - 0x03000000 };
      if (addr >= 0x04000000 && addr < 0x04000400) return { id: 'io', data: this.io, off: addr - 0x04000000 };
      if (addr >= 0x05000000 && addr < 0x05000400) return { id: 'palette', data: this.palette, off: addr - 0x05000000 };
      if (addr >= 0x06000000 && addr < 0x06018000) return { id: 'vram', data: this.vram, off: addr - 0x06000000 };
      if (addr >= 0x07000000 && addr < 0x07000400) return { id: 'oam', data: this.oam, off: addr - 0x07000000 };
      if (addr >= tools.GBA_ROM_BASE && addr < tools.GBA_ROM_BASE + this.memory.rom.length) return { id: 'rom', data: this.memory.rom, off: addr - tools.GBA_ROM_BASE };
      if (addr >= 0x0e000000 && addr < 0x0e010000) return { id: 'sram', data: this.sram, off: addr - 0x0e000000 };
      return null;
    }

    read8(addr) {
      const r = this.region(addr);
      if (!r || r.off >= r.data.length) {
        this.unmappedReads++;
        return 0;
      }
      return r.data[r.off];
    }

    read16(addr) {
      addr >>>= 0;
      return this.read8(addr) | (this.read8(addr + 1) << 8);
    }

    read32(addr) {
      addr >>>= 0;
      return (this.read8(addr) | (this.read8(addr + 1) << 8) | (this.read8(addr + 2) << 16) | (this.read8(addr + 3) << 24)) >>> 0;
    }

    write8(addr, value) {
      addr >>>= 0;
      value &= 0xff;
      const r = this.region(addr);
      if (!r || r.id === 'rom' || r.off >= r.data.length) {
        this.unmappedWrites++;
        return;
      }
      r.data[r.off] = value;
      this._logIoWrite(addr, value, 1);
    }

    write16(addr, value) {
      this.write8(addr, value);
      this.write8((addr + 1) >>> 0, value >>> 8);
    }

    write32(addr, value) {
      this.write8(addr, value);
      this.write8((addr + 1) >>> 0, value >>> 8);
      this.write8((addr + 2) >>> 0, value >>> 16);
      this.write8((addr + 3) >>> 0, value >>> 24);
    }

    _logIoWrite(addr, value, bytes) {
      if (addr < 0x04000000 || addr >= 0x04000400) return;
      let kind = 'io';
      if (addr >= IO_SOUND_START && addr < IO_SOUND_END) kind = 'sound';
      else if (addr >= IO_TIMER_START && addr < IO_TIMER_END) kind = 'timer';
      else if (addr >= IO_DMA_START && addr < IO_DMA_END) kind = 'dma';
      this.events.push({ kind, addr, value, bytes });
      if (this.events.length > 512) this.events.shift();
    }
  }

  class Arm7Cpu {
    constructor(bus, entryAddr = tools.GBA_ROM_BASE) {
      this.bus = bus;
      this.regs = new Uint32Array(16);
      this.cpsr = MODE_SYSTEM;
      this.halted = false;
      this.reason = '';
      this.instructions = 0;
      this.unsupported = new Map();
      this.regs[15] = entryAddr >>> 0;
      if (entryAddr & 1) {
        this.regs[15] = entryAddr & ~1;
        this.cpsr |= CPSR_T;
      }
    }

    run(maxInstructions = 20000) {
      const start = this.instructions;
      while (!this.halted && this.instructions - start < maxInstructions) this.step();
      return this.snapshot();
    }

    step() {
      if (this.cpsr & CPSR_T) {
        this.halted = true;
        this.reason = 'thumb-not-implemented';
        return;
      }
      const pc = this.regs[15] >>> 0;
      const instr = this.bus.read32(pc);
      this.regs[15] = (pc + 4) >>> 0;
      this.instructions++;
      if (!this._conditionPassed(instr >>> 28)) return;
      this._execArm(instr, pc);
    }

    snapshot() {
      return {
        halted: this.halted,
        reason: this.reason,
        instructions: this.instructions,
        cpsr: this.cpsr >>> 0,
        thumb: !!(this.cpsr & CPSR_T),
        pc: this.regs[15] >>> 0,
        regs: Array.from(this.regs, v => v >>> 0),
        unsupported: Object.fromEntries([...this.unsupported.entries()].slice(0, 24)),
      };
    }

    _conditionPassed(cond) {
      const n = !!(this.cpsr & CPSR_N);
      const z = !!(this.cpsr & CPSR_Z);
      const c = !!(this.cpsr & CPSR_C);
      const v = !!(this.cpsr & CPSR_V);
      switch (cond) {
        case 0x0: return z;
        case 0x1: return !z;
        case 0x2: return c;
        case 0x3: return !c;
        case 0x4: return n;
        case 0x5: return !n;
        case 0x6: return v;
        case 0x7: return !v;
        case 0x8: return c && !z;
        case 0x9: return !c || z;
        case 0xa: return n === v;
        case 0xb: return n !== v;
        case 0xc: return !z && n === v;
        case 0xd: return z || n !== v;
        case 0xe: return true;
        default: return false;
      }
    }

    _execArm(instr, pc) {
      if ((instr & 0x0e000000) === 0x0a000000) return this._branch(instr, pc);
      if ((instr & 0x0ffffff0) === 0x012fff10) return this._bx(instr);
      if ((instr & 0x0fc000f0) === 0x00000090) return this._unsupported(instr, pc); // MUL/MLA family
      if ((instr & 0x0fbf0fff) === 0x010f0000) return this._unsupported(instr, pc); // MRS
      if ((instr & 0x0fb0fff0) === 0x0120f000) return this._unsupported(instr, pc); // MSR register
      if ((instr & 0x0e000090) === 0x00000090) return this._unsupported(instr, pc); // halfword/signed transfer
      if ((instr & 0x0c000000) === 0x04000000) return this._singleDataTransfer(instr);
      if ((instr & 0x0c000000) === 0x00000000) return this._dataProcessing(instr);
      this._unsupported(instr, pc);
    }

    _reg(idx) {
      return idx === 15 ? (this.regs[15] + 4) >>> 0 : this.regs[idx] >>> 0;
    }

    _setReg(idx, value) {
      value >>>= 0;
      this.regs[idx] = value;
      if (idx === 15) this.regs[15] = value & ~3;
    }

    _setNZ(result) {
      result >>>= 0;
      this.cpsr = (this.cpsr & ~(CPSR_N | CPSR_Z)) | (result & 0x80000000 ? CPSR_N : 0) | (result === 0 ? CPSR_Z : 0);
    }

    _operand2(instr) {
      if (instr & 0x02000000) {
        const imm = instr & 0xff;
        const rotate = ((instr >>> 8) & 0xf) * 2;
        const value = ror32(imm, rotate);
        return { value, carry: rotate ? !!(value & 0x80000000) : !!(this.cpsr & CPSR_C) };
      }
      const rm = instr & 0xf;
      const shiftType = (instr >>> 5) & 3;
      const byReg = !!(instr & 0x10);
      let amount = byReg ? (this._reg((instr >>> 8) & 0xf) & 0xff) : ((instr >>> 7) & 0x1f);
      let value = this._reg(rm);
      let carry = !!(this.cpsr & CPSR_C);
      if (amount === 0) {
        if (shiftType === 3 && !byReg) {
          carry = !!(value & 1);
          value = ((this.cpsr & CPSR_C ? 0x80000000 : 0) | (value >>> 1)) >>> 0;
        }
        return { value: value >>> 0, carry };
      }
      if (shiftType === 0) {
        carry = amount <= 32 ? !!(value & (1 << (32 - amount))) : false;
        value = amount >= 32 ? 0 : (value << amount) >>> 0;
      } else if (shiftType === 1) {
        carry = amount <= 32 ? !!(value & (1 << (amount - 1))) : false;
        value = amount >= 32 ? 0 : value >>> amount;
      } else if (shiftType === 2) {
        carry = amount <= 32 ? !!(value & (1 << (amount - 1))) : !!(value & 0x80000000);
        value = amount >= 32 ? (value & 0x80000000 ? 0xffffffff : 0) : (value >> amount) >>> 0;
      } else {
        amount &= 31;
        value = ror32(value, amount);
        carry = !!(value & 0x80000000);
      }
      return { value: value >>> 0, carry };
    }

    _dataProcessing(instr) {
      const opcode = (instr >>> 21) & 0xf;
      const setFlags = !!(instr & 0x00100000);
      const rn = (instr >>> 16) & 0xf;
      const rd = (instr >>> 12) & 0xf;
      const a = this._reg(rn);
      const op2 = this._operand2(instr);
      let result = 0;
      let write = true;
      let carry = op2.carry;
      let overflow = false;
      switch (opcode) {
        case 0x0: result = a & op2.value; break; // AND
        case 0x1: result = a ^ op2.value; break; // EOR
        case 0x2: result = (a - op2.value) >>> 0; carry = a >= op2.value; overflow = subOverflow(a, op2.value, result); break; // SUB
        case 0x4: result = (a + op2.value) >>> 0; carry = result < a; overflow = addOverflow(a, op2.value, result); break; // ADD
        case 0x8: result = a & op2.value; write = false; break; // TST
        case 0x9: result = a ^ op2.value; write = false; break; // TEQ
        case 0xa: result = (a - op2.value) >>> 0; carry = a >= op2.value; overflow = subOverflow(a, op2.value, result); write = false; break; // CMP
        case 0xb: result = (a + op2.value) >>> 0; carry = result < a; overflow = addOverflow(a, op2.value, result); write = false; break; // CMN
        case 0xc: result = a | op2.value; break; // ORR
        case 0xd: result = op2.value; break; // MOV
        case 0xe: result = a & (~op2.value); break; // BIC
        case 0xf: result = (~op2.value) >>> 0; break; // MVN
        default: return this._unsupported(instr, (this.regs[15] - 4) >>> 0);
      }
      if (write) this._setReg(rd, result);
      if (setFlags || !write) {
        this._setNZ(result);
        this.cpsr = (this.cpsr & ~(CPSR_C | CPSR_V)) | (carry ? CPSR_C : 0) | (overflow ? CPSR_V : 0);
      }
    }

    _singleDataTransfer(instr) {
      const immediateOffset = !(instr & 0x02000000);
      if (!immediateOffset) return this._unsupported(instr, (this.regs[15] - 4) >>> 0);
      const pre = !!(instr & 0x01000000);
      const up = !!(instr & 0x00800000);
      const byte = !!(instr & 0x00400000);
      const writeBack = !!(instr & 0x00200000);
      const load = !!(instr & 0x00100000);
      const rn = (instr >>> 16) & 0xf;
      const rd = (instr >>> 12) & 0xf;
      const off = instr & 0xfff;
      const base = this._reg(rn);
      const offsetAddr = up ? (base + off) >>> 0 : (base - off) >>> 0;
      const addr = pre ? offsetAddr : base;
      const finalBase = pre ? offsetAddr : (up ? (base + off) >>> 0 : (base - off) >>> 0);
      if (load) {
        this._setReg(rd, byte ? this.bus.read8(addr) : this.bus.read32(addr & ~3));
      } else {
        const value = this._reg(rd);
        if (byte) this.bus.write8(addr, value);
        else this.bus.write32(addr & ~3, value);
      }
      if (writeBack || !pre) this._setReg(rn, finalBase);
    }

    _branch(instr, pc) {
      const link = !!(instr & 0x01000000);
      const offset = (signExtend24(instr & 0x00ffffff) << 2) >> 0;
      if (link) this.regs[14] = (pc + 4) >>> 0;
      this.regs[15] = (pc + 8 + offset) >>> 0;
    }

    _bx(instr) {
      const target = this._reg(instr & 0xf);
      if (target & 1) {
        this.cpsr |= CPSR_T;
        this.regs[15] = target & ~1;
      } else {
        this.cpsr &= ~CPSR_T;
        this.regs[15] = target & ~3;
      }
    }

    _unsupported(instr, pc) {
      const key = `0x${(instr >>> 24).toString(16).padStart(2, '0')}`;
      this.unsupported.set(key, (this.unsupported.get(key) || 0) + 1);
      this.halted = true;
      this.reason = `unsupported ARM ${tools.hex(instr)} at ${tools.hex(pc)}`;
    }
  }

  class StandardGsfEngine {
    constructor() {
      this.id = 'gsf-lle';
      this.label = 'Standard GSF LLE';
      this.state = 'empty';
      this.source = null;
      this.library = null;
      this.entries = [];
      this.memory = null;
      this.bus = null;
      this.cpu = null;
      this.decodeReport = null;
      this.diagnostics = null;
      this.lastError = null;
    }

    reset() {
      this.state = 'empty';
      this.source = null;
      this.library = null;
      this.entries = [];
      this.memory = null;
      this.bus = null;
      this.cpu = null;
      this.decodeReport = null;
      this.diagnostics = null;
      this.lastError = null;
    }

    async loadBuffer(buf, source = {}) {
      this.reset();
      try {
        if (tools.isZip(buf) || tools.isSevenZip(buf)) return await this._loadArchive(buf, source);
        if (!tools.isValid(buf)) return null;
        const decoded = await tools.decodeProgram(buf, {
          kind: /\.minigsf$/i.test(source.name || '') ? 'minigsf' : 'gsf',
          name: source.name || 'Dropped GSF',
        });
        const info = await tools.programInfo(buf);
        this.source = {
          kind: /\.minigsf$/i.test(source.name || '') ? 'minigsf' : 'gsf',
          name: source.name || 'Dropped GSF',
          tags: tools.tags(buf),
          ...(info || {}),
        };
        this.memory = createMemoryImage();
        applyDecodedProgram(this.memory, decoded, this.source.name);
        this.entries = [{
          name: this.source.tags.title || this.source.name,
          tags: this.source.tags,
          decoded,
          patch: await tools.miniPatch(buf),
        }];
        this.decodeReport = this._makeDecodeReport();
        this._initCpu();
        this.state = 'loaded-no-emulator';
        return this.source;
      } catch (err) {
        this.state = 'error';
        this.lastError = err;
        throw err;
      }
    }

    async _loadArchive(buf, source = {}) {
      const files = await tools.archiveFiles(buf);
      if (!files) return null;
      const libKey = Object.keys(files).find(k => /\.gsflib$/i.test(k));
      if (!libKey) throw new Error('No .gsflib found in archive');
      const libDecoded = await tools.decodeProgram(files[libKey], { kind: 'gsflib', name: libKey });
      const libInfo = await tools.programInfo(files[libKey]);
      this.library = {
        key: libKey,
        tags: tools.tags(files[libKey]),
        decoded: libDecoded,
        ...(libInfo || {}),
      };
      this.memory = createMemoryImage();
      applyDecodedProgram(this.memory, libDecoded, libKey);
      const miniKeys = Object.keys(files).filter(k => /\.minigsf$/i.test(k)).sort();
      this.entries = [];
      for (const key of miniKeys) {
        const patch = await tools.miniPatch(files[key]);
        const decoded = await tools.decodeProgram(files[key], { kind: 'minigsf', name: key });
        applyDecodedProgram(this.memory, decoded, key);
        const entryTags = tools.tags(files[key]);
        this.entries.push({
          key,
          name: entryTags.title || key.replace(/\.minigsf$/i, ''),
          tags: entryTags,
          decoded,
          patch,
        });
      }
      this.source = {
        kind: tools.isSevenZip(buf) ? 'gsf-7z' : 'gsf-zip',
        name: source.name || (tools.isSevenZip(buf) ? 'Dropped 7z' : 'Dropped ZIP'),
        library: libKey,
        tags: this.library.tags,
        minigsfCount: miniKeys.length,
        ...(libInfo || {}),
      };
      this.decodeReport = this._makeDecodeReport();
      this._initCpu();
      this.state = 'loaded-no-emulator';
      return this.source;
    }

    canPlay() {
      return false;
    }

    async play() {
      if (!this.cpu) throw new Error('No GSF CPU image loaded.');
      this.runDiagnostics();
      return this.diagnostics;
    }

    stop() {}

    _entryAddr() {
      const entry = this.source?.entryAddr || this.library?.entryAddr || this.source?.loadAddr || tools.GBA_ROM_BASE;
      return entry >>> 0;
    }

    _initCpu() {
      this.bus = new GbaMemoryBus(this.memory);
      this.cpu = new Arm7Cpu(this.bus, this._entryAddr());
      this.diagnostics = this._makeInitialDiagnostics();
    }

    runDiagnostics(maxInstructions = 20000) {
      if (!this.cpu) this._initCpu();
      const cpu = this.cpu.run(maxInstructions);
      const events = this.bus.events;
      const soundWrites = events.filter(ev => ev.kind === 'sound');
      const timerWrites = events.filter(ev => ev.kind === 'timer');
      const dmaWrites = events.filter(ev => ev.kind === 'dma');
      this.diagnostics = {
        status: cpu.halted ? 'cpu-halted' : 'cpu-ran',
        hooks: {
          cpu: true,
          ioWrites: events.length > 0,
          timers: timerWrites.length > 0,
          dma: dmaWrites.length > 0,
          sound: soundWrites.length > 0,
        },
        cpu,
        io: {
          totalWrites: events.length,
          soundWrites: soundWrites.length,
          timerWrites: timerWrites.length,
          dmaWrites: dmaWrites.length,
          recent: events.slice(-64).map(ev => ({
            ...ev,
            addrHex: tools.hex(ev.addr),
            valueHex: tools.hex(ev.value, ev.bytes * 2),
          })),
          unmappedReads: this.bus.unmappedReads,
          unmappedWrites: this.bus.unmappedWrites,
        },
        patchPoints: [],
        notes: [
          'ARM mode CPU scaffold is active.',
          'Thumb instructions, block transfers, multiply, swaps, coprocessor, and many edge cases are not implemented yet.',
        ],
      };
      return this.diagnostics;
    }

    _makeDecodeReport() {
      const segments = this.memory?.segments || [];
      const warnings = [
        ...(this.memory?.warnings || []),
        ...(this.library?.decoded?.program?.warnings || []),
        ...this.entries.flatMap(entry => entry.decoded?.program?.warnings || []),
      ];
      return {
        source: this.source,
        library: this.library ? {
          key: this.library.key,
          loadAddr: this.library.loadAddr,
          dataSize: this.library.dataSize,
          region: this.library.region,
        } : null,
        entries: this.entries.map(entry => ({
          key: entry.key,
          name: entry.name,
          loadAddr: entry.patch?.loadAddr,
          dataSize: entry.patch?.size,
          region: entry.patch?.region,
          tags: entry.tags,
        })),
        segments,
        romBytesTouched: segments
          .filter(segment => segment.region === 'rom')
          .reduce((sum, segment) => sum + segment.dataSize, 0),
        warnings,
      };
    }

    _makeInitialDiagnostics() {
      return {
        status: 'decoder-ready',
        hooks: {
          cpu: !!this.cpu,
          ioWrites: false,
          timers: false,
          dma: false,
          sound: false,
        },
        patchPoints: [],
        cpu: this.cpu ? this.cpu.snapshot() : null,
        notes: ['GSF memory image is decoded; ARM CPU scaffold is ready for a bounded diagnostic run.'],
      };
    }

    reportText() {
      const report = this.decodeReport;
      if (!report) return this.summary();
      const parts = [];
      if (report.source?.kind) parts.push(`decoded ${report.source.kind}`);
      if (report.library?.key) parts.push(`library ${report.library.key}`);
      if (report.entries.length) parts.push(`${report.entries.length} entries`);
      parts.push(`${report.segments.length} load segment${report.segments.length === 1 ? '' : 's'}`);
      if (report.romBytesTouched) parts.push(`${report.romBytesTouched} ROM bytes`);
      if (report.warnings.length) parts.push(`${report.warnings.length} warning${report.warnings.length === 1 ? '' : 's'}`);
      return parts.join(' | ');
    }

    summary() {
      if (this.state === 'empty') return 'GSF LLE: no GSF loaded';
      if (this.state === 'error') return `GSF LLE: error ${this.lastError?.message || 'unknown'}`;
      const parts = [`GSF LLE: ${this.label} payload decoded`];
      if (this.source?.name) parts.push(this.source.name);
      if (this.library?.key) parts.push(`library ${this.library.key}`);
      if (this.entries.length) parts.push(`${this.entries.length} minigsf entries`);
      if (this.source?.loadAddr != null && this.source?.dataSize != null) {
        parts.push(`load ${tools.hex(this.source.loadAddr)} +${this.source.dataSize}`);
      }
      if (this.decodeReport) parts.push(this.reportText());
      const summaryText = tools.tagSummary(this.source?.tags);
      if (summaryText) parts.push(summaryText);
      parts.push('playback: not emulated yet');
      return parts.join(' | ');
    }
  }

  window.GsfEmulator = {
    GbaMemoryBus,
    Arm7Cpu,
    createMemoryImage,
    applyDecodedProgram,
    StandardGsfEngine,
  };
  window.StandardGsfEngine = StandardGsfEngine;
})();
