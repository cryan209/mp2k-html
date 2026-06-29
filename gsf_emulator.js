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
      ewram: new Uint8Array(256 * 1024),
      iwram: new Uint8Array(32 * 1024),
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
    if (region?.id === 'rom') {
      const romOffset = program.loadAddr - tools.GBA_ROM_BASE;
      if (romOffset < 0 || romOffset + program.clippedSize > memory.rom.length) {
        memory.warnings.push(`${label} ROM write ${tools.hex(program.loadAddr)} +${program.clippedSize} is out of range`);
        return false;
      }
      memory.rom.set(program.data, romOffset);
      return true;
    }
    if (region?.id === 'ewram') {
      const off = program.loadAddr - 0x02000000;
      if (off < 0 || off + program.clippedSize > memory.ewram.length) {
        memory.warnings.push(`${label} EWRAM write ${tools.hex(program.loadAddr)} +${program.clippedSize} is out of range`);
        return false;
      }
      memory.ewram.set(program.data, off);
      return true;
    }
    if (region?.id === 'iwram') {
      const off = program.loadAddr - 0x03000000;
      if (off < 0 || off + program.clippedSize > memory.iwram.length) {
        memory.warnings.push(`${label} IWRAM write ${tools.hex(program.loadAddr)} +${program.clippedSize} is out of range`);
        return false;
      }
      memory.iwram.set(program.data, off);
      return true;
    }
    memory.warnings.push(`${label} loads into ${region?.label || 'unknown memory'} (${tools.hex(program.loadAddr)}); not applied`);
    return false;
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
  const GBA_CPU_HZ = 16777216;
  const GBA_CYCLES_PER_FRAME = 280896;
  const GBA_CYCLES_PER_SCANLINE = 1232; // 280896 / 228 scanlines (exact)
  const GBA_TOTAL_SCANLINES = 228;
  const GBA_VBLANK_SCANLINE = 160;
  const GBA_SYSTEM_STACK = 0x03007f00;
  const TIMER_PRESCALERS = [1, 64, 256, 1024];
  const IRQ_VBLANK = 0x0001;

  function signExtend24(v) {
    return (v & 0x00800000) ? (v | 0xff000000) : v;
  }

  function signExtend8(v) {
    return (v & 0x80) ? (v | 0xffffff00) : v;
  }

  function signExtend16(v) {
    return (v & 0x8000) ? (v | 0xffff0000) : v;
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

  function ioName(addr) {
    const names = {
      0x04000060: 'SOUND1CNT_L',
      0x04000062: 'SOUND1CNT_H',
      0x04000064: 'SOUND1CNT_X',
      0x04000068: 'SOUND2CNT_L',
      0x0400006c: 'SOUND2CNT_H',
      0x04000070: 'SOUND3CNT_L',
      0x04000072: 'SOUND3CNT_H',
      0x04000074: 'SOUND3CNT_X',
      0x04000078: 'SOUND4CNT_L',
      0x0400007c: 'SOUND4CNT_H',
      0x04000080: 'SOUNDCNT_L',
      0x04000082: 'SOUNDCNT_H',
      0x04000084: 'SOUNDCNT_X',
      0x04000088: 'SOUNDBIAS',
      0x040000a0: 'FIFO_A',
      0x040000a4: 'FIFO_B',
    };
    if (addr >= IO_TIMER_START && addr < IO_TIMER_END) {
      const ch = (addr - IO_TIMER_START) >>> 2;
      return ((addr - IO_TIMER_START) & 2) ? `TM${ch}CNT_H` : `TM${ch}CNT_L`;
    }
    if (addr >= IO_DMA_START && addr < IO_DMA_END) {
      const ch = Math.floor((addr - IO_DMA_START) / 12);
      const off = (addr - IO_DMA_START) % 12;
      if (off < 4) return `DMA${ch}SAD`;
      if (off < 8) return `DMA${ch}DAD`;
      if (off < 10) return `DMA${ch}CNT_L`;
      return `DMA${ch}CNT_H`;
    }
    return null;
  }

  class GbaMemoryBus {
    constructor(memory) {
      this.memory = memory;
      this.ewram = memory.ewram ? new Uint8Array(memory.ewram) : new Uint8Array(256 * 1024);
      this.iwram = memory.iwram ? new Uint8Array(memory.iwram) : new Uint8Array(32 * 1024);
      this.io = new Uint8Array(1024);
      this.palette = new Uint8Array(1024);
      this.vram = new Uint8Array(96 * 1024);
      this.oam = new Uint8Array(1024);
      this.sram = new Uint8Array(64 * 1024);
      this.events = [];
      this.unmappedReads = 0;
      this.unmappedWrites = 0;
      this.cycles = 0;
      this.frameCycles = 0;
      this.vblankCount = 0;
      this.irqEvents = [];
      this.dmaTransfers = [];
      this.memoryWrites = [];
      this.timerCounters = [0, 0, 0, 0];
      this.timerPhases = [0, 0, 0, 0];
      this.fifoDmaPhase = [0, 0]; // overflow counter for timer 0 and 1; DMA fires every 16
      this.wordWrites = new Map();
      this.fastMode = false;
      this.fifoSamplesA = []; // signed 8-bit PCM captured from FIFO A (direct sound A)
      this.fifoSamplesB = []; // signed 8-bit PCM captured from FIFO B (direct sound B)
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

    executableRegion(addr) {
      const r = this.region(addr);
      return r && ['ewram', 'iwram', 'rom'].includes(r.id) && r.off < r.data.length ? r : null;
    }

    read8(addr) {
      addr >>>= 0;
      // VCOUNT (0x04000006): dynamically computed from frame cycle position
      if (addr === 0x04000006) {
        return Math.floor(this.frameCycles / GBA_CYCLES_PER_SCANLINE) % GBA_TOTAL_SCANLINES;
      }
      // DISPSTAT (0x04000004) bit 0: VBlank flag, set when VCOUNT >= 160
      if (addr === 0x04000004) {
        const r = this.region(addr);
        const base = r ? r.data[r.off] : 0;
        const inVBlank = Math.floor(this.frameCycles / GBA_CYCLES_PER_SCANLINE) >= GBA_VBLANK_SCANLINE ? 1 : 0;
        return (base & ~1) | inVBlank;
      }
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
      // Timer enable: detect 0→1 transition on TM0-3 CNT_H high byte
      // Check BEFORE the write so we have the old value
      let timerEnableInit = -1;
      if (addr >= 0x04000103 && addr <= 0x0400010f && ((addr - 0x04000103) & 3) === 0) {
        const ch = (addr - 0x04000103) >> 2;
        const oldEnable = r.data[r.off] & 0x80;
        if ((value & 0x80) && !oldEnable) timerEnableInit = ch;
      }
      r.data[r.off] = value;
      this._logIoWrite(addr, value, 1);
      // Trigger DMA when high byte of CNT_H is written with enable bit (offset 11 in each 12-byte channel block)
      if (addr >= IO_DMA_START && addr < IO_DMA_END) {
        const dmaOff = addr - IO_DMA_START;
        if (dmaOff % 12 === 11) this._maybeRunDma(Math.floor(dmaOff / 12));
      }
      // Initialize timer counter from reload on enable transition
      if (timerEnableInit >= 0) {
        const base = 0x04000100 + timerEnableInit * 4;
        this.timerCounters[timerEnableInit] = (this.io[base - 0x04000000] | (this.io[base - 0x04000000 + 1] << 8));
        this.timerPhases[timerEnableInit] = 0;
      }
    }

    write16(addr, value) {
      addr >>>= 0;
      value &= 0xffff;
      if (addr === 0x04000202) {
        const current = this.read16(addr);
        const next = current & ~value;
        this.write8(addr, next);
        this.write8((addr + 1) >>> 0, next >>> 8);
        return;
      }
      this.write8(addr, value);
      this.write8((addr + 1) >>> 0, value >>> 8);
      if (addr >= IO_DMA_START && addr < IO_DMA_END && ((addr - IO_DMA_START) % 12) === 10) this._maybeRunDma((addr - IO_DMA_START) / 12);
    }

    write32(addr, value) {
      this.write8(addr, value);
      this.write8((addr + 1) >>> 0, value >>> 8);
      this.write8((addr + 2) >>> 0, value >>> 16);
      this.write8((addr + 3) >>> 0, value >>> 24);
    }

    noteMemoryWrite(addr, value, bytes, source = {}) {
      if (this.fastMode) return;
      addr >>>= 0;
      value >>>= 0;
      const r = this.region(addr);
      if (!r || r.id === 'io' || r.id === 'rom') return;
      const entry = {
        addr,
        addrHex: tools.hex(addr),
        value,
        valueHex: tools.hex(value, bytes * 2),
        bytes,
        region: r.id,
        ...source,
      };
      this.memoryWrites.push(entry);
      if (this.memoryWrites.length > 256) this.memoryWrites.shift();
      if (bytes === 4) this.wordWrites.set(addr & ~3, entry);
    }

    lastWordWrite(addr) {
      return this.wordWrites.get((addr >>> 0) & ~3) || null;
    }

    stepCycles(cycles) {
      cycles = Math.max(1, cycles | 0);
      this.cycles += cycles;
      this.frameCycles += cycles;
      this._tickTimers(cycles);
      while (this.frameCycles >= GBA_CYCLES_PER_FRAME) {
        this.frameCycles -= GBA_CYCLES_PER_FRAME;
        this._enterVBlank();
      }
    }

    _tickTimers(cycles) {
      for (let ch = 0; ch < 4; ch++) {
        const base = 0x04000100 + ch * 4;
        const ctrl = (this.io[base - 0x04000000 + 2] | (this.io[base - 0x04000000 + 3] << 8));
        if (!(ctrl & 0x80)) { this.timerPhases[ch] = 0; continue; } // disabled
        if (ch > 0 && (ctrl & 0x04)) continue; // cascade, driven by previous timer
        const prescaler = TIMER_PRESCALERS[ctrl & 3];
        const reload = (this.io[base - 0x04000000] | (this.io[base - 0x04000000 + 1] << 8));
        this.timerPhases[ch] += cycles;
        let ticks = Math.floor(this.timerPhases[ch] / prescaler);
        this.timerPhases[ch] -= ticks * prescaler;
        while (ticks > 0) {
          const space = 0x10000 - this.timerCounters[ch];
          if (ticks < space) { this.timerCounters[ch] += ticks; break; }
          ticks -= space;
          this.timerCounters[ch] = reload;
          this._timerOverflow(ch, ctrl);
        }
      }
    }

    _timerOverflow(ch, ctrl) {
      // Cascade: tick next timer by 1
      if (ch < 3) {
        const nBase = 0x04000100 + (ch + 1) * 4;
        const nCtrl = (this.io[nBase - 0x04000000 + 2] | (this.io[nBase - 0x04000000 + 3] << 8));
        if ((nCtrl & 0x80) && (nCtrl & 0x04)) {
          const nReload = (this.io[nBase - 0x04000000] | (this.io[nBase - 0x04000000 + 1] << 8));
          this.timerCounters[ch + 1]++;
          if (this.timerCounters[ch + 1] >= 0x10000) {
            this.timerCounters[ch + 1] = nReload;
            this._timerOverflow(ch + 1, nCtrl);
          }
        }
      }
      // Timer IRQ
      if (ctrl & 0x40) this.requestIrq(1 << (3 + ch), `timer${ch}-overflow`);
      // Sound FIFO DMA: timers 0 and 1 drive DMA channels 1 and 2
      // Fire every 16 overflows (FIFO = 32 bytes, DMA fires when half-empty after 16 consumes)
      if (ch <= 1) {
        this.fifoDmaPhase[ch] = (this.fifoDmaPhase[ch] + 1) & 15;
        if (this.fifoDmaPhase[ch] === 0) this._triggerSoundFifoDma(ch);
      }
    }

    _triggerSoundFifoDma(timerCh) {
      // Timer select for sound FIFO DMA is in SOUNDCNT_H (0x04000082):
      // bit 10 = Sound A timer select, bit 14 = Sound B timer select
      const soundCntH = (this.io[0x82] | (this.io[0x83] << 8));
      // DMA1 → FIFO A (0x040000a0), DMA2 → FIFO B (0x040000a4)
      const timerSelA = (soundCntH >>> 10) & 1;
      const timerSelB = (soundCntH >>> 14) & 1;
      const dmaTimers = [0, timerSelA, timerSelB, 0]; // ch→timer mapping (ch 1=FIFO A, ch 2=FIFO B)
      for (let dmaCh = 1; dmaCh <= 2; dmaCh++) {
        if (dmaTimers[dmaCh] !== timerCh) continue;
        const base = IO_DMA_START + dmaCh * 12;
        const ctrl = (this.io[base - 0x04000000 + 10] | (this.io[base - 0x04000000 + 11] << 8));
        if (!(ctrl & 0x8000)) continue; // DMA not enabled
        const timing = (ctrl >>> 12) & 3;
        if (timing !== 3) continue; // not sound FIFO timing
        this._runSoundFifoDma(dmaCh);
      }
    }

    _runSoundFifoDma(ch) {
      const base = IO_DMA_START + ch * 12;
      const src = this.read32(base);
      const dst = this.read32(base + 4); // should be FIFO address (0x040000a0 or 0x040000a4)
      // Sound FIFO: always transfer 4 words (16 bytes), dst fixed, src advances
      for (let i = 0; i < 4; i++) {
        const word = this.read32((src + i * 4) >>> 0);
        this._writeSoundFifo(dst, word);
      }
      // Advance src by 16 bytes (write back to DMA SAD register)
      const newSrc = (src + 16) >>> 0;
      this.write32(base, newSrc);
      // Don't disable — repeat bit is set, DMA stays active
    }

    _writeSoundFifo(fifoAddr, word) {
      // Capture signed 8-bit samples for audio output
      const buf = fifoAddr === 0x040000a0 ? this.fifoSamplesA : fifoAddr === 0x040000a4 ? this.fifoSamplesB : null;
      if (buf !== null) {
        for (let i = 0; i < 4; i++) {
          const b = (word >>> (i * 8)) & 0xff;
          buf.push(b < 128 ? b : b - 256);
        }
      }
      if (!this.fastMode) this.write32(fifoAddr, word);
    }

    forceVBlank(reason = 'forced') {
      this._enterVBlank(reason);
    }

    advanceFrame(reason = 'frame-wait') {
      const cyclesToFrame = GBA_CYCLES_PER_FRAME - this.frameCycles;
      this.stepCycles(cyclesToFrame > 0 ? cyclesToFrame : GBA_CYCLES_PER_FRAME);
      if (this.frameCycles === 0) {
        const last = this.irqEvents[this.irqEvents.length - 1];
        if (last && last.reason === 'vblank:frame') last.reason = `vblank:${reason}`;
      }
    }

    _enterVBlank(reason = 'frame') {
      this.vblankCount++;
      // VCOUNT is now computed dynamically from frameCycles; no need to write it
      this.write16(0x04000004, this.read16(0x04000004) | 0x0001);
      this.requestIrq(IRQ_VBLANK, `vblank:${reason}`);
    }

    requestIrq(mask, reason = 'irq') {
      const next = this.read16(0x04000202) | (mask & 0xffff);
      this.write8(0x04000202, next);
      this.write8(0x04000203, next >>> 8);
      this.irqEvents.push({
        mask: mask & 0xffff,
        maskHex: tools.hex(mask & 0xffff, 4),
        reason,
        cycles: this.cycles,
        ime: this.read16(0x04000208) & 1,
        ieHex: tools.hex(this.read16(0x04000200), 4),
        ifHex: tools.hex(this.read16(0x04000202), 4),
      });
      if (this.irqEvents.length > 128) this.irqEvents.shift();
    }

    pendingIrq(mask = 0xffff) {
      const ime = this.read16(0x04000208) & 1;
      const ie = this.read16(0x04000200);
      const flags = this.read16(0x04000202);
      return !!(ime && (ie & flags & mask));
    }

    _maybeRunDma(chFloat) {
      const ch = chFloat | 0;
      const base = 0x040000b0 + ch * 12;
      const control = this.read16(base + 10);
      if (!(control & 0x8000)) return;
      const timing = (control >>> 12) & 3;
      if (timing !== 0) return;
      this._runDma(ch, 'immediate');
    }

    _runDma(ch, reason = 'manual') {
      const base = 0x040000b0 + ch * 12;
      let src = this.read32(base);
      let dst = this.read32(base + 4);
      let count = this.read16(base + 8);
      const control = this.read16(base + 10);
      const width = (control & 0x0400) ? 4 : 2;
      if (!count) count = ch === 3 ? 0x10000 : 0x4000;
      const maxCount = Math.min(count, 0x10000);
      for (let i = 0; i < maxCount; i++) {
        const value = width === 4 ? this.read32(src) : this.read16(src);
        if (width === 4) this.write32(dst, value);
        else this.write16(dst, value);
        src = (src + width) >>> 0;
        dst = (dst + width) >>> 0;
      }
      if (!(control & 0x0200)) {
        const disabled = control & ~0x8000;
        this.write8(base + 10, disabled);
        this.write8(base + 11, disabled >>> 8);
      }
      if (!this.fastMode) {
        this.dmaTransfers.push({
          ch, reason,
          srcHex: tools.hex(this.read32(base)),
          dstHex: tools.hex(this.read32(base + 4)),
          count: maxCount, width: width * 8,
          controlHex: tools.hex(control, 4),
        });
        if (this.dmaTransfers.length > 64) this.dmaTransfers.shift();
      }
      if (control & 0x4000) this.requestIrq(1 << (8 + ch), `dma${ch}`);
    }

    _logIoWrite(addr, value, bytes) {
      if (this.fastMode || addr < 0x04000000 || addr >= 0x04000400) return;
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
      this.fastMode = false;
      this.r13_irq = 0x03007FA0; // GBA BIOS initializes IRQ SP here
      this._inIrqDispatch = false; // re-entrancy guard
      this.unsupported = new Map();
      this.psrWrites = [];
      this.swiCalls = [];
      this.pcHits = new Map();
      this.recentPcs = [];
      this.branches = [];
      this.regWrites = Array.from({ length: 16 }, (_, reg) => ({
        reg,
        regName: `r${reg}`,
        value: this.regs[reg] >>> 0,
        valueHex: tools.hex(this.regs[reg]),
        kind: 'init',
        pcHex: null,
      }));
      this._writeReg(13, GBA_SYSTEM_STACK, 'init-sp', null);
      this.regs[15] = entryAddr >>> 0;
      this._writeReg(15, entryAddr, 'entry', entryAddr);
      if (entryAddr & 1) {
        this.regs[15] = entryAddr & ~1;
        this._writeReg(15, this.regs[15], 'entry-thumb', this.regs[15]);
        this.cpsr |= CPSR_T;
      }
    }

    run(maxInstructions = 20000) {
      const start = this.instructions;
      while (!this.halted && this.instructions - start < maxInstructions) this.step();
      return this.fastMode ? null : this.snapshot();
    }

    step() {
      if (this.cpsr & CPSR_T) {
        const pc = this.regs[15] >>> 0;
        if (!this._canFetch(pc, 2)) return;
        this._tracePc(pc);
        const instr = this.bus.read16(pc);
        this.regs[15] = (pc + 2) >>> 0;
        this.instructions++;
        this._execThumb(instr, pc);
        this.bus.stepCycles(4);
        return;
      }
      const pc = this.regs[15] >>> 0;
      if (!this._canFetch(pc, 4)) return;
      this._tracePc(pc);
      const instr = this.bus.read32(pc);
      this.regs[15] = (pc + 4) >>> 0;
      this.instructions++;
      if (!this._conditionPassed(instr >>> 28)) {
        this.bus.stepCycles(4);
        return;
      }
      this._execArm(instr, pc);
      this.bus.stepCycles(4);
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
        pcHex: tools.hex(this.regs[15]),
        regs: Array.from(this.regs, v => v >>> 0),
        recentPcs: this.recentPcs.slice(-32).map(pc => tools.hex(pc)),
        pcHotspots: [...this.pcHits.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12)
          .map(([pc, hits]) => ({ pc, pcHex: tools.hex(pc), hits })),
        branches: this.branches.slice(-32),
        regWrites: this.regWrites.map(write => ({ ...write })),
        psrWrites: this.psrWrites.slice(-32),
        swiCalls: this.swiCalls.slice(-32),
        unsupported: Object.fromEntries([...this.unsupported.entries()].slice(0, 24)),
      };
    }

    _canFetch(pc, bytes) {
      const r = this.bus.executableRegion(pc);
      if (r && r.off + bytes <= r.data.length) return true;
      const source = this.branches.slice().reverse().find(branch => branch.kind !== 'fetch-fault') || null;
      this.halted = true;
      const sourceText = source ? ` from ${source.kind} ${source.pcHex}->${source.targetHex}` : '';
      this.reason = `pc-out-of-range fetch ${bytes * 8}-bit at ${tools.hex(pc)}${sourceText}`;
      if (!this.fastMode) this.branches.push({
        kind: 'fetch-fault',
        pc: pc >>> 0,
        pcHex: tools.hex(pc),
        thumb: !!(this.cpsr & CPSR_T),
        lrHex: tools.hex(this.regs[14]),
        spHex: tools.hex(this.regs[13]),
        source,
      });
      if (this.branches.length > 128) this.branches.shift();
      return false;
    }

    _tracePc(pc) {
      if (this.fastMode) return;
      pc >>>= 0;
      this.recentPcs.push(pc);
      if (this.recentPcs.length > 128) this.recentPcs.shift();
      this.pcHits.set(pc, (this.pcHits.get(pc) || 0) + 1);
      if (this.pcHits.size > 4096 && (this.instructions & 0xfff) === 0) this._trimPcHits();
    }

    _trimPcHits() {
      const keep = [...this.pcHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2048);
      this.pcHits = new Map(keep);
    }

    _recordBranch(kind, pc, target, detail = {}) {
      if (this.fastMode) return;
      this.branches.push({
        kind,
        pc: pc >>> 0,
        pcHex: tools.hex(pc),
        target: target >>> 0,
        targetHex: tools.hex(target),
        thumb: !!(this.cpsr & CPSR_T),
        lrHex: tools.hex(this.regs[14]),
        spHex: tools.hex(this.regs[13]),
        ...detail,
      });
      if (this.branches.length > 128) this.branches.shift();
    }

    _writeReg(idx, value, kind, pc = null, detail = {}) {
      value >>>= 0;
      this.regs[idx] = value;
      if (!this.fastMode) {
        this.regWrites[idx] = {
          reg: idx, regName: `r${idx}`, value, valueHex: tools.hex(value), kind,
          pc: pc == null ? null : pc >>> 0, pcHex: pc == null ? null : tools.hex(pc),
          ...detail,
        };
      }
      return value;
    }

    _writeMem32(addr, value, kind, detail = {}) {
      addr >>>= 0;
      value >>>= 0;
      const pc = (this.regs[15] - (this.cpsr & CPSR_T ? 2 : 4)) >>> 0;
      this.bus.write32(addr & ~3, value);
      this.bus.noteMemoryWrite(addr & ~3, value, 4, {
        kind,
        pc,
        pcHex: tools.hex(pc),
        ...detail,
      });
    }

    _writeMem16(addr, value, kind, detail = {}) {
      addr >>>= 0;
      value &= 0xffff;
      const pc = (this.regs[15] - (this.cpsr & CPSR_T ? 2 : 4)) >>> 0;
      this.bus.write16(addr & ~1, value);
      this.bus.noteMemoryWrite(addr & ~1, value, 2, {
        kind,
        pc,
        pcHex: tools.hex(pc),
        ...detail,
      });
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
      if ((instr & 0x0f000000) === 0x0f000000) return this._swi((instr >>> 16) & 0xff, pc, 'arm');
      if ((instr & 0x0e000000) === 0x0a000000) return this._branch(instr, pc);
      if ((instr & 0x0ffffff0) === 0x012fff10) return this._bx(instr);
      if ((instr & 0x0fc000f0) === 0x00000090) return this._multiply(instr);
      if ((instr & 0x0f8000f0) === 0x00800090) return this._multiplyLong(instr);
      if ((instr & 0x0fbf0fff) === 0x010f0000) return this._mrs(instr);
      if ((instr & 0x0db0f000) === 0x0120f000) return this._msr(instr);
      if ((instr & 0x0e000090) === 0x00000090) return this._halfwordDataTransfer(instr);
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
      this._writeReg(idx, value, 'arm-set-reg', (this.regs[15] - 4) >>> 0);
      if (idx === 15) {
        this._recordBranch('set-pc', (this.regs[15] - 4) >>> 0, value);
        this._writeReg(15, value & ~3, 'arm-set-pc', (this.regs[15] - 4) >>> 0, { rawValueHex: tools.hex(value) });
      }
    }

    _setRegThumb(idx, value) {
      value >>>= 0;
      this._writeReg(idx, value, 'thumb-set-reg', (this.regs[15] - 2) >>> 0);
      if (idx === 15) {
        this._recordBranch('set-pc-thumb', (this.regs[15] - 2) >>> 0, value);
        this._writeReg(15, value & ~1, 'thumb-set-pc', (this.regs[15] - 2) >>> 0, { rawValueHex: tools.hex(value) });
      }
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
        case 0x3: result = (op2.value - a) >>> 0; carry = op2.value >= a; overflow = subOverflow(op2.value, a, result); break; // RSB
        case 0x4: result = (a + op2.value) >>> 0; carry = result < a; overflow = addOverflow(a, op2.value, result); break; // ADD
        case 0x5: { const c5 = this.cpsr & CPSR_C ? 1 : 0; result = (a + op2.value + c5) >>> 0; carry = result < a || (c5 && result === a); overflow = addOverflow(a, op2.value, result); break; } // ADC
        case 0x6: { const c6 = this.cpsr & CPSR_C ? 0 : 1; result = (a - op2.value - c6) >>> 0; carry = a >= op2.value + c6; overflow = subOverflow(a, op2.value, result); break; } // SBC
        case 0x7: { const c7 = this.cpsr & CPSR_C ? 0 : 1; result = (op2.value - a - c7) >>> 0; carry = op2.value >= a + c7; overflow = subOverflow(op2.value, a, result); break; } // RSC
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
      // ARM exception return: S=1, Rd=15, privileged mode (not User 0x10)
      const exReturn = write && rd === 15 && setFlags && (this.cpsr & 0x1f) !== 0x10;
      if (write) {
        if (exReturn) {
          this.cpsr = this.spsr; // restore CPSR from SPSR
          this.regs[15] = result & ~3;
          if (!this.fastMode) this._recordBranch('exception-return', result, result & ~3);
        } else {
          this._setReg(rd, result);
        }
      }
      if (!exReturn && (setFlags || !write)) {
        this._setNZ(result);
        this.cpsr = (this.cpsr & ~(CPSR_C | CPSR_V)) | (carry ? CPSR_C : 0) | (overflow ? CPSR_V : 0);
      }
    }

    _multiply(instr) {
      const accumulate = !!(instr & 0x00200000);
      const setFlags = !!(instr & 0x00100000);
      const rd = (instr >>> 16) & 0xf;
      const rn = (instr >>> 12) & 0xf;
      const rs = (instr >>> 8) & 0xf;
      const rm = instr & 0xf;
      if (rd === 15 || rs === 15 || rm === 15 || (accumulate && rn === 15)) {
        return this._unsupported(instr, (this.regs[15] - 4) >>> 0);
      }
      let result = Math.imul(this._reg(rm), this._reg(rs)) >>> 0;
      if (accumulate) result = (result + this._reg(rn)) >>> 0;
      this._setReg(rd, result);
      if (setFlags) this._setNZ(result);
    }

    _multiplyLong(instr) {
      const isSigned = !(instr & 0x00400000);
      const accumulate = !!(instr & 0x00200000);
      const setFlags = !!(instr & 0x00100000);
      const rdHi = (instr >>> 16) & 0xf;
      const rdLo = (instr >>> 12) & 0xf;
      const rs = (instr >>> 8) & 0xf;
      const rm = instr & 0xf;
      const pc = (this.regs[15] - 4) >>> 0;
      const a = isSigned ? BigInt(this.regs[rm] | 0) : BigInt(this.regs[rm] >>> 0);
      const b = isSigned ? BigInt(this.regs[rs] | 0) : BigInt(this.regs[rs] >>> 0);
      let result = a * b;
      if (accumulate) {
        result += (BigInt(this.regs[rdHi] >>> 0) << 32n) | BigInt(this.regs[rdLo] >>> 0);
      }
      const lo = Number(result & 0xffffffffn) >>> 0;
      const hi = Number((result >> 32n) & 0xffffffffn) >>> 0;
      this._writeReg(rdLo, lo, 'arm-long-mul', pc);
      this._writeReg(rdHi, hi, 'arm-long-mul', pc);
      if (setFlags) {
        const n = result < 0n ? CPSR_N : 0;
        const z = result === 0n ? CPSR_Z : 0;
        this.cpsr = (this.cpsr & ~(CPSR_N | CPSR_Z | CPSR_C | CPSR_V)) | n | z;
      }
    }

    _singleDataTransfer(instr) {
      const immediateOffset = !(instr & 0x02000000);
      if (!immediateOffset && (instr & 0x00000010)) return this._unsupported(instr, (this.regs[15] - 4) >>> 0);
      const pre = !!(instr & 0x01000000);
      const up = !!(instr & 0x00800000);
      const byte = !!(instr & 0x00400000);
      const writeBack = !!(instr & 0x00200000);
      const load = !!(instr & 0x00100000);
      const rn = (instr >>> 16) & 0xf;
      const rd = (instr >>> 12) & 0xf;
      const off = immediateOffset ? (instr & 0xfff) : this._shiftedRegisterOffset(instr);
      const base = this._reg(rn);
      const offsetAddr = up ? (base + off) >>> 0 : (base - off) >>> 0;
      const addr = pre ? offsetAddr : base;
      const finalBase = pre ? offsetAddr : (up ? (base + off) >>> 0 : (base - off) >>> 0);
      if (load) {
        this._setReg(rd, byte ? this.bus.read8(addr) : this.bus.read32(addr & ~3));
      } else {
        const value = this._reg(rd);
        if (byte) this.bus.write8(addr, value);
        else this._writeMem32(addr, value, 'arm-store', { rd, rn });
      }
      if (writeBack || !pre) this._setReg(rn, finalBase);
    }

    _shiftedRegisterOffset(instr) {
      const rm = instr & 0xf;
      const shiftType = (instr >>> 5) & 3;
      const amount = (instr >>> 7) & 0x1f;
      const value = this._reg(rm);
      if (shiftType === 0) return amount ? (value << amount) >>> 0 : value;
      if (shiftType === 1) return amount ? value >>> amount : 0;
      if (shiftType === 2) return amount ? (value >> amount) >>> 0 : (value & 0x80000000 ? 0xffffffff : 0);
      if (!amount) return ((this.cpsr & CPSR_C ? 0x80000000 : 0) | (value >>> 1)) >>> 0;
      return ror32(value, amount);
    }

    _halfwordDataTransfer(instr) {
      const immediateOffset = !!(instr & 0x00400000);
      const pre = !!(instr & 0x01000000);
      const up = !!(instr & 0x00800000);
      const writeBack = !!(instr & 0x00200000);
      const load = !!(instr & 0x00100000);
      const rn = (instr >>> 16) & 0xf;
      const rd = (instr >>> 12) & 0xf;
      const sign = !!(instr & 0x00000040);
      const halfword = !!(instr & 0x00000020);
      const offset = immediateOffset ? (((instr >>> 4) & 0xf0) | (instr & 0xf)) : this._reg(instr & 0xf);
      const base = this._reg(rn);
      const offsetAddr = up ? (base + offset) >>> 0 : (base - offset) >>> 0;
      const addr = pre ? offsetAddr : base;
      const finalBase = pre ? offsetAddr : (up ? (base + offset) >>> 0 : (base - offset) >>> 0);

      if (!load && sign) return this._unsupported(instr, (this.regs[15] - 4) >>> 0);
      if (!load && !halfword) return this._unsupported(instr, (this.regs[15] - 4) >>> 0);

      if (load) {
        if (sign && halfword) this._setReg(rd, signExtend16(this.bus.read16(addr & ~1)) >>> 0);
        else if (sign) this._setReg(rd, signExtend8(this.bus.read8(addr)) >>> 0);
        else if (halfword) this._setReg(rd, this.bus.read16(addr & ~1));
        else return this._unsupported(instr, (this.regs[15] - 4) >>> 0);
      } else {
        this._writeMem16(addr, this._reg(rd), 'arm-halfword-store', { rd, rn });
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
      if (!this.fastMode) {
        this.psrWrites.push({ target: useSpsr ? 'spsr' : 'cpsr', fieldMask, value, before, after });
        if (this.psrWrites.length > 128) this.psrWrites.shift();
      }
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
      // PSR/S bit: load with PC in list = exception return; otherwise unsupported
      if (psr && !(load && (list & 0x8000))) return this._unsupported(instr, (this.regs[15] - 4) >>> 0);
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
          this._writeMem32(addr, this._reg(reg), 'arm-block-store', { reg, rn });
        }
        addr = (addr + 4) >>> 0;
      }
      if (writeBack && !writeBackFirst) this._setReg(rn, finalBase);
      // Exception return: LDM with S-bit, load=true, PC in list
      if (psr && load && (list & 0x8000)) {
        this.cpsr = this.spsr; // restore CPSR from SPSR (mode switch back to interrupted mode)
      }
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
      this._writeReg(rd, result, 'thumb-shift', (this.regs[15] - 2) >>> 0, { instrClass: 'shift' });
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
      this._writeReg(rd, result, 'thumb-add-sub', (this.regs[15] - 2) >>> 0, { subtract, immediate });
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
        this._writeReg(rd, result, 'thumb-imm', (this.regs[15] - 2) >>> 0, { op });
      } else if (op === 3) {
        result = (a - imm) >>> 0;
        carry = a >= imm;
        overflow = subOverflow(a, imm, result);
        this._writeReg(rd, result, 'thumb-imm', (this.regs[15] - 2) >>> 0, { op });
      } else {
        this._writeReg(rd, result, 'thumb-imm', (this.regs[15] - 2) >>> 0, { op });
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
      if (write) this._writeReg(rd, result, 'thumb-alu', (this.regs[15] - 2) >>> 0, { op });
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
        this._recordBranch('thumb-bx', (this.regs[15] - 2) >>> 0, target, {
          rs,
          rsName: `r${rs}`,
          rsValueHex: tools.hex(this._reg(rs)),
          rsWrite: this.regWrites[rs] ? { ...this.regWrites[rs] } : null,
        });
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
      this._writeReg(rd, this.bus.read32(addr) >>> 0, 'thumb-pc-load', pc, { addrHex: tools.hex(addr) });
    }

    _thumbRegOffsetLoadStore(instr) {
      const load = !!(instr & 0x0800);
      const byte = !!(instr & 0x0400);
      const ro = (instr >>> 6) & 7;
      const rb = (instr >>> 3) & 7;
      const rd = instr & 7;
      const addr = (this.regs[rb] + this.regs[ro]) >>> 0;
      if (load) this._writeReg(rd, byte ? this.bus.read8(addr) : this.bus.read32(addr & ~3), 'thumb-reg-load', (this.regs[15] - 2) >>> 0, { addrHex: tools.hex(addr), byte });
      else if (byte) this.bus.write8(addr, this.regs[rd]);
      else this._writeMem32(addr, this.regs[rd], 'thumb-reg-store', { rd, rb, ro });
    }

    _thumbImmLoadStore(instr) {
      const load = !!(instr & 0x0800);
      const byte = !!(instr & 0x1000);
      const imm = (instr >>> 6) & 0x1f;
      const rb = (instr >>> 3) & 7;
      const rd = instr & 7;
      const off = byte ? imm : imm << 2;
      const addr = (this.regs[rb] + off) >>> 0;
      if (load) this._writeReg(rd, byte ? this.bus.read8(addr) : this.bus.read32(addr & ~3), 'thumb-imm-load', (this.regs[15] - 2) >>> 0, { addrHex: tools.hex(addr), byte });
      else if (byte) this.bus.write8(addr, this.regs[rd]);
      else this._writeMem32(addr, this.regs[rd], 'thumb-imm-store', { rd, rb });
    }

    _thumbHalfwordLoadStore(instr) {
      const load = !!(instr & 0x0800);
      const imm = ((instr >>> 6) & 0x1f) << 1;
      const rb = (instr >>> 3) & 7;
      const rd = instr & 7;
      const addr = (this.regs[rb] + imm) >>> 0;
      if (load) this._writeReg(rd, this.bus.read16(addr & ~1), 'thumb-halfword-load', (this.regs[15] - 2) >>> 0, { addrHex: tools.hex(addr & ~1) });
      else this._writeMem16(addr, this.regs[rd], 'thumb-halfword-store', { rd, rb });
    }

    _thumbSpLoadStore(instr) {
      const load = !!(instr & 0x0800);
      const rd = (instr >>> 8) & 7;
      const addr = (this.regs[13] + ((instr & 0xff) << 2)) >>> 0;
      if (load) this._writeReg(rd, this.bus.read32(addr & ~3), 'thumb-sp-load', (this.regs[15] - 2) >>> 0, { addrHex: tools.hex(addr & ~3) });
      else this._writeMem32(addr, this.regs[rd], 'thumb-sp-store', { rd });
    }

    _thumbLoadAddress(instr, pc) {
      const sp = !!(instr & 0x0800);
      const rd = (instr >>> 8) & 7;
      const off = (instr & 0xff) << 2;
      this._writeReg(rd, ((sp ? this.regs[13] : ((pc + 4) & ~3)) + off) >>> 0, 'thumb-load-address', pc, { sp });
    }

    _thumbAddSp(instr) {
      const sign = !!(instr & 0x0080);
      const off = (instr & 0x7f) << 2;
      this._writeReg(13, sign ? (this.regs[13] - off) >>> 0 : (this.regs[13] + off) >>> 0, 'thumb-add-sp', (this.regs[15] - 2) >>> 0, { sign, off });
    }

    _thumbPushPop(instr) {
      const pop = !!(instr & 0x0800);
      const extra = !!(instr & 0x0100);
      const list = instr & 0xff;
      if (pop) {
        for (let r = 0; r < 8; r++) {
          if (!(list & (1 << r))) continue;
          const addr = this.regs[13] & ~3;
          const value = this.bus.read32(addr);
          this._writeReg(r, value, 'thumb-pop', (this.regs[15] - 2) >>> 0, {
            addrHex: tools.hex(addr),
            readValueHex: tools.hex(value),
            slotWrite: this.bus.lastWordWrite(addr),
            spBeforeHex: tools.hex(this.regs[13]),
            spWrite: this.regWrites[13] ? { ...this.regWrites[13] } : null,
          });
          this._writeReg(13, (this.regs[13] + 4) >>> 0, 'thumb-pop-sp', (this.regs[15] - 2) >>> 0);
        }
        if (extra) {
          const addr = this.regs[13] & ~3;
          const target = this.bus.read32(addr);
          this._recordBranch('thumb-pop-pc', (this.regs[15] - 2) >>> 0, target, {
            addrHex: tools.hex(addr),
            readValueHex: tools.hex(target),
            slotWrite: this.bus.lastWordWrite(addr),
            spBeforeHex: tools.hex(this.regs[13]),
            spWrite: this.regWrites[13] ? { ...this.regWrites[13] } : null,
          });
          this._setRegThumb(15, target);
          this._writeReg(13, (this.regs[13] + 4) >>> 0, 'thumb-pop-sp', (this.regs[15] - 2) >>> 0);
        }
      } else {
        let count = this._bitCount(list) + (extra ? 1 : 0);
        this._writeReg(13, (this.regs[13] - count * 4) >>> 0, 'thumb-push-sp', (this.regs[15] - 2) >>> 0, { count });
        let addr = this.regs[13];
        for (let r = 0; r < 8; r++) {
          if (!(list & (1 << r))) continue;
          this._writeMem32(addr, this.regs[r], 'thumb-push', { reg: r });
          addr = (addr + 4) >>> 0;
        }
        if (extra) this._writeMem32(addr, this.regs[14], 'thumb-push-lr', { reg: 14 });
      }
    }

    _thumbMultiLoadStore(instr) {
      const load = !!(instr & 0x0800);
      const rb = (instr >>> 8) & 7;
      const list = instr & 0xff;
      let addr = this.regs[rb] >>> 0;
      const rbInList = !!(list & (1 << rb));
      for (let r = 0; r < 8; r++) {
        if (!(list & (1 << r))) continue;
        if (load) this._writeReg(r, this.bus.read32(addr & ~3), 'thumb-multi-load', (this.regs[15] - 2) >>> 0, { addrHex: tools.hex(addr & ~3), rb });
        else this._writeMem32(addr, this.regs[r], 'thumb-multi-store', { r, rb });
        addr = (addr + 4) >>> 0;
      }
      if (!load || !rbInList) this.regs[rb] = addr >>> 0;
    }

    _thumbCondBranch(instr, pc) {
      const cond = (instr >>> 8) & 0xf;
      if (cond === 0xf) return this._swi(instr & 0xff, pc, 'thumb');
      if (cond === 0xe) return this._unsupportedThumb(instr, pc);
      if (!this._conditionPassed(cond)) return;
      const imm = instr & 0xff;
      const off = ((imm & 0x80 ? imm | 0xffffff00 : imm) << 1) >> 0;
      const target = (pc + 4 + off) >>> 0;
      this._recordBranch('thumb-cond-branch', pc, target, { cond });
      this.regs[15] = target;
    }

    _swi(num, pc, state) {
      const call = {
        num,
        name: this._swiName(num),
        pc,
        state,
        r0: this.regs[0] >>> 0,
        r1: this.regs[1] >>> 0,
        r2: this.regs[2] >>> 0,
      };
      try {
        if (num === 0x02) call.result = this._biosHalt();
        else if (num === 0x04) call.result = this._biosIntrWait();
        else if (num === 0x05) call.result = this._biosVBlankIntrWait();
        else if (num === 0x06) call.result = this._biosDiv(false);
        else if (num === 0x07) call.result = this._biosDiv(true);
        else if (num === 0x08) call.result = this._biosSqrt();
        else if (num === 0x0b) call.result = this._biosCpuSet();
        else if (num === 0x0c) call.result = this._biosCpuFastSet();
        else call.result = 'stubbed';
      } catch (err) {
        call.result = 'error';
        call.error = err.message;
        this.halted = true;
        this.reason = `SWI ${tools.hex(num, 2)} ${call.name} failed at ${tools.hex(pc)}: ${err.message}`;
      }
      if (!this.fastMode) {
        this.swiCalls.push(call);
        if (this.swiCalls.length > 128) this.swiCalls.shift();
      }
    }

    _swiName(num) {
      const names = {
        0x00: 'SoftReset',
        0x01: 'RegisterRamReset',
        0x02: 'Halt',
        0x03: 'Stop',
        0x04: 'IntrWait',
        0x05: 'VBlankIntrWait',
        0x06: 'Div',
        0x07: 'DivArm',
        0x08: 'Sqrt',
        0x09: 'ArcTan',
        0x0a: 'ArcTan2',
        0x0b: 'CpuSet',
        0x0c: 'CpuFastSet',
        0x0e: 'BgAffineSet',
        0x0f: 'ObjAffineSet',
        0x10: 'BitUnPack',
        0x11: 'LZ77UnCompWram',
        0x12: 'LZ77UnCompVram',
        0x13: 'HuffUnComp',
        0x14: 'RLUnCompWram',
        0x15: 'RLUnCompVram',
        0x16: 'Diff8bitUnFilterWram',
        0x17: 'Diff8bitUnFilterVram',
        0x18: 'Diff16bitUnFilter',
        0x19: 'SoundBias',
        0x1f: 'MidiKey2Freq',
      };
      return names[num] || `SWI_${tools.hex(num, 2)}`;
    }

    _biosHalt() {
      this.bus.advanceFrame('halt');
      if (!this._inIrqDispatch) this._checkAndDispatchIrq();
      return 'advanced to vblank';
    }

    _biosIntrWait() {
      const discardOld = !!this.regs[0];
      const mask = this.regs[1] & 0xffff;
      if (discardOld) this.bus.write16(0x04000202, mask);
      let frames = 0;
      while (!this.bus.pendingIrq(mask) && frames < 8) {
        this.bus.advanceFrame('intrwait');
        if (!this._inIrqDispatch) this._checkAndDispatchIrq();
        frames++;
      }
      return `waited ${frames} frame${frames === 1 ? '' : 's'} for ${tools.hex(mask, 4)}`;
    }

    _biosVBlankIntrWait() {
      this.bus.write16(0x04000200, this.bus.read16(0x04000200) | IRQ_VBLANK);
      this.bus.write16(0x04000208, 1);
      this.bus.write16(0x04000202, IRQ_VBLANK);
      this.bus.advanceFrame('vblankintrwait');
      if (!this._inIrqDispatch) this._checkAndDispatchIrq();
      return 'vblank';
    }

    _checkAndDispatchIrq() {
      if (!(this.bus.io[0x208] & 1)) return; // IME off
      const ie  = this.bus.io[0x200] | (this.bus.io[0x201] << 8);
      const ifl = this.bus.io[0x202] | (this.bus.io[0x203] << 8);
      const pending = ie & ifl & 0x3fff;
      if (!pending) return;
      const handlerAddr = this.bus.read32(0x03007FFC);
      // Require handler to be in ROM/EWRAM/IWRAM (not zero/unmapped)
      if (!handlerAddr || handlerAddr < 0x02000000) return;
      this._runIrqHandler(handlerAddr, pending);
    }

    _runIrqHandler(handlerAddr, pending) {
      this._inIrqDispatch = true;

      // Clear IF bits that we're about to handle (BIOS does this)
      const ifl = this.bus.io[0x202] | (this.bus.io[0x203] << 8);
      this.bus.io[0x202] = (ifl & ~pending) & 0xff;
      this.bus.io[0x203] = ((ifl & ~pending) >> 8) & 0xff;

      // Save full CPU state
      const savedRegs = Array.from(this.regs);
      const savedCpsr = this.cpsr;
      const savedSpsr = this.spsr;
      const savedHalted = this.halted;
      const savedReason = this.reason;

      // Enter IRQ mode: use IRQ stack, set SPSR = current CPSR so exception-return works
      this.regs[13] = this.r13_irq;
      this.spsr = savedCpsr; // so LDMFD {PC}^ or SUBS PC, LR, #4 restores CPSR correctly
      // CPSR: IRQ mode (0x12), I=1 (disable further IRQs), ARM
      this.cpsr = (savedCpsr & 0xffffff00) | 0x92;

      // Sentinel: when handler returns here, we stop. 0x204 is in unmapped BIOS space.
      const SENTINEL = 0x00000204;
      this.regs[14] = SENTINEL; // LR for handler to return to
      if (handlerAddr & 1) {
        this.regs[15] = (handlerAddr & ~1) >>> 0;
        this.cpsr |= CPSR_T;
      } else {
        this.regs[15] = handlerAddr >>> 0;
        this.cpsr &= ~CPSR_T;
      }

      // Run handler until it returns to sentinel or halts
      const MAX_HANDLER_STEPS = 500000;
      let count = 0;
      while (count < MAX_HANDLER_STEPS) {
        if (this.regs[15] === SENTINEL || this.halted) break;
        this.step();
        count++;
      }

      // Save updated IRQ stack pointer (handler may have adjusted it)
      this.r13_irq = this.regs[13];

      // Restore CPU state to pre-IRQ values
      for (let i = 0; i < 16; i++) this.regs[i] = savedRegs[i];
      this.cpsr = savedCpsr;
      this.spsr = savedSpsr;
      this.halted = savedHalted;
      this.reason = savedReason;

      this._inIrqDispatch = false;
    }

    _biosDiv(swapArgs = false) {
      const num = (swapArgs ? this.regs[1] : this.regs[0]) | 0;
      const den = (swapArgs ? this.regs[0] : this.regs[1]) | 0;
      if (den === 0) throw new Error('Div by zero');
      const quot = Math.trunc(num / den) | 0;
      const rem = (num - quot * den) | 0;
      const pc = (this.regs[15] - (this.cpsr & CPSR_T ? 2 : 4)) >>> 0;
      this._writeReg(0, quot >>> 0, 'bios-div', pc);
      this._writeReg(1, rem >>> 0, 'bios-div', pc);
      this._writeReg(3, (quot < 0 ? -quot : quot) >>> 0, 'bios-div', pc);
      return `${num}/${den}=${quot} rem ${rem}`;
    }

    _biosSqrt() {
      const val = this.regs[0] >>> 0;
      const result = Math.floor(Math.sqrt(val)) & 0xffff;
      const pc = (this.regs[15] - (this.cpsr & CPSR_T ? 2 : 4)) >>> 0;
      this._writeReg(0, result, 'bios-sqrt', pc);
      return `sqrt(${val})=${result}`;
    }

    _biosCpuFastSet() {
      const src = this.regs[0] >>> 0;
      const dst = this.regs[1] >>> 0;
      const mode = this.regs[2] >>> 0;
      const count = mode & 0x001fffff;
      const fill = !!(mode & 0x01000000);
      if (count > 0x100000) throw new Error(`unreasonable CpuFastSet count ${count}`);
      const fillValue = this.bus.read32(src & ~3);
      for (let i = 0; i < count; i++) {
        const value = fill ? fillValue : this.bus.read32(((src + i * 4) & ~3) >>> 0);
        this._writeMem32(((dst + i * 4) & ~3) >>> 0, value, 'bios-cpufastset', { srcHex: tools.hex(src), dstHex: tools.hex(dst), fill });
      }
      if (!fill && dst >= 0x03000000 && dst < 0x03008000 && count >= 64 && count <= 4096) {
        this._maybePatchSoundWork(dst, count);
      }
      return `${fill ? 'fill' : 'copy'} ${count} words ${tools.hex(src)}->${tools.hex(dst)}`;
    }

    _biosCpuSet() {
      const src = this.regs[0] >>> 0;
      const dst = this.regs[1] >>> 0;
      const mode = this.regs[2] >>> 0;
      const count = mode & 0x001fffff;
      const fill = !!(mode & 0x01000000);
      const word = !!(mode & 0x04000000);
      const bytes = word ? 4 : 2;
      if (count > 0x100000) throw new Error(`unreasonable CpuSet count ${count}`);
      const fillValue = word ? this.bus.read32(src & ~3) : this.bus.read16(src & ~1);
      for (let i = 0; i < count; i++) {
        const value = fill ? fillValue : (word ? this.bus.read32((src + i * bytes) & ~3) : this.bus.read16((src + i * bytes) & ~1));
        if (word) this._writeMem32((dst + i * bytes) & ~3, value, 'bios-cpuset', { srcHex: tools.hex(src), dstHex: tools.hex(dst), fill, word });
        else this._writeMem16((dst + i * bytes) & ~1, value, 'bios-cpuset', { srcHex: tools.hex(src), dstHex: tools.hex(dst), fill, word });
      }
      const result = `${fill ? 'fill' : 'copy'} ${count} ${word ? 'words' : 'halfwords'} ${tools.hex(src)}->${tools.hex(dst)}`;
      if (!fill && word && dst >= 0x03000000 && dst < 0x03008000 && count >= 64 && count <= 4096) {
        this._maybePatchSoundWork(dst, count);
      }
      return result;
    }

    _maybePatchSoundWork(driverBase, wordCount) {
      const soundWorkBase = GBA_SYSTEM_STACK;
      if (this.bus.read32(soundWorkBase + 8) !== 0) return;
      // Scan the IWRAM driver copy for a literal pool word that is a valid IWRAM Thumb
      // address (bit 0 set, in range 0x03000001-0x03007fff). This is typically the
      // ARM-to-Thumb switchover address stored as a literal after a BX rN instruction.
      const scanLimit = Math.min(wordCount * 4, 512);
      let thumbEntry = 0;
      for (let off = 0; off < scanLimit; off += 4) {
        const word = this.bus.read32((driverBase + off) >>> 0);
        if ((word & 1) && word >= 0x03000001 && word < 0x03008000) {
          thumbEntry = word;
          break;
        }
      }
      if (thumbEntry) {
        this._writeMem32(soundWorkBase + 8, thumbEntry, 'soundwork-patch', { driverBase: tools.hex(driverBase), thumbEntry: tools.hex(thumbEntry) });
      }
    }

    _thumbBranch(instr, pc) {
      const imm = instr & 0x7ff;
      const off = ((imm & 0x400 ? imm | 0xfffff800 : imm) << 1) >> 0;
      const target = (pc + 4 + off) >>> 0;
      this._recordBranch('thumb-branch', pc, target);
      this.regs[15] = target;
    }

    _thumbLongBranchLink(instr, pc) {
      const off = instr & 0x7ff;
      if ((instr & 0xf800) === 0xf000) {
        const signed = off & 0x400 ? off | 0xfffff800 : off;
        this.regs[14] = (pc + 4 + (signed << 12)) >>> 0;
      } else {
        const target = (this.regs[14] + (off << 1)) >>> 0;
        this.regs[14] = ((pc + 2) | 1) >>> 0;
        this._recordBranch('thumb-bl', pc, target);
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
      const target = (pc + 8 + offset) >>> 0;
      this._recordBranch(link ? 'arm-bl' : 'arm-b', pc, target);
      this.regs[15] = target;
    }

    _bx(instr) {
      const target = this._reg(instr & 0xf);
      this._recordBranch('arm-bx', (this.regs[15] - 4) >>> 0, target, { rm: instr & 0xf });
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

    _directSoundSampleRate(fallback = 13379) {
      if (!this.bus) return fallback;
      const soundCntH = this.bus.read16(0x04000082);
      const timerChoices = [
        this.bus.fifoSamplesA.length ? ((soundCntH & 0x0400) ? 1 : 0) : null,
        this.bus.fifoSamplesB.length ? ((soundCntH & 0x4000) ? 1 : 0) : null,
      ].filter(ch => ch != null);
      for (const ch of timerChoices.length ? timerChoices : [0, 1]) {
        const base = 0x04000100 + ch * 4;
        const reload = this.bus.read16(base);
        const control = this.bus.read16(base + 2);
        const period = 0x10000 - reload;
        if ((control & 0x80) && !(control & 0x04) && period > 0) {
          return Math.round(GBA_CPU_HZ / (TIMER_PRESCALERS[control & 3] * period));
        }
      }
      return fallback;
    }

    async play(renderSeconds = 10) {
      if (!this.cpu) this._initCpu();

      const FALLBACK_SAMPLE_RATE = 13379;
      let targetSamples = FALLBACK_SAMPLE_RATE * renderSeconds;
      const CHUNK = 500000; // instructions per setTimeout slice

      // Enable fast mode — skip all diagnostic tracking
      this.bus.fastMode = true;
      this.cpu.fastMode = true;
      this.bus.fifoSamplesA = [];
      this.bus.fifoSamplesB = [];

      // Run in chunks until we have enough FIFO samples (avoids blocking the event loop)
      // Safety cap: bail after 500M instructions if no samples arrive (e.g. timer never enabled)
      const MAX_INSTRUCTIONS = 500_000_000;
      const instructionsAtStart = this.cpu.instructions;
      let renderStopReason = 'unknown';
      await new Promise(resolve => {
        const tick = () => {
          this.cpu.run(CHUNK);
          const ranTotal = this.cpu.instructions - instructionsAtStart;
          const capturedSamples = Math.max(this.bus.fifoSamplesA.length, this.bus.fifoSamplesB.length);
          targetSamples = this._directSoundSampleRate(FALLBACK_SAMPLE_RATE) * renderSeconds;
          if (capturedSamples >= targetSamples || this.cpu.halted || ranTotal >= MAX_INSTRUCTIONS) {
            renderStopReason = capturedSamples >= targetSamples ? 'target' : this.cpu.halted ? 'halted' : 'cap';
            resolve();
          } else {
            setTimeout(tick, 0);
          }
        };
        setTimeout(tick, 0);
      });

      // Restore diagnostic mode and capture a small snapshot of current state
      this.bus.fastMode = false;
      this.cpu.fastMode = false;
      this.cpu.pcHits = new Map();
      this.cpu.recentPcs = [];
      this.cpu.branches = [];
      this.runDiagnostics(5000);

      // Build AudioBuffer from collected FIFO samples
      const sampleRate = this._directSoundSampleRate(FALLBACK_SAMPLE_RATE);
      targetSamples = sampleRate * renderSeconds;
      const nSamples = Math.min(Math.max(this.bus.fifoSamplesA.length, this.bus.fifoSamplesB.length), targetSamples);
      this.diagnostics.render = {
        requestedSeconds: renderSeconds,
        sampleRate,
        targetSamples,
        renderedSamples: nSamples,
        renderedMs: Math.round((nSamples / sampleRate) * 1000),
        instructions: this.cpu.instructions - instructionsAtStart,
        stopReason: renderStopReason,
      };
      if (nSamples > 0) {
        try {
          const audioCtx = new AudioContext({ sampleRate });
          await audioCtx.resume();
          const buffer = audioCtx.createBuffer(2, nSamples, sampleRate);
          // SOUNDCNT_H 0xa90e: Sound A → right, Sound B → left
          const left  = buffer.getChannelData(0);
          const right = buffer.getChannelData(1);
          const sampA = this.bus.fifoSamplesA;
          const sampB = this.bus.fifoSamplesB;
          for (let i = 0; i < nSamples; i++) {
            right[i] = (sampA[i] || 0) / 128;
            left[i]  = (sampB[i] || 0) / 128;
          }
          if (this._audioSrc) { try { this._audioSrc.stop(); } catch (_) {} }
          if (this._audioCtx) { this._audioCtx.close(); }
          const src = audioCtx.createBufferSource();
          src.buffer = buffer;
          src.loop = true;
          src.connect(audioCtx.destination);
          src.start();
          this._audioCtx = audioCtx;
          this._audioSrc = src;
        } catch (err) {
          console.warn('[GsfEngine] Audio playback failed:', err);
        }
      }

      return this.diagnostics;
    }

    stop() {
      if (this._audioSrc) { try { this._audioSrc.stop(); } catch (_) {} this._audioSrc = null; }
      if (this._audioCtx) { this._audioCtx.close(); this._audioCtx = null; }
    }

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
      const startInstructions = this.cpu.instructions;
      const startEvents = this.bus.events.length;
      const cpu = this.cpu.run(maxInstructions);
      const ranInstructions = cpu.instructions - startInstructions;
      const events = this.bus.events;
      const lastBranch = cpu.branches?.slice(-1)[0] || null;
      const faultSourceBranch = lastBranch?.kind === 'fetch-fault'
        ? (lastBranch.source || cpu.branches?.slice(0, -1).reverse().find(branch => branch.kind !== 'fetch-fault') || null)
        : null;
      const branchTrail = (cpu.branches || []).filter(branch => branch.kind !== 'fetch-fault').slice(-6);
      const soundWrites = events.filter(ev => ev.kind === 'sound');
      const timerWrites = events.filter(ev => ev.kind === 'timer');
      const dmaWrites = events.filter(ev => ev.kind === 'dma');
      const swiCalls = this.cpu.swiCalls || [];
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
        run: {
          requestedInstructions: maxInstructions,
          ranInstructions,
          newIoWrites: Math.max(0, events.length - startEvents),
          pcHex: cpu.pcHex,
          hotPcHex: cpu.pcHotspots?.[0]?.pcHex || null,
          hotPcHits: cpu.pcHotspots?.[0]?.hits || 0,
          lastBranch,
          faultSourceBranch,
          branchTrail,
        },
        io: {
          totalWrites: events.length,
          soundWrites: soundWrites.length,
          timerWrites: timerWrites.length,
          dmaWrites: dmaWrites.length,
          recent: events.slice(-64).map(ev => ({
            ...ev,
            addrHex: tools.hex(ev.addr),
            name: ioName(ev.addr),
            valueHex: tools.hex(ev.value, ev.bytes * 2),
          })),
          unmappedReads: this.bus.unmappedReads,
          unmappedWrites: this.bus.unmappedWrites,
        },
        audio: this._makeAudioDiagnostics(soundWrites, timerWrites, dmaWrites),
        fifo: {
          samplesA: this.bus.fifoSamplesA.length,
          samplesB: this.bus.fifoSamplesB.length,
          durationMs: Math.round(this.bus.fifoSamplesA.length / 13.379),
        },
        interrupts: this._makeInterruptDiagnostics(),
        bios: {
          swiCalls: swiCalls.length,
          swiSummary: (() => {
            const counts = new Map();
            for (const c of swiCalls) counts.set(c.name, (counts.get(c.name) || 0) + 1);
            return [...counts.entries()].map(([name, n]) => `${name}×${n}`).join(' ');
          })(),
          stubbed: swiCalls.filter(c => c.result === 'stubbed').map(c => c.name).filter((v, i, a) => a.indexOf(v) === i),
          recent: swiCalls.slice(-32).map(call => ({
            ...call,
            pcHex: tools.hex(call.pc),
            r0Hex: tools.hex(call.r0),
            r1Hex: tools.hex(call.r1),
            r2Hex: tools.hex(call.r2),
          })),
        },
        patchPoints: [],
        memPeek: (() => {
          const peek = (addr, count = 8) => {
            const words = [];
            for (let i = 0; i < count; i++) words.push(tools.hex(this.bus.read32((addr + i * 4) >>> 0)));
            return { addrHex: tools.hex(addr), words };
          };
          return {
            soundWork: peek(0x03007f00, 12),
            iwramStub: peek(0x03000520, 8),
            iwramDriver: peek(0x03006000, 8),
          };
        })(),
        iwramWrites: (() => {
          const writes = this.bus.memoryWrites.filter(w => w.addr >= 0x03000000 && w.addr < 0x03008000);
          const byAddr = new Map();
          for (const w of writes) byAddr.set(w.addr & ~3, w);
          return [...byAddr.values()].sort((a, b) => a.addr - b.addr).map(w => ({
            addrHex: tools.hex(w.addr),
            valueHex: tools.hex(w.value),
            kind: w.kind,
            pcHex: tools.hex(w.pc),
          }));
        })(),
        notes: [
          'ARM+Thumb CPU is active with data processing, branches, load/store, block transfer, multiply (including long MULL/MLAL), and BIOS SWI stubs.',
          'VCOUNT (0x04000006) computed dynamically from frameCycles; timers tick and overflow with cascade/IRQ/sound-FIFO-DMA support.',
          'IRQ dispatch: Halt/VBlankIntrWait SWIs run the handler at [0x03007FFC] as a nested CPU loop; S-flag exception return (SUBS PC,LR,#4 and LDM^) implemented.',
          'Not implemented: SWP, coprocessor, full IRQ mode register banking for all ARM modes.',
        ],
      };
      return this.diagnostics;
    }

    _makeInterruptDiagnostics() {
      const ime = this.bus.read16(0x04000208) & 1;
      const ie = this.bus.read16(0x04000200);
      const flags = this.bus.read16(0x04000202);
      return {
        ime,
        ieHex: tools.hex(ie, 4),
        ifHex: tools.hex(flags, 4),
        pendingHex: tools.hex(ime ? (ie & flags) : 0, 4),
        vblankCount: this.bus.vblankCount,
        cycles: this.bus.cycles,
        frameCycles: this.bus.frameCycles,
        recent: this.bus.irqEvents.slice(-24),
      };
    }

    _makeAudioDiagnostics(soundWrites, timerWrites, dmaWrites) {
      const reg16 = addr => this.bus.read16(addr) & 0xffff;
      const reg32 = addr => this.bus.read32(addr) >>> 0;
      const soundCntL = reg16(0x04000080);
      const soundCntH = reg16(0x04000082);
      const soundCntX = reg16(0x04000084);
      const soundBias = reg16(0x04000088);
      const fifoA = soundWrites.filter(ev => ev.addr >= 0x040000a0 && ev.addr < 0x040000a4).length;
      const fifoB = soundWrites.filter(ev => ev.addr >= 0x040000a4 && ev.addr < 0x040000a8).length;
      const timers = [];
      for (let ch = 0; ch < 4; ch++) {
        const base = 0x04000100 + ch * 4;
        const reload = reg16(base);
        const control = reg16(base + 2);
        const prescaler = TIMER_PRESCALERS[control & 3];
        const period = 0x10000 - reload;
        const enabled = !!(control & 0x80);
        const cascade = !!(control & 0x04);
        timers.push({
          ch,
          reload,
          reloadHex: tools.hex(reload, 4),
          counter: this.bus.timerCounters[ch],
          controlHex: tools.hex(control, 4),
          enabled,
          cascade,
          irq: !!(control & 0x40),
          prescaler,
          rateHz: enabled && !cascade && period > 0 ? Math.round(GBA_CPU_HZ / (prescaler * period)) : 0,
          writes: timerWrites.filter(ev => ev.addr >= base && ev.addr < base + 4).length,
        });
      }
      const dmas = [];
      for (let ch = 0; ch < 4; ch++) {
        const base = 0x040000b0 + ch * 12;
        const src = reg32(base);
        const dst = reg32(base + 4);
        const count = reg16(base + 8);
        const control = reg16(base + 10);
        const timing = (control >>> 12) & 3;
        dmas.push({
          ch,
          srcHex: tools.hex(src),
          dstHex: tools.hex(dst),
          count,
          controlHex: tools.hex(control, 4),
          enabled: !!(control & 0x8000),
          irq: !!(control & 0x4000),
          timing: ['immediate', 'vblank', 'hblank', 'special'][timing],
          repeat: !!(control & 0x0200),
          width: (control & 0x0400) ? 32 : 16,
          soundFifo: dst >= 0x040000a0 && dst < 0x040000a8,
          writes: dmaWrites.filter(ev => ev.addr >= base && ev.addr < base + 12).length,
        });
      }
      return {
        sound: {
          enabled: !!(soundCntX & 0x0080),
          soundCntLHex: tools.hex(soundCntL, 4),
          soundCntHHex: tools.hex(soundCntH, 4),
          soundCntXHex: tools.hex(soundCntX, 4),
          soundBiasHex: tools.hex(soundBias, 4),
          masterVolume: (soundCntH >>> 8) & 3,
          directSoundA: {
            volume100: !!(soundCntH & 0x0004),
            right: !!(soundCntH & 0x0100),
            left: !!(soundCntH & 0x0200),
            timer: (soundCntH & 0x0400) ? 1 : 0,
            reset: !!(soundCntH & 0x0800),
            fifoWrites: fifoA,
          },
          directSoundB: {
            volume100: !!(soundCntH & 0x0008),
            right: !!(soundCntH & 0x1000),
            left: !!(soundCntH & 0x2000),
            timer: (soundCntH & 0x4000) ? 1 : 0,
            reset: !!(soundCntH & 0x8000),
            fifoWrites: fifoB,
          },
          recent: soundWrites.slice(-24).map(ev => ({
            ...ev,
            addrHex: tools.hex(ev.addr),
            name: ioName(ev.addr),
            valueHex: tools.hex(ev.value, ev.bytes * 2),
          })),
        },
        timers,
        dma: dmas,
        dmaTransfers: this.bus.dmaTransfers.slice(-16),
        activeTimers: timers.filter(t => t.enabled).map(t => t.ch),
        soundDma: dmas.filter(d => d.enabled && d.soundFifo).map(d => d.ch),
      };
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
        romBytesTouched: segments.filter(s => s.region === 'rom').reduce((sum, s) => sum + s.dataSize, 0),
        ewramBytesTouched: segments.filter(s => s.region === 'ewram').reduce((sum, s) => sum + s.dataSize, 0),
        iwramBytesTouched: segments.filter(s => s.region === 'iwram').reduce((sum, s) => sum + s.dataSize, 0),
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
      if (report.ewramBytesTouched) parts.push(`${report.ewramBytesTouched} EWRAM bytes`);
      if (report.iwramBytesTouched) parts.push(`${report.iwramBytesTouched} IWRAM bytes`);
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
