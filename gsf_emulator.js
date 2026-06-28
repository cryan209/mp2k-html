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
      this.spsr = 0;
      this.halted = false;
      this.reason = '';
      this.instructions = 0;
      this.unsupported = new Map();
      this.psrWrites = [];
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
        const pc = this.regs[15] >>> 0;
        const instr = this.bus.read16(pc);
        this.regs[15] = (pc + 2) >>> 0;
        this.instructions++;
        this._execThumb(instr, pc);
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
        spsr: this.spsr >>> 0,
        thumb: !!(this.cpsr & CPSR_T),
        pc: this.regs[15] >>> 0,
        regs: Array.from(this.regs, v => v >>> 0),
        psrWrites: this.psrWrites.slice(-32),
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
      if ((instr & 0x0fbf0fff) === 0x010f0000) return this._mrs(instr);
      if ((instr & 0x0db0f000) === 0x0120f000) return this._msr(instr);
      if ((instr & 0x0e000090) === 0x00000090) return this._unsupported(instr, pc); // halfword/signed transfer
      if ((instr & 0x0e000000) === 0x08000000) return this._blockDataTransfer(instr);
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

    _setRegThumb(idx, value) {
      value >>>= 0;
      this.regs[idx] = value;
      if (idx === 15) this.regs[15] = value & ~1;
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

    _mrs(instr) {
      const useSpsr = !!(instr & 0x00400000);
      const rd = (instr >>> 12) & 0xf;
      this._setReg(rd, useSpsr ? this.spsr : this.cpsr);
    }

    _msr(instr) {
      const useSpsr = !!(instr & 0x00400000);
      const fieldMask = (instr >>> 16) & 0xf;
      let value;
      if (instr & 0x02000000) {
        value = ror32(instr & 0xff, ((instr >>> 8) & 0xf) * 2);
      } else {
        value = this._reg(instr & 0xf);
      }
      const before = useSpsr ? this.spsr : this.cpsr;
      const after = this._applyPsrFields(before, value, fieldMask);
      if (useSpsr) this.spsr = after;
      else this.cpsr = after;
      this.psrWrites.push({
        target: useSpsr ? 'spsr' : 'cpsr',
        fieldMask,
        value,
        before,
        after,
      });
      if (this.psrWrites.length > 128) this.psrWrites.shift();
    }

    _applyPsrFields(before, value, fieldMask) {
      let mask = 0;
      if (fieldMask & 0x1) mask |= 0x000000ff;
      if (fieldMask & 0x2) mask |= 0x0000ff00;
      if (fieldMask & 0x4) mask |= 0x00ff0000;
      if (fieldMask & 0x8) mask |= 0xff000000;
      return ((before & ~mask) | (value & mask)) >>> 0;
    }

    _blockDataTransfer(instr) {
      const pre = !!(instr & 0x01000000);
      const up = !!(instr & 0x00800000);
      const psr = !!(instr & 0x00400000);
      const writeBack = !!(instr & 0x00200000);
      const load = !!(instr & 0x00100000);
      const rn = (instr >>> 16) & 0xf;
      const list = instr & 0xffff;
      if (psr) return this._unsupported(instr, (this.regs[15] - 4) >>> 0);
      const count = this._bitCount(list);
      if (count === 0) return this._unsupported(instr, (this.regs[15] - 4) >>> 0);
      const base = this._reg(rn);
      let addr;
      let finalBase;
      if (up) {
        addr = pre ? (base + 4) >>> 0 : base;
        finalBase = (base + count * 4) >>> 0;
      } else {
        addr = pre ? (base - count * 4) >>> 0 : (base - (count - 1) * 4) >>> 0;
        finalBase = (base - count * 4) >>> 0;
      }
      const writeBackFirst = writeBack && (!load || !(list & (1 << rn)));
      if (writeBackFirst) this._setReg(rn, finalBase);
      for (let reg = 0; reg < 16; reg++) {
        if (!(list & (1 << reg))) continue;
        if (load) {
          this._setReg(reg, this.bus.read32(addr & ~3));
        } else {
          this.bus.write32(addr & ~3, this._reg(reg));
        }
        addr = (addr + 4) >>> 0;
      }
      if (writeBack && !writeBackFirst) this._setReg(rn, finalBase);
    }

    _execThumb(instr, pc) {
      if ((instr & 0xf800) === 0x1800) return this._thumbAddSub(instr);
      if ((instr & 0xe000) === 0x0000) return this._thumbShift(instr);
      if ((instr & 0xe000) === 0x2000) return this._thumbImm(instr);
      if ((instr & 0xfc00) === 0x4000) return this._thumbAlu(instr);
      if ((instr & 0xfc00) === 0x4400) return this._thumbHiRegBx(instr);
      if ((instr & 0xf800) === 0x4800) return this._thumbPcLoad(instr, pc);
      if ((instr & 0xf200) === 0x5000) return this._thumbRegOffsetLoadStore(instr);
      if ((instr & 0xe000) === 0x6000) return this._thumbImmLoadStore(instr);
      if ((instr & 0xf000) === 0x8000) return this._thumbHalfwordLoadStore(instr);
      if ((instr & 0xf000) === 0x9000) return this._thumbSpLoadStore(instr);
      if ((instr & 0xf000) === 0xa000) return this._thumbLoadAddress(instr, pc);
      if ((instr & 0xff00) === 0xb000) return this._thumbAddSp(instr);
      if ((instr & 0xf600) === 0xb400) return this._thumbPushPop(instr);
      if ((instr & 0xf000) === 0xc000) return this._thumbMultiLoadStore(instr);
      if ((instr & 0xf000) === 0xd000) return this._thumbCondBranch(instr, pc);
      if ((instr & 0xf800) === 0xe000) return this._thumbBranch(instr, pc);
      if ((instr & 0xf800) === 0xf000 || (instr & 0xf800) === 0xf800) return this._thumbLongBranchLink(instr, pc);
      this._unsupportedThumb(instr, pc);
    }

    _thumbShift(instr) {
      const op = (instr >>> 11) & 3;
      if (op === 3) return this._unsupportedThumb(instr, (this.regs[15] - 2) >>> 0);
      const offset = (instr >>> 6) & 0x1f;
      const rs = (instr >>> 3) & 7;
      const rd = instr & 7;
      const value = this.regs[rs] >>> 0;
      let result = value;
      let carry = !!(this.cpsr & CPSR_C);
      if (op === 0) {
        carry = offset ? !!(value & (1 << (32 - offset))) : carry;
        result = offset ? (value << offset) >>> 0 : value;
      } else if (op === 1) {
        carry = offset ? !!(value & (1 << (offset - 1))) : !!(value & 0x80000000);
        result = offset ? value >>> offset : 0;
      } else {
        carry = offset ? !!(value & (1 << (offset - 1))) : !!(value & 0x80000000);
        result = offset ? (value >> offset) >>> 0 : (value & 0x80000000 ? 0xffffffff : 0);
      }
      this.regs[rd] = result >>> 0;
      this._setNZ(result);
      this.cpsr = (this.cpsr & ~CPSR_C) | (carry ? CPSR_C : 0);
    }

    _thumbAddSub(instr) {
      const immediate = !!(instr & 0x0400);
      const subtract = !!(instr & 0x0200);
      const rnOrImm = (instr >>> 6) & 7;
      const rs = (instr >>> 3) & 7;
      const rd = instr & 7;
      const a = this.regs[rs] >>> 0;
      const b = immediate ? rnOrImm : (this.regs[rnOrImm] >>> 0);
      const result = subtract ? (a - b) >>> 0 : (a + b) >>> 0;
      this.regs[rd] = result;
      this._setNZ(result);
      const carry = subtract ? a >= b : result < a;
      const overflow = subtract ? subOverflow(a, b, result) : addOverflow(a, b, result);
      this.cpsr = (this.cpsr & ~(CPSR_C | CPSR_V)) | (carry ? CPSR_C : 0) | (overflow ? CPSR_V : 0);
    }

    _thumbImm(instr) {
      const op = (instr >>> 11) & 3;
      const rd = (instr >>> 8) & 7;
      const imm = instr & 0xff;
      const a = this.regs[rd] >>> 0;
      let result = imm;
      let carry = !!(this.cpsr & CPSR_C);
      let overflow = false;
      if (op === 1) {
        result = (a - imm) >>> 0;
        carry = a >= imm;
        overflow = subOverflow(a, imm, result);
      } else if (op === 2) {
        result = (a + imm) >>> 0;
        carry = result < a;
        overflow = addOverflow(a, imm, result);
        this.regs[rd] = result;
      } else if (op === 3) {
        result = (a - imm) >>> 0;
        carry = a >= imm;
        overflow = subOverflow(a, imm, result);
        this.regs[rd] = result;
      } else {
        this.regs[rd] = result;
      }
      this._setNZ(result);
      if (op !== 0) this.cpsr = (this.cpsr & ~(CPSR_C | CPSR_V)) | (carry ? CPSR_C : 0) | (overflow ? CPSR_V : 0);
    }

    _thumbAlu(instr) {
      const op = (instr >>> 6) & 0xf;
      const rs = (instr >>> 3) & 7;
      const rd = instr & 7;
      const a = this.regs[rd] >>> 0;
      const b = this.regs[rs] >>> 0;
      let result = a;
      let write = true;
      let carry = !!(this.cpsr & CPSR_C);
      let overflow = false;
      switch (op) {
        case 0x0: result = a & b; break;
        case 0x1: result = a ^ b; break;
        case 0x2: result = b >= 32 ? 0 : a << b; carry = b ? !!(a & (1 << (32 - b))) : carry; break;
        case 0x3: result = b >= 32 ? 0 : a >>> b; carry = b ? !!(a & (1 << (b - 1))) : carry; break;
        case 0x4: result = b >= 32 ? (a & 0x80000000 ? 0xffffffff : 0) : (a >> b) >>> 0; carry = b ? !!(a & (1 << (b - 1))) : carry; break;
        case 0x5: result = (a + b + (this.cpsr & CPSR_C ? 1 : 0)) >>> 0; carry = result < a; overflow = addOverflow(a, b, result); break;
        case 0x6: result = (a - b - (this.cpsr & CPSR_C ? 0 : 1)) >>> 0; carry = a >= (b + (this.cpsr & CPSR_C ? 0 : 1)); overflow = subOverflow(a, b, result); break;
        case 0x7: result = ror32(a, b); carry = b ? !!(result & 0x80000000) : carry; break;
        case 0x8: result = a & b; write = false; break;
        case 0x9: result = (-b) >>> 0; overflow = b === 0x80000000; carry = b === 0; break;
        case 0xa: result = (a - b) >>> 0; carry = a >= b; overflow = subOverflow(a, b, result); write = false; break;
        case 0xb: result = (a + b) >>> 0; carry = result < a; overflow = addOverflow(a, b, result); write = false; break;
        case 0xc: result = a | b; break;
        case 0xd: result = Math.imul(a, b) >>> 0; break;
        case 0xe: result = a & (~b); break;
        case 0xf: result = (~b) >>> 0; break;
      }
      if (write) this.regs[rd] = result >>> 0;
      this._setNZ(result);
      if ([0x5, 0x6, 0x9, 0xa, 0xb].includes(op)) {
        this.cpsr = (this.cpsr & ~(CPSR_C | CPSR_V)) | (carry ? CPSR_C : 0) | (overflow ? CPSR_V : 0);
      } else if ([0x2, 0x3, 0x4, 0x7].includes(op)) {
        this.cpsr = (this.cpsr & ~CPSR_C) | (carry ? CPSR_C : 0);
      }
    }

    _thumbHiRegBx(instr) {
      const op = (instr >>> 8) & 3;
      const h1 = (instr >>> 7) & 1;
      const h2 = (instr >>> 6) & 1;
      const rs = ((h2 << 3) | ((instr >>> 3) & 7)) & 0xf;
      const rd = ((h1 << 3) | (instr & 7)) & 0xf;
      const a = this._reg(rd);
      const b = this._reg(rs);
      if (op === 0) this._setRegThumb(rd, (a + b) >>> 0);
      else if (op === 1) {
        const result = (a - b) >>> 0;
        this._setNZ(result);
        this.cpsr = (this.cpsr & ~(CPSR_C | CPSR_V)) | (a >= b ? CPSR_C : 0) | (subOverflow(a, b, result) ? CPSR_V : 0);
      } else if (op === 2) this._setRegThumb(rd, b);
      else {
        const target = b;
        if (target & 1) {
          this.cpsr |= CPSR_T;
          this.regs[15] = target & ~1;
        } else {
          this.cpsr &= ~CPSR_T;
          this.regs[15] = target & ~3;
        }
      }
    }

    _thumbPcLoad(instr, pc) {
      const rd = (instr >>> 8) & 7;
      const addr = ((pc + 4) & ~3) + ((instr & 0xff) << 2);
      this.regs[rd] = this.bus.read32(addr) >>> 0;
    }

    _thumbRegOffsetLoadStore(instr) {
      const load = !!(instr & 0x0800);
      const byte = !!(instr & 0x0400);
      const ro = (instr >>> 6) & 7;
      const rb = (instr >>> 3) & 7;
      const rd = instr & 7;
      const addr = (this.regs[rb] + this.regs[ro]) >>> 0;
      if (load) this.regs[rd] = byte ? this.bus.read8(addr) : this.bus.read32(addr & ~3);
      else if (byte) this.bus.write8(addr, this.regs[rd]);
      else this.bus.write32(addr & ~3, this.regs[rd]);
    }

    _thumbImmLoadStore(instr) {
      const load = !!(instr & 0x0800);
      const byte = !!(instr & 0x1000);
      const imm = (instr >>> 6) & 0x1f;
      const rb = (instr >>> 3) & 7;
      const rd = instr & 7;
      const off = byte ? imm : imm << 2;
      const addr = (this.regs[rb] + off) >>> 0;
      if (load) this.regs[rd] = byte ? this.bus.read8(addr) : this.bus.read32(addr & ~3);
      else if (byte) this.bus.write8(addr, this.regs[rd]);
      else this.bus.write32(addr & ~3, this.regs[rd]);
    }

    _thumbHalfwordLoadStore(instr) {
      const load = !!(instr & 0x0800);
      const imm = ((instr >>> 6) & 0x1f) << 1;
      const rb = (instr >>> 3) & 7;
      const rd = instr & 7;
      const addr = (this.regs[rb] + imm) >>> 0;
      if (load) this.regs[rd] = this.bus.read16(addr & ~1);
      else this.bus.write16(addr & ~1, this.regs[rd]);
    }

    _thumbSpLoadStore(instr) {
      const load = !!(instr & 0x0800);
      const rd = (instr >>> 8) & 7;
      const addr = (this.regs[13] + ((instr & 0xff) << 2)) >>> 0;
      if (load) this.regs[rd] = this.bus.read32(addr & ~3);
      else this.bus.write32(addr & ~3, this.regs[rd]);
    }

    _thumbLoadAddress(instr, pc) {
      const sp = !!(instr & 0x0800);
      const rd = (instr >>> 8) & 7;
      const off = (instr & 0xff) << 2;
      this.regs[rd] = ((sp ? this.regs[13] : ((pc + 4) & ~3)) + off) >>> 0;
    }

    _thumbAddSp(instr) {
      const sign = !!(instr & 0x0080);
      const off = (instr & 0x7f) << 2;
      this.regs[13] = sign ? (this.regs[13] - off) >>> 0 : (this.regs[13] + off) >>> 0;
    }

    _thumbPushPop(instr) {
      const pop = !!(instr & 0x0800);
      const extra = !!(instr & 0x0100);
      const list = instr & 0xff;
      if (pop) {
        for (let r = 0; r < 8; r++) {
          if (!(list & (1 << r))) continue;
          this.regs[r] = this.bus.read32(this.regs[13] & ~3);
          this.regs[13] = (this.regs[13] + 4) >>> 0;
        }
        if (extra) {
          this._setRegThumb(15, this.bus.read32(this.regs[13] & ~3));
          this.regs[13] = (this.regs[13] + 4) >>> 0;
        }
      } else {
        let count = this._bitCount(list) + (extra ? 1 : 0);
        this.regs[13] = (this.regs[13] - count * 4) >>> 0;
        let addr = this.regs[13];
        for (let r = 0; r < 8; r++) {
          if (!(list & (1 << r))) continue;
          this.bus.write32(addr & ~3, this.regs[r]);
          addr = (addr + 4) >>> 0;
        }
        if (extra) this.bus.write32(addr & ~3, this.regs[14]);
      }
    }

    _thumbMultiLoadStore(instr) {
      const load = !!(instr & 0x0800);
      const rb = (instr >>> 8) & 7;
      const list = instr & 0xff;
      let addr = this.regs[rb] >>> 0;
      for (let r = 0; r < 8; r++) {
        if (!(list & (1 << r))) continue;
        if (load) this.regs[r] = this.bus.read32(addr & ~3);
        else this.bus.write32(addr & ~3, this.regs[r]);
        addr = (addr + 4) >>> 0;
      }
      this.regs[rb] = addr >>> 0;
    }

    _thumbCondBranch(instr, pc) {
      const cond = (instr >>> 8) & 0xf;
      if (cond === 0xf) return this._unsupportedThumb(instr, pc); // SWI
      if (cond === 0xe) return this._unsupportedThumb(instr, pc);
      if (!this._conditionPassed(cond)) return;
      const imm = instr & 0xff;
      const off = ((imm & 0x80 ? imm | 0xffffff00 : imm) << 1) >> 0;
      this.regs[15] = (pc + 4 + off) >>> 0;
    }

    _thumbBranch(instr, pc) {
      const imm = instr & 0x7ff;
      const off = ((imm & 0x400 ? imm | 0xfffff800 : imm) << 1) >> 0;
      this.regs[15] = (pc + 4 + off) >>> 0;
    }

    _thumbLongBranchLink(instr, pc) {
      const off = instr & 0x7ff;
      if ((instr & 0xf800) === 0xf000) {
        const signed = off & 0x400 ? off | 0xfffff800 : off;
        this.regs[14] = (pc + 4 + (signed << 12)) >>> 0;
      } else {
        const target = (this.regs[14] + (off << 1)) >>> 0;
        this.regs[14] = ((pc + 2) | 1) >>> 0;
        this.regs[15] = target & ~1;
      }
    }

    _unsupportedThumb(instr, pc) {
      const key = `thumb:0x${(instr >>> 8).toString(16).padStart(2, '0')}`;
      this.unsupported.set(key, (this.unsupported.get(key) || 0) + 1);
      this.halted = true;
      this.reason = `unsupported THUMB 0x${instr.toString(16).padStart(4, '0')} at ${tools.hex(pc)}`;
    }

    _bitCount(v) {
      v &= 0xffff;
      let c = 0;
      while (v) {
        v &= v - 1;
        c++;
      }
      return c;
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

  function selfTest() {
    const memory = createMemoryImage();
    const base = tools.GBA_ROM_BASE;
    const view = new DataView(memory.rom.buffer);
    const words = [
      0xe3a0d403, // mov sp, #0x03000000
      0xe28dd902, // add sp, sp, #0x00008000
      0xe3a0e001, // mov lr, #1
      0xe92d4000, // stmdb sp!, {lr}
      0xe3a0002a, // mov r0, #42
      0xe8bd0002, // ldmia sp!, {r1}
    ];
    words.forEach((word, i) => view.setUint32(i * 4, word >>> 0, true));
    const bus = new GbaMemoryBus(memory);
    const cpu = new Arm7Cpu(bus, base);
    cpu.run(16);
    return {
      cpu: cpu.snapshot(),
      sp: cpu.regs[13] >>> 0,
      r0: cpu.regs[0] >>> 0,
      r1: cpu.regs[1] >>> 0,
      stackWord: bus.read32(0x03007ffc),
      events: bus.events,
    };
  }

  window.GsfEmulator = {
    GbaMemoryBus,
    Arm7Cpu,
    createMemoryImage,
    applyDecodedProgram,
    selfTest,
    StandardGsfEngine,
  };
  window.StandardGsfEngine = StandardGsfEngine;
})();
