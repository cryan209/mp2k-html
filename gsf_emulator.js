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
  const MODE_USER = 0x10;
  const MODE_FIQ = 0x11;
  const MODE_IRQ = 0x12;
  const MODE_SUPERVISOR = 0x13;
  const MODE_ABORT = 0x17;
  const MODE_UNDEFINED = 0x1b;
  const MODE_SYSTEM = 0x1f;
  const IO_SOUND_START = 0x04000060;
  const IO_SOUND_END = 0x040000a8;
  const IO_TIMER_START = 0x04000100;
  const IO_TIMER_END = 0x04000110;
  const IO_DMA_START = 0x040000b0;
  const IO_DMA_END = 0x040000e0;
  const GBA_CPU_HZ = 16777216;
  const GBA_CYCLES_PER_FRAME = 280896;
  const PSG_FRAME_SEQ_CYCLES = GBA_CPU_HZ / 512;
  const GBA_CYCLES_PER_SCANLINE = 1232; // 280896 / 228 scanlines (exact)
  const GBA_TOTAL_SCANLINES = 228;
  const GBA_VBLANK_SCANLINE = 160;
  const GBA_VBLANK_CYCLE = GBA_VBLANK_SCANLINE * GBA_CYCLES_PER_SCANLINE; // 197120
  const GBA_HBLANK_CYCLE_IN_LINE = 1006; // HBlank flag/IRQ/DMA point within each scanline
  const GBA_SYSTEM_STACK = 0x03007f00;
  const TIMER_PRESCALERS = [1, 64, 256, 1024];
  const IRQ_VBLANK = 0x0001;
  const BIT_COUNT_16 = new Uint8Array(0x10000);
  for (let i = 1; i < BIT_COUNT_16.length; i++) BIT_COUNT_16[i] = BIT_COUNT_16[i >>> 1] + (i & 1);

  function signExtend24(v) {
    return (v & 0x00800000) ? (v | 0xff000000) : v;
  }

  function signExtend8(v) {
    return (v & 0x80) ? (v | 0xffffff00) : v;
  }

  function signExtend16(v) {
    return (v & 0x8000) ? (v | 0xffff0000) : v;
  }

  // Polyphase windowed-sinc resampling kernel. Rows are fractional phases in [0,1);
  // each row holds `taps` Blackman-windowed sinc coefficients (cutoff fcNorm in
  // source-sample units), normalized to unit DC gain so amplitude cannot ripple with
  // phase. Replaces linear interpolation in the stream path: linear interp of high-
  // rate sources (e.g. Golden Sun's 21kHz mixer) leaves imaging around the source
  // rate that beats against the music — audible as a watery warble that a proper
  // sinc kernel suppresses by design.
  function buildSincKernel(fcNorm, taps = 24, phases = 512) {
    const half = taps / 2;
    const table = new Float32Array(taps * phases);
    for (let p = 0; p < phases; p++) {
      const frac = p / phases;
      let sum = 0;
      for (let k = 0; k < taps; k++) {
        const t = (k - (half - 1)) - frac; // distance (in source samples) to this tap
        const x = Math.PI * fcNorm * t;
        const sinc = x === 0 ? 1 : Math.sin(x) / x;
        const wpos = (t + half) / taps;   // 0..1 across the kernel span
        const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * wpos) + 0.08 * Math.cos(4 * Math.PI * wpos);
        const c = fcNorm * sinc * Math.max(0, w);
        table[p * taps + k] = c;
        sum += c;
      }
      if (sum !== 0) for (let k = 0; k < taps; k++) table[p * taps + k] /= sum;
    }
    return table;
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
    if (names[addr] !== undefined) return names[addr];
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
      // Bus-stall cycles owed by DMA/SWI work that ran "for free" inside an instruction;
      // drained by the CPU on its next step so DMA time is charged without re-entering
      // stepCycles (and thus _tickTimers) recursively from inside a timer tick.
      this.stallCycles = 0;
      // Whether the ROM has ever written the BIOS IRQ-acknowledge flags halfword at
      // 0x03007FF8. Well-behaved ISRs mirror IF there for IntrWait; degenerate GSF stubs
      // never do, and IntrWait falls back to raw IE&IF semantics for those.
      this.biosIrqFlagsWritten = false;
      // Whether the ROM has ever written DISPSTAT. Hardware gates the VBlank IRQ on
      // DISPSTAT bit 3; ROMs that configure it get hardware behavior, ROMs that never
      // touch it keep the historical always-fire fallback.
      this.dispstatWritten = false;
      // Open-bus value: the last opcode fetched by the CPU. Unmapped reads return this
      // (per 16/32-bit lane) instead of 0, matching GBA prefetch-latch behavior.
      this.openBus = 0;
      // BIOS-region open bus: reading 0x00000000-0x00003FFF from outside the BIOS
      // returns the last opcode the BIOS itself fetched. With the BIOS fully HLE'd we
      // track the documented values: 0xE129F000 after startup, 0xE3A02004 after a SWI,
      // 0xE55EC002 after an IRQ handler returns. Anti-piracy checks read these.
      this.biosOpenBus = 0xe129f000;
      // Cached per-wait-state ROM fetch costs (index 0/1/2 = 0x08/0x0A/0x0C regions),
      // derived from WAITCNT sequential-wait bits: cost = 1+s (Thumb), 1+2s (ARM).
      // Defaults reflect WAITCNT=0 (s-waits 2/4/8).
      this.romCostThumb = [3, 5, 9];
      this.romCostArm = [5, 9, 17];
      this._vblankFiredThisFrame = false;
      this.vblankCount = 0;
      this.irqEvents = [];
      this.irqVectorWrites = [];
      this.soundBufferWrites = [];
      this.soundBufferWriteMap = new Map();
      this.mplInitWrites = []; // first 256 writes to 0x03007100-0x0300717f (VBL 1 init trace)
      this.dmaTransfers = [];
      this.dmaSourceLatch = [0, 0, 0, 0];
      this.dmaDestLatch = [0, 0, 0, 0];
      // Each Direct Sound FIFO DMA channel's *initial* source address, captured the first time
      // its source latch is set. Real hardware has no "buffer size" register — the DMA's
      // internal source pointer just increments by 16 bytes forever, only ever wrapping via the
      // 32KB IWRAM physical-address mirror. mp2k's actual per-channel mix buffer is far smaller
      // than that (see dsFifoBufferSize below), so relying on the 32KB mirror means the pointer
      // spends most of its time reading unrelated IWRAM (stack, other tracks' state, code)
      // instead of the freshly-mixed samples — which is consistent with Direct Sound going
      // silent/noisy after the first buffer pass. Confine each channel's source pointer to its
      // own buffer window instead.
      this.dmaSourceBase = [0, 0, 0, 0];
      this.dsFifoBufferSize = 0;
      this.dmaSadLog = []; // every write that touches DMA1/DMA2 SAD (sound FIFO source reg), fastMode-safe
      this.psgRegWrites = new Map(); // PSG channel register write tally, fastMode-safe
      this.psgFrameSeqCycles = 0;
      this.psgFrameSeqStep = 0;
      this.memoryWrites = [];
      this.timerCounters = [0, 0, 0, 0];
      this.timerPhases = [0, 0, 0, 0];
      // Event-driven timer advancement: timers are lazily synced to this.cycles only
      // when execution crosses nextTimerEventCycles (the earliest possible overflow),
      // instead of being re-examined on every instruction's stepCycles call.
      this.timerSyncCycles = 0;
      this.nextTimerEventCycles = Infinity;
      this.timerControls = [0, 0, 0, 0];
      this.timerReloads = [0, 0, 0, 0];
      this.timerEnabledMask = 0;
      this.timerCpuMask = 0;
      this.fifoDmaPhase = [0, 0]; // overflow counter for timer 0 and 1; DMA fires every 16
      this.wordWrites = new Map();
      this.fastMode = false;
      this.diagnosticProbes = false;
      this.fifoQueueA = [];
      this.fifoQueueB = [];
      this.fifoHeadA = 0;
      this.fifoHeadB = 0;
      this.fifoLenA = 0;
      this.fifoLenB = 0;
      // Parallel to fifoQueueA/B: per-byte provenance (source addr + who last wrote it + the
      // cycle DMA actually read it), pushed/shifted in lockstep. Lets us trace a specific played
      // sample back to exactly which memory write produced it and how stale that read was.
      this.fifoQueueMetaA = [];
      this.fifoQueueMetaB = [];
      this.fifoMetaHeadA = 0;
      this.fifoMetaHeadB = 0;
      this.fifoSamplesA = []; // signed 8-bit DAC values consumed from FIFO A
      this.fifoSamplesB = []; // signed 8-bit DAC values consumed from FIFO B
      this.dsOnlySamplesA = []; // fifoSamplesA before PSG gets mixed in, for isolating which part is wrong
      this.dsOnlySamplesB = [];
      this.dmaSrcTraceA = []; // per-sample provenance, parallel to dsOnlySamplesA/B
      this.dmaSrcTraceB = [];
      this.fifoLastA = 0;
      this.fifoLastB = 0;
      this.fifoFillBytesA = 0;
      this.fifoFillBytesB = 0;
      this.fifoDmaLog = [];
      this.timerReloadLog = []; // log writes to TM0CNT_L for debugging
      this.timerRegSnaps = []; // register snapshots at key PCs
      this.fn2CallSnaps = []; // per-VBL fn2 call site snapshots (first 4 + last 4)
      this.dmaDriftLog = []; // per-VBL DMA1 read-ptr vs mixer write-ptr (r5) drift, first 8 + last 8
      this.debugPc = 0; // set by CPU before each step for write logging
      this.debugThumb = false;
      this.debugRegs = null; // reference to CPU registers array, set by CPU init
      // PSG Square1 (ch 0) and Square2 (ch 1) oscillator state. Square2 has no sweep.
      this.psg = [0, 1].map(ch => ({
        enabled: false,
        triggerCycles: 0,
        lastSampleCycles: 0,
        freqRaw: 0, freqCur: 0,
        dutyFraction: 0.5,
        dutyStep: 4,
        volInit: 0, volume: 0, envDir: 0, envStep: 0, envStepsApplied: 0,
        envTimer: 0, envActive: false,
        lengthEnabled: false, lengthCounter: 0, lengthCyclesTotal: Infinity,
        sweepShift: 0, sweepDir: 0, sweepPeriod: 0, sweepStepsApplied: 0,
        sweepTimer: 0, sweepEnabled: false, sweepShadow: 0,
        phase: 0,
      }));
      // Per-channel trigger stats: how many retriggers keep the same frequency (suggests
      // vibrato/pitch-bend re-pokes rather than new notes, which would cause audible phase-
      // reset clicks) and how close together they land. fastMode-safe.
      this.psgTriggerStats = [0, 1].map(() => ({
        total: 0, sameFreq: 0, minGapCycles: Infinity, sumGapCycles: 0, gapSamples: 0,
      }));
      this.psgFreqLog = [[], []]; // melodic-contour trace, first 24 + last 24 per channel
      this.psgSampleCacheCycles = -1;
      this.psgSampleCache = [0, 0, 0, 0];
      // PSG Wave (ch 2): plays back the 32x4-bit sample table at WAVE_RAM (0x04000090-9F)
      // at the programmed digit rate, scaled by a fixed output-level select (no envelope).
      this.waveRam = new Uint8Array(32); // two 16-byte banks, each 32 packed 4-bit digits
      this.psgWave = {
        enabled: false, triggerCycles: 0, lastSampleCycles: 0,
        freqRaw: 0, freqCur: 0,
        lengthEnabled: false, lengthCounter: 0, lengthCyclesTotal: Infinity,
        outputLevel: 0, forceVolume: false,
        phase: 0,
      };
      // PSG Noise (ch 3): pseudorandom LFSR bitstream, envelope like the Square channels but
      // no frequency/duty — pitch is a clock divider+shift pair, width is 15-bit or 7-bit.
      this.psgNoise = {
        enabled: false, triggerCycles: 0, lastSampleCycles: 0,
        volInit: 0, volume: 0, envDir: 0, envStep: 0, envStepsApplied: 0,
        envTimer: 0, envActive: false,
        lengthEnabled: false, lengthCounter: 0, lengthCyclesTotal: Infinity,
        divRatio: 0, widthMode: 0, shiftFreq: 0,
        periodCycles: 32,
        lfsr: 0x7fff, phaseCycles: 0,
      };
      this.noiseTriggerLog = []; // first 8 + last 8 Noise trigger snapshots (gap/div/shift/width)
      this._noiseTriggerCount = 0;
    }

    region(addr) {
      addr >>>= 0;
      if (addr >= 0x02000000 && addr < 0x03000000) return { id: 'ewram', data: this.ewram, off: (addr - 0x02000000) & 0x3ffff };
      if (addr >= 0x03000000 && addr < 0x04000000) return { id: 'iwram', data: this.iwram, off: (addr - 0x03000000) & 0x7fff };
      if (addr >= 0x04000000 && addr < 0x04000400) return { id: 'io', data: this.io, off: addr - 0x04000000 };
      if (addr >= 0x05000000 && addr < 0x05000400) return { id: 'palette', data: this.palette, off: addr - 0x05000000 };
      if (addr >= 0x06000000 && addr < 0x06018000) return { id: 'vram', data: this.vram, off: addr - 0x06000000 };
      if (addr >= 0x07000000 && addr < 0x07000400) return { id: 'oam', data: this.oam, off: addr - 0x07000000 };
      if (addr >= 0x08000000 && addr < 0x0e000000) {
        // Game Pak ROM is mirrored at 0x0A000000 (wait state 1) and 0x0C000000 (wait
        // state 2); sound engines deliberately stream sample data through those mirrors
        // to use different waitstate settings, so all three must resolve to the image.
        const off = (addr - 0x08000000) & 0x01ffffff;
        if (off < this.memory.rom.length) return { id: 'rom', data: this.memory.rom, off };
        return null;
      }
      if (addr >= 0x0e000000 && addr < 0x0e010000) return { id: 'sram', data: this.sram, off: addr - 0x0e000000 };
      return null;
    }

    canonicalAddr(addr) {
      const r = this.region(addr);
      if (!r) return addr >>> 0;
      if (r.id === 'ewram') return (0x02000000 + r.off) >>> 0;
      if (r.id === 'iwram') return (0x03000000 + r.off) >>> 0;
      if (r.id === 'rom') return (0x08000000 + r.off) >>> 0;
      return addr >>> 0;
    }

    executableRegion(addr) {
      const r = this.region(addr);
      return r && ['ewram', 'iwram', 'rom'].includes(r.id) && r.off < r.data.length ? r : null;
    }

    read8(addr) {
      addr >>>= 0;
      // Timer counter readback: reading TM0-3CNT_L/H returns the live counter, not the reload value.
      // GBA hardware uses a separate shadow reload register; reads reflect the running counter.
      if (addr >= 0x04000100 && addr <= 0x04000109) {
        const ch = (addr - 0x04000100) >> 2;
        const byteOff = (addr - 0x04000100) & 3;
        if (byteOff <= 1) { // CNT_L (counter) bytes
          const ctrl = this.io[0x102 + ch * 4]; // control low byte
          if (ctrl & 0x80) { // timer enabled
            // Lazily-advanced timers: bring counters up to date before reading back.
            if (this.cycles > this.timerSyncCycles) this._flushTimers();
            const counter = Math.floor(this.timerCounters[ch]) & 0xffff;
            return byteOff === 0 ? (counter & 0xff) : ((counter >> 8) & 0xff);
          }
        }
        // Disabled timer or CNT_H: fall through to io array
      }
      // VCOUNT (0x04000006): dynamically computed from frame cycle position
      if (addr === 0x04000006) {
        return Math.floor(this.frameCycles / GBA_CYCLES_PER_SCANLINE) % GBA_TOTAL_SCANLINES;
      }
      // DISPSTAT (0x04000004): bit 0 VBlank flag (VCOUNT >= 160), bit 1 HBlank flag
      // (set from cycle 1006 of each 1232-cycle scanline), bit 2 VCount match flag.
      if (addr === 0x04000004) {
        const r = this.region(addr);
        const base = r ? r.data[r.off] : 0;
        const line = Math.floor(this.frameCycles / GBA_CYCLES_PER_SCANLINE) % GBA_TOTAL_SCANLINES;
        const inVBlank = line >= GBA_VBLANK_SCANLINE ? 1 : 0;
        const inHBlank = (this.frameCycles % GBA_CYCLES_PER_SCANLINE) >= GBA_HBLANK_CYCLE_IN_LINE ? 2 : 0;
        const vMatch = line === this.io[5] ? 4 : 0;
        return (base & ~7) | inVBlank | inHBlank | vMatch;
      }
      if (addr === 0x04000084) return this._soundCntXRead();
      if (addr === 0x04000085) return 0;
      if (addr >= 0x04000090 && addr < 0x040000a0) return this._waveRamRead(addr);
      const r = this.region(addr);
      if (!r || r.off >= r.data.length) {
        this.unmappedReads++;
        // Open bus: unmapped reads return the prefetch latch (last fetched opcode),
        // byte-laned by address; BIOS-region reads return the tracked BIOS latch.
        const latch = addr < 0x00004000 ? this.biosOpenBus : this.openBus;
        return (latch >>> ((addr & 3) << 3)) & 0xff;
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

    read32FastRam(addr) {
      addr >>>= 0;
      let data;
      let off;
      if (addr >= 0x03000000 && addr < 0x04000000) {
        data = this.iwram;
        off = (addr - 0x03000000) & 0x7fff;
      } else if (addr >= 0x02000000 && addr < 0x03000000) {
        data = this.ewram;
        off = (addr - 0x02000000) & 0x3ffff;
      } else {
        return this.read32(addr);
      }
      return (data[off] | (data[(off + 1) & (data.length - 1)] << 8) | (data[(off + 2) & (data.length - 1)] << 16) | (data[(off + 3) & (data.length - 1)] << 24)) >>> 0;
    }

    write8(addr, value) {
      addr >>>= 0;
      value &= 0xff;
      const r = this.region(addr);
      if (!r || r.id === 'rom' || r.off >= r.data.length) {
        this.unmappedWrites++;
        return;
      }
      // Track whether the ROM's ISR ever mirrors IF into the BIOS IRQ flags halfword at
      // 0x03007FF8 (any IWRAM mirror) — IntrWait HLE keys its wait condition off this.
      if (r.id === 'iwram' && (r.off === 0x7ff8 || r.off === 0x7ff9)) this.biosIrqFlagsWritten = true;
      // Track whether the ROM ever configures DISPSTAT — see dispstatWritten above.
      if (addr === 0x04000004 || addr === 0x04000005) this.dispstatWritten = true;
      // WAITCNT (0x04000204): recompute the cached ROM fetch costs when the game
      // reprograms the Game Pak wait states.
      if (addr === 0x04000204 || addr === 0x04000205) {
        r.data[r.off] = value;
        this._updateWaitstates();
      }
      // Tally writes to the PSG channel registers (Square1/2, Wave, Noise), fastMode-safe.
      // The live PSG synth below consumes the same register state when FIFO samples are
      // mixed, so this tally now doubles as a quick activity summary in diagnostics.
      if (addr >= 0x04000060 && addr < 0x04000080) {
        this.psgSampleCacheCycles = -1;
        if (!this.psgRegWrites) this.psgRegWrites = new Map();
        const name = ioName(addr & ~1);
        this.psgRegWrites.set(name, (this.psgRegWrites.get(name) || 0) + 1);
      }
      if (addr >= 0x04000090 && addr < 0x040000a0) {
        this._waveRamWrite(addr, value);
        this._logIoWrite(addr, value, 1);
        return;
      }
      // IF is write-one-to-clear. Hardware IRQ sources set these bits internally;
      // CPU-visible writes acknowledge requests instead of storing the written value.
      if (addr === 0x04000202 || addr === 0x04000203) {
        r.data[r.off] &= (~value) & 0xff;
        this._logIoWrite(addr, value, 1);
        return;
      }
      let loggedValue = value;
      // SOUNDCNT_H bits 11 and 15 reset Direct Sound FIFOs. They are pulse
      // controls, not sticky readable state.
      if (addr === 0x04000084) {
        this._setSoundMasterEnabled(!!(value & 0x80));
        value &= 0x80;
      }
      if (addr === 0x04000085) value = 0;
      if (addr === 0x04000083) {
        if (value & 0x08) this._resetSoundFifo('A');
        if (value & 0x80) this._resetSoundFifo('B');
        value &= ~0x88;
      }
      if (addr >= 0x040000a0 && addr < 0x040000a8) {
        const channel = addr < 0x040000a4 ? 'A' : 'B';
        this._pushSoundFifoByte(channel, loggedValue);
        if (channel === 'A') this.fifoFillBytesA++;
        else this.fifoFillBytesB++;
      }
      // Timer enable: detect 0→1 transition on TM0-3 CNT (low byte of 16-bit control register).
      // The enable bit is bit 7 of the LOW byte: 0x04000102, 0x04000106, 0x0400010a, 0x0400010e.
      // Check BEFORE the write so we have the old value.
      let timerEnableInit = -1;
      let dmaEnableInit = -1;
      if (addr >= 0x04000102 && addr <= 0x0400010e && ((addr - 0x04000102) & 3) === 0) {
        const ch = (addr - 0x04000102) >> 2;
        const oldEnable = r.data[r.off] & 0x80;
        if ((value & 0x80) && !oldEnable) timerEnableInit = ch;
      }
      if (addr >= IO_DMA_START && addr < IO_DMA_END) {
        const dmaOff = addr - IO_DMA_START;
        if (dmaOff % 12 === 11) {
          const ch = Math.floor(dmaOff / 12);
          const oldEnable = r.data[r.off] & 0x80;
          if ((value & 0x80) && !oldEnable) dmaEnableInit = ch;
        }
      }
      // Timer config is about to change: bring the timers up to date under the OLD
      // configuration first, so the pending un-synced span isn't re-interpreted (or
      // double-counted for a timer that only becomes enabled now) under the new one.
      if (addr >= 0x04000100 && addr < 0x04000110) this._flushTimers();
      r.data[r.off] = value;
      if (addr >= 0x04000100 && addr < 0x04000110) this._refreshTimerCache();
      this._logIoWrite(addr, loggedValue, 1);
      // PSG frequency register (SOUND1CNT_X for ch0, SOUND2CNT_H for ch1): the live frequency
      // takes effect immediately on every write, not just on Trigger — games commonly rewrite
      // just the frequency bits (no Trigger bit) to do real-time pitch bends/vibrato without
      // clicking. If we only relatched frequency at Trigger, those glides would be silently
      // dropped and the channel would just hold its last triggered pitch. bit7 (=bit15 of the
      // 16-bit register, Trigger/Initial) additionally restarts duty/envelope/volume/length/sweep.
      if (addr === 0x04000065 || addr === 0x0400006d) {
        const ch = addr === 0x04000065 ? 0 : 1;
        const st = this.psg[ch];
        const prevFreq = st.freqRaw;
        const wasEnabled = st.enabled;
        const prevTriggerCycles = st.triggerCycles;
        this._psgUpdateFreq(ch);
        const isTrigger = !!(value & 0x80);
        if (isTrigger) {
          const stats = this.psgTriggerStats[ch];
          stats.total++;
          if (wasEnabled && st.freqRaw === prevFreq) stats.sameFreq++;
          if (wasEnabled) {
            const gap = this.cycles - prevTriggerCycles;
            stats.minGapCycles = Math.min(stats.minGapCycles, gap);
            stats.sumGapCycles += gap;
            stats.gapSamples++;
          }
          this._psgTrigger(ch);
        }
        // Melodic-contour trace: actual pitch (raw + Hz) at every trigger, so we can eyeball
        // whether the sequence of notes makes musical sense or is erratic/wrong, independent
        // of envelope/timing which we've already verified separately. First 24 + last 24 per
        // channel, kept as a simple rolling window.
        if (isTrigger || st.freqRaw !== prevFreq) {
          const freqHz = Math.round(131072 / (2048 - st.freqRaw));
          const entry = { ch, freqRaw: st.freqRaw, freqHz, trigger: isTrigger, cycles: this.cycles };
          if (!this.psgFreqLog) this.psgFreqLog = [[], []];
          const log = this.psgFreqLog[ch];
          if (log.length < 24) log.push(entry);
          else { if (log.length < 48) log.push(entry); else { log.splice(24, 1); log.push(entry); } }
        }
      }
      // Wave (SOUND3CNT_X high byte, 0x75): same live-frequency + Trigger split as Square.
      if (addr === 0x04000070 && !(value & 0x80)) this.psgWave.enabled = false;
      if (addr === 0x04000075) {
        this._waveUpdateFreq();
        if (value & 0x80) this._waveTrigger();
      }
      // Noise NR43 (0x7c) live-updates the LFSR clock divider/shift/width; NR44 trigger
      // restarts envelope/length/LFSR state.
      if (addr === 0x0400007c) this._noiseUpdateControl();
      if (addr === 0x0400007d) {
        this.psgNoise.lengthEnabled = !!(this.read16(0x0400007c) & 0x4000);
        if (value & 0x80) this._noiseTrigger();
      }
      // Log writes to TM0CNT_L/H (0x04000100-0x04000103) for debugging timer misconfiguration
      if (addr >= 0x04000100 && addr <= 0x04000103 && this.timerReloadLog.length < 64) {
        const pc = this.debugPc || 0;
        const thumb = !!this.debugThumb;
        const b0 = this.read8(pc), b1 = this.read8(pc+1), b2 = this.read8(pc+2), b3 = this.read8(pc+3);
        const instrHex = thumb ? tools.hex((b1 << 8) | b0, 4) : tools.hex((b3 << 24 | b2 << 16 | b1 << 8 | b0) >>> 0);
        this.timerReloadLog.push({ addr: tools.hex(addr), value: tools.hex(value, 2), cycles: this.cycles, pc: tools.hex(pc), instrHex, thumb });
      }
      // Trigger DMA when high byte of CNT_H is written with enable bit (offset 11 in each 12-byte channel block)
      if (addr >= IO_DMA_START && addr < IO_DMA_END) {
        const dmaOff = addr - IO_DMA_START;
        if (dmaEnableInit >= 0) {
          const base = IO_DMA_START + dmaEnableInit * 12;
          const oldLatch = this.dmaSourceLatch[dmaEnableInit];
          const freshSad = this.read32(base);
          this.dmaSourceLatch[dmaEnableInit] = freshSad;
          this.dmaDestLatch[dmaEnableInit] = this.read32(base + 4);
          // Does the re-arm actually rewind the running pointer back toward SAD (a real reset),
          // or does the visible SAD register itself already sit wherever the pointer had already
          // drifted to (meaning the "reload" is a no-op and the pointer just keeps marching on)?
          if (!this.reloadEffectLog) this.reloadEffectLog = [];
          if (this.reloadEffectLog.length < 4000) {
            this.reloadEffectLog.push({
              ch: dmaEnableInit,
              cycles: this.cycles,
              oldLatch: tools.hex(oldLatch >>> 0),
              freshSad: tools.hex(freshSad >>> 0),
              rewoundBytes: (oldLatch >>> 0) - (freshSad >>> 0),
            });
          }
        }
        // Immediate DMA fires on the enable bit's 0→1 edge only — rewriting CNT_H with
        // the enable bit already set changes settings but does not retrigger on hardware.
        if (dmaEnableInit >= 0) this._maybeRunDma(dmaEnableInit);
        // Log every write that completes a DMA1/2 SAD (source addr, field offset 0-3) or
        // CNT_H high byte (offset 11, enable/control) so we can see whether the game is
        // actually re-pointing the sound FIFO DMA source each frame, independent of fastMode.
        const ch = Math.floor(dmaOff / 12);
        const field = dmaOff % 12;
        if ((ch === 1 || ch === 2) && (field === 3 || field === 11) && this.dmaSadLog.length < 16000) {
          const base = IO_DMA_START + ch * 12;
          this.dmaSadLog.push({
            ch,
            field: field === 3 ? 'sad' : 'cnth',
            value: tools.hex(field === 3 ? this.read32(base) : this.read16(base + 10), field === 3 ? 8 : 4),
            liveLatch: tools.hex(this.dmaSourceLatch[ch]),
            pc: tools.hex(this.debugPc || 0),
            cycles: this.cycles,
            reArmed: dmaEnableInit === ch,
          });
        }
      }
      // Initialize timer counter from reload on enable transition. Hardware starts
      // counting 2 cycles after the enable write; a negative phase models the delay.
      if (timerEnableInit >= 0) {
        const base = 0x04000100 + timerEnableInit * 4;
        this.timerCounters[timerEnableInit] = (this.io[base - 0x04000000] | (this.io[base - 0x04000000 + 1] << 8));
        this.timerPhases[timerEnableInit] = -2;
      }
      // Any timer-range write may have changed when the next overflow lands.
      if (addr >= 0x04000100 && addr < 0x04000110) this._recomputeTimerEvent();
    }

    write16(addr, value) {
      addr >>>= 0;
      value &= 0xffff;
      if (addr === 0x04000202) {
        this.write8(addr, value);
        this.write8((addr + 1) >>> 0, value >>> 8);
        return;
      }
      this.write8(addr, value);
      this.write8((addr + 1) >>> 0, value >>> 8);
      // DMA enable-edge triggering is handled entirely in write8 (offset 11, the CNT_H
      // high byte) — a second trigger here double-ran immediate DMAs on 16-bit writes.
    }

    write32(addr, value) {
      this.write8(addr, value);
      this.write8((addr + 1) >>> 0, value >>> 8);
      this.write8((addr + 2) >>> 0, value >>> 16);
      this.write8((addr + 3) >>> 0, value >>> 24);
    }

    write32FastRam(addr, value) {
      addr >>>= 0;
      value >>>= 0;
      let data;
      let off;
      if (addr >= 0x03000000 && addr < 0x04000000) {
        data = this.iwram;
        off = (addr - 0x03000000) & 0x7fff;
        if (off <= 0x7ffb && 0x7ff8 < off + 4) this.biosIrqFlagsWritten = true;
      } else if (addr >= 0x02000000 && addr < 0x03000000) {
        data = this.ewram;
        off = (addr - 0x02000000) & 0x3ffff;
      } else {
        this.write32(addr, value);
        return;
      }
      const mask = data.length - 1;
      data[off] = value & 0xff;
      data[(off + 1) & mask] = (value >>> 8) & 0xff;
      data[(off + 2) & mask] = (value >>> 16) & 0xff;
      data[(off + 3) & mask] = (value >>> 24) & 0xff;
    }

    // Golden Sun crash investigation: track every POP-driven read from the
    // suspect stack window too, not just writes -- an intervening pop that
    // consumes a slot without ever writing to it is invisible to the write-only
    // watch and could explain why the last logged write doesn't match what's
    // actually read at crash time.
    _noteStackCrashRead(addr, value, pc, kind) {
      addr >>>= 0;
      if (this.fastMode && !this.diagnosticProbes) return;
      if (addr >= 0x03007f00 || addr + 4 <= 0x03007e80) return;
      if (!this.stackCrashReadLog) this.stackCrashReadLog = [];
      if (this.stackCrashReadLog.length < 400) {
        this._stackCrashSeq = (this._stackCrashSeq || 0) + 1;
        this.stackCrashReadLog.push({
          seq: this._stackCrashSeq,
          vbl: this.vblankCount,
          addrHex: tools.hex(addr),
          valueHex: tools.hex(value >>> 0),
          pcHex: tools.hex(pc),
          kind,
        });
      }
    }

    noteMemoryWrite(addr, value, bytes, source = {}) {
      addr >>>= 0;
      value >>>= 0;
      // In streaming playback this hook is otherwise pure diagnostics, and it sits in
      // the IRQ mixer's hottest block-store path. Keep only the BIOS IRQ flag side
      // effect that IntrWait/VBlankIntrWait semantics depend on.
      if (this.fastMode && !this.diagnosticProbes) {
        if (addr <= 0x03007ffa && 0x03007ff8 < addr + bytes) this.biosIrqFlagsWritten = true;
        return;
      }
      const r = this.region(addr);
      if (!r || r.id === 'io' || r.id === 'rom') return;
      const entry = {
        addr,
        addrHex: tools.hex(addr),
        value,
        valueHex: tools.hex(value, bytes * 2),
        bytes,
        region: r.id,
        cycles: this.cycles,
        ...source,
      };
      if (addr >= 0x03007ff8 && addr <= 0x03007ffc) {
        this.irqVectorWrites.push(entry);
        if (this.irqVectorWrites.length > 32) this.irqVectorWrites.shift();
      }
      // Watch every write that touches the resolved [sp+0x14] address the mixer-entry gate
      // reads (see _spWatchAddr above) — this stack slot is stuck at 0x3C after VBL 1 despite
      // being 0xDE on VBL 1, so something else must be writing it in between.
      if (this._spWatchAddr && addr <= this._spWatchAddr && this._spWatchAddr < addr + bytes) {
        if (!this.spWatchLog) this.spWatchLog = [];
        const log = this.spWatchLog;
        if (log.length < 300) log.push({ vbl: this.vblankCount, ...entry });
      }
      // Same idea for the r2 operand feeding that stack slot: it's 0xa2 on VBL 1 but reads back
      // 0x00000000 forever after via LDRB [literal-pool-pointer]. Watch every write to that
      // resolved address to find what zeroes it.
      if (this._literalWatchAddr && addr <= this._literalWatchAddr && this._literalWatchAddr < addr + bytes) {
        if (!this.literalWatchLog) this.literalWatchLog = [];
        const log = this.literalWatchLog;
        if (log.length < 300) log.push({ vbl: this.vblankCount, ...entry });
      }
      // Golden Sun (modified-mp2k) crash investigation: a POP{R0};BX R0 at
      // 0x081c1fe0 reads 0 off the stack at 0x03007eec instead of a real function
      // pointer. Watch every write in that stack window to see what (if anything)
      // ever wrote a real value there, and what last touched it before the crash.
      if (addr < 0x03007f00 && addr + bytes > 0x03007e80) {
        if (!this.stackCrashWatchLog) this.stackCrashWatchLog = [];
        if (this.stackCrashWatchLog.length < 400) {
          this._stackCrashSeq = (this._stackCrashSeq || 0) + 1;
          this.stackCrashWatchLog.push({ seq: this._stackCrashSeq, vbl: this.vblankCount, ...entry });
        }
      }
      const canonicalAddr = this.canonicalAddr(addr);
      if (addr >= 0x03007100 && addr < 0x03007180 && this.mplInitWrites.length < 256) {
        this.mplInitWrites.push({ a: tools.hex(addr), v: tools.hex(value), k: source.kind, pc: source.pc !== undefined ? tools.hex(source.pc) : '?' });
      }
      // Track write provenance for ALL of EWRAM + IWRAM. The old 0x4000-0x8000 EWRAM
      // window was tuned to one engine's buffer placement; Golden Sun's ring lives at
      // EWRAM 0x3520-0x3B4F and showed up as 100% "never written" in staleness traces.
      if (r.id === 'ewram' || r.id === 'iwram') {
        this.soundBufferWriteMap.set(canonicalAddr & ~3, entry);
        if (entry.value !== 0 || this.soundBufferWrites.length < 8) {
          this.soundBufferWrites.push(entry);
          if (this.soundBufferWrites.length > 64) this.soundBufferWrites.shift();
        }
      }
      if (this.fastMode) return;
      this.memoryWrites.push(entry);
      if (this.memoryWrites.length > 256) this.memoryWrites.shift();
      if (bytes === 4) this.wordWrites.set(addr & ~3, entry);
    }

    lastWordWrite(addr) {
      return this.wordWrites.get((addr >>> 0) & ~3) || null;
    }

    timerReload(ch) {
      return this.timerReloads[ch] & 0xffff;
    }

    _refreshTimerCache() {
      let enabledMask = 0;
      let cpuMask = 0;
      for (let ch = 0; ch < 4; ch++) {
        const base = 0x100 + ch * 4;
        const ctrl = (this.io[base + 2] | (this.io[base + 3] << 8)) & 0xffff;
        this.timerControls[ch] = ctrl;
        this.timerReloads[ch] = (this.io[base] | (this.io[base + 1] << 8)) & 0xffff;
        if (ctrl & 0x80) {
          enabledMask |= 1 << ch;
          if (!(ch > 0 && (ctrl & 0x04))) cpuMask |= 1 << ch;
        } else {
          this.timerPhases[ch] = 0;
        }
      }
      this.timerEnabledMask = enabledMask;
      this.timerCpuMask = cpuMask;
    }

    stepCycles(cycles) {
      cycles = Math.max(1, cycles | 0);
      this.cycles += cycles;
      this.frameCycles += cycles;
      if (this.cycles >= this.nextTimerEventCycles) this._syncTimers();
      this._processScanlineEvents(this.frameCycles - cycles, this.frameCycles);
      // The VBlank IRQ fires when the scanline counter enters the VBlank region
      // (scanline 160), not at the full-frame wrap (scanline 0/227->0). Firing it at
      // the wrap made VCOUNT read back ~0 inside every VBlank IRQ handler after the
      // first (instead of ~160), since frameCycles had just been reset right before
      // the handler's own instructions started accumulating cycles again.
      if (!this._vblankFiredThisFrame && this.frameCycles >= GBA_VBLANK_CYCLE) {
        this._vblankFiredThisFrame = true;
        this._enterVBlank();
      }
      while (this.frameCycles >= GBA_CYCLES_PER_FRAME) {
        this.frameCycles -= GBA_CYCLES_PER_FRAME;
        this._vblankFiredThisFrame = false;
      }
    }

    stepCyclesFast(cycles) {
      cycles = Math.max(1, cycles | 0);
      const from = this.frameCycles;
      const to = from + cycles;
      this.cycles += cycles;
      if (this.cycles >= this.nextTimerEventCycles) this._syncTimers();

      if (to < GBA_CYCLES_PER_FRAME) {
        const lineStart = Math.floor(from / GBA_CYCLES_PER_SCANLINE) * GBA_CYCLES_PER_SCANLINE;
        const hblankAt = lineStart + GBA_HBLANK_CYCLE_IN_LINE;
        const nextLine = lineStart + GBA_CYCLES_PER_SCANLINE;
        const crossesHBlank = from < hblankAt && hblankAt <= to;
        const crossesLine = from < nextLine && nextLine <= to;
        const crossesVBlank = !this._vblankFiredThisFrame && from < GBA_VBLANK_CYCLE && GBA_VBLANK_CYCLE <= to;
        if (!crossesHBlank && !crossesLine && !crossesVBlank) {
          this.frameCycles = to;
          return;
        }
      }

      this.frameCycles = to;
      this._processScanlineEvents(from, to);
      if (!this._vblankFiredThisFrame && this.frameCycles >= GBA_VBLANK_CYCLE) {
        this._vblankFiredThisFrame = true;
        this._enterVBlank();
      }
      while (this.frameCycles >= GBA_CYCLES_PER_FRAME) {
        this.frameCycles -= GBA_CYCLES_PER_FRAME;
        this._vblankFiredThisFrame = false;
      }
    }

    // Derive per-region ROM fetch costs from WAITCNT's sequential-wait bits. Thumb
    // fetch = one 16-bit access (1+s cycles); ARM fetch = two (1+2s). WS0 s-wait:
    // bit4 (0=2, 1=1); WS1: bit7 (0=4, 1=1); WS2: bit10 (0=8, 1=1). Games that program
    // the typical 3,1 + prefetch setup get Thumb ROM code at 2 cycles/instruction.
    _updateWaitstates() {
      const w = this.io[0x204] | (this.io[0x205] << 8);
      const sWaits = [
        (w & 0x0010) ? 1 : 2,
        (w & 0x0080) ? 1 : 4,
        (w & 0x0400) ? 1 : 8,
      ];
      for (let i = 0; i < 3; i++) {
        this.romCostThumb[i] = 1 + sWaits[i];
        this.romCostArm[i] = 1 + 2 * sWaits[i];
      }
    }

    // Walk every scanline-boundary and HBlank point crossed in (from, to] and fire the
    // associated hardware events: HBlank DMA (visible lines only), HBlank IRQ, and
    // VCount-match IRQ. Large steps (Halt slices) cross many boundaries; per-instruction
    // steps cross at most one, so the loop body almost never runs.
    _processScanlineEvents(from, to) {
      let line = Math.floor(from / GBA_CYCLES_PER_SCANLINE);
      while (true) {
        const lineStart = line * GBA_CYCLES_PER_SCANLINE;
        const hblankAt = lineStart + GBA_HBLANK_CYCLE_IN_LINE;
        if (from < hblankAt) {
          if (hblankAt > to) break;
          this._enterHBlank(line % GBA_TOTAL_SCANLINES);
        }
        const nextLineStart = lineStart + GBA_CYCLES_PER_SCANLINE;
        if (nextLineStart > to) break;
        this._enterScanline((line + 1) % GBA_TOTAL_SCANLINES);
        line++;
      }
    }

    _enterHBlank(line) {
      // DISPSTAT bit 4: HBlank IRQ enable (fires on every line, including VBlank).
      if (this.io[4] & 0x10) this.requestIrq(0x0002, 'hblank');
      // HBlank-timed DMA (start timing 2) triggers on visible scanlines only.
      if (line < GBA_VBLANK_SCANLINE) this._runTimedDma(2, 'hblank');
    }

    _enterScanline(line) {
      // DISPSTAT bit 5: VCount-match IRQ enable; the target line is DISPSTAT's high byte.
      if ((this.io[4] & 0x20) && line === this.io[5]) this.requestIrq(0x0004, 'vcount');
    }

    // Run every enabled DMA channel armed with the given start timing (1 = VBlank,
    // 2 = HBlank). Timing 3 (sound FIFO on ch1/2) has its own dedicated path.
    _runTimedDma(timing, reason) {
      for (let ch = 0; ch < 4; ch++) {
        const base = IO_DMA_START + ch * 12;
        const ctrl = (this.io[base - 0x04000000 + 10] | (this.io[base - 0x04000000 + 11] << 8));
        if (!(ctrl & 0x8000)) continue;
        if (((ctrl >>> 12) & 3) !== timing) continue;
        this._runDma(ch, reason);
      }
    }

    // Advance all CPU-clocked timers by the span since the last sync, then compute the
    // absolute cycle of the earliest possible next overflow. stepCycles compares one
    // number against nextTimerEventCycles on the hot path instead of walking the timer
    // state per instruction — with a 21kHz FIFO timer that's one real sync every ~800
    // cycles instead of per-instruction bookkeeping.
    _syncTimers() {
      this._flushTimers();
      this._recomputeTimerEvent();
    }

    _flushTimers() {
      const delta = this.cycles - this.timerSyncCycles;
      if (delta > 0) this._tickTimersFast(delta);
      this.timerSyncCycles = this.cycles;
    }

    _recomputeTimerEvent() {
      let min = Infinity;
      for (let mask = this.timerCpuMask; mask; mask &= mask - 1) {
        const bit = mask & -mask;
        const ch = bit === 1 ? 0 : bit === 2 ? 1 : bit === 4 ? 2 : 3;
        const prescaler = TIMER_PRESCALERS[this.timerControls[ch] & 3];
        // Cycles until this timer's next overflow: remaining counter ticks at its
        // prescaler, minus already-accumulated phase (negative phase = start delay).
        const remaining = (0x10000 - this.timerCounters[ch]) * prescaler - this.timerPhases[ch];
        if (remaining < min) min = remaining;
      }
      this.nextTimerEventCycles = min === Infinity ? Infinity : this.timerSyncCycles + Math.max(1, min);
    }

    _tickTimersFast(cycles) {
      let mask = this.timerCpuMask;
      if (!mask) return;
      while (mask) {
        const bit = mask & -mask;
        const ch = bit === 1 ? 0 : bit === 2 ? 1 : bit === 4 ? 2 : 3;
        mask &= mask - 1;
        const ctrl = this.timerControls[ch];
        const prescaler = TIMER_PRESCALERS[ctrl & 3];
        let phase = this.timerPhases[ch] + cycles;
        if (phase < 0) {
          this.timerPhases[ch] = phase;
          continue;
        }
        let ticks;
        if (prescaler === 1) {
          ticks = phase;
          phase = 0;
        } else {
          ticks = Math.floor(phase / prescaler);
          phase -= ticks * prescaler;
        }
        this.timerPhases[ch] = phase;
        if (ticks <= 0) continue;
        let counter = this.timerCounters[ch];
        const reload = this.timerReloads[ch];
        while (ticks > 0) {
          const space = 0x10000 - counter;
          if (ticks < space) {
            this.timerCounters[ch] = counter + ticks;
            break;
          }
          ticks -= space;
          counter = reload;
          this.timerCounters[ch] = counter;
          this._timerOverflow(ch, ctrl);
        }
      }
    }

    _timerOverflow(ch, ctrl) {
      // Cascade: tick next timer by 1
      if (ch < 3) {
        const nCtrl = this.timerControls[ch + 1];
        if ((nCtrl & 0x80) && (nCtrl & 0x04)) {
          const nReload = this.timerReloads[ch + 1];
          this.timerCounters[ch + 1]++;
          if (this.timerCounters[ch + 1] >= 0x10000) {
            this.timerCounters[ch + 1] = nReload;
            this._timerOverflow(ch + 1, nCtrl);
          }
        }
      }
      // Timer IRQ
      if (ctrl & 0x40) this.requestIrq(1 << (3 + ch), `timer${ch}-overflow`);
      // Sound FIFO DMA: timers 0 and 1 consume Direct Sound bytes and request
      // DMA refills when the emulated FIFO drops to half-full.
      if (ch <= 1) this._consumeSoundFifo(ch);
    }

    _consumeSoundFifo(timerCh) {
      const soundCntH = (this.io[0x82] | (this.io[0x83] << 8));
      const timerSelA = (soundCntH >>> 10) & 1;
      const timerSelB = (soundCntH >>> 14) & 1;
      if (timerSelA === timerCh) this._consumeFifoChannel('A');
      if (timerSelB === timerCh) this._consumeFifoChannel('B');
    }

    _fifoLength(channel) {
      return channel === 'A' ? this.fifoLenA : this.fifoLenB;
    }

    _fifoPush(channel, value) {
      if (channel === 'A') {
        if (this.fifoLenA >= 32) return false;
        this.fifoQueueA[(this.fifoHeadA + this.fifoLenA) & 31] = value;
        this.fifoLenA++;
        return true;
      }
      if (this.fifoLenB >= 32) return false;
      this.fifoQueueB[(this.fifoHeadB + this.fifoLenB) & 31] = value;
      this.fifoLenB++;
      return true;
    }

    _fifoShift(channel) {
      if (channel === 'A') {
        if (!this.fifoLenA) return null;
        const value = this.fifoQueueA[this.fifoHeadA] || 0;
        this.fifoHeadA = (this.fifoHeadA + 1) & 31;
        this.fifoLenA--;
        return value;
      }
      if (!this.fifoLenB) return null;
      const value = this.fifoQueueB[this.fifoHeadB] || 0;
      this.fifoHeadB = (this.fifoHeadB + 1) & 31;
      this.fifoLenB--;
      return value;
    }

    _fifoMetaPush(channel, meta) {
      const metaQueue = channel === 'A' ? this.fifoQueueMetaA : this.fifoQueueMetaB;
      const head = channel === 'A' ? this.fifoMetaHeadA : this.fifoMetaHeadB;
      const len = this._fifoLength(channel);
      metaQueue[(head + len - 1) & 31] = meta;
    }

    _fifoMetaShift(channel) {
      const metaQueue = channel === 'A' ? this.fifoQueueMetaA : this.fifoQueueMetaB;
      if (channel === 'A') {
        const value = metaQueue[this.fifoMetaHeadA] || null;
        this.fifoMetaHeadA = (this.fifoMetaHeadA + 1) & 31;
        return value;
      }
      const value = metaQueue[this.fifoMetaHeadB] || null;
      this.fifoMetaHeadB = (this.fifoMetaHeadB + 1) & 31;
      return value;
    }

    _consumeFifoChannel(channel) {
      const collectTrace = !this.fastMode || this.diagnosticProbes;
      const wasEmpty = this._fifoLength(channel) === 0;
      // Underruns repeat the previous byte: each one time-stretches the waveform by a
      // sample (pitch flat + warble when frequent). fastMode-safe cheap tally.
      if (wasEmpty) {
        if (channel === 'A') this.fifoUnderrunsA = (this.fifoUnderrunsA || 0) + 1;
        else this.fifoUnderrunsB = (this.fifoUnderrunsB || 0) + 1;
      }
      const shifted = wasEmpty ? null : this._fifoShift(channel);
      const value = shifted == null ? (channel === 'A' ? this.fifoLastA : this.fifoLastB) : shifted;
      const meta = (collectTrace && !wasEmpty) ? this._fifoMetaShift(channel) : null;
      const mixed = this._mixPsgInto(channel, value);
      if (channel === 'A') {
        this.fifoLastA = value;
        this.fifoSamplesA.push(mixed);
        if (collectTrace) {
          this.dsOnlySamplesA.push(value);
          this.dmaSrcTraceA.push(this._sampleTrace(meta, wasEmpty));
        }
      } else {
        this.fifoLastB = value;
        this.fifoSamplesB.push(mixed);
        if (collectTrace) {
          this.dsOnlySamplesB.push(value);
          this.dmaSrcTraceB.push(this._sampleTrace(meta, wasEmpty));
        }
      }
      // Hardware is level-triggered: on each timer overflow, if the FIFO holds 16 bytes
      // or fewer and a special-timing DMA is armed, it transfers 16 more. The previous
      // edge-triggered heuristic dropped requests that landed while the game had the DMA
      // momentarily disabled for a re-arm, leaving the FIFO to underrun before refills
      // resumed — an audible click backed by a stale repeated byte.
      if (this._fifoLength(channel) <= 16) this._requestSoundFifoDma(channel);
    }

    _sampleTrace(meta, wasEmpty) {
      return {
        addr: meta ? meta.addr : null,
        writeInfo: meta ? meta.writeInfo : (wasEmpty ? 'underrun-repeat' : '-'),
        readCycles: meta ? meta.readCycles : null,
        consumeCycles: this.cycles,
        lagCycles: meta ? this.cycles - meta.readCycles : null,
        writeCycles: meta ? meta.writeCycles : null,
        staleCycles: (meta && meta.writeCycles != null) ? meta.readCycles - meta.writeCycles : null,
      };
    }

    _soundCntXRead() {
      this._clockPsgFrameSequencer(this.cycles);
      return (this.io[0x84] & 0x80)
        | (this.psg[0]?.enabled ? 0x01 : 0)
        | (this.psg[1]?.enabled ? 0x02 : 0)
        | (this.psgWave?.enabled ? 0x04 : 0)
        | (this.psgNoise?.enabled ? 0x08 : 0);
    }

    _setSoundMasterEnabled(enabled) {
      const wasEnabled = !!(this.io[0x84] & 0x80);
      this.io[0x84] = enabled ? 0x80 : 0;
      this.psgSampleCacheCycles = -1;
      if (enabled || !wasEnabled) return;
      this.io.fill(0, 0x60, 0x84);
      for (const st of this.psg) {
        st.enabled = false;
        st.envActive = false;
        st.sweepEnabled = false;
        st.volume = 0;
        st.lengthCounter = 0;
      }
      this.psgWave.enabled = false;
      this.psgWave.lengthCounter = 0;
      this.psgNoise.enabled = false;
      this.psgNoise.envActive = false;
      this.psgNoise.volume = 0;
      this.psgNoise.lengthCounter = 0;
    }

    // Live PSG frequency/length-enable update: called on EVERY write to SOUND1CNT_X (ch0) or
    // SOUND2CNT_H (ch1), regardless of the Trigger bit. On real hardware the frequency
    // register feeds the channel's timer reload continuously — a write without Trigger takes
    // effect immediately as a pitch bend, it doesn't just get cached for the next note.
    _psgUpdateFreq(ch) {
      const st = this.psg[ch];
      const freqReg = ch === 0 ? this.read16(0x04000064) : this.read16(0x0400006c);
      st.freqRaw = freqReg & 0x7ff;
      st.freqCur = st.freqRaw;
      st.lengthEnabled = !!(freqReg & 0x4000);
      if (!st.lengthEnabled && st.lengthCounter <= 0) st.lengthCounter = 64;
    }

    // PSG trigger ("Initial"/restart): relatch duty/envelope/volume, length, and (Square1
    // only) sweep from the channel's control registers, and reset phase. Called when the high
    // byte of SOUND1CNT_X (ch 0) or SOUND2CNT_H (ch 1) is written with the trigger bit set —
    // frequency itself is already current via _psgUpdateFreq, called unconditionally above.
    _psgTrigger(ch) {
      const st = this.psg[ch];
      const envReg = ch === 0 ? this.read16(0x04000062) : this.read16(0x04000068);
      let triggerEnabled = true;
      const dutyBits = (envReg >>> 6) & 3;
      st.dutyFraction = [0.125, 0.25, 0.5, 0.75][dutyBits];
      st.dutyStep = [1, 2, 4, 6][dutyBits];
      st.volInit = (envReg >>> 12) & 0xf;
      st.volume = st.volInit;
      if (st.volInit === 0) triggerEnabled = false;
      st.envDir = (envReg >>> 11) & 1; // 0=decrease, 1=increase
      st.envStep = (envReg >>> 8) & 7;
      st.envStepsApplied = 0;
      st.envTimer = st.envStep || 8;
      st.envActive = st.envStep > 0;
      const lengthData = envReg & 0x3f;
      st.lengthCounter = 64 - lengthData;
      st.lengthCyclesTotal = st.lengthEnabled ? (64 - lengthData) * (GBA_CPU_HZ / 256) : Infinity;
      if (ch === 0) {
        const sweepReg = this.read16(0x04000060);
        st.sweepShift = sweepReg & 7;
        st.sweepDir = (sweepReg >>> 3) & 1; // 0=increase, 1=decrease
        st.sweepPeriod = (sweepReg >>> 4) & 7;
        st.sweepStepsApplied = 0;
        st.sweepTimer = st.sweepPeriod || 8;
        st.sweepShadow = st.freqCur;
        st.sweepEnabled = !!(st.sweepPeriod || st.sweepShift);
        if (st.sweepShift && this._psgSweepCalc(st, false) > 2047) triggerEnabled = false;
      }
      // Real hardware does NOT reset a pulse channel's duty-cycle position on Trigger if the
      // channel is already playing — only the frequency-timer reload, envelope, and volume
      // reset (this is the opposite of Wave, whose position genuinely resets to 0, and Noise,
      // whose LFSR genuinely resets to all-1s — both handled separately, correctly, below).
      // Sappy-derived engines commonly re-poke Trigger every few frames on an already-sounding
      // note just to keep it from decaying, without meaning to restart the wave; unconditionally
      // resetting phase here produced an audible click/warble on every one of those re-pokes.
      if (!st.enabled) st.phase = 0;
      st.triggerCycles = this.cycles;
      st.lastSampleCycles = this.cycles;
      st.enabled = triggerEnabled;
    }

    _clockPsgLength(st) {
      if (!st || !st.enabled || !st.lengthEnabled || !(st.lengthCounter > 0)) return;
      st.lengthCounter--;
      if (st.lengthCounter <= 0) st.enabled = false;
    }

    _clockPsgEnvelope(st) {
      if (!st || !st.enabled || !st.envActive || !(st.envStep > 0)) return;
      st.envTimer--;
      if (st.envTimer > 0) return;
      st.envTimer = st.envStep || 8;
      const next = st.volume + (st.envDir ? 1 : -1);
      if (next >= 0 && next <= 15) {
        st.volume = next;
        st.envStepsApplied++;
      } else {
        st.envActive = false;
      }
    }

    _psgSweepCalc(st, commit) {
      const delta = st.sweepShadow >> st.sweepShift;
      const next = st.sweepDir ? (st.sweepShadow - delta) : (st.sweepShadow + delta);
      if (next > 2047 || next < 0) {
        if (commit) st.enabled = false;
        return next;
      }
      if (commit && st.sweepShift > 0) {
        st.sweepShadow = next;
        st.freqCur = next;
        st.freqRaw = next;
      }
      return next;
    }

    _clockPsgSweep() {
      const st = this.psg[0];
      if (!st?.enabled || !st.sweepEnabled) return;
      st.sweepTimer--;
      if (st.sweepTimer > 0) return;
      st.sweepTimer = st.sweepPeriod || 8;
      st.sweepStepsApplied++;
      if (st.sweepPeriod > 0) {
        const next = this._psgSweepCalc(st, true);
        if (st.enabled && st.sweepShift > 0 && next <= 2047 && this._psgSweepCalc(st, false) > 2047) {
          st.enabled = false;
        }
      }
    }

    _clockPsgFrameSequencer(nowCycles) {
      if (nowCycles < this.psgFrameSeqCycles) this.psgFrameSeqCycles = nowCycles;
      while (this.psgFrameSeqCycles + PSG_FRAME_SEQ_CYCLES <= nowCycles) {
        this.psgFrameSeqCycles += PSG_FRAME_SEQ_CYCLES;
        const step = this.psgFrameSeqStep & 7;
        if ((step & 1) === 0) {
          this._clockPsgLength(this.psg[0]);
          this._clockPsgLength(this.psg[1]);
          this._clockPsgLength(this.psgWave);
          this._clockPsgLength(this.psgNoise);
        }
        if (step === 2 || step === 6) this._clockPsgSweep();
        if (step === 7) {
          this._clockPsgEnvelope(this.psg[0]);
          this._clockPsgEnvelope(this.psg[1]);
          this._clockPsgEnvelope(this.psgNoise);
        }
        this.psgFrameSeqStep = (this.psgFrameSeqStep + 1) & 7;
      }
    }

    _waveUpdateFreq() {
      const st = this.psgWave;
      const freqReg = this.read16(0x04000074);
      st.freqRaw = freqReg & 0x7ff;
      st.freqCur = st.freqRaw;
      st.lengthEnabled = !!(freqReg & 0x4000);
      if (!st.lengthEnabled && st.lengthCounter <= 0) st.lengthCounter = 256;
    }

    _wavePlaybackBank() {
      return (this.read8(0x04000070) & 0x40) ? 1 : 0;
    }

    _waveAccessBank() {
      return this._wavePlaybackBank() ^ 1;
    }

    _waveRamRead(addr) {
      const off = (addr - 0x04000090) & 0xf;
      return this.waveRam[this._waveAccessBank() * 16 + off] || 0;
    }

    _waveRamWrite(addr, value) {
      const off = (addr - 0x04000090) & 0xf;
      this.waveRam[this._waveAccessBank() * 16 + off] = value & 0xff;
      this.io[addr - 0x04000000] = value & 0xff;
      this.psgSampleCacheCycles = -1;
    }

    _wavePlaybackLength() {
      return (this.read8(0x04000070) & 0x20) ? 64 : 32;
    }

    _waveTrigger() {
      const st = this.psgWave;
      const cntL = this.read8(0x04000070);
      const cntH = this.read16(0x04000072);
      // NR30 bit7: DAC power. If off, the channel produces no output regardless of Trigger.
      const dacOn = !!(cntL & 0x80);
      const levelBits = (cntH >>> 13) & 3;
      st.outputLevel = [0, 1, 0.5, 0.25][levelBits];
      st.forceVolume = !!(cntH & 0x8000);
      const lengthData = cntH & 0xff;
      st.lengthCounter = 256 - lengthData;
      st.lengthCyclesTotal = st.lengthEnabled ? (256 - lengthData) * (GBA_CPU_HZ / 256) : Infinity;
      st.phase = 0;
      st.triggerCycles = this.cycles;
      st.lastSampleCycles = this.cycles;
      st.enabled = dacOn;
    }

    // Wave RAM is two 32-digit banks (16 packed bytes each), MSB-first per byte. In 32-digit
    // mode the selected bank loops; in 64-digit mode playback starts at the selected bank and
    // continues through the other bank. CPU reads/writes address the non-selected bank.
    _waveSample(index) {
      const len = this._wavePlaybackLength();
      const sample = ((index % len) + len) % len;
      const baseBank = this._wavePlaybackBank();
      const bank = len === 64 && sample >= 32 ? (baseBank ^ 1) : baseBank;
      const bankIndex = sample & 31;
      const byte = this.waveRam[bank * 16 + (bankIndex >>> 1)] || 0;
      const nibble = (index & 1) === 0 ? (byte >>> 4) & 0xf : byte & 0xf;
      return nibble - 8; // center to roughly -8..7
    }

    _waveAdvance(nowCycles) {
      const st = this.psgWave;
      if (!st.enabled) return 0;
      const digitRate = 2097152 / (2048 - st.freqCur);
      const waveLength = this._wavePlaybackLength();
      const dtCycles = nowCycles - st.lastSampleCycles;
      st.lastSampleCycles = nowCycles;
      const level = st.forceVolume ? 0.75 : st.outputLevel;
      if (!(dtCycles > 0)) return this._waveSample(Math.floor(st.phase) % waveLength) * level;
      const digitPeriodCycles = GBA_CPU_HZ / digitRate;
      const phaseStart = st.phase;
      const phaseInc = dtCycles / digitPeriodCycles;
      const raw = this._waveAreaAverage(phaseStart, phaseInc, waveLength);
      st.phase = ((phaseStart + phaseInc) % waveLength + waveLength) % waveLength;
      return raw * level;
    }

    _waveAreaAverage(start, len, waveLength) {
      if (!(len > 0)) return this._waveSample(Math.floor(start) % waveLength);
      let pos = ((start % waveLength) + waveLength) % waveLength;
      let remaining = len;
      let weighted = 0;
      let segments = 0;
      while (remaining > 1e-9 && segments++ < 4096) {
        const nextBoundary = Math.floor(pos) + 1;
        const span = Math.min(remaining, nextBoundary - pos || 1);
        weighted += this._waveSample(Math.floor(pos) % waveLength) * span;
        remaining -= span;
        pos = (pos + span) % waveLength;
      }
      if (remaining > 1e-9) weighted += this._waveSample(Math.floor(pos) % waveLength) * remaining;
      return weighted / len;
    }

    _noiseTrigger() {
      const st = this.psgNoise;
      const envReg = this.read16(0x04000078);
      const freqReg = this.read16(0x0400007c);
      const prevTriggerCycles = st.triggerCycles;
      const wasEnabled = st.enabled;
      st.volInit = (envReg >>> 12) & 0xf;
      st.volume = st.volInit;
      const triggerEnabled = st.volInit > 0;
      st.envDir = (envReg >>> 11) & 1;
      st.envStep = (envReg >>> 8) & 7;
      st.envStepsApplied = 0;
      st.envTimer = st.envStep || 8;
      st.envActive = st.envStep > 0;
      st.lengthEnabled = !!(freqReg & 0x4000);
      const lengthData = envReg & 0x3f;
      st.lengthCounter = 64 - lengthData;
      st.lengthCyclesTotal = st.lengthEnabled ? (64 - lengthData) * (GBA_CPU_HZ / 256) : Infinity;
      this._noiseUpdateControl(freqReg);
      st.lfsr = 0x7fff;
      st.phaseCycles = 0;
      st.triggerCycles = this.cycles;
      st.lastSampleCycles = this.cycles;
      st.enabled = triggerEnabled;
      // Trigger log: unlike Square's phase, Noise's LFSR IS reset to the same seed on every
      // trigger per real hardware. If this channel is retriggered very frequently (like
      // Sappy's sustain-via-retrigger pattern seen on Square), the LFSR would keep replaying
      // the same short pseudo-random sequence from scratch each time instead of running freely
      // — turning broadband noise into an audible repeating buzz/tone. Log gap + settings per
      // trigger so we can see whether that's actually happening here.
      const gapCycles = wasEnabled ? this.cycles - prevTriggerCycles : null;
      const entry = { volInit: st.volInit, div: st.divRatio, width: st.widthMode, shift: st.shiftFreq, gapMs: gapCycles !== null ? Math.round((gapCycles / GBA_CPU_HZ) * 1000) : null, cycles: this.cycles };
      if (!this.noiseTriggerLog) this.noiseTriggerLog = [];
      const n = ++this._noiseTriggerCount;
      if (n <= 8) this.noiseTriggerLog.push(entry);
      else { if (this.noiseTriggerLog.length < 16) this.noiseTriggerLog.push(entry); else { this.noiseTriggerLog.splice(8, 1); this.noiseTriggerLog.push(entry); } }
    }

    _noiseUpdateControl(freqReg = this.read16(0x0400007c)) {
      const st = this.psgNoise;
      st.divRatio = freqReg & 7;
      st.widthMode = (freqReg >>> 3) & 1; // 0=15-bit, 1=7-bit
      st.shiftFreq = (freqReg >>> 4) & 0xf;
      // GBATEK: frequency = 524288 / r / 2^(s+1), with r=0 treated as 0.5.
      // In CPU cycles this is exactly 64*r*2^s, or 32*2^s for r=0.
      st.periodCycles = (st.divRatio ? 64 * st.divRatio : 32) * Math.pow(2, st.shiftFreq);
      this.psgSampleCacheCycles = -1;
    }

    _noiseAdvance(nowCycles) {
      const st = this.psgNoise;
      if (!st.enabled) return 0;
      const dCycles = nowCycles - st.lastSampleCycles;
      st.lastSampleCycles = nowCycles;
      if (!(dCycles > 0)) return this._noiseOutput(st);
      // Shift periods are integer CPU-cycle counts. Cap iterations defensively so a huge
      // dt (e.g. after a long halt) cannot spin here for an unbounded amount of work.
      const period = Math.max(1, st.periodCycles || 32);
      let remaining = dCycles;
      let weighted = 0;
      let segments = 0;
      while (remaining > 0 && segments++ < 4096) {
        const untilShift = Math.max(0, period - st.phaseCycles);
        const span = Math.min(remaining, untilShift || period);
        weighted += this._noiseOutput(st) * span;
        st.phaseCycles += span;
        remaining -= span;
        if (st.phaseCycles >= period) {
          st.phaseCycles -= period;
          this._noiseShift(st);
        }
      }
      if (remaining > 0) weighted += this._noiseOutput(st) * remaining;
      return weighted / dCycles;
    }

    _noiseOutput(st) {
      return (st.lfsr & 1) ? -st.volume : st.volume;
    }

    _noiseShift(st) {
      // GB/CGB noise uses xor feedback from bits 0 and 1, shifts right, writes feedback to
      // bit14, and mirrors it into bit6 in 7-bit mode. The DAC output is the inverted low bit.
      const feedback = (st.lfsr ^ (st.lfsr >>> 1)) & 1;
      st.lfsr = (st.lfsr >>> 1) | (feedback << 14);
      if (st.widthMode) st.lfsr = (st.lfsr & ~0x40) | (feedback << 6);
    }

    // Advance envelope/length/(ch0)sweep timing to `nowCycles` and return this channel's
    // current waveform sample. Idempotent w.r.t. nowCycles, so it's safe to call once per
    // stereo output channel even if both land on the same cycle.
    _psgAdvance(ch, nowCycles) {
      const st = this.psg[ch];
      if (!st.enabled) return 0;
      const stepRate = 1048576 / (2048 - st.freqCur);
      const dt = (nowCycles - st.lastSampleCycles) / GBA_CPU_HZ;
      st.lastSampleCycles = nowCycles;
      const stepStart = st.phase;
      const stepInc = stepRate * dt;
      st.phase = ((stepStart + stepInc) % 8 + 8) % 8;
      // Average the 8-step hardware duty sequencer over this output sample. The old normalized
      // cycle oscillator had the right nominal pitch, but expressing this as a 1048576Hz-derived
      // step clock matches GB/GBA square-channel timing and makes duty/sweep edge cases clearer.
      const fractionHigh = this._squareStepAreaHigh(stepStart, stepInc, st.dutyStep);
      return st.volume * (2 * fractionHigh - 1);
    }

    // Fraction of the interval [start, start+len) (wrapping mod 8) spent in the high duty steps.
    _squareStepAreaHigh(start, len, highSteps) {
      highSteps = Math.max(0, Math.min(8, highSteps | 0));
      if (len <= 0) return (((start % 8) + 8) % 8) < highSteps ? 1 : 0;
      if (len >= 8) return highSteps / 8;
      const s = ((start % 8) + 8) % 8;
      const end = s + len;
      const segments = end <= 8 ? [[s, end]] : [[s, 8], [0, end - 8]];
      let highTime = 0;
      for (const [a, b] of segments) highTime += Math.max(0, Math.min(b, highSteps) - a);
      return highTime / len;
    }

    _psgOutputsAt(nowCycles) {
      if (this.psgSampleCacheCycles === nowCycles) return this.psgSampleCache;
      this._clockPsgFrameSequencer(nowCycles);
      const out = this.psgSampleCache || [0, 0, 0, 0];
      out[0] = this._psgAdvance(0, nowCycles);
      out[1] = this._psgAdvance(1, nowCycles);
      out[2] = this._waveAdvance(nowCycles);
      out[3] = this._noiseAdvance(nowCycles);
      this.psgSampleCache = out;
      this.psgSampleCacheCycles = nowCycles;
      return out;
    }

    // Mix the active PSG channels (gated by SOUNDCNT_L's per-channel L/R enable bits) into a
    // Direct Sound FIFO sample, matching GBATEK's documented hardware mixing ratios: a single
    // FIFO spans the FULL internal range (±200h=512) at 100% DMA volume, while each of the 4
    // PSG channels individually spans ONE QUARTER of that (±80h=128) at max volume/master vol.
    // Our previous scale (dsValue used as-is at its native ±128 byte range, PSG capped around
    // ±60/channel) didn't match those ratios — PSG was proportionally louder relative to Direct
    // Sound than real hardware, and the combined signal never used its real ±511-ish headroom.
    // 'A' maps to the right output, 'B' to left (matching the existing FIFO_A→right/
    // FIFO_B→left convention used at final mixdown).
    _mixPsgInto(channel, dsValue) {
      // SOUNDCNT_X bit 7: PSG+FIFO master enable. When off, all sound circuits are
      // powered down and the output is silence regardless of channel state.
      if (!(this.io[0x84] & 0x80)) return 0;
      const soundCntL = this.read16(0x04000080);
      const soundCntH = this.read16(0x04000082);
      const isRight = channel === 'A';
      const masterVol = isRight ? (soundCntL & 7) : ((soundCntL >>> 4) & 7); // 0-7
      const psgVolumeRatio = [0.25, 0.5, 1, 1][soundCntH & 3];

      // SOUNDCNT_H bit2 (DMA Sound A) / bit3 (DMA Sound B): 0=50%, 1=100% volume.
      const dmaFull = !!(soundCntH & (channel === 'A' ? 0x04 : 0x08));
      const dsScaled = dsValue * 4 * (dmaFull ? 1 : 0.5);

      let psgMix = 0;
      const psgOut = this._psgOutputsAt(this.cycles);
      for (let ch = 0; ch < 2; ch++) {
        const enableBit = isRight ? (8 + ch) : (12 + ch);
        if (soundCntL & (1 << enableBit)) psgMix += psgOut[ch];
      }
      // Wave = ch2 (bit10 right / bit14 left), Noise = ch3 (bit11 right / bit15 left).
      if (soundCntL & (1 << (isRight ? 10 : 14))) psgMix += psgOut[2];
      if (soundCntL & (1 << (isRight ? 11 : 15))) psgMix += psgOut[3];
      const psgScaled = psgMix * (128 / 15) * psgVolumeRatio * (masterVol / 7);

      // Real hardware adds a BIAS then clips the unsigned result to 0..3FFh; with the default
      // bias (200h) that's an effective signed range of roughly ±511 before bias. GBATEK notes
      // bias has no audible effect otherwise, so we skip modeling it and just clip symmetrically.
      return Math.round(Math.max(-511, Math.min(511, dsScaled + psgScaled)));
    }

    _requestSoundFifoDma(channel) {
      const dmaCh = channel === 'A' ? 1 : 2;
      const base = IO_DMA_START + dmaCh * 12;
      const ctrl = (this.io[base - 0x04000000 + 10] | (this.io[base - 0x04000000 + 11] << 8));
      // Fastmode-safe tally of how often refill is requested vs. actually granted, to check
      // whether Direct Sound FIFO DMA is refiring continuously (as intended) or only firing
      // once at startup and then going silent for the rest of the render.
      this.fifoDmaReqTally = (this.fifoDmaReqTally || 0) + 1;
      if (!(ctrl & 0x8000)) { this.fifoDmaReqDisabled = (this.fifoDmaReqDisabled || 0) + 1; return; }
      const timing = (ctrl >>> 12) & 3;
      if (timing !== 3) { this.fifoDmaReqWrongTiming = (this.fifoDmaReqWrongTiming || 0) + 1; return; }
      this._runSoundFifoDma(dmaCh);
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
      this.fifoDmaRunTally = (this.fifoDmaRunTally || 0) + 1;
      const base = IO_DMA_START + ch * 12;
      if (!this.dmaSourceLatch[ch]) this.dmaSourceLatch[ch] = this.read32(base);
      if (!this.dmaDestLatch[ch]) this.dmaDestLatch[ch] = this.read32(base + 4);
      if (!this.dmaSourceBase[ch]) {
        this.dmaSourceBase[ch] = this.dmaSourceLatch[ch];
        // DMA1 feeds FIFO A, DMA2 feeds FIFO B — mp2k lays their mix buffers out back-to-back,
        // so the distance between their bases is each channel's own buffer size.
        if (this.dmaSourceBase[1] && this.dmaSourceBase[2] && !this.dsFifoBufferSize) {
          this.dsFifoBufferSize = Math.abs(this.dmaSourceBase[2] - this.dmaSourceBase[1]) >>> 0;
        }
      }
      const src = this.dmaSourceLatch[ch] >>> 0;
      const dst = this.dmaDestLatch[ch] >>> 0; // should be FIFO address (0x040000a0 or 0x040000a4)
      const logDma = !this.fastMode || this.diagnosticProbes;
      const words = logDma ? [] : null;
      // Sound FIFO: always transfer 4 words (16 bytes), dst fixed, src advances
      for (let i = 0; i < 4; i++) {
        const wordAddr = (src + i * 4) >>> 0;
        const word = this.read32(wordAddr);
        if (logDma) words.push(word >>> 0);
        this._writeSoundFifo(dst, word, wordAddr);
        // Direct, render-wide tally of how often the DMA source word is actually zero at the
        // moment it's read, regardless of what it held a moment earlier or later — this is the
        // most direct test of whether the mix buffer is genuinely silent when DMA drains it
        // (a producer/consumer timing issue) versus DMA reading the wrong memory entirely.
        if (word === 0) this.fifoDmaZeroWords = (this.fifoDmaZeroWords || 0) + 1;
        else this.fifoDmaNonZeroWords = (this.fifoDmaNonZeroWords || 0) + 1;
      }
      if (logDma) {
        const entry = {
          ch,
          src,
          srcHex: tools.hex(src),
          canonicalSrcHex: tools.hex(this.canonicalAddr(src)),
          dstHex: tools.hex(dst),
          words: words.map(word => tools.hex(word)),
          nonZeroWords: words.filter(word => word !== 0).length,
          writers: words.map((_, i) => {
            const write = this.soundBufferWriteMap.get(this.canonicalAddr(src + i * 4) & ~3);
            return write ? `${write.valueHex}@${write.pcHex}/${write.kind}` : '-';
          }),
        };
        if (this.fifoDmaLog.length < 8 || entry.nonZeroWords) {
          this.fifoDmaLog.push(entry);
          if (this.fifoDmaLog.length > 48) this.fifoDmaLog.shift();
        }
      }
      // Advance the internal DMA source latch. The visible DMAxSAD register is an initial value register.
      this.dmaSourceLatch[ch] = this._advanceDmaSource(ch, src, 16);
      // Don't disable — repeat bit is set, DMA stays active.
      this.stallCycles += 12; // ~2N+2S per word for a 4-word FIFO burst
    }

    _advanceDmaSource(ch, src, bytes) {
      // Real GBA DMA hardware just increments/decrements the internal source register per
      // SourceAddrControl -- it never wraps to a "detected" buffer size on its own. Buffer
      // looping is entirely the game's responsibility, via periodically rewriting DMAxSAD
      // (already handled above: the latch reloads from the fresh SAD value on every DMA
      // re-enable). An earlier heuristic here artificially confined the running pointer to
      // a guessed window (distance between DMA1/DMA2's first SAD values, assumed to be two
      // back-to-back mp2k mix buffers) -- that assumption doesn't hold for every engine (e.g.
      // a modified/non-standard mp2k layout), and when the guessed size is wrong it sends the
      // "live" pointer to unintended addresses almost all the time, producing near-silent,
      // sporadically-glitchy audio instead of a hard failure. Removed in favor of matching
      // real hardware exactly.
      const base = IO_DMA_START + ch * 12;
      const control = this.read16(base + 10);
      const sourceControl = (control >>> 7) & 3;
      if (sourceControl === 1) return (src - bytes) >>> 0;
      if (sourceControl === 2) return src >>> 0;
      return (src + bytes) >>> 0;
    }

    _writeSoundFifo(fifoAddr, word, sourceAddr) {
      const channel = fifoAddr === 0x040000a0 ? 'A' : fifoAddr === 0x040000a4 ? 'B' : null;
      if (channel) {
        const collectTrace = !this.fastMode || this.diagnosticProbes;
        for (let i = 0; i < 4; i++) {
          let meta = null;
          if (collectTrace && sourceAddr !== undefined) {
            const byteAddr = (sourceAddr + i) >>> 0;
            const canonical = this.canonicalAddr(byteAddr);
            const write = this.soundBufferWriteMap.get(canonical & ~3);
            meta = {
              addr: byteAddr,
              readCycles: this.cycles,
              writeInfo: write ? `${write.valueHex}@${write.pcHex}/${write.kind}` : '-',
              // Cycle timestamp of the write that produced this byte, so we can tell whether
              // DMA is reading data the CPU just wrote this pass vs. stale content left over
              // from N frames ago (or never written at all, if `write` is undefined) -- this
              // is how we distinguish "CPU hasn't caught up yet" from a genuine addressing bug.
              writeCycles: write ? write.cycles : null,
            };
          }
          this._pushSoundFifoByte(channel, (word >>> (i * 8)) & 0xff, meta);
        }
        if (channel === 'A') this.fifoFillBytesA += 4;
        else this.fifoFillBytesB += 4;
      }
      if (!this.fastMode) {
        for (let i = 0; i < 4; i++) this._logIoWrite((fifoAddr + i) >>> 0, (word >>> (i * 8)) & 0xff, 1);
      }
    }

    _pushSoundFifoByte(channel, value, meta = null) {
      if (channel !== 'A' && channel !== 'B') return;
      const byte = value & 0xff;
      if (!this._fifoPush(channel, byte < 128 ? byte : byte - 256)) {
        // Dropped byte on a full FIFO while the DMA latch still advanced past it:
        // the stream skips time (pitch sharp + warble when frequent). fastMode-safe.
        if (channel === 'A') this.fifoDropsA = (this.fifoDropsA || 0) + 1;
        else this.fifoDropsB = (this.fifoDropsB || 0) + 1;
        return;
      }
      if (!this.fastMode || this.diagnosticProbes) this._fifoMetaPush(channel, meta);
    }

    _resetSoundFifo(channel) {
      if (channel === 'A') {
        this.fifoQueueA = [];
        this.fifoQueueMetaA = [];
        this.fifoHeadA = 0;
        this.fifoLenA = 0;
        this.fifoMetaHeadA = 0;
        this.fifoLastA = 0;
      } else if (channel === 'B') {
        this.fifoQueueB = [];
        this.fifoQueueMetaB = [];
        this.fifoHeadB = 0;
        this.fifoLenB = 0;
        this.fifoMetaHeadB = 0;
        this.fifoLastB = 0;
      }
    }

    forceVBlank(reason = 'forced') {
      this._enterVBlank(reason);
    }

    advanceFrame(reason = 'frame-wait') {
      // Skip forward to the VBlank boundary (scanline 160), matching real hardware
      // timing for BIOS Halt/IntrWait/VBlankIntrWait callers waiting on the VBlank IRQ
      // — not the full-frame wrap, which landed frameCycles at 0 right as the handler
      // started running.
      let cyclesToVBlank = GBA_VBLANK_CYCLE - this.frameCycles;
      if (cyclesToVBlank <= 0) cyclesToVBlank += GBA_CYCLES_PER_FRAME;
      const wasFired = this._vblankFiredThisFrame;
      this.stepCycles(cyclesToVBlank);
      if (!wasFired && this._vblankFiredThisFrame) {
        const last = this.irqEvents[this.irqEvents.length - 1];
        if (last && last.reason === 'vblank:frame') last.reason = `vblank:${reason}`;
      }
    }

    _enterVBlank(reason = 'frame') {
      this.vblankCount++;
      // VCOUNT and the DISPSTAT status bits are computed dynamically from frameCycles
      // on read — no register write needed here (and writing DISPSTAT here would spoil
      // the dispstatWritten "has the ROM configured it" tracking).
      // DISPSTAT bit 3 gates the VBlank IRQ on hardware. ROMs that never touch DISPSTAT
      // keep the historical always-fire fallback so degenerate rips stay alive.
      if ((this.io[4] & 0x08) || !this.dispstatWritten) {
        this.requestIrq(IRQ_VBLANK, `vblank:${reason}`);
      } else {
        this.vblankIrqSuppressed = (this.vblankIrqSuppressed || 0) + 1;
      }
      // VBlank-timed DMA (start timing 1) fires once per frame regardless of the IRQ.
      this._runTimedDma(1, 'vblank');
    }

    // Advance to the next scanline boundary. Used by the BIOS Halt/IntrWait HLE so
    // mid-frame IRQs (timer-driven engines especially) wake the CPU at roughly the
    // right time instead of being coalesced at the next VBlank.
    advanceScanline() {
      this.stepCycles(GBA_CYCLES_PER_SCANLINE - (this.frameCycles % GBA_CYCLES_PER_SCANLINE));
    }

    // Watch every VBlank IRQ dispatch to see whether execution actually reaches the
    // sound-engine wrapper (0x081dcdc6, the fn2/SoundMainBatch caller) -- fn2CallCount only
    // reaches ~57% of vblankCount even after fixing IRQ delivery timing, so something
    // upstream of that wrapper is still gating whether it's ever called this frame.
    _beginIrqPcTrace() {
      this._irqPcTrace = [];
      this._irqPcTraceHitWrapper = false;
      this._irqPcTraceHitReloadBlock = false;
    }
    // The DMA1/DMA2 SAD-reload code (0x081dd78c-0x081dd7a6, confirmed by dmaSad log)
    // is only taken 1 in 14 VBlanks even though the buffer (1584 bytes, 224B/VBlank)
    // only needs a reload every 7 VBlanks -- track exactly which VBlanks take this
    // branch vs which skip straight to 0x081dd7a8, to find the real period/gating.
    _recordIrqPcTraceStep(pc) {
      if (pc === 0x081dd78c) {
        if (!this.dmaReloadBranchLog) this.dmaReloadBranchLog = [];
        if (this.dmaReloadBranchLog.length < 120) this.dmaReloadBranchLog.push({ vbl: this.vblankCount, hit: true });
        this._irqPcTraceHitReloadBlock = true;
      }
      if (!this._irqPcTrace) return;
      if (this._irqPcTrace.length < 80) this._irqPcTrace.push(tools.hex(pc));
      if (pc === 0x081dcdc6) this._irqPcTraceHitWrapper = true;
    }
    _endIrqPcTrace() {
      if (!this._irqPcTraceHitReloadBlock) {
        if (!this.dmaReloadBranchLog) this.dmaReloadBranchLog = [];
        if (this.dmaReloadBranchLog.length < 120) this.dmaReloadBranchLog.push({ vbl: this.vblankCount, hit: false });
      }
      if (!this._irqPcTrace) return;
      if (this._irqPcTraceHitWrapper) {
        this.lastHitIrqPcTrace = this._irqPcTrace;
      } else {
        this.lastMissIrqPcTrace = this._irqPcTrace;
      }
      this._irqPcTrace = null;
    }

    requestIrq(mask, reason = 'irq') {
      this._setIrqFlags(mask);
      if (this.fastMode) return;
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

    _setIrqFlags(mask) {
      const next = this.read16(0x04000202) | (mask & 0xffff);
      this.io[0x202] = next & 0xff;
      this.io[0x203] = (next >>> 8) & 0xff;
    }

    pendingIrq(mask = 0xffff) {
      const ime = this.read16(0x04000208) & 1;
      const ie = this.read16(0x04000200);
      const flags = this.read16(0x04000202);
      return !!(ime && (ie & flags & mask));
    }

    haltPendingIrq(mask = 0xffff) {
      const ie = this.read16(0x04000200);
      const flags = this.read16(0x04000202);
      return !!(ie & flags & mask);
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
      const control = this.read16(base + 10);
      const width = (control & 0x0400) ? 4 : 2;
      // Internal address latches: loaded from SAD/DAD on the enable 0→1 edge (see write8);
      // repeat-mode DMA (VBlank/HBlank timed) must continue from where the last transfer
      // stopped, not restart from the visible registers each trigger.
      if (!this.dmaSourceLatch[ch]) this.dmaSourceLatch[ch] = this.read32(base);
      if (!this.dmaDestLatch[ch]) this.dmaDestLatch[ch] = this.read32(base + 4);
      let src = this.dmaSourceLatch[ch] >>> 0;
      let dst = this.dmaDestLatch[ch] >>> 0;
      // The word count is re-read (reloaded) on every trigger, matching hardware repeat.
      let count = this.read16(base + 8);
      if (!count) count = ch === 3 ? 0x10000 : 0x4000;
      const maxCount = Math.min(count, 0x10000);
      // Address control: SAD bits 7-8 (0/3=increment, 1=decrement, 2=fixed),
      // DAD bits 5-6 (0=increment, 1=decrement, 2=fixed, 3=increment+reload).
      const srcCtl = (control >>> 7) & 3;
      const dstCtl = (control >>> 5) & 3;
      const srcStep = srcCtl === 1 ? -width : srcCtl === 2 ? 0 : width;
      const dstStep = dstCtl === 1 ? -width : dstCtl === 2 ? 0 : width;
      // DMA writes go straight through write8/16/32 and never call noteMemoryWrite,
      // so they're invisible to address-watch logs (e.g. stackCrashWatchLog). Flag
      // any transfer whose destination range overlaps the Golden Sun crash-stack
      // window so a DMA-driven corruption doesn't masquerade as "nothing wrote it".
      const dmaSpanBytes = dstStep === 0 ? width : maxCount * width;
      const dstLo = dstStep < 0 ? (dst - dmaSpanBytes + width) >>> 0 : dst;
      const dmaEndExclusive = (dstLo + dmaSpanBytes) >>> 0;
      if (dstLo < 0x03007f00 && dmaEndExclusive > 0x03007e80) {
        if (!this.dmaStackOverlaps) this.dmaStackOverlaps = [];
        if (this.dmaStackOverlaps.length < 64) {
          this.dmaStackOverlaps.push({
            vbl: this.vblankCount, ch, reason,
            srcHex: tools.hex(src), dstHex: tools.hex(dst),
            count: maxCount, width, dstEndHex: tools.hex(dmaEndExclusive),
          });
        }
      }
      // With probes on, record DMA writes in the provenance map too — engines that copy
      // their mix output into the FIFO-DMA ring via another DMA channel (rather than CPU
      // stores) otherwise show every ring byte as "never written" in staleness traces.
      const noteDmaWrites = !this.fastMode || this.diagnosticProbes;
      for (let i = 0; i < maxCount; i++) {
        const value = width === 4 ? this.read32(src) : this.read16(src);
        if (width === 4) this.write32(dst, value);
        else this.write16(dst, value);
        if (noteDmaWrites) this.noteMemoryWrite(dst, value, width, { kind: `dma${ch}-write` });
        src = (src + srcStep) >>> 0;
        dst = (dst + dstStep) >>> 0;
      }
      this.dmaSourceLatch[ch] = src;
      // Dest control 3 (increment+reload) rewinds the internal dest pointer to DAD after
      // every transfer — the classic HBlank-effects mode.
      this.dmaDestLatch[ch] = dstCtl === 3 ? this.read32(base + 4) : dst;
      // Charge the bus time this transfer really costs (~2 cycles per unit on ROM/EWRAM);
      // accumulated as a stall the CPU drains on its next step, to avoid re-entering
      // stepCycles from inside a timer tick or VBlank event.
      this.stallCycles += 2 * maxCount + 4;
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
      // Real ARM7TDMI banks r13/r14 (+ SPSR) separately per privileged mode -- User
      // and System share one bank, but IRQ/Supervisor/Abort/Undefined each get their
      // own, and FIQ additionally banks r8-r12. Without this, a ROM that switches
      // CPSR mode mid-handler (e.g. IRQ -> System) keeps using whatever r13 value
      // was live in the *other* mode instead of that mode's own stack pointer,
      // corrupting whichever stack happens to alias it. See Golden Sun (modified
      // mp2k) investigation: a BX-via-popped-R0 crash traced to exactly this.
      const usrBank = { r13: GBA_SYSTEM_STACK, r14: 0 };
      this.bankedR13R14 = {
        [MODE_USER]: usrBank,
        [MODE_SYSTEM]: usrBank,
        [MODE_FIQ]: { r13: 0, r14: 0 },
        [MODE_IRQ]: { r13: this.r13_irq, r14: 0 },
        [MODE_SUPERVISOR]: { r13: 0x03007FE0, r14: 0 }, // GBA BIOS initializes SVC SP here
        [MODE_ABORT]: { r13: 0, r14: 0 },
        [MODE_UNDEFINED]: { r13: 0, r14: 0 },
      };
      this.bankedR8to12Fiq = { r8: 0, r9: 0, r10: 0, r11: 0, r12: 0 };
      this.bankedSpsr = {
        [MODE_FIQ]: 0, [MODE_IRQ]: 0, [MODE_SUPERVISOR]: 0, [MODE_ABORT]: 0, [MODE_UNDEFINED]: 0,
      };
      this._inIrqDispatch = false; // re-entrancy guard
      this.diagnosticProbes = false;
      this.unsupported = new Map();
      this.psrWrites = [];
      this.swiCalls = [];
      this.swiCounts = new Uint32Array(256); // cheap per-number tally, kept even in fastMode
      this.irqDispatches = [];
      this.irqCallTargets = [];
      this.irqCallTargetsFirst = []; // first 16 call records (from earliest VBLs)
      this.irqStepStats = { min: Infinity, max: 0, total: 0, count: 0, firstActiveVbl: -1, activeVbls: 0, baselineEstimate: 0 };
      this.haltEvents = [];
      this.pcHits = new Map();
      this.recentPcs = [];
      this.branches = [];
      // Fixed-size ring buffer of the last N executed PCs, updated unconditionally
      // (even in fastMode, unlike recentPcs/branches) so a pc-out-of-range crash
      // still has a cheap trail of what ran right before it.
      this._pcRing = new Int32Array(32).fill(-1);
      this._pcRingIdx = 0;
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
      // Normal streaming playback spends most of its time inside IRQ mixer handlers,
      // so keep the hot instruction path free of diagnostics and avoid a function call
      // for the overwhelmingly common "IRQs are masked or none are pending" case.
      if (this.fastMode && !this.diagnosticProbes) return this._stepFast();

      // Real hardware delivers IRQs asynchronously the instant IE&IF&IME allows it,
      // regardless of what the CPU is doing. _checkAndDispatchIrq was previously only
      // wired into the Halt/IntrWait/VBlankIntrWait BIOS stubs, so a VBlank firing while
      // the CPU was busy running ordinary code (not blocked in one of those SWIs) sat
      // undelivered until the next such call -- silently dropping/delaying the VBlank
      // ISR (and the sound engine tick it drives) on every frame the CPU didn't happen
      // to halt, which is why playback tempo dragged once real audio was flowing again.
      this._checkAndDispatchIrq(); // internally gated on CPSR.I, IME, and nesting depth
      this.bus.debugPc = this.regs[15] >>> 0;
      this.bus.debugThumb = !!(this.cpsr & CPSR_T);
      if (this.diagnosticProbes) this._runDiagnosticProbes();
      if (this.cpsr & CPSR_T) {
        const pc = this.regs[15] >>> 0;
        this._pushPcRing(pc);
        if (!this._canFetch(pc, 2)) return;
        this._tracePc(pc);
        const instr = this.bus.read16(pc);
        this.bus.openBus = ((instr << 16) | instr) >>> 0; // prefetch latch (Thumb repeats on both lanes)
        this.regs[15] = (pc + 2) >>> 0;
        this.instructions++;
        this._execThumb(instr, pc);
        this._chargeCyclesFast(pc, true);
        return;
      }
      const pc = this.regs[15] >>> 0;
      this._pushPcRing(pc);
      if (!this._canFetch(pc, 4)) return;
      this._tracePc(pc);
      const instr = this.bus.read32(pc);
      this.bus.openBus = instr >>> 0; // prefetch latch for open-bus reads
      this.regs[15] = (pc + 4) >>> 0;
      this.instructions++;
      if (!this._conditionPassed(instr >>> 28)) {
        this._chargeCycles(pc, false);
        return;
      }
      this._execArm(instr, pc);
      this._chargeCycles(pc, false);
    }

    _stepFast() {
      if (!(this.cpsr & 0x80)
          && (this._irqDepth || 0) < 4
          && (this.bus.io[0x208] & 1)
          && ((this.bus.io[0x200] | (this.bus.io[0x201] << 8))
              & (this.bus.io[0x202] | (this.bus.io[0x203] << 8)) & 0x3fff)) {
        this._checkAndDispatchIrq();
      }
      if (this.cpsr & CPSR_T) {
        const pc = this.regs[15] >>> 0;
        let data;
        let off;
        let cost;
        if (pc >= 0x08000000 && pc < 0x0e000000) {
          data = this.bus.memory.rom;
          off = (pc - 0x08000000) & 0x01ffffff;
          if (off + 2 > data.length) { if (!this._canFetch(pc, 2)) return; }
          const ws = pc >= 0x0c000000 ? 2 : pc >= 0x0a000000 ? 1 : 0;
          cost = this.bus.romCostThumb[ws];
        } else if (pc >= 0x03000000 && pc < 0x04000000) {
          data = this.bus.iwram;
          off = (pc - 0x03000000) & 0x7fff;
          if (off + 2 > data.length) { if (!this._canFetch(pc, 2)) return; }
          cost = 1;
        } else if (pc >= 0x02000000 && pc < 0x03000000) {
          data = this.bus.ewram;
          off = (pc - 0x02000000) & 0x3ffff;
          if (off + 2 > data.length) { if (!this._canFetch(pc, 2)) return; }
          cost = 3;
        } else {
          if (!this._canFetch(pc, 2)) return;
          data = this.bus.executableRegion(pc).data;
          off = this.bus.executableRegion(pc).off;
          cost = 1;
        }
        const instr = data[off] | (data[off + 1] << 8);
        this.bus.openBus = ((instr << 16) | instr) >>> 0;
        this.regs[15] = (pc + 2) >>> 0;
        this.instructions++;
        this._execThumb(instr, pc);
        const stall = this.bus.stallCycles;
        if (stall > 0) {
          this.bus.stallCycles = 0;
          cost += stall;
        }
        this.bus.stepCyclesFast(cost);
        return;
      }
      const pc = this.regs[15] >>> 0;
      let data;
      let off;
      let cost;
      if (pc >= 0x08000000 && pc < 0x0e000000) {
        data = this.bus.memory.rom;
        off = (pc - 0x08000000) & 0x01ffffff;
        if (off + 4 > data.length) { if (!this._canFetch(pc, 4)) return; }
        const ws = pc >= 0x0c000000 ? 2 : pc >= 0x0a000000 ? 1 : 0;
        cost = this.bus.romCostArm[ws];
      } else if (pc >= 0x03000000 && pc < 0x04000000) {
        data = this.bus.iwram;
        off = (pc - 0x03000000) & 0x7fff;
        if (off + 4 > data.length) { if (!this._canFetch(pc, 4)) return; }
        cost = 1;
      } else if (pc >= 0x02000000 && pc < 0x03000000) {
        data = this.bus.ewram;
        off = (pc - 0x02000000) & 0x3ffff;
        if (off + 4 > data.length) { if (!this._canFetch(pc, 4)) return; }
        cost = 6;
      } else {
        if (!this._canFetch(pc, 4)) return;
        const r = this.bus.executableRegion(pc);
        data = r.data;
        off = r.off;
        cost = 1;
      }
      const instr = (data[off] | (data[off + 1] << 8) | (data[off + 2] << 16) | (data[off + 3] << 24)) >>> 0;
      this.bus.openBus = instr >>> 0;
      this.regs[15] = (pc + 4) >>> 0;
      this.instructions++;
      const cond = instr >>> 28;
      if (cond !== 0xe) {
        const f = this.cpsr;
        const n = !!(f & CPSR_N);
        const z = !!(f & CPSR_Z);
        const c = !!(f & CPSR_C);
        const v = !!(f & CPSR_V);
        let pass;
        switch (cond) {
          case 0x0: pass = z; break;
          case 0x1: pass = !z; break;
          case 0x2: pass = c; break;
          case 0x3: pass = !c; break;
          case 0x4: pass = n; break;
          case 0x5: pass = !n; break;
          case 0x6: pass = v; break;
          case 0x7: pass = !v; break;
          case 0x8: pass = c && !z; break;
          case 0x9: pass = !c || z; break;
          case 0xa: pass = n === v; break;
          case 0xb: pass = n !== v; break;
          case 0xc: pass = !z && n === v; break;
          case 0xd: pass = z || n !== v; break;
          default: pass = false; break;
        }
        if (!pass) {
          const stall = this.bus.stallCycles;
          if (stall > 0) {
            this.bus.stallCycles = 0;
            cost += stall;
          }
          this.bus.stepCyclesFast(cost);
          return;
        }
      }
      this._execArmFast(instr, pc);
      const stall = this.bus.stallCycles;
      if (stall > 0) {
        this.bus.stallCycles = 0;
        cost += stall;
      }
      this.bus.stepCyclesFast(cost);
    }

    _canFetchFast(pc, bytes) {
      pc >>>= 0;
      let off;
      if (pc >= 0x08000000 && pc < 0x0e000000) {
        off = (pc - 0x08000000) & 0x01ffffff;
        if (off + bytes <= this.bus.memory.rom.length) return true;
      } else if (pc >= 0x03000000 && pc < 0x04000000) {
        off = (pc - 0x03000000) & 0x7fff;
        if (off + bytes <= this.bus.iwram.length) return true;
      } else if (pc >= 0x02000000 && pc < 0x03000000) {
        off = (pc - 0x02000000) & 0x3ffff;
        if (off + bytes <= this.bus.ewram.length) return true;
      }
      return this._canFetch(pc, bytes);
    }

    _readCode16Fast(pc) {
      let data;
      let off;
      if (pc >= 0x08000000) {
        data = this.bus.memory.rom;
        off = (pc - 0x08000000) & 0x01ffffff;
      } else if (pc >= 0x03000000) {
        data = this.bus.iwram;
        off = (pc - 0x03000000) & 0x7fff;
      } else {
        data = this.bus.ewram;
        off = (pc - 0x02000000) & 0x3ffff;
      }
      return data[off] | (data[off + 1] << 8);
    }

    _readCode32Fast(pc) {
      let data;
      let off;
      if (pc >= 0x08000000) {
        data = this.bus.memory.rom;
        off = (pc - 0x08000000) & 0x01ffffff;
      } else if (pc >= 0x03000000) {
        data = this.bus.iwram;
        off = (pc - 0x03000000) & 0x7fff;
      } else {
        data = this.bus.ewram;
        off = (pc - 0x02000000) & 0x3ffff;
      }
      return (data[off] | (data[off + 1] << 8) | (data[off + 2] << 16) | (data[off + 3] << 24)) >>> 0;
    }

    _chargeCyclesFast(pc, thumb) {
      let cost;
      if (pc >= 0x08000000) {
        const ws = pc >= 0x0c000000 ? 2 : pc >= 0x0a000000 ? 1 : 0;
        cost = thumb ? this.bus.romCostThumb[ws] : this.bus.romCostArm[ws];
      } else if (pc >= 0x03000000) {
        cost = 1;
      } else if (pc >= 0x02000000) {
        cost = thumb ? 3 : 6;
      } else {
        cost = 1;
      }
      const stall = this.bus.stallCycles;
      if (stall > 0) {
        this.bus.stallCycles = 0;
        cost += stall;
      }
      this.bus.stepCyclesFast(cost);
    }

    _execArmFast(instr, pc) {
      const major = instr & 0x0e000000;
      if ((instr & 0x0c000000) === 0x00000000) {
        if ((instr & 0x0e000090) === 0x00000090) {
          if ((instr & 0x0fc000f0) === 0x00000090) return this._multiply(instr);
          if ((instr & 0x0f8000f0) === 0x00800090) return this._multiplyLong(instr);
          if ((instr & 0x0fb00ff0) === 0x01000090) return this._swp(instr);
          return this._halfwordDataTransfer(instr);
        }
        if ((instr & 0x0ffffff0) === 0x012fff10) return this._bx(instr);
        if ((instr & 0x0fbf0fff) === 0x010f0000) return this._mrs(instr);
        if ((instr & 0x0db0f000) === 0x0120f000) return this._msr(instr);
        return this._dataProcessingFast(instr);
      }
      if (major === 0x08000000) return this._blockDataTransferFast(instr);
      if ((instr & 0x0c000000) === 0x04000000) return this._singleDataTransfer(instr);
      if (major === 0x0a000000) return this._branch(instr, pc);
      if ((instr & 0x0f000000) === 0x0f000000) return this._swi((instr >>> 16) & 0xff, pc, 'arm');
      this._unsupported(instr, pc);
    }

    _operand2Fast(instr) {
      if (instr & 0x02000000) {
        const imm = instr & 0xff;
        const rotate = ((instr >>> 8) & 0xf) * 2;
        const value = ror32(imm, rotate);
        this._operand2Carry = rotate ? !!(value & 0x80000000) : !!(this.cpsr & CPSR_C);
        return value >>> 0;
      }
      const rm = instr & 0xf;
      const shiftType = (instr >>> 5) & 3;
      const byReg = !!(instr & 0x10);
      let amount = byReg ? (this.regs[(instr >>> 8) & 0xf] & 0xff) : ((instr >>> 7) & 0x1f);
      let value = this.regs[rm] >>> 0;
      let carry = !!(this.cpsr & CPSR_C);
      if (amount === 0) {
        if (!byReg && shiftType === 1) {
          carry = !!(value & 0x80000000);
          value = 0;
        } else if (!byReg && shiftType === 2) {
          carry = !!(value & 0x80000000);
          value = carry ? 0xffffffff : 0;
        } else if (!byReg && shiftType === 3) {
          carry = !!(value & 1);
          value = ((this.cpsr & CPSR_C ? 0x80000000 : 0) | (value >>> 1)) >>> 0;
        }
        this._operand2Carry = carry;
        return value >>> 0;
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
      this._operand2Carry = carry;
      return value >>> 0;
    }

    _dataProcessingFast(instr) {
      const rn = (instr >>> 16) & 0xf;
      const rd = (instr >>> 12) & 0xf;
      if (rn === 15 || rd === 15) return this._dataProcessing(instr);
      if (!(instr & 0x02000000)) {
        const rm = instr & 0xf;
        if (rm === 15) return this._dataProcessing(instr);
        if ((instr & 0x10) && (((instr >>> 8) & 0xf) === 15)) return this._dataProcessing(instr);
      }

      const opcode = (instr >>> 21) & 0xf;
      const setFlags = !!(instr & 0x00100000);
      const needFlags = setFlags || opcode === 0x8 || opcode === 0x9 || opcode === 0xa || opcode === 0xb;
      const a = this.regs[rn] >>> 0;
      let op2;
      if (instr & 0x02000000) {
        const imm = instr & 0xff;
        const rotate = ((instr >>> 8) & 0xf) * 2;
        if (rotate) {
          op2 = ror32(imm, rotate);
          this._operand2Carry = !!(op2 & 0x80000000);
        } else {
          op2 = imm;
          this._operand2Carry = !!(this.cpsr & CPSR_C);
        }
      } else if ((instr & 0x00000ff0) === 0) {
        op2 = this.regs[instr & 0xf] >>> 0;
        this._operand2Carry = !!(this.cpsr & CPSR_C);
      } else {
        op2 = this._operand2Fast(instr);
      }
      let result = 0;
      let write = true;
      let carry = this._operand2Carry;
      let overflow = false;
      switch (opcode) {
        case 0x0: result = a & op2; break; // AND
        case 0x1: result = a ^ op2; break; // EOR
        case 0x2: result = (a - op2) >>> 0; if (needFlags) { carry = a >= op2; overflow = subOverflow(a, op2, result); } break; // SUB
        case 0x3: result = (op2 - a) >>> 0; if (needFlags) { carry = op2 >= a; overflow = subOverflow(op2, a, result); } break; // RSB
        case 0x4: result = (a + op2) >>> 0; if (needFlags) { carry = result < a; overflow = addOverflow(a, op2, result); } break; // ADD
        case 0x5: { const c5 = this.cpsr & CPSR_C ? 1 : 0; result = (a + op2 + c5) >>> 0; if (needFlags) { carry = result < a || (c5 && result === a); overflow = addOverflow(a, op2, result); } break; } // ADC
        case 0x6: { const c6 = this.cpsr & CPSR_C ? 0 : 1; result = (a - op2 - c6) >>> 0; if (needFlags) { carry = a >= op2 + c6; overflow = subOverflow(a, op2, result); } break; } // SBC
        case 0x7: { const c7 = this.cpsr & CPSR_C ? 0 : 1; result = (op2 - a - c7) >>> 0; if (needFlags) { carry = op2 >= a + c7; overflow = subOverflow(op2, a, result); } break; } // RSC
        case 0x8: result = a & op2; write = false; break; // TST
        case 0x9: result = a ^ op2; write = false; break; // TEQ
        case 0xa: result = (a - op2) >>> 0; carry = a >= op2; overflow = subOverflow(a, op2, result); write = false; break; // CMP
        case 0xb: result = (a + op2) >>> 0; carry = result < a; overflow = addOverflow(a, op2, result); write = false; break; // CMN
        case 0xc: result = a | op2; break; // ORR
        case 0xd: result = op2; break; // MOV
        case 0xe: result = a & (~op2); break; // BIC
        case 0xf: result = (~op2) >>> 0; break; // MVN
        default: return this._unsupported(instr, (this.regs[15] - 4) >>> 0);
      }
      result >>>= 0;
      if (write) this.regs[rd] = result;
      if (needFlags) {
        this.cpsr = (this.cpsr & ~(CPSR_N | CPSR_Z | CPSR_C | CPSR_V))
          | (result & 0x80000000 ? CPSR_N : 0)
          | (result === 0 ? CPSR_Z : 0)
          | (carry ? CPSR_C : 0)
          | (overflow ? CPSR_V : 0);
      }
    }

    _runDiagnosticProbes() {
      const _snapPc = this.bus.debugPc;
      const _isCallSite = (_snapPc === 0x081c248a || _snapPc === 0x081c121a);
      const _isDivFn = _snapPc >= 0x08001800 && _snapPc <= 0x080019ff;
      const _isIwramFn = _snapPc >= 0x03000400 && _snapPc <= 0x030005ff;

      if ((_snapPc === 0x081dce1c || _snapPc === 0x081dee48) && this._inIrqDispatch) {
        const r = this.regs;
        const isFn2 = (_snapPc === 0x081dce1c);
        const cnt = isFn2 ? 'fn2' : 'seq';
        const cntKey = `_${cnt}CallCount`;
        const n = this.bus[cntKey] = (this.bus[cntKey] || 0) + 1;
        const memPeek = (a) => { if (a < 0x02000000 || a > 0x09000000) return []; const ws = []; for (let i=0;i<8;i++) ws.push(tools.hex(this.bus.read32((a+i*4)>>>0))); return ws; };
        const snap = {
          n, r0: tools.hex(r[0]>>>0), r1: tools.hex(r[1]>>>0),
          r2: tools.hex(r[2]>>>0), r3: tools.hex(r[3]>>>0),
          r4: tools.hex(r[4]>>>0), r5: tools.hex(r[5]>>>0),
          memR0: memPeek(r[0]>>>0),
          memR1: memPeek(r[1]>>>0),
          memR2: memPeek(r[2]>>>0),
          memR5: memPeek(r[5]>>>0),
        };
        const listKey = isFn2 ? 'fn2CallSnaps' : 'seqCallSnaps';
        if (!this.bus[listKey]) this.bus[listKey] = [];
        const list = this.bus[listKey];
        if (n <= 4) list.push(snap);
        else { if (list.length < 8) list.push(snap); else { list.splice(4, 1); list.push(snap); } }
        if (isFn2) {
          const writeAddr = r[5] >>> 0;
          const readAddr = this.bus.dmaSourceLatch[1] >>> 0;
          const bufSize = this.bus.dsFifoBufferSize || 0x8000;
          const driftBytes = ((readAddr - writeAddr) % bufSize + bufSize) % bufSize;
          const drift = { n, vbl: this.bus.vblankCount, r5: tools.hex(writeAddr), dmaSad1: tools.hex(readAddr), driftBytes, bufSize };
          if (!this.bus.dmaDriftLog) this.bus.dmaDriftLog = [];
          const dlist = this.bus.dmaDriftLog;
          if (n <= 8) dlist.push(drift);
          else { if (dlist.length < 16) dlist.push(drift); else { dlist.splice(8, 1); dlist.push(drift); } }
        }
      }

      if (_snapPc === 0x03000fee) this.bus._cpFee = (this.bus._cpFee || 0) + 1;
      else if (_snapPc === 0x03001000) this.bus._cp1000 = (this.bus._cp1000 || 0) + 1;
      else if (_snapPc === 0x0300101c) this.bus._cp101c = (this.bus._cp101c || 0) + 1;
      else if (_snapPc === 0x03001056) this.bus._cp1056 = (this.bus._cp1056 || 0) + 1;
      else if (_snapPc === 0x030010fc) this.bus._cp10fc = (this.bus._cp10fc || 0) + 1;
      else if (_snapPc === 0x03001110) this.bus._cp1110 = (this.bus._cp1110 || 0) + 1;
      else if (_snapPc === 0x03001002) this.bus._cp1002 = (this.bus._cp1002 || 0) + 1;
      else if (_snapPc === 0x03001008) this.bus._cp1008 = (this.bus._cp1008 || 0) + 1;
      else if (_snapPc === 0x0300100c) this.bus._cp100c = (this.bus._cp100c || 0) + 1;
      else if (_snapPc === 0x03001010) this.bus._cp1010 = (this.bus._cp1010 || 0) + 1;
      else if (_snapPc === 0x03001012) this.bus._cp1012 = (this.bus._cp1012 || 0) + 1;
      else if (_snapPc === 0x03001014) this.bus._cp1014 = (this.bus._cp1014 || 0) + 1;
      else if (_snapPc === 0x03001016) this.bus._cp1016 = (this.bus._cp1016 || 0) + 1;
      else if (_snapPc === 0x03001018) this.bus._cp1018 = (this.bus._cp1018 || 0) + 1;

      if (_snapPc === 0x03000ffc && !this.bus._spWatchAddr) {
        this.bus._spWatchAddr = (this.regs[13] + 0x14) >>> 0;
      }
      if (!this.bus._literalWatchAddr) {
        this.bus._literalWatchAddr = this.bus.read32(0x081dce2c) >>> 0;
      }
      if (_snapPc === 0x081dcde6) {
        if (!this.bus.spStoreOperands) this.bus.spStoreOperands = [];
        const log = this.bus.spStoreOperands;
        if (log.length < 60) {
          log.push({
            vbl: this.bus.vblankCount,
            r0: tools.hex(this.regs[0]),
            r1: tools.hex(this.regs[1]),
            r2: tools.hex(this.regs[2]),
            r0plus12: tools.hex(this.bus.read8((this.regs[0] + 12) >>> 0)),
          });
        }
      }
      if (_snapPc === 0x0300100c) {
        if (!this.bus.mixCmpTrace) this.bus.mixCmpTrace = [];
        const t = this.bus.mixCmpTrace;
        if (t.length < 2000) {
          const r = this.regs;
          t.push({ vbl: this.bus.vblankCount, r0: tools.hex(r[0] >>> 0), r1: tools.hex(r[1] >>> 0) });
        }
      }
      if (_snapPc === 0x0300112c) {
        if (!this.bus.mixGateTrace) this.bus.mixGateTrace = [];
        const t = this.bus.mixGateTrace;
        if (t.length < 2000) {
          const r = this.regs;
          t.push({ vbl: this.bus.vblankCount, r0: tools.hex(r[0] >>> 0), r4: tools.hex(r[4] >>> 0) });
        }
      }
      if (_snapPc === 0x03001260) {
        const nHit = (this.bus._mixVolHitCount = (this.bus._mixVolHitCount || 0) + 1);
        if (nHit % 211 === 1) {
          if (!this.bus.mixVolTrace) this.bus.mixVolTrace = [];
          const t = this.bus.mixVolTrace;
          if (t.length < 200) {
            const r = this.regs;
            t.push({
              n: nHit, vbl: this.bus.vblankCount,
              r4: tools.hex(r[4] >>> 0), r10: tools.hex(r[10] >>> 0), r11: tools.hex(r[11] >>> 0),
            });
          }
        }
      }
      if (this.bus._fn2CallCount === 1 && _snapPc >= 0x03000fee && _snapPc <= 0x03001318) {
        if (!this.bus.mixerLoopTrace) this.bus.mixerLoopTrace = [];
        const trace = this.bus.mixerLoopTrace;
        if (trace.length < 600) {
          const thumb = !!(this.cpsr & CPSR_T);
          const instrWord = thumb ? this.bus.read16(_snapPc) : this.bus.read32(_snapPc);
          const r = this.regs;
          trace.push({
            pc: tools.hex(_snapPc), t: thumb ? 1 : 0, i: tools.hex(instrWord, thumb ? 4 : 8),
            r0: tools.hex(r[0]>>>0), r1: tools.hex(r[1]>>>0), r2: tools.hex(r[2]>>>0), r3: tools.hex(r[3]>>>0),
            r4: tools.hex(r[4]>>>0), r5: tools.hex(r[5]>>>0), r6: tools.hex(r[6]>>>0), r7: tools.hex(r[7]>>>0),
            r8: tools.hex(r[8]>>>0), r9: tools.hex(r[9]>>>0), r10: tools.hex(r[10]>>>0), r11: tools.hex(r[11]>>>0),
            r12: tools.hex(r[12]>>>0), r14: tools.hex(r[14]>>>0), c: (this.cpsr & CPSR_C) ? 1 : 0,
          });
        }
      }
      if ((_isCallSite || _isDivFn || _isIwramFn) && this.bus.timerRegSnaps.length < 16) {
        const _label = _isCallSite ? 'site' : _isDivFn ? 'div' : 'iwram';
        if (!this.bus.timerRegSnaps.some(s => s.label === _label)) {
          const r = this.regs;
          this.bus.timerRegSnaps.push({
            label: _label,
            pc: tools.hex(_snapPc),
            cycles: this.bus.cycles,
            r0: tools.hex(r[0]>>>0), r1: tools.hex(r[1]>>>0),
            r2: tools.hex(r[2]>>>0), r3: tools.hex(r[3]>>>0),
            r4: tools.hex(r[4]>>>0), r5: tools.hex(r[5]>>>0),
            r6: tools.hex(r[6]>>>0), r7: tools.hex(r[7]>>>0),
            lr: tools.hex(r[14]>>>0),
          });
        }
        if (_isCallSite && this.bus.timerRegSnaps.filter(s=>s.label==='site').length < 4) {
          const r = this.regs;
          this.bus.timerRegSnaps.push({
            label: 'site',
            pc: tools.hex(_snapPc),
            cycles: this.bus.cycles,
            r0: tools.hex(r[0]>>>0), r1: tools.hex(r[1]>>>0),
            r2: tools.hex(r[2]>>>0), r3: tools.hex(r[3]>>>0),
            r4: tools.hex(r[4]>>>0), r5: tools.hex(r[5]>>>0),
            r6: tools.hex(r[6]>>>0), r7: tools.hex(r[7]>>>0),
            lr: tools.hex(r[14]>>>0),
          });
        }
      }
    }

    // Region-aware per-instruction cycle cost, plus draining any bus-stall cycles owed
    // by DMA transfers that ran inside the previous instruction. The old flat 4 charged
    // IWRAM Thumb code (where mp2k mixers live, on a zero-wait 32-bit bus) 4x its real
    // cost, so mixer/IRQ handlers routinely overran their VBlank budget in emulated time
    // even though they comfortably fit on hardware. ROM costs come from the WAITCNT-
    // derived cache on the bus, per wait-state region (0x08/0x0A/0x0C mirrors).
    _chargeCycles(pc, thumb) {
      let cost;
      if (pc >= 0x08000000) {
        const ws = pc >= 0x0c000000 ? 2 : pc >= 0x0a000000 ? 1 : 0;
        cost = thumb ? this.bus.romCostThumb[ws] : this.bus.romCostArm[ws];
      }
      else if (pc >= 0x03000000 && pc < 0x04000000) cost = 1; // IWRAM: 32-bit, zero-wait
      else if (pc >= 0x02000000 && pc < 0x03000000) cost = thumb ? 3 : 6; // EWRAM: 16-bit, 2 waits
      else cost = 1;
      const stall = this.bus.stallCycles;
      if (stall > 0) {
        this.bus.stallCycles = 0;
        cost += stall;
      }
      if (this.fastMode && !this.diagnosticProbes) this.bus.stepCyclesFast(cost);
      else this.bus.stepCycles(cost);
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

    _pushPcRing(pc) {
      this._pcRing[this._pcRingIdx] = pc | 0;
      this._pcRingIdx = (this._pcRingIdx + 1) % this._pcRing.length;
    }

    _pcRingTrail() {
      // Oldest-to-newest order, skipping unfilled (-1) slots.
      const out = [];
      for (let i = 0; i < this._pcRing.length; i++) {
        const v = this._pcRing[(this._pcRingIdx + i) % this._pcRing.length];
        if (v !== -1) out.push(tools.hex(v >>> 0));
      }
      return out;
    }

    _canFetch(pc, bytes) {
      const r = this.bus.executableRegion(pc);
      if (r && r.off + bytes <= r.data.length) return true;
      const source = this.branches.slice().reverse().find(branch => branch.kind !== 'fetch-fault') || null;
      this.halted = true;
      const sourceText = source ? ` from ${source.kind} ${source.pcHex}->${source.targetHex}` : '';
      const trail = this._pcRingTrail();
      const trailText = trail.length ? ` trail:[${trail.join(',')}]` : '';
      // Decode the raw instruction at the last executed PC (whatever jumped us
      // to the invalid address) plus full register state, so we can tell
      // whether it's a BX/POP{pc} reading a bad register/stack value.
      let lastPcInfo = '';
      if (trail.length) {
        const lastPc = parseInt(trail[trail.length - 1], 16) >>> 0;
        try {
          const opcode16 = this.bus.read16(lastPc);
          const opcode32 = this.bus.read32(lastPc);
          const regsText = Array.from({ length: 16 }, (_, i) => `r${i}=${tools.hex(this.regs[i] >>> 0)}`).join(',');
          lastPcInfo = ` lastOpcode:${tools.hex(opcode16, 4)}/${tools.hex(opcode32)} regs:[${regsText}] cpsr=${tools.hex(this.cpsr >>> 0)}`;
        } catch (e) { /* ignore */ }
      }
      this.reason = `pc-out-of-range fetch ${bytes * 8}-bit at ${tools.hex(pc)}${sourceText}${trailText}${lastPcInfo}`;
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
      if (this.bus.fastMode && !this.bus.diagnosticProbes) {
        this.bus.noteMemoryWrite(addr & ~3, value, 4);
      } else {
        this.bus.noteMemoryWrite(addr & ~3, value, 4, {
          kind,
          pc,
          pcHex: tools.hex(pc),
          ...detail,
        });
      }
      // Capture the actual packed-PCM words the mixer stores at its two STR sites
      // (left channel at 0x030012cc, right channel at 0x030012c8) for the first fn2
      // invocation, decoded into 4 signed 8-bit samples each, so the real output
      // waveform shape can be inspected directly instead of inferred from register
      // snapshots taken 20 instructions apart.
      if (this.bus.diagnosticProbes && this.bus._fn2CallCount === 1 && (pc === 0x030012c8 || pc === 0x030012cc)) {
        if (!this.bus.mixerPcmTrace) this.bus.mixerPcmTrace = [];
        const t = this.bus.mixerPcmTrace;
        if (t.length < 256) {
          const s8 = (b) => (b & 0x80) ? (b - 0x100) : b;
          t.push({
            pc: tools.hex(pc), ch: pc === 0x030012cc ? 'L' : 'R', addr: tools.hex(addr & ~3),
            bytes: [s8(value & 0xff), s8((value >>> 8) & 0xff), s8((value >>> 16) & 0xff), s8((value >>> 24) & 0xff)],
          });
        }
      }
    }

    _writeMem8(addr, value, kind, detail = {}) {
      addr >>>= 0;
      value &= 0xff;
      const pc = (this.regs[15] - (this.cpsr & CPSR_T ? 2 : 4)) >>> 0;
      this.bus.write8(addr, value);
      if (this.bus.fastMode && !this.bus.diagnosticProbes) {
        this.bus.noteMemoryWrite(addr, value, 1);
      } else {
        this.bus.noteMemoryWrite(addr, value, 1, {
          kind,
          pc,
          pcHex: tools.hex(pc),
          ...detail,
        });
      }
    }

    _writeMem16(addr, value, kind, detail = {}) {
      addr >>>= 0;
      value &= 0xffff;
      const pc = (this.regs[15] - (this.cpsr & CPSR_T ? 2 : 4)) >>> 0;
      this.bus.write16(addr & ~1, value);
      if (this.bus.fastMode && !this.bus.diagnosticProbes) {
        this.bus.noteMemoryWrite(addr & ~1, value, 2);
      } else {
        this.bus.noteMemoryWrite(addr & ~1, value, 2, {
          kind,
          pc,
          pcHex: tools.hex(pc),
          ...detail,
        });
      }
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
      if ((instr & 0x0fb00ff0) === 0x01000090) return this._swp(instr);
      if ((instr & 0x0e000090) === 0x00000090) return this._halfwordDataTransfer(instr);
      if ((instr & 0x0e000000) === 0x08000000) return this._blockDataTransfer(instr);
      if ((instr & 0x0c000000) === 0x04000000) return this._singleDataTransfer(instr);
      if ((instr & 0x0c000000) === 0x00000000) return this._dataProcessing(instr);
      this._unsupported(instr, pc);
    }

    _reg(idx) {
      return idx === 15 ? (this.regs[15] + 4) >>> 0 : this.regs[idx] >>> 0;
    }

    _armStoreRegValue(idx) {
      // ARM stores of R15 write the instruction address + 12, not the normal
      // data-processing PC value of instruction address + 8.
      return idx === 15 ? (this.regs[15] + 8) >>> 0 : this._reg(idx);
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
        this._operand2Carry = rotate ? !!(value & 0x80000000) : !!(this.cpsr & CPSR_C);
        return value;
      }
      const rm = instr & 0xf;
      const shiftType = (instr >>> 5) & 3;
      const byReg = !!(instr & 0x10);
      let amount = byReg ? (this._reg((instr >>> 8) & 0xf) & 0xff) : ((instr >>> 7) & 0x1f);
      let value = this._reg(rm);
      let carry = !!(this.cpsr & CPSR_C);
      if (amount === 0) {
        // Immediate-encoded shift amount of 0 has special meanings per ARM ARM:
        // LSL #0 is a true no-op, but LSR #0 / ASR #0 encode shift-by-32, and
        // ROR #0 encodes RRX. Register-specified shifts (byReg) have no such
        // special-casing: amount 0 is always a genuine no-op there.
        if (!byReg && shiftType === 1) {
          carry = !!(value & 0x80000000);
          value = 0;
        } else if (!byReg && shiftType === 2) {
          carry = !!(value & 0x80000000);
          value = carry ? 0xffffffff : 0;
        } else if (!byReg && shiftType === 3) {
          carry = !!(value & 1);
          value = ((this.cpsr & CPSR_C ? 0x80000000 : 0) | (value >>> 1)) >>> 0;
        }
        this._operand2Carry = carry;
        return value >>> 0;
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
      this._operand2Carry = carry;
      return value >>> 0;
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
      let carry = this._operand2Carry;
      let overflow = false;
      switch (opcode) {
        case 0x0: result = a & op2; break; // AND
        case 0x1: result = a ^ op2; break; // EOR
        case 0x2: result = (a - op2) >>> 0; carry = a >= op2; overflow = subOverflow(a, op2, result); break; // SUB
        case 0x3: result = (op2 - a) >>> 0; carry = op2 >= a; overflow = subOverflow(op2, a, result); break; // RSB
        case 0x4: result = (a + op2) >>> 0; carry = result < a; overflow = addOverflow(a, op2, result); break; // ADD
        case 0x5: { const c5 = this.cpsr & CPSR_C ? 1 : 0; result = (a + op2 + c5) >>> 0; carry = result < a || (c5 && result === a); overflow = addOverflow(a, op2, result); break; } // ADC
        case 0x6: { const c6 = this.cpsr & CPSR_C ? 0 : 1; result = (a - op2 - c6) >>> 0; carry = a >= op2 + c6; overflow = subOverflow(a, op2, result); break; } // SBC
        case 0x7: { const c7 = this.cpsr & CPSR_C ? 0 : 1; result = (op2 - a - c7) >>> 0; carry = op2 >= a + c7; overflow = subOverflow(op2, a, result); break; } // RSC
        case 0x8: result = a & op2; write = false; break; // TST
        case 0x9: result = a ^ op2; write = false; break; // TEQ
        case 0xa: result = (a - op2) >>> 0; carry = a >= op2; overflow = subOverflow(a, op2, result); write = false; break; // CMP
        case 0xb: result = (a + op2) >>> 0; carry = result < a; overflow = addOverflow(a, op2, result); write = false; break; // CMN
        case 0xc: result = a | op2; break; // ORR
        case 0xd: result = op2; break; // MOV
        case 0xe: result = a & (~op2); break; // BIC
        case 0xf: result = (~op2) >>> 0; break; // MVN
        default: return this._unsupported(instr, (this.regs[15] - 4) >>> 0);
      }
      // ARM exception return: S=1, Rd=15, privileged mode (not User 0x10)
      const exReturn = write && rd === 15 && setFlags && (this.cpsr & 0x1f) !== 0x10;
      if (write) {
        if (exReturn) {
          this._switchCpuMode(this.spsr & 0x1f); // bank-switch while this.cpsr still reflects the old mode
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

    // ARM7TDMI unaligned load behavior: LDR from a non-word-aligned address reads the
    // aligned word rotated right by 8x the byte offset; LDRH from an odd address reads
    // the aligned halfword rotated right by 8; LDRSH from an odd address degrades to
    // LDRSB. Code (memcpy tails, packed readers) does rely on these rotations.
    _ldrWord(addr) {
      addr >>>= 0;
      const value = this.bus.read32(addr & ~3);
      const rot = (addr & 3) << 3;
      return rot ? ror32(value, rot) : value;
    }

    _ldrHalf(addr) {
      addr >>>= 0;
      const value = this.bus.read16(addr & ~1);
      return (addr & 1) ? ror32(value, 8) : value;
    }

    _ldrSignedHalf(addr) {
      addr >>>= 0;
      if (addr & 1) return signExtend8(this.bus.read8(addr)) >>> 0;
      return signExtend16(this.bus.read16(addr)) >>> 0;
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
        this._setReg(rd, byte ? this.bus.read8(addr) : this._ldrWord(addr));
      } else {
        const value = this._armStoreRegValue(rd);
        if (byte) this._writeMem8(addr, value, 'arm-byte-store', { rd, rn });
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

    _swp(instr) {
      const byte = !!(instr & 0x00400000);
      const rn = (instr >>> 16) & 0xf;
      const rd = (instr >>> 12) & 0xf;
      const rm = instr & 0xf;
      const addr = this._reg(rn);
      const pc = (this.regs[15] - 4) >>> 0;
      if (byte) {
        const old = this.bus.read8(addr);
        this._writeMem8(addr, this.regs[rm], 'arm-swpb', { rd, rn, rm });
        this._setReg(rd, old);
      } else {
        const old = this._ldrWord(addr);
        this._writeMem32(addr & ~3, this.regs[rm], 'arm-swp', { rd, rn, rm });
        this._setReg(rd, old);
      }
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
        if (sign && halfword) this._setReg(rd, this._ldrSignedHalf(addr));
        else if (sign) this._setReg(rd, signExtend8(this.bus.read8(addr)) >>> 0);
        else if (halfword) this._setReg(rd, this._ldrHalf(addr));
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

    // Swap banked r13/r14 (+ r8-r12 for FIQ) when the active CPSR mode changes.
    // Called from any place that can change the mode bits: MSR and CPSR-from-SPSR
    // exception returns. this.spsr always reflects "the current mode's SPSR" the
    // same way regs[13]/regs[14] reflect "the current mode's banked registers" --
    // swapped in _switchCpuMode rather than kept as 5 separate live fields.
    _switchCpuMode(newMode) {
      const oldMode = this.cpsr & 0x1f;
      newMode &= 0x1f;
      if (newMode === oldMode) return;
      if (oldMode === MODE_FIQ) {
        const b = this.bankedR8to12Fiq;
        b.r8 = this.regs[8]; b.r9 = this.regs[9]; b.r10 = this.regs[10]; b.r11 = this.regs[11]; b.r12 = this.regs[12];
      }
      const oldBank = this.bankedR13R14[oldMode];
      if (oldBank) { oldBank.r13 = this.regs[13]; oldBank.r14 = this.regs[14]; }
      if (oldMode in this.bankedSpsr) this.bankedSpsr[oldMode] = this.spsr;

      if (newMode === MODE_FIQ) {
        const b = this.bankedR8to12Fiq;
        this.regs[8] = b.r8; this.regs[9] = b.r9; this.regs[10] = b.r10; this.regs[11] = b.r11; this.regs[12] = b.r12;
      } else if (oldMode === MODE_FIQ) {
        // Leaving FIQ without entering it again: r8-r12 already hold the FIQ
        // values above; nothing else banks them, so no restore needed here --
        // the non-FIQ modes' r8-r12 are simply whatever was last live before FIQ
        // was entered, which real hardware doesn't restore automatically either
        // (FIQ's r8-r12 bank only round-trips through FIQ entry/exit).
      }
      const newBank = this.bankedR13R14[newMode];
      if (newBank) { this.regs[13] = newBank.r13; this.regs[14] = newBank.r14; }
      if (newMode in this.bankedSpsr) this.spsr = this.bankedSpsr[newMode];
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
      if (useSpsr) {
        this.spsr = after;
      } else {
        // Bank-switch while this.cpsr still reflects the *old* mode (it reads
        // `this.cpsr & 0x1f` to know what to save), then commit the new value.
        if (fieldMask & 0x1) this._switchCpuMode(after & 0x1f);
        this.cpsr = after;
      }
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
      const base = this._reg(rn);
      // ARMv4 empty-rlist quirk: R15 alone is transferred and the base moves by 0x40
      // (as if all 16 registers had been named). Some ROMs use this deliberately.
      if (count === 0) {
        const emptyAddr = up ? (pre ? (base + 4) >>> 0 : base) : (pre ? (base - 0x40) >>> 0 : (base - 0x3c) >>> 0);
        const emptyFinal = up ? (base + 0x40) >>> 0 : (base - 0x40) >>> 0;
        if (load) this._setReg(15, this.bus.read32(emptyAddr & ~3));
        else this._writeMem32(emptyAddr, this._armStoreRegValue(15), 'arm-block-store', { reg: 15, rn, emptyRlist: true });
        if (writeBack) this._setReg(rn, emptyFinal);
        return;
      }
      let addr;
      let finalBase;
      if (up) {
        addr = pre ? (base + 4) >>> 0 : base;
        finalBase = (base + count * 4) >>> 0;
      } else {
        addr = pre ? (base - count * 4) >>> 0 : (base - (count - 1) * 4) >>> 0;
        finalBase = (base - count * 4) >>> 0;
      }
      const baseInList = !!(list & (1 << rn));
      // STM with the base in the list stores the OLD base value only when it is the
      // first (lowest) register in the list; later positions store the written-back
      // value. LDM with the base in the list suppresses writeback (loaded value wins).
      const baseIsFirst = baseInList && (list & ((1 << rn) - 1)) === 0;
      const writeBackFirst = writeBack && (!load || !baseInList);
      if (writeBackFirst) this._setReg(rn, finalBase);
      for (let reg = 0; reg < 16; reg++) {
        if (!(list & (1 << reg))) continue;
        if (load) {
          this._setReg(reg, this.bus.read32(addr & ~3));
        } else {
          const value = (reg === rn && baseIsFirst) ? base : this._armStoreRegValue(reg);
          this._writeMem32(addr, value, 'arm-block-store', { reg, rn });
        }
        addr = (addr + 4) >>> 0;
      }
      if (writeBack && !writeBackFirst && !(load && baseInList)) this._setReg(rn, finalBase);
      // Exception return: LDM with S-bit, load=true, PC in list
      if (psr && load && (list & 0x8000)) {
        this._switchCpuMode(this.spsr & 0x1f); // bank-switch while this.cpsr still reflects the old mode
        this.cpsr = this.spsr; // restore CPSR from SPSR (mode switch back to interrupted mode)
      }
    }

    _blockDataTransferFast(instr) {
      const psr = !!(instr & 0x00400000);
      const list = instr & 0xffff;
      if (psr || (list & 0x8000) || list === 0) return this._blockDataTransfer(instr);

      const pre = !!(instr & 0x01000000);
      const up = !!(instr & 0x00800000);
      const writeBack = !!(instr & 0x00200000);
      const load = !!(instr & 0x00100000);
      const rn = (instr >>> 16) & 0xf;
      if (rn === 15) return this._blockDataTransfer(instr);

      const count = BIT_COUNT_16[list];
      const base = this.regs[rn] >>> 0;
      let addr;
      const finalBase = up ? (base + count * 4) >>> 0 : (base - count * 4) >>> 0;
      if (up) addr = pre ? (base + 4) >>> 0 : base;
      else addr = pre ? finalBase : (base - (count - 1) * 4) >>> 0;

      const baseInList = !!(list & (1 << rn));
      if (load) {
        if (writeBack && !baseInList) this.regs[rn] = finalBase;
        for (let reg = 0, bits = list; bits; reg++, bits >>>= 1) {
          if (!(bits & 1)) continue;
          this.regs[reg] = this.bus.read32FastRam(addr & ~3);
          addr = (addr + 4) >>> 0;
        }
      } else {
        const baseIsFirst = baseInList && (list & ((1 << rn) - 1)) === 0;
        if (writeBack) this.regs[rn] = finalBase;
        for (let reg = 0, bits = list; bits; reg++, bits >>>= 1) {
          if (!(bits & 1)) continue;
          const value = (reg === rn && baseIsFirst) ? base : (reg === 15 ? (this.regs[15] + 4) >>> 0 : this.regs[reg] >>> 0);
          this.bus.write32FastRam(addr & ~3, value);
          addr = (addr + 4) >>> 0;
        }
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
      if ((instr & 0xf200) === 0x5200) return this._thumbSignExtendLoadStore(instr);
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
      result >>>= 0;
      if (write) {
        if (this.fastMode && !this.diagnosticProbes) this.regs[rd] = result;
        else this._writeReg(rd, result, 'thumb-alu', (this.regs[15] - 2) >>> 0, { op });
      }
      this._setNZ(result);
      if (op === 0x5 || op === 0x6 || op === 0x9 || op === 0xa || op === 0xb) {
        this.cpsr = (this.cpsr & ~(CPSR_C | CPSR_V)) | (carry ? CPSR_C : 0) | (overflow ? CPSR_V : 0);
      } else if (op === 0x2 || op === 0x3 || op === 0x4 || op === 0x7) {
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
        this._recordIrqCall('thumb-bx', (this.regs[15] - 2) >>> 0, target);
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
      if (load) this._writeReg(rd, byte ? this.bus.read8(addr) : this._ldrWord(addr), 'thumb-reg-load', (this.regs[15] - 2) >>> 0, { addrHex: tools.hex(addr), byte });
      else if (byte) this._writeMem8(addr, this.regs[rd], 'thumb-reg-byte-store', { rd, rb, ro });
      else this._writeMem32(addr, this.regs[rd], 'thumb-reg-store', { rd, rb, ro });
    }

    _thumbSignExtendLoadStore(instr) {
      const h = !!(instr & 0x0800);
      const s = !!(instr & 0x0400);
      const ro = (instr >>> 6) & 7;
      const rb = (instr >>> 3) & 7;
      const rd = instr & 7;
      const addr = (this.regs[rb] + this.regs[ro]) >>> 0;
      const pc = (this.regs[15] - 2) >>> 0;
      if (!h && !s) {
        this._writeMem16(addr & ~1, this.regs[rd], 'thumb-strh', { rd, rb, ro });
      } else if (!h) {
        this._writeReg(rd, signExtend8(this.bus.read8(addr)) >>> 0, 'thumb-ldsb', pc, { addrHex: tools.hex(addr) });
      } else if (!s) {
        this._writeReg(rd, this._ldrHalf(addr), 'thumb-ldrh', pc, { addrHex: tools.hex(addr) });
      } else {
        this._writeReg(rd, this._ldrSignedHalf(addr), 'thumb-ldsh', pc, { addrHex: tools.hex(addr) });
      }
    }

    _thumbImmLoadStore(instr) {
      const load = !!(instr & 0x0800);
      const byte = !!(instr & 0x1000);
      const imm = (instr >>> 6) & 0x1f;
      const rb = (instr >>> 3) & 7;
      const rd = instr & 7;
      const off = byte ? imm : imm << 2;
      const addr = (this.regs[rb] + off) >>> 0;
      if (load) this._writeReg(rd, byte ? this.bus.read8(addr) : this._ldrWord(addr), 'thumb-imm-load', (this.regs[15] - 2) >>> 0, { addrHex: tools.hex(addr), byte });
      else if (byte) this._writeMem8(addr, this.regs[rd], 'thumb-imm-byte-store', { rd, rb });
      else this._writeMem32(addr, this.regs[rd], 'thumb-imm-store', { rd, rb });
    }

    _thumbHalfwordLoadStore(instr) {
      const load = !!(instr & 0x0800);
      const imm = ((instr >>> 6) & 0x1f) << 1;
      const rb = (instr >>> 3) & 7;
      const rd = instr & 7;
      const addr = (this.regs[rb] + imm) >>> 0;
      if (load) this._writeReg(rd, this._ldrHalf(addr), 'thumb-halfword-load', (this.regs[15] - 2) >>> 0, { addrHex: tools.hex(addr & ~1) });
      else this._writeMem16(addr, this.regs[rd], 'thumb-halfword-store', { rd, rb });
    }

    _thumbSpLoadStore(instr) {
      const load = !!(instr & 0x0800);
      const rd = (instr >>> 8) & 7;
      const addr = (this.regs[13] + ((instr & 0xff) << 2)) >>> 0;
      if (load) this._writeReg(rd, this._ldrWord(addr), 'thumb-sp-load', (this.regs[15] - 2) >>> 0, { addrHex: tools.hex(addr & ~3) });
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
      // ARMv4 empty-rlist quirk (no registers, no LR/PC bit): R15 transfers, SP +/- 0x40.
      if (!list && !extra) {
        if (pop) {
          this._setRegThumb(15, this.bus.read32(this.regs[13] & ~3));
          this._writeReg(13, (this.regs[13] + 0x40) >>> 0, 'thumb-pop-sp', (this.regs[15] - 2) >>> 0);
        } else {
          this._writeReg(13, (this.regs[13] - 0x40) >>> 0, 'thumb-push-sp', (this.regs[15] - 2) >>> 0);
          this._writeMem32(this.regs[13], (this.regs[15] + 4) >>> 0, 'thumb-push', { reg: 15, emptyRlist: true });
        }
        return;
      }
      if (this.fastMode && !this.diagnosticProbes) {
        if (pop) {
          let sp = this.regs[13] >>> 0;
          for (let r = 0; r < 8; r++) {
            if (!(list & (1 << r))) continue;
            this.regs[r] = this.bus.read32(sp & ~3) >>> 0;
            sp = (sp + 4) >>> 0;
          }
          if (extra) {
            const target = this.bus.read32(sp & ~3) >>> 0;
            this.regs[15] = target & ~1;
            sp = (sp + 4) >>> 0;
          }
          this.regs[13] = sp;
        } else {
          const count = this._bitCount(list) + (extra ? 1 : 0);
          let addr = (this.regs[13] - count * 4) >>> 0;
          this.regs[13] = addr;
          for (let r = 0; r < 8; r++) {
            if (!(list & (1 << r))) continue;
            this.bus.write32(addr & ~3, this.regs[r] >>> 0);
            addr = (addr + 4) >>> 0;
          }
          if (extra) this.bus.write32(addr & ~3, this.regs[14] >>> 0);
        }
        return;
      }
      if (pop) {
        for (let r = 0; r < 8; r++) {
          if (!(list & (1 << r))) continue;
          const addr = this.regs[13] & ~3;
          const value = this.bus.read32(addr);
          this.bus._noteStackCrashRead(addr, value, (this.regs[15] - 2) >>> 0, `pop-r${r}`);
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
          this.bus._noteStackCrashRead(addr, target, (this.regs[15] - 2) >>> 0, 'pop-pc');
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
      // ARMv4 empty-rlist quirk: R15 is transferred and the base advances by 0x40.
      if (!list) {
        if (load) this._setRegThumb(15, this.bus.read32(addr & ~3));
        else this._writeMem32(addr, (this.regs[15] + 4) >>> 0, 'thumb-multi-store', { r: 15, rb, emptyRlist: true });
        this.regs[rb] = (addr + 0x40) >>> 0;
        return;
      }
      // STMIA with rb in the list stores the OLD base only when rb is the first
      // (lowest) register in the list; later positions store the written-back value.
      const rbIsFirst = rbInList && (list & ((1 << rb) - 1)) === 0;
      const finalAddr = (addr + this._bitCount(list) * 4) >>> 0;
      for (let r = 0; r < 8; r++) {
        if (!(list & (1 << r))) continue;
        if (load) {
          const detail = this.fastMode ? { rb } : { addrHex: tools.hex(addr & ~3), rb };
          this._writeReg(r, this.bus.read32(addr & ~3), 'thumb-multi-load', (this.regs[15] - 2) >>> 0, detail);
        }
        else {
          const value = (r === rb && !rbIsFirst) ? finalAddr : this.regs[r];
          this._writeMem32(addr, value, 'thumb-multi-store', { r, rb });
        }
        addr = (addr + 4) >>> 0;
      }
      if (!load || !rbInList) this.regs[rb] = addr >>> 0;
    }

    _thumbCondBranch(instr, pc) {
      const cond = (instr >>> 8) & 0xf;
      if (cond === 0xf) return this._swi(instr & 0xff, pc, 'thumb');
      if (cond === 0xe) {
        // ARM7TDMI hardware treats cond=0xE as BAL (always) even though the Thumb spec marks it
        // undefined. This encoding is used as a tight backward branch in IWRAM mixer loops.
        const imm = instr & 0xff;
        const off = ((imm & 0x80 ? imm | 0xffffff00 : imm) << 1) >> 0;
        const target = (pc + 4 + off) >>> 0;
        this._recordBranch('thumb-bal', pc, target, { cond });
        this.regs[15] = target;
        return;
      }
      if (!this._conditionPassed(cond)) return;
      const imm = instr & 0xff;
      const off = ((imm & 0x80 ? imm | 0xffffff00 : imm) << 1) >> 0;
      const target = (pc + 4 + off) >>> 0;
      this._recordBranch('thumb-cond-branch', pc, target, { cond });
      this.regs[15] = target;
    }

    _swi(num, pc, state) {
      this.swiCounts[num & 0xff]++;
      if (this.fastMode && !this.diagnosticProbes) {
        try {
          if (num === 0x02 || num === 0x03) this._biosHalt(pc);
          else if (num === 0x04) this._biosIntrWait();
          else if (num === 0x05) this._biosVBlankIntrWait();
          else if (num === 0x06) this._biosDiv(false);
          else if (num === 0x07) this._biosDiv(true);
          else if (num === 0x08) this._biosSqrt();
          else if (num === 0x09) this._biosArcTan();
          else if (num === 0x0a) this._biosArcTan2();
          else if (num === 0x0b) this._biosCpuSet();
          else if (num === 0x0c) this._biosCpuFastSet();
          else if (num === 0x10) this._biosBitUnPack();
          else if (num === 0x11 || num === 0x12) this._biosLz77UnComp();
          else if (num === 0x13) this._biosHuffUnComp();
          else if (num === 0x14 || num === 0x15) this._biosRlUnComp();
          else if (num === 0x16 || num === 0x17) this._biosDiffUnFilter(false);
          else if (num === 0x18) this._biosDiffUnFilter(true);
          else if (num === 0x19) this._biosSoundBias();
          else if (num === 0x1f) this._biosMidiKey2Freq();
        } catch (err) {
          this.halted = true;
          this.reason = `SWI ${tools.hex(num, 2)} failed at ${tools.hex(pc)}: ${err.message}`;
        }
        this.bus.biosOpenBus = 0xe3a02004;
        return;
      }
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
        if (num === 0x00) call.result = this._biosSoftReset();
        else if (num === 0x01) call.result = this._biosRegisterRamReset();
        else if (num === 0x02) call.result = this._biosHalt(pc);
        // Stop (0x03) powers down more than Halt (only keypad/SIO/cart IRQs wake it),
        // but for headless GSF playback waking on any enabled IRQ is the right shape.
        else if (num === 0x03) call.result = this._biosHalt(pc);
        else if (num === 0x04) call.result = this._biosIntrWait();
        else if (num === 0x05) call.result = this._biosVBlankIntrWait();
        else if (num === 0x06) call.result = this._biosDiv(false);
        else if (num === 0x07) call.result = this._biosDiv(true);
        else if (num === 0x08) call.result = this._biosSqrt();
        else if (num === 0x09) call.result = this._biosArcTan();
        else if (num === 0x0a) call.result = this._biosArcTan2();
        else if (num === 0x0b) call.result = this._biosCpuSet();
        else if (num === 0x0c) call.result = this._biosCpuFastSet();
        else if (num === 0x10) call.result = this._biosBitUnPack();
        else if (num === 0x11 || num === 0x12) call.result = this._biosLz77UnComp();
        else if (num === 0x13) call.result = this._biosHuffUnComp();
        else if (num === 0x14 || num === 0x15) call.result = this._biosRlUnComp();
        else if (num === 0x16 || num === 0x17) call.result = this._biosDiffUnFilter(false);
        else if (num === 0x18) call.result = this._biosDiffUnFilter(true);
        else if (num === 0x19) call.result = this._biosSoundBias();
        else if (num === 0x1f) call.result = this._biosMidiKey2Freq();
        else {
          call.result = 'stubbed';
          // A silently-stubbed BIOS call is a whole class of "mysteriously wrong on some
          // ROMs" bugs (wrong pitches, missing unpacked data). Warn loudly, once per SWI.
          if (!this._stubbedSwiWarned) this._stubbedSwiWarned = new Set();
          if (!this._stubbedSwiWarned.has(num & 0xff)) {
            this._stubbedSwiWarned.add(num & 0xff);
            console.warn(`[GsfEngine] Unimplemented BIOS call SWI ${tools.hex(num, 2)} (${this._swiName(num)}) at ${tools.hex(pc)} — emulation may be incorrect for this ROM`);
          }
        }
      } catch (err) {
        call.result = 'error';
        call.error = err.message;
        this.halted = true;
        this.reason = `SWI ${tools.hex(num, 2)} ${call.name} failed at ${tools.hex(pc)}: ${err.message}`;
      }
      // BIOS open-bus latch: after any SWI the last BIOS opcode fetched is the
      // documented post-SWI value (GBATEK "reading from BIOS memory").
      this.bus.biosOpenBus = 0xe3a02004;
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

    // Halt wakes on ANY enabled IRQ (IE&IF, regardless of IME) the moment it fires.
    // Advancing in scanline slices instead of whole frames means mid-frame timer IRQs —
    // which timer-driven PCM/sequencer engines depend on — wake the CPU within ~1232
    // cycles of firing instead of being coalesced once per frame at the VBlank boundary.
    _biosHalt(pc = this.regs[15] >>> 0) {
      this._recordHaltEvent('before', pc);
      const MAX_SLICES = GBA_TOTAL_SCANLINES * 8; // 8 frames worth
      let slices = 0;
      while (!this.bus.haltPendingIrq() && slices < MAX_SLICES) {
        this.bus.advanceScanline();
        slices++;
      }
      this._checkAndDispatchIrq(); // internally gated on CPSR.I, IME, and nesting depth
      this._recordHaltEvent('after', pc);
      return `halted ${slices} scanline${slices === 1 ? '' : 's'}`;
    }

    _biosIntrWait() {
      return this._intrWaitCore(!!this.regs[0], this.regs[1] & 0xffff, false);
    }

    _biosVBlankIntrWait() {
      // VBlankIntrWait is IntrWait(1, 1). Keep the historical IE|=VBLANK safety net for
      // minimal rips whose init path never runs far enough to set IE itself.
      return this._intrWaitCore(true, IRQ_VBLANK, true);
    }

    // Real BIOS IntrWait semantics: force IME=1, halt until an enabled IRQ fires, run the
    // user ISR, then check the BIOS IRQ flags halfword at 0x03007FF8 — which the ISR is
    // responsible for setting — against the wait mask, clearing satisfied bits before
    // returning. Waiting on IF directly (the old behavior) could never be satisfied by a
    // well-behaved ISR, since those acknowledge IF before returning.
    _intrWaitCore(discardOld, mask, forceEnableVBlank) {
      const BIOS_FLAGS = 0x03007ff8;
      if (forceEnableVBlank) this.bus.write16(0x04000200, this.bus.read16(0x04000200) | IRQ_VBLANK);
      this.bus.write16(0x04000208, 1); // BIOS IntrWait forcefully sets IME=1
      if (discardOld) {
        this.bus.write16(BIOS_FLAGS, this.bus.read16(BIOS_FLAGS) & ~mask);
        this.bus.write16(0x04000202, mask); // acknowledge stale IF so we wait for a fresh edge
      }
      const MAX_SLICES = GBA_TOTAL_SCANLINES * 8;
      let sawHwIrq = false;
      for (let slices = 0; slices < MAX_SLICES; slices++) {
        const flags = this.bus.read16(BIOS_FLAGS);
        if (flags & mask) {
          this.bus.write16(BIOS_FLAGS, flags & ~mask);
          return `intrwait ${tools.hex(mask, 4)} satisfied after ${slices} scanlines`;
        }
        // Degenerate handlers (e.g. the GSF idle stub) never mirror IF into 0x03007FF8;
        // once the requested IRQ has been observed on the wire, fall back to returning
        // rather than spinning to the cap on every single wait call.
        if (sawHwIrq && !this.bus.biosIrqFlagsWritten) {
          return `intrwait ${tools.hex(mask, 4)} if-fallback after ${slices} scanlines`;
        }
        this.bus.advanceScanline();
        if (this.bus.haltPendingIrq(mask)) sawHwIrq = true;
        this._checkAndDispatchIrq(); // internally gated on CPSR.I, IME, and nesting depth
      }
      return `intrwait ${tools.hex(mask, 4)} timeout`;
    }

    _checkAndDispatchIrq() {
      // Hardware IRQ gate: CPSR.I masks IRQs. Handlers enter with I=1; if one clears it
      // (mp2k's SoundMain does, so a long mix can be preempted by the next VBlank) the
      // pending IRQ nests exactly like hardware. Depth-capped as a runaway guard.
      if (this.cpsr & 0x80) return;
      if ((this._irqDepth || 0) >= 4) return;
      if (!(this.bus.io[0x208] & 1)) return;
      const ie  = this.bus.io[0x200] | (this.bus.io[0x201] << 8);
      const ifl = this.bus.io[0x202] | (this.bus.io[0x203] << 8);
      const pending = ie & ifl & 0x3fff;
      if (!pending) return;
      const handlerAddr = this.bus.read32(0x03007FFC);
      // Require handler to be in ROM/EWRAM/IWRAM (not zero/unmapped)
      if (!handlerAddr || handlerAddr < 0x02000000) {
        this._recordIrqDispatch({ result: 'no-handler', ie, ifl, pending, handlerAddr });
        return;
      }
      if (this._isGsfIdleIrqHandler(handlerAddr)) {
        this._clearPendingIrq(pending);
        this._recordIrqDispatch({ result: 'idle-loop', ie, ifl, pending, handlerAddr });
        return;
      }
      this._recordIrqDispatch({ result: 'dispatch', ie, ifl, pending, handlerAddr });
      this._runIrqHandler(handlerAddr, pending);
    }

    _isGsfIdleIrqHandler(handlerAddr) {
      const addr = handlerAddr & ~1;
      return this.bus.read32((addr - 4) >>> 0) === 0xef020000 && this.bus.read32(addr) === 0xeafffffd;
    }

    _clearPendingIrq(pending) {
      const ifl = this.bus.io[0x202] | (this.bus.io[0x203] << 8);
      this.bus.io[0x202] = (ifl & ~pending) & 0xff;
      this.bus.io[0x203] = ((ifl & ~pending) >> 8) & 0xff;
    }

    _recordIrqDispatch(entry) {
      if (this.fastMode && !this.diagnosticProbes) return;
      this.irqDispatches.push({
        cycles: this.bus.cycles,
        pcHex: tools.hex(this.regs[15]),
        ieHex: tools.hex(entry.ie || 0, 4),
        ifHex: tools.hex(entry.ifl || 0, 4),
        pendingHex: tools.hex(entry.pending || 0, 4),
        handlerHex: tools.hex(entry.handlerAddr || 0),
        result: entry.result,
        steps: entry.steps || 0,
        reason: entry.reason || '',
      });
      if (this.irqDispatches.length > 64) this.irqDispatches.shift();
      // Update step stats for understanding when channels are active (only count actual handler runs)
      const st = this.irqStepStats;
      const s = entry.steps || 0;
      if (entry.result !== 'dispatch' && s > 0) {
        st.total += s; st.count++;
        if (s < st.min) st.min = s;
        if (s > st.max) st.max = s;
        // Estimate baseline (min observed steps when presumably 0 active channels)
        if (st.count >= 16 && st.min < 50000) st.baselineEstimate = st.min;
        // Track first VBL with significantly more steps than baseline (= first active channel)
        const thresh = st.baselineEstimate > 0 ? st.baselineEstimate + 200 : 0;
        if (thresh > 0 && s > thresh) {
          if (st.firstActiveVbl < 0) st.firstActiveVbl = st.count;
          st.activeVbls++;
        }
      }
    }

    _recordIrqCall(kind, pc, target) {
      if (this.fastMode && !this.diagnosticProbes) return;
      if (!this._inIrqDispatch) return;
      const _callEntry = {
        kind,
        pcHex: tools.hex(pc),
        targetHex: tools.hex(target),
        lrHex: tools.hex(this.regs[14]),
        thumb: !!(this.cpsr & CPSR_T),
      };
      this.irqCallTargets.push(_callEntry);
      if (this.irqCallTargets.length > 64) this.irqCallTargets.shift();
      if (this.irqCallTargetsFirst.length < 16) this.irqCallTargetsFirst.push(_callEntry);
    }

    _recordHaltEvent(phase, pc) {
      if (this.fastMode && !this.diagnosticProbes) return;
      const dma = ch => {
        const base = 0x040000b0 + ch * 12;
        return {
          ch,
          srcHex: tools.hex(this.bus.read32(base)),
          liveSrcHex: tools.hex(this.bus.dmaSourceLatch[ch] || this.bus.read32(base)),
          dstHex: tools.hex(this.bus.read32(base + 4)),
          liveDstHex: tools.hex(this.bus.dmaDestLatch[ch] || this.bus.read32(base + 4)),
          cntHex: tools.hex(this.bus.read16(base + 10), 4),
        };
      };
      this.haltEvents.push({
        phase,
        pcHex: tools.hex(pc),
        cycles: this.bus.cycles,
        frameCycles: this.bus.frameCycles,
        ime: this.bus.read16(0x04000208) & 1,
        ieHex: tools.hex(this.bus.read16(0x04000200), 4),
        ifHex: tools.hex(this.bus.read16(0x04000202), 4),
        wake: this.bus.haltPendingIrq(),
        dispatchable: this.bus.pendingIrq(),
        handlerHex: tools.hex(this.bus.read32(0x03007ffc)),
        dma1: dma(1),
        dma2: dma(2),
      });
      if (this.haltEvents.length > 32) this.haltEvents.shift();
    }

    _runIrqHandler(handlerAddr, pending) {
      this._irqDepth = (this._irqDepth || 0) + 1;
      this._inIrqDispatch = true;

      // Save full CPU state
      if (!this._irqSavedRegsStack) this._irqSavedRegsStack = [];
      const savedSlot = this._irqDepth - 1;
      const savedRegs = this._irqSavedRegsStack[savedSlot] || (this._irqSavedRegsStack[savedSlot] = new Uint32Array(16));
      savedRegs.set(this.regs);
      const savedCpsr = this.cpsr;
      const savedSpsr = this.spsr;
      const savedHalted = this.halted;
      const savedReason = this.reason;

      // Enter IRQ mode via the same bank-switch path a real MSR/exception would take,
      // so the outgoing (interrupted) mode's r13/r14 land in its own bank -- if the
      // handler itself does an internal CPSR mode switch (e.g. back to System to call
      // something), it needs to see the *actual* interrupted stack pointer there, not
      // whatever IRQ's r13 happens to hold mid-handler.
      this._switchCpuMode(MODE_IRQ);
      this.spsr = savedCpsr; // so LDMFD {PC}^ or SUBS PC, LR, #4 restores CPSR correctly
      // CPSR: IRQ mode (0x12), I=1 (disable further IRQs), ARM
      this.cpsr = (savedCpsr & 0xffffff00) | 0x92;

      // Replicate the BIOS IRQ wrapper's stack frame: STMFD sp!,{r0-r3,r12,lr} then
      // MOV r0,#0x04000000 before jumping through [0x03007FFC]. Handlers commonly use
      // the r0 = IO-base convention (e.g. LDRH r1,[r0,#0x200] to read IE), and some
      // inspect the stacked lr; without the frame both saw stale interrupted-context
      // values. The stacked lr is the interrupted PC + 4, as hardware IRQ entry sets it.
      const spBeforePush = this.regs[13] >>> 0;
      const frameBase = (spBeforePush - 24) >>> 0;
      if (this.fastMode && !this.diagnosticProbes && frameBase >= 0x03000000 && frameBase + 24 <= 0x03008000) {
        const mem = this.bus.iwram;
        let off = (frameBase - 0x03000000) & 0x7fff;
        let value = savedRegs[0] >>> 0;
        mem[off] = value & 0xff; mem[off + 1] = (value >>> 8) & 0xff; mem[off + 2] = (value >>> 16) & 0xff; mem[off + 3] = value >>> 24; off += 4;
        value = savedRegs[1] >>> 0;
        mem[off] = value & 0xff; mem[off + 1] = (value >>> 8) & 0xff; mem[off + 2] = (value >>> 16) & 0xff; mem[off + 3] = value >>> 24; off += 4;
        value = savedRegs[2] >>> 0;
        mem[off] = value & 0xff; mem[off + 1] = (value >>> 8) & 0xff; mem[off + 2] = (value >>> 16) & 0xff; mem[off + 3] = value >>> 24; off += 4;
        value = savedRegs[3] >>> 0;
        mem[off] = value & 0xff; mem[off + 1] = (value >>> 8) & 0xff; mem[off + 2] = (value >>> 16) & 0xff; mem[off + 3] = value >>> 24; off += 4;
        value = savedRegs[12] >>> 0;
        mem[off] = value & 0xff; mem[off + 1] = (value >>> 8) & 0xff; mem[off + 2] = (value >>> 16) & 0xff; mem[off + 3] = value >>> 24; off += 4;
        value = (savedRegs[15] + 4) >>> 0;
        mem[off] = value & 0xff; mem[off + 1] = (value >>> 8) & 0xff; mem[off + 2] = (value >>> 16) & 0xff; mem[off + 3] = value >>> 24;
      } else {
        const frameValues = [savedRegs[0], savedRegs[1], savedRegs[2], savedRegs[3], savedRegs[12], (savedRegs[15] + 4) >>> 0];
        for (let i = 0; i < 6; i++) {
          const slotAddr = (frameBase + i * 4) >>> 0;
          this.bus.write32(slotAddr, frameValues[i] >>> 0);
          this.bus.noteMemoryWrite(slotAddr, frameValues[i] >>> 0, 4, { kind: 'bios-irq-frame' });
        }
      }
      this.regs[13] = frameBase;
      this.regs[0] = 0x04000000;

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

      // Run handler until it returns to sentinel or halts. A mixer/IRQ handler
      // can legitimately need tens of thousands of steps (e.g. a full m4a
      // channel-mixing pass), regardless of where the ROM places it -- capping
      // this too low forcibly truncates the handler mid-execution, which
      // discards its in-progress register state (via the restore below) while
      // leaving its memory writes in place, corrupting engine state.
      const MAX_HANDLER_STEPS = this.fastMode ? 65536 : 500000;
      const traceThisDispatch = this.diagnosticProbes && (pending & IRQ_VBLANK) !== 0;
      if (traceThisDispatch) this.bus._beginIrqPcTrace();
      const vblBeforeHandler = this.bus.vblankCount;
      let count = 0;
      if (this.fastMode && !this.diagnosticProbes) {
        while (count < MAX_HANDLER_STEPS) {
          if (this.regs[15] === SENTINEL || this.halted) break;
          this._stepFast();
          count++;
        }
      } else {
        while (count < MAX_HANDLER_STEPS) {
          if (this.regs[15] === SENTINEL || this.halted) break;
          if (traceThisDispatch) this.bus._recordIrqPcTraceStep(this.regs[15] >>> 0);
          this.step();
          count++;
        }
      }
      if (traceThisDispatch) this.bus._endIrqPcTrace();
      const result = this.regs[15] === SENTINEL ? 'returned' : this.halted ? 'halted' : 'capped';
      if (traceThisDispatch) {
        // How many *additional* real VBlanks fired while this handler was still
        // running (their IF bit gets coalesced into the one already-pending
        // VBLANK bit and never gets its own dispatch) -- tests the hypothesis
        // that the handler's own runtime frequently overruns a frame boundary.
        const vblSpan = this.bus.vblankCount - vblBeforeHandler;
        this.bus._handlerVblSpanTotal = (this.bus._handlerVblSpanTotal || 0) + vblSpan;
        this.bus._handlerVblSpanCount = (this.bus._handlerVblSpanCount || 0) + 1;
        this.bus._handlerVblSpanMax = Math.max(this.bus._handlerVblSpanMax || 0, vblSpan);
        this.bus._handlerCappedCount = (this.bus._handlerCappedCount || 0) + (result === 'capped' ? 1 : 0);
      }
      this._recordIrqDispatch({
        result,
        pending,
        handlerAddr,
        steps: count,
        reason: this.halted ? this.reason : '',
      });

      // Save updated IRQ stack pointer. On a clean return the BIOS wrapper would pop
      // its 6-word frame (LDMFD sp!,{r0-r3,r12,lr}), so add 24 back to whatever the
      // (balanced) handler left; read from the bank rather than this.regs[13] directly
      // in case the handler is sitting in a different CPSR mode at the sentinel. On a
      // capped/halted run, reset to the pre-dispatch value rather than trust a pointer
      // the handler never got to unwind.
      if (result === 'returned') {
        const spAtReturn = (this.cpsr & 0x1f) === MODE_IRQ ? this.regs[13] : this.bankedR13R14[MODE_IRQ].r13;
        this.r13_irq = (spAtReturn + 24) >>> 0;
      } else {
        this.r13_irq = spBeforePush;
      }
      this.bankedR13R14[MODE_IRQ].r13 = this.r13_irq;

      // Restore CPU state to pre-IRQ values
      this.regs.set(savedRegs);
      this.cpsr = savedCpsr;
      this.spsr = savedSpsr;
      this.halted = savedHalted;
      this.reason = savedReason;

      // BIOS open-bus latch: documented post-IRQ value (the BIOS return sequence's
      // final opcode). Anti-piracy checks distinguish this from the post-SWI value.
      this.bus.biosOpenBus = 0xe55ec002;

      this._irqDepth--;
      this._inIrqDispatch = this._irqDepth > 0;
    }

    _biosSoftReset() {
      // Read the return-address flag before clearing the BIOS work area that holds it.
      const flag = this.bus.read8(0x03007ffa);
      for (let off = 0x7e00; off < 0x8000; off++) this.bus.iwram[off] = 0;
      this.bankedR13R14[MODE_SUPERVISOR].r13 = 0x03007fe0;
      this.bankedR13R14[MODE_IRQ].r13 = 0x03007fa0;
      this.r13_irq = 0x03007fa0;
      this._switchCpuMode(MODE_SYSTEM);
      this.cpsr = MODE_SYSTEM; // ARM state, IRQs enabled
      for (let i = 0; i <= 12; i++) this.regs[i] = 0;
      this.regs[13] = 0x03007f00;
      this.regs[14] = 0;
      this.regs[15] = flag ? 0x02000000 : 0x08000000;
      this._recordBranch('bios-softreset', 0, this.regs[15]);
      return `softreset -> ${tools.hex(this.regs[15])}`;
    }

    _biosRegisterRamReset() {
      const flags = this.regs[0] & 0xff;
      if (flags & 0x01) this.bus.ewram.fill(0);
      if (flags & 0x02) { // IWRAM excluding the topmost 0x200 bytes (stacks/BIOS area)
        for (let off = 0; off < 0x7e00; off++) this.bus.iwram[off] = 0;
      }
      if (flags & 0x04) this.bus.palette.fill(0);
      if (flags & 0x08) this.bus.vram.fill(0);
      if (flags & 0x10) this.bus.oam.fill(0);
      if (flags & 0x40) { // sound registers
        for (let addr = 0x04000060; addr < 0x040000b0; addr += 2) this.bus.write16(addr, 0);
      }
      return `ramreset flags=${tools.hex(flags, 2)}`;
    }

    // GBA LZ77 (type 0x10 header): u32 header with unpacked size in bits 8-31, then
    // flag-byte-prefixed groups of 8 blocks; flag bit set = back-reference (length 3-18,
    // displacement 1-4096), clear = literal byte. The Wram/Vram variants differ only in
    // write granularity on hardware; our bus accepts byte writes everywhere.
    _biosLz77UnComp() {
      let src = this.regs[0] >>> 0;
      let dst = this.regs[1] >>> 0;
      const dst0 = dst;
      let remaining = this.bus.read32(src & ~3) >>> 8;
      src = (src + 4) >>> 0;
      if (remaining > 0x400000) throw new Error(`unreasonable LZ77 size ${remaining}`);
      while (remaining > 0) {
        let flags = this.bus.read8(src); src = (src + 1) >>> 0;
        for (let b = 0; b < 8 && remaining > 0; b++, flags = (flags << 1) & 0xff) {
          if (flags & 0x80) {
            const b0 = this.bus.read8(src); src = (src + 1) >>> 0;
            const b1 = this.bus.read8(src); src = (src + 1) >>> 0;
            let len = (b0 >>> 4) + 3;
            const disp = (((b0 & 0xf) << 8) | b1) + 1;
            while (len-- > 0 && remaining > 0) {
              this._writeMem8(dst, this.bus.read8((dst - disp) >>> 0), 'bios-lz77');
              dst = (dst + 1) >>> 0;
              remaining--;
            }
          } else {
            this._writeMem8(dst, this.bus.read8(src), 'bios-lz77');
            src = (src + 1) >>> 0;
            dst = (dst + 1) >>> 0;
            remaining--;
          }
        }
      }
      return `lz77 ${tools.hex(this.regs[0])}->${tools.hex(dst0)} ${(dst - dst0) >>> 0} bytes`;
    }

    // GBA run-length (type 0x30 header): flag byte bit7 set = run of (len&0x7f)+3 copies
    // of the next byte; clear = (len&0x7f)+1 raw bytes.
    _biosRlUnComp() {
      let src = this.regs[0] >>> 0;
      let dst = this.regs[1] >>> 0;
      const dst0 = dst;
      let remaining = this.bus.read32(src & ~3) >>> 8;
      src = (src + 4) >>> 0;
      if (remaining > 0x400000) throw new Error(`unreasonable RL size ${remaining}`);
      while (remaining > 0) {
        const flag = this.bus.read8(src); src = (src + 1) >>> 0;
        if (flag & 0x80) {
          let len = (flag & 0x7f) + 3;
          const value = this.bus.read8(src); src = (src + 1) >>> 0;
          while (len-- > 0 && remaining > 0) { this._writeMem8(dst, value, 'bios-rl'); dst = (dst + 1) >>> 0; remaining--; }
        } else {
          let len = (flag & 0x7f) + 1;
          while (len-- > 0 && remaining > 0) {
            this._writeMem8(dst, this.bus.read8(src), 'bios-rl');
            src = (src + 1) >>> 0; dst = (dst + 1) >>> 0; remaining--;
          }
        }
      }
      return `rl ${tools.hex(this.regs[0])}->${tools.hex(dst0)} ${(dst - dst0) >>> 0} bytes`;
    }

    _biosDiffUnFilter(is16bit) {
      let src = this.regs[0] >>> 0;
      let dst = this.regs[1] >>> 0;
      const size = this.bus.read32(src & ~3) >>> 8;
      src = (src + 4) >>> 0;
      if (size > 0x400000) throw new Error(`unreasonable Diff size ${size}`);
      let prev = 0;
      if (is16bit) {
        for (let i = 0; i + 2 <= size; i += 2) {
          prev = (prev + this.bus.read16(src)) & 0xffff;
          this._writeMem16(dst, prev, 'bios-diff16');
          src = (src + 2) >>> 0; dst = (dst + 2) >>> 0;
        }
      } else {
        for (let i = 0; i < size; i++) {
          prev = (prev + this.bus.read8(src)) & 0xff;
          this._writeMem8(dst, prev, 'bios-diff8');
          src = (src + 1) >>> 0; dst = (dst + 1) >>> 0;
        }
      }
      return `diff${is16bit ? 16 : 8} ${size} bytes`;
    }

    _biosBitUnPack() {
      let src = this.regs[0] >>> 0;
      let dst = this.regs[1] >>> 0;
      const info = this.regs[2] >>> 0;
      const srcLen = this.bus.read16(info);
      const srcWidth = this.bus.read8(info + 2);
      const dstWidth = this.bus.read8(info + 3);
      const dataOffset = this.bus.read32(info + 4) >>> 0;
      const ofs = dataOffset & 0x7fffffff;
      const zeroFlag = !!(dataOffset & 0x80000000);
      if (![1, 2, 4, 8].includes(srcWidth) || ![1, 2, 4, 8, 16, 32].includes(dstWidth)) {
        throw new Error(`BitUnPack widths ${srcWidth}->${dstWidth} unsupported`);
      }
      let outBuf = 0;
      let outBits = 0;
      const srcMask = (1 << srcWidth) - 1;
      for (let i = 0; i < srcLen; i++) {
        const byte = this.bus.read8((src + i) >>> 0);
        for (let bit = 0; bit < 8; bit += srcWidth) {
          let unit = (byte >>> bit) & srcMask;
          if (unit || zeroFlag) unit = (unit + ofs) >>> 0;
          outBuf = (outBuf | (unit << outBits)) >>> 0;
          outBits += dstWidth;
          if (outBits >= 32) {
            this._writeMem32(dst, outBuf, 'bios-bitunpack');
            dst = (dst + 4) >>> 0;
            outBuf = 0;
            outBits = 0;
          }
        }
      }
      return `bitunpack ${srcLen} bytes ${srcWidth}->${dstWidth}`;
    }

    // GBA Huffman (type 0x20 header): a byte-coded binary tree followed by a bitstream
    // read MSB-first from 32-bit words. Non-leaf node byte: bits 0-5 = offset (children
    // live at (nodeAddr & ~1) + offset*2 + 2, node0 then node1), bit 7 = node0-is-data,
    // bit 6 = node1-is-data. Decoded units (4 or 8 bits) pack LSB-first into 32-bit
    // output words, which is why the BIOS variant is VRAM-safe.
    _biosHuffUnComp() {
      const src = this.regs[0] >>> 0;
      let dst = this.regs[1] >>> 0;
      const dst0 = dst;
      const header = this.bus.read32(src & ~3) >>> 0;
      const dataBits = header & 0xf;
      if (dataBits !== 4 && dataBits !== 8) throw new Error(`Huffman data size ${dataBits} unsupported`);
      let remaining = header >>> 8;
      if (remaining > 0x400000) throw new Error(`unreasonable Huffman size ${remaining}`);
      const treeSizeByte = this.bus.read8((src + 4) >>> 0);
      const rootAddr = (src + 5) >>> 0;
      let bitsAddr = (src + 4 + (treeSizeByte + 1) * 2) >>> 0;
      const dataMask = (1 << dataBits) - 1;
      let nodeAddr = rootAddr;
      let bitWord = 0;
      let bitsLeft = 0;
      let outBuf = 0;
      let outBits = 0;
      let guard = remaining * 64 + 1024; // no valid stream needs more bits than this
      while (remaining > 0) {
        if (--guard < 0) throw new Error('Huffman stream did not terminate');
        if (!bitsLeft) {
          bitWord = this.bus.read32(bitsAddr & ~3) >>> 0;
          bitsAddr = (bitsAddr + 4) >>> 0;
          bitsLeft = 32;
        }
        const bit = bitWord >>> 31;
        bitWord = (bitWord << 1) >>> 0;
        bitsLeft--;
        const node = this.bus.read8(nodeAddr);
        const childAddr = (((nodeAddr & ~1) + ((node & 0x3f) * 2) + 2) + bit) >>> 0;
        const isData = bit ? (node & 0x40) : (node & 0x80);
        if (isData) {
          outBuf = (outBuf | ((this.bus.read8(childAddr) & dataMask) << outBits)) >>> 0;
          outBits += dataBits;
          if (outBits >= 32) {
            this._writeMem32(dst, outBuf, 'bios-huffman');
            dst = (dst + 4) >>> 0;
            remaining = Math.max(0, remaining - 4);
            outBuf = 0;
            outBits = 0;
          }
          nodeAddr = rootAddr;
        } else {
          nodeAddr = childAddr;
        }
      }
      return `huffman ${tools.hex(src)}->${tools.hex(dst0)} ${(dst - dst0) >>> 0} bytes`;
    }

    // ArcTan: r0 = tan as 1.1.14 signed fixpoint; returns the angle scaled so that
    // 0x4000 = +pi/2 (result range roughly 0xC000..0x4000).
    _biosArcTan() {
      const x = (this.regs[0] << 16) >> 16;
      const result = Math.round(Math.atan(x / 16384) * (0x8000 / Math.PI)) & 0xffff;
      const pc = (this.regs[15] - (this.cpsr & CPSR_T ? 2 : 4)) >>> 0;
      this._writeReg(0, result, 'bios-arctan', pc);
      return `arctan(${x}) = ${tools.hex(result, 4)}`;
    }

    // ArcTan2: r0 = x, r1 = y (16-bit signed); returns the full-circle angle as an
    // unsigned 16-bit value where 0x8000 = pi.
    _biosArcTan2() {
      const x = (this.regs[0] << 16) >> 16;
      const y = (this.regs[1] << 16) >> 16;
      const result = Math.round(Math.atan2(y, x) * (0x10000 / (2 * Math.PI))) & 0xffff;
      const pc = (this.regs[15] - (this.cpsr & CPSR_T ? 2 : 4)) >>> 0;
      this._writeReg(0, result, 'bios-arctan2', pc);
      return `arctan2(${x}, ${y}) = ${tools.hex(result, 4)}`;
    }

    _biosSoundBias() {
      this.bus.write16(0x04000088, this.regs[0] ? 0x200 : 0);
      return `soundbias ${this.regs[0] ? 0x200 : 0}`;
    }

    // MidiKey2Freq: result = wave->freq / 2^((180 - midiKey - fineAdjust/256) / 12),
    // where wave->freq is the u32 at WaveData+4 (frequency scaled for midi key 180).
    // Matches the reference HLE used by mGBA.
    _biosMidiKey2Freq() {
      const wa = this.regs[0] >>> 0;
      const mk = this.regs[1] & 0xff;
      const fp = this.regs[2] & 0xff;
      const baseFreq = this.bus.read32((wa + 4) >>> 0) >>> 0;
      const result = baseFreq / Math.pow(2, (180 - mk - fp / 256) / 12);
      const pc = (this.regs[15] - (this.cpsr & CPSR_T ? 2 : 4)) >>> 0;
      this._writeReg(0, result >>> 0, 'bios-midikey2freq', pc);
      return `midikey2freq(${tools.hex(wa)}, ${mk}, ${fp}) = ${result >>> 0}`;
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
        this._recordIrqCall('thumb-bl', pc, target);
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
      return BIT_COUNT_16[v & 0xffff];
    }

    _branch(instr, pc) {
      const link = !!(instr & 0x01000000);
      const offset = (signExtend24(instr & 0x00ffffff) << 2) >> 0;
      if (link) this.regs[14] = (pc + 4) >>> 0;
      const target = (pc + 8 + offset) >>> 0;
      if (link) this._recordIrqCall('arm-bl', pc, target);
      this._recordBranch(link ? 'arm-bl' : 'arm-b', pc, target);
      this.regs[15] = target;
    }

    _bx(instr) {
      const target = this._reg(instr & 0xf);
      this._recordIrqCall('arm-bx', (this.regs[15] - 4) >>> 0, target);
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
      const source = this.branches.slice().reverse().find(branch => branch.kind !== 'fetch-fault') || null;
      const lo = this.bus.read16(pc & ~1);
      const hi = this.bus.read16((pc + 2) & ~1);
      const sourceText = source ? ` from ${source.kind} ${source.pcHex}->${source.targetHex}` : '';
      this.reason = `unsupported ARM ${tools.hex(instr)} at ${tools.hex(pc)} h:${tools.hex(lo, 4)}/${tools.hex(hi, 4)}${sourceText}`;
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
      this.activeEntryIndex = 0;
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
      this.activeEntryIndex = 0;
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
        this.entries = [{
          name: this.source.tags.title || this.source.name,
          tags: this.source.tags,
          decoded,
          patch: await tools.miniPatch(buf),
        }];
        this._rebuildMemoryForEntry(0);
        this.decodeReport = this._makeDecodeReport();
        this._initCpu();
        this.state = 'loaded';
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
      const miniKeys = Object.keys(files).filter(k => /\.minigsf$/i.test(k)).sort();
      this.entries = [];
      for (const key of miniKeys) {
        const patch = await tools.miniPatch(files[key]);
        const decoded = await tools.decodeProgram(files[key], { kind: 'minigsf', name: key });
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
      this._rebuildMemoryForEntry(0);
      this.decodeReport = this._makeDecodeReport();
      this._initCpu();
      this.state = 'loaded';
      return this.source;
    }

    _rebuildMemoryForEntry(index = this.activeEntryIndex || 0) {
      this.activeEntryIndex = Math.max(0, Math.min(index | 0, Math.max(0, this.entries.length - 1)));
      this.memory = createMemoryImage();
      if (this.library?.decoded) applyDecodedProgram(this.memory, this.library.decoded, this.library.key);
      const entry = this.entries[this.activeEntryIndex];
      if (entry?.decoded) applyDecodedProgram(this.memory, entry.decoded, entry.key || entry.name || 'minigsf');
      return entry || null;
    }

    selectEntry(index = 0) {
      const entry = this._rebuildMemoryForEntry(index);
      this.decodeReport = this._makeDecodeReport();
      this._initCpu();
      return entry;
    }

    canPlay() {
      return this.state === 'loaded' && !!this.memory && !!this.cpu && this.entries.length > 0;
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
        const reload = this.bus.timerReload(ch);
        const control = this.bus.read16(base + 2);
        const period = 0x10000 - reload;
        if ((control & 0x80) && !(control & 0x04) && period > 0) {
          return Math.round(GBA_CPU_HZ / (TIMER_PRESCALERS[control & 3] * period));
        }
      }
      return fallback;
    }

    _soundBiasOutput() {
      const bias = this.bus ? this.bus.read16(0x04000088) : 0;
      const resolution = (bias >>> 14) & 3;
      return {
        bias,
        biasHex: tools.hex(bias, 4),
        dacBits: 9 - resolution,
        outputRate: 32768 << resolution,
      };
    }

    _sampleAt(samples, pos) {
      if (!samples.length) return 0;
      if (pos <= 0) return samples[0] || 0;
      const i = Math.floor(pos);
      return samples[Math.min(i, samples.length - 1)] || 0;
    }

    _sampleStats(samples) {
      if (!samples.length) return { count: 0, min: 0, max: 0, mean: 0, rms: 0, head: [] };
      let min = Infinity;
      let max = -Infinity;
      let sum = 0;
      let sumSq = 0;
      let nonZero = 0;
      let clipped = 0;
      const firstNonZero = [];
      for (const sample of samples) {
        if (sample < min) min = sample;
        if (sample > max) max = sample;
        if (sample !== 0) {
          nonZero++;
          if (firstNonZero.length < 8) firstNonZero.push(sample);
        }
        // Mixed samples now span the hardware-accurate ±511 range (see _mixPsgInto), not ±128.
        if (sample <= -511 || sample >= 511) clipped++;
        sum += sample;
        sumSq += sample * sample;
      }
      const midStart = Math.max(0, Math.floor(samples.length / 2) - 12);
      return {
        count: samples.length,
        min,
        max,
        mean: Math.round(sum / samples.length),
        rms: Math.round(Math.sqrt(sumSq / samples.length)),
        nonZero,
        clipped,
        firstNonZero,
        // 24 consecutive samples from the middle of the render (not the intro, which may be
        // silence/lead-in) — lets us eyeball whether the waveform looks like structured audio
        // (smooth runs, plausible periodicity) or literal noise (no discernible pattern).
        mid: samples.slice(midStart, midStart + 24),
        head: samples.slice(0, 16),
      };
    }

    // Scan the full render for sample-to-sample discontinuities a human ear would register as
    // a "click" — jumps far bigger than the local waveform is actually moving. A fixed absolute
    // threshold alone would miss clicks in quiet passages and over-fire during loud/fast attacks,
    // so each candidate is judged against a rolling local average of recent deltas instead. Also
    // buckets hits into 10 equal time slices across the render so we can see whether clicks are
    // spread evenly, clustered at specific moments, or increase over the render (which would
    // support a growing-drift explanation rather than one-off events).
    // companion (optional): a parallel same-length, same-index sample array captured at an
    // earlier mixing stage (e.g. Direct-Sound-only, before PSG gets added). Attaching its
    // before/after values to each event lets us tell whether a discontinuity already existed
    // at that stage or was introduced later (e.g. by PSG mixing), without a second full scan.
    // trace (optional): parallel array of per-sample DMA provenance (see dmaSrcTraceA/B) —
    // attaches the exact source address, last writer, and read-to-play lag to each event so a
    // click can be traced back to precisely which memory write produced the offending byte.
    _detectClicks(samples, playbackRate, companion = null, trace = null) {
      const n = samples.length;
      if (n < 3) return { count: 0, events: [], buckets: [] };
      const WINDOW = 32;
      const ABS_FLOOR = 180; // below this delta, never call it a click even with a quiet local average
      const RATIO = 5; // delta must exceed the local average by this multiple
      const events = [];
      const buckets = new Array(10).fill(0);
      let windowSum = 0;
      const windowDeltas = [];
      for (let i = 1; i < n; i++) {
        const delta = Math.abs(samples[i] - samples[i - 1]);
        const localAvg = windowDeltas.length ? windowSum / windowDeltas.length : 0;
        if (delta >= ABS_FLOOR && delta >= localAvg * RATIO) {
          const bucket = Math.min(9, Math.floor((i / n) * 10));
          buckets[bucket]++;
          if (events.length < 60) {
            events.push({
              index: i,
              ms: Math.round((i / playbackRate) * 1000),
              cycles: Math.round((i / playbackRate) * GBA_CPU_HZ),
              from: samples[i - 1],
              to: samples[i],
              dsFrom: companion && companion.length > i - 1 ? companion[i - 1] : undefined,
              dsTo: companion && companion.length > i ? companion[i] : undefined,
              delta,
              localAvg: Math.round(localAvg),
              toTrace: trace && trace.length > i ? trace[i] : undefined,
            });
          }
        }
        windowDeltas.push(delta);
        windowSum += delta;
        if (windowDeltas.length > WINDOW) windowSum -= windowDeltas.shift();
      }
      return { count: buckets.reduce((a, b) => a + b, 0), events, buckets };
    }

    // Real-time streaming playback: emulate in short wall-clock slices and schedule the
    // freshly produced Direct Sound samples as small AudioBuffers on a rolling timeline,
    // instead of rendering the whole track offline and only then playing one big looping
    // buffer. Audio starts after a short warmup (enough samples to derive the source
    // rate); renderSeconds > 0 caps the stream length, <= 0 streams until stop().
    async play(renderSeconds = 0, entryIndex = this.activeEntryIndex || 0, options = {}) {
      if (entryIndex !== this.activeEntryIndex) this.selectEntry(entryIndex);
      if (!this.cpu) this._initCpu();
      this.stop(); // tear down any previous stream before rewinding state
      const debug = !!options.debug;

      const FALLBACK_SAMPLE_RATE = 13379;
      const maxSeconds = renderSeconds > 0 ? renderSeconds : Infinity;
      const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

      // Enable fast mode — skip all diagnostic tracking
      this.bus.fastMode = true;
      this.bus.diagnosticProbes = debug;
      this.cpu.fastMode = true;
      this.cpu.diagnosticProbes = debug;
      this.bus.timerReloadLog = [];
      this.bus.timerRegSnaps = [];
      this.bus.fn2CallSnaps = [];
      this.bus.seqCallSnaps = [];
      this.bus.dmaDriftLog = [];
      this.bus.mplInitWrites = [];
      this.bus._fn2CallCount = 0;
      this.bus._seqCallCount = 0;
      this.bus.fifoQueueA = [];
      this.bus.fifoQueueB = [];
      this.bus.fifoHeadA = 0;
      this.bus.fifoHeadB = 0;
      this.bus.fifoLenA = 0;
      this.bus.fifoLenB = 0;
      this.bus.fifoQueueMetaA = [];
      this.bus.fifoQueueMetaB = [];
      this.bus.fifoMetaHeadA = 0;
      this.bus.fifoMetaHeadB = 0;
      this.bus.fifoSamplesA = [];
      this.bus.fifoSamplesB = [];
      this.bus.dsOnlySamplesA = [];
      this.bus.dsOnlySamplesB = [];
      this.bus.dmaSrcTraceA = [];
      this.bus.dmaSrcTraceB = [];
      this.bus.fifoLastA = 0;
      this.bus.fifoLastB = 0;
      this.bus.fifoFillBytesA = 0;
      this.bus.fifoFillBytesB = 0;
      this.bus.fifoDmaLog = [];
      this.bus.dmaSadLog = [];
      this.bus.reloadEffectLog = [];
      this.bus.dmaReloadBranchLog = [];
      this.bus.psgRegWrites = new Map();
      this.bus.psgFrameSeqCycles = 0;
      this.bus.psgFrameSeqStep = 0;
      this.bus.psg = [0, 1].map(() => ({
        enabled: false, triggerCycles: 0, lastSampleCycles: 0,
        freqRaw: 0, freqCur: 0, dutyFraction: 0.5, dutyStep: 4,
        volInit: 0, volume: 0, envDir: 0, envStep: 0, envStepsApplied: 0,
        envTimer: 0, envActive: false,
        lengthEnabled: false, lengthCounter: 0, lengthCyclesTotal: Infinity,
        sweepShift: 0, sweepDir: 0, sweepPeriod: 0, sweepStepsApplied: 0,
        sweepTimer: 0, sweepEnabled: false, sweepShadow: 0,
        phase: 0,
      }));
      this.bus.psgTriggerStats = [0, 1].map(() => ({
        total: 0, sameFreq: 0, minGapCycles: Infinity, sumGapCycles: 0, gapSamples: 0,
      }));
      this.bus.psgFreqLog = [[], []];
      this.bus.psgSampleCacheCycles = -1;
      this.bus.psgSampleCache = [0, 0, 0, 0];
      this.bus.psgWave = {
        enabled: false, triggerCycles: 0, lastSampleCycles: 0,
        freqRaw: 0, freqCur: 0,
        lengthEnabled: false, lengthCounter: 0, lengthCyclesTotal: Infinity,
        outputLevel: 0, forceVolume: false,
        phase: 0,
      };
      this.bus.psgNoise = {
        enabled: false, triggerCycles: 0, lastSampleCycles: 0,
        volInit: 0, volume: 0, envDir: 0, envStep: 0, envStepsApplied: 0,
        envTimer: 0, envActive: false,
        lengthEnabled: false, lengthCounter: 0, lengthCyclesTotal: Infinity,
        divRatio: 0, widthMode: 0, shiftFreq: 0,
        periodCycles: 32,
        lfsr: 0x7fff, phaseCycles: 0,
      };
      this.bus.noiseTriggerLog = [];
      this.bus._noiseTriggerCount = 0;

      // --- Warmup: emulate (sliced, page stays responsive) until Direct Sound samples
      // flow, so the source sample rate can be derived before audio starts.
      const instructionsAtStart = this.cpu.instructions;
      const cyclesAtStart = this.bus.cycles;
      const WARMUP_TARGET_SAMPLES = 2048; // ~150ms at typical mp2k rates
      const WARMUP_MAX_CYCLES = GBA_CPU_HZ * 5;
      const warmupWallStart = now();
      const fastPlayback = !debug;
      const runCpuBatch = (count) => {
        if (fastPlayback) {
          for (let i = 0; i < count; i++) this.cpu._stepFast();
        } else {
          for (let i = 0; i < count; i++) this.cpu.step();
        }
      };
      let firstSampleCycles = -1;
      await new Promise(resolve => {
        const slice = () => {
          const deadline = now() + 12;
          let done = false;
          while (now() < deadline) {
            runCpuBatch(256);
            const produced = Math.max(this.bus.fifoSamplesA.length, this.bus.fifoSamplesB.length);
            if (firstSampleCycles < 0 && produced > 0) firstSampleCycles = this.bus.cycles;
            if (this.cpu.halted || produced >= WARMUP_TARGET_SAMPLES
                || this.bus.cycles - cyclesAtStart >= WARMUP_MAX_CYCLES) { done = true; break; }
          }
          if (done) resolve();
          else setTimeout(slice, 0);
        };
        setTimeout(slice, 0);
      });
      const warmupWallMs = Math.max(1, now() - warmupWallStart);

      const sourceRate = this._directSoundSampleRate(0);
      const biasOutput = this._soundBiasOutput();
      const warmCycles = this.bus.cycles - cyclesAtStart;
      const warmSeconds = warmCycles / GBA_CPU_HZ;
      const sourceSamples = Math.max(this.bus.fifoSamplesA.length, this.bus.fifoSamplesB.length);
      // Observed production rate measured from the FIRST sample onward — dividing by the
      // whole warmup window (which includes driver-init silence) understated the rate,
      // and the AudioContext then played slow and pitched down by the same ratio. Golden
      // Sun's high-rate mixer (21kHz) lost ~22% this way while stock-mp2k games (init
      // finishes almost immediately, so tiny error) sounded normal.
      const postInitSeconds = firstSampleCycles >= 0 ? (this.bus.cycles - firstSampleCycles) / GBA_CPU_HZ : 0;
      const observedSourceRate = (postInitSeconds > 0.02 && sourceSamples > 256)
        ? Math.round(sourceSamples / postInitSeconds) : 0;
      // The timer-derived rate is exact (computed from the TM reload feeding the FIFO),
      // so prefer it whenever it roughly agrees with what we actually saw produced; the
      // observed rate covers the case where the timer heuristic picked the wrong channel.
      let playbackRate;
      if (sourceRate && (!observedSourceRate || Math.abs(sourceRate - observedSourceRate) / sourceRate < 0.1)) {
        playbackRate = sourceRate;
      } else {
        playbackRate = observedSourceRate || sourceRate || FALLBACK_SAMPLE_RATE;
      }
      playbackRate = Math.max(3000, Math.min(96000, playbackRate));
      // Emulated seconds per wall second over the warmup; below ~1.0 the stream cannot
      // keep up with real time and will underrun (audible gaps).
      const realtimeFactor = Math.round((warmSeconds / (warmupWallMs / 1000)) * 100) / 100;
      if (realtimeFactor < 1.1 && !this.cpu.halted) {
        console.warn(`[GsfEngine] Emulation runs at ${realtimeFactor}x real time — streaming may underrun`);
      }

      // Diagnostics snapshot at the warmup point; the stream keeps running after
      // play() resolves. Keep it opt-in because it briefly disables fast mode and
      // builds a large diagnostic object for the main-page debug dump.
      if (debug) {
        this.bus.fastMode = false;
        this.bus.diagnosticProbes = true;
        this.cpu.fastMode = false;
        this.cpu.diagnosticProbes = true;
        this.cpu.pcHits = new Map();
        this.cpu.recentPcs = [];
        this.cpu.branches = [];
        this.runDiagnostics(0);
        this.bus.fastMode = true;
        this.bus.diagnosticProbes = debug;
        this.cpu.fastMode = true;
        this.cpu.diagnosticProbes = debug;
      }

      if (!this.diagnostics.fifo) this.diagnostics.fifo = {};
      this.diagnostics.render = {
        mode: 'stream',
        requestedSeconds: renderSeconds > 0 ? renderSeconds : null,
        sampleRate: playbackRate,
        sourceRate: observedSourceRate || playbackRate,
        fifoFillRate: observedSourceRate || playbackRate,
        timerSourceRate: sourceRate || null,
        outputRate: playbackRate,
        biasOutputRate: biasOutput.outputRate,
        dacBits: biasOutput.dacBits,
        soundBiasHex: biasOutput.biasHex,
        renderedCycles: warmCycles,
        renderedSamples: sourceSamples,
        sourceSamples,
        realtimeFactor,
        sampleStatsA: this._sampleStats(this.bus.fifoSamplesA),
        sampleStatsB: this._sampleStats(this.bus.fifoSamplesB),
        clicksA: this._detectClicks(this.bus.fifoSamplesA, playbackRate, this.bus.dsOnlySamplesA, this.bus.dmaSrcTraceA),
        clicksB: this._detectClicks(this.bus.fifoSamplesB, playbackRate, this.bus.dsOnlySamplesB, this.bus.dmaSrcTraceB),
        // Direct Sound BEFORE PSG gets mixed in — isolates whether Direct Sound alone is
        // correct on this track, since everything inspected so far has been the final mix.
        dsOnlyStatsA: this._sampleStats(this.bus.dsOnlySamplesA),
        dsOnlyStatsB: this._sampleStats(this.bus.dsOnlySamplesB),
        renderedMs: Math.round(warmSeconds * 1000),
        instructions: this.cpu.instructions - instructionsAtStart,
        stopReason: this.cpu.halted ? 'halted' : 'streaming',
      };
      this.diagnostics.fifo.renderSamplesA = this.bus.fifoSamplesA.length;
      this.diagnostics.fifo.renderSamplesB = this.bus.fifoSamplesB.length;
      this.diagnostics.fifo.fillBytesA = this.bus.fifoFillBytesA;
      this.diagnostics.fifo.fillBytesB = this.bus.fifoFillBytesB;
      this.diagnostics.fifo.queueA = this.bus._fifoLength('A');
      this.diagnostics.fifo.queueB = this.bus._fifoLength('B');
      this.diagnostics.fifo.dmaLog = this.bus.fifoDmaLog.slice();

      if (this.cpu.halted && sourceSamples === 0) return this.diagnostics;
      if (typeof AudioContext === 'undefined') return this.diagnostics;

      // --- Audio graph + streaming pump ---
      // Run the AudioContext at the DEVICE's native rate and resample the GBA stream
      // ourselves with a continuous fractional cursor. Asking the browser for an
      // AudioContext at the game's exotic source rate (e.g. Golden Sun's 21024 Hz)
      // left the final resample-to-device step to the browser/OS, which audibly
      // warbled; a continuous-phase linear interpolator here is time-invariant, so
      // it cannot warble by construction. (Verified: the same PCM rendered to a WAV
      // sounded clean — the defect was purely in the playback-rate conversion.)
      let ctx;
      try {
        ctx = new AudioContext();
        await ctx.resume();
      } catch (err) {
        console.warn('[GsfEngine] Audio init failed:', err);
        return this.diagnostics;
      }
      const outRate = ctx.sampleRate;
      const ratio = playbackRate / outRate; // source samples per output sample
      this.diagnostics.render.outputRate = outRate;

      const stream = {
        ctx,
        rate: playbackRate,
        stopped: false,
        ended: false,
        timer: null,
        nextTime: ctx.currentTime + 0.15, // priming latency before the first chunk plays
        srcPos: 0,      // continuous fractional read cursor into the source stream (absolute)
        consumed: 0,    // whole source samples consumed = floor(srcPos); drives trimming
        trimOffset: 0,  // samples spliced off the front of the live arrays
        underruns: 0,
      };
      this._stream = stream;

      const engine = this;
      const bus = this.bus;
      const OUT_CHUNK = Math.max(256, Math.round(outRate * 0.15));
      // Windowed-sinc polyphase kernel for the fixed source->device ratio. Cutoff at
      // the lower of the two Nyquists (with a small transition margin) so upsampling
      // suppresses source imaging and downsampling (e.g. GS2's 63kHz) pre-filters.
      const KERNEL_TAPS = 24;
      const KERNEL_PHASES = 512;
      const KERNEL_HALF = KERNEL_TAPS / 2;
      const kernel = buildSincKernel(Math.min(1, 1 / ratio) * 0.92, KERNEL_TAPS, KERNEL_PHASES);
      // Source samples a full output chunk needs, plus the kernel's look-around.
      const SRC_NEEDED = Math.ceil(OUT_CHUNK * ratio) + KERNEL_TAPS + 2;
      // Runway of scheduled-but-unplayed audio. Production is gated on this draining,
      // so a bigger runway costs no steady-state CPU — it only buys tolerance for
      // main-thread stalls (GC, extensions, layout) before an audible underrun.
      const TARGET_AHEAD_SEC = 1.2;
      const MIN_AHEAD_SEC = 0.4;

      const producedTotal = () => stream.trimOffset + Math.max(bus.fifoSamplesA.length, bus.fifoSamplesB.length);
      const reachedEnd = () => engine.cpu.halted || (bus.cycles - cyclesAtStart) / GBA_CPU_HZ >= maxSeconds;
      const sampleFrom = (arr, idx) => {
        if (!arr.length) return 0;
        return arr[idx < 0 ? 0 : idx >= arr.length ? arr.length - 1 : idx] || 0;
      };

      const scheduleChunk = (outN) => {
        const buffer = ctx.createBuffer(2, outN, outRate);
        // SOUNDCNT_H convention used throughout: Sound A → right, Sound B → left.
        const left = buffer.getChannelData(0);
        const right = buffer.getChannelData(1);
        let pos = stream.srcPos;
        const sampA = bus.fifoSamplesA;
        const sampB = bus.fifoSamplesB;
        for (let i = 0; i < outN; i++) {
          const idxAbs = Math.floor(pos);
          const frac = pos - idxAbs;
          const phase = Math.min(KERNEL_PHASES - 1, (frac * KERNEL_PHASES) | 0);
          const rowOff = phase * KERNEL_TAPS;
          const base = idxAbs - stream.trimOffset - (KERNEL_HALF - 1);
          let accA = 0;
          let accB = 0;
          for (let k = 0; k < KERNEL_TAPS; k++) {
            const c = kernel[rowOff + k];
            accA += c * sampleFrom(sampA, base + k);
            accB += c * sampleFrom(sampB, base + k);
          }
          // Mixed samples span the hardware ±511 range; normalize by 512 for Web Audio.
          right[i] = accA / 512;
          left[i] = accB / 512;
          pos += ratio;
        }
        stream.srcPos = pos;
        stream.consumed = Math.floor(pos);
        if (stream.nextTime < ctx.currentTime + 0.02) {
          if (stream.consumed > 0) {
            stream.underruns++;
            if (stream.underruns <= 5) {
              console.warn(`[GsfEngine] stream underrun #${stream.underruns} (audible gap) — emulation fell behind the playhead`);
            }
          }
          stream.nextTime = ctx.currentTime + 0.05;
        }
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.start(stream.nextTime);
        stream.nextTime += outN / outRate;
      };

      // Endless streams must not grow the sample arrays forever: splice off the played
      // prefix (all six per-sample arrays advance in lockstep), keeping a small tail
      // for the clamp-to-last-sample reads of a stalled channel.
      const trimConsumed = () => {
        const startIdx = stream.consumed - stream.trimOffset;
        if (startIdx <= 65536) return;
        let cut = startIdx - 4096;
        if (bus.fifoSamplesA.length) cut = Math.min(cut, bus.fifoSamplesA.length - 1);
        if (bus.fifoSamplesB.length) cut = Math.min(cut, bus.fifoSamplesB.length - 1);
        if (cut <= 0) return;
        for (const arr of [bus.fifoSamplesA, bus.fifoSamplesB, bus.dsOnlySamplesA, bus.dsOnlySamplesB, bus.dmaSrcTraceA, bus.dmaSrcTraceB]) {
          if (arr.length) arr.splice(0, Math.min(cut, arr.length));
        }
        stream.trimOffset += cut;
      };

      const tick = () => {
        if (stream.stopped) return;
        // Only produce when the scheduled runway has actually drained below target.
        // Previously every tick emulated + scheduled another chunk regardless of how
        // far ahead playback already was, so production ran ~3x real time forever:
        // the emulator never idled (constant tab CPU) and thousands of pending
        // one-shot buffer sources piled up in the audio graph. In steady state this
        // now emulates only the ~1x real time the playhead consumes and keeps at
        // most a few chunks in flight.
        if (stream.nextTime - ctx.currentTime < TARGET_AHEAD_SEC) {
          // Emulate until a chunk's worth of new samples exists, bounded by a
          // wall-clock slice so the UI thread stays responsive.
          const deadline = now() + 12;
          while (!reachedEnd() && producedTotal() - stream.consumed < SRC_NEEDED && now() < deadline) {
            if (fastPlayback) {
              for (let i = 0; i < 512; i++) engine.cpu._stepFast();
            } else {
              for (let i = 0; i < 512; i++) engine.cpu.step();
            }
          }
          while (producedTotal() - stream.consumed >= SRC_NEEDED) scheduleChunk(OUT_CHUNK);
          if (reachedEnd()) {
            // Flush whatever full source samples remain as one final (shorter) chunk.
            const tailSrc = producedTotal() - stream.consumed;
            const tailOut = Math.floor(Math.max(0, tailSrc - KERNEL_TAPS) / ratio);
            if (tailOut > 0) scheduleChunk(tailOut);
            stream.ended = true;
            if (engine.cpu.halted) console.warn('[GsfEngine] Stream ended: CPU halted:', engine.cpu.reason);
            // Let the final scheduled buffer play out, then release the audio context.
            const remainMs = Math.max(0, (stream.nextTime - ctx.currentTime) * 1000) + 200;
            stream.timer = setTimeout(() => { if (engine._stream === stream) engine.stop(); }, remainMs);
            return;
          }
          trimConsumed();
        }
        const ahead = stream.nextTime - ctx.currentTime;
        const delayMs = ahead > TARGET_AHEAD_SEC
          ? 50
          : ahead > MIN_AHEAD_SEC
            ? Math.min(35, Math.max(4, Math.round((ahead - MIN_AHEAD_SEC) * 500)))
            : 0;
        stream.timer = setTimeout(tick, delayMs);
      };
      stream.timer = setTimeout(tick, 0);

      return this.diagnostics;
    }

    stop() {
      if (this._stream) {
        const s = this._stream;
        this._stream = null;
        s.stopped = true;
        if (s.timer) clearTimeout(s.timer);
        try { s.ctx.close(); } catch (_) { /* already closed */ }
      }
      if (this._audioSrc) { try { this._audioSrc.stop(); } catch (_) {} this._audioSrc = null; }
      if (this._audioCtx) { this._audioCtx.close(); this._audioCtx = null; }
    }

    // Parse a GSF length tag ("m:ss", "m:ss.fff", or plain seconds) into seconds.
    _tagSeconds(text) {
      if (!text) return 0;
      const m = String(text).trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
      if (!m) return 0;
      return (m[1] ? parseInt(m[1], 10) * 60 : 0) + parseFloat(m[2]);
    }

    // Offline-render the selected entry (no audio graph involved) and return a 16-bit
    // stereo WAV at the exact source sample rate — the proven-clean reference path for
    // A/B listening against real hardware or other players. seconds <= 0 uses the
    // rip's tagged track length when present (else 90s), capped at 5 minutes.
    async exportWav(seconds = 0, entryIndex = this.activeEntryIndex || 0, onProgress = null) {
      this.stop();
      this.selectEntry(entryIndex); // clean rebuild so the render always starts from t=0
      const entry = this.entries[this.activeEntryIndex];
      if (!(seconds > 0)) seconds = this._tagSeconds(entry?.tags?.length) || 90;
      seconds = Math.min(seconds, 300);
      const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
      this.bus.fastMode = true;
      this.cpu.fastMode = true;
      const targetCycles = Math.round(GBA_CPU_HZ * seconds);
      let firstSampleCycles = -1;
      await new Promise(resolve => {
        const slice = () => {
          const deadline = now() + 14;
          while (now() < deadline) {
            // Small batches: a halted step fast-forwards a whole frame, so checking the
            // target only every N steps overshoots the render length by up to N frames.
            for (let i = 0; i < 64; i++) this.cpu._stepFast();
            if (firstSampleCycles < 0 && (this.bus.fifoSamplesA.length || this.bus.fifoSamplesB.length)) {
              firstSampleCycles = this.bus.cycles;
            }
            if (this.cpu.halted || this.bus.cycles >= targetCycles) { resolve(); return; }
          }
          if (onProgress) onProgress(this.bus.cycles / GBA_CPU_HZ, seconds);
          setTimeout(slice, 0);
        };
        setTimeout(slice, 0);
      });

      const a = this.bus.fifoSamplesA;
      const b = this.bus.fifoSamplesB;
      const producedSamples = Math.max(a.length, b.length);
      const halted = this.cpu.halted;
      const haltReason = this.cpu.reason;
      // Same rate preference as play(): the exact timer-derived rate wins when it
      // agrees with the post-first-sample production rate.
      const timerRate = this._directSoundSampleRate(0);
      const producedSeconds = firstSampleCycles >= 0 ? (this.bus.cycles - firstSampleCycles) / GBA_CPU_HZ : 0;
      const observed = (producedSeconds > 0.5 && producedSamples > 256) ? Math.round(producedSamples / producedSeconds) : 0;
      let rate;
      if (timerRate && (!observed || Math.abs(timerRate - observed) / timerRate < 0.1)) rate = timerRate;
      else rate = observed || timerRate || 13379;
      // Trim any residual overshoot to the requested length.
      const nSamples = Math.min(producedSamples, Math.round(seconds * rate));
      // Leave a fresh CPU behind so a subsequent play() starts from t=0 rather than
      // wherever this render stopped.
      this._initCpu();
      if (!nSamples) {
        throw new Error(`render produced no audio${halted ? ` (CPU halted: ${haltReason})` : ''}`);
      }

      // 16-bit stereo interleaved WAV; FIFO B → left, FIFO A → right (playback convention).
      const dataBytes = nSamples * 4;
      const buf = new ArrayBuffer(44 + dataBytes);
      const view = new DataView(buf);
      const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
      writeStr(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); writeStr(8, 'WAVE');
      writeStr(12, 'fmt '); view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);  // PCM
      view.setUint16(22, 2, true);  // stereo
      view.setUint32(24, rate, true);
      view.setUint32(28, rate * 4, true);
      view.setUint16(32, 4, true);
      view.setUint16(34, 16, true);
      writeStr(36, 'data'); view.setUint32(40, dataBytes, true);
      // Source samples span ±511; ×64 fills the int16 range (511×64 = 32704).
      const clamp16 = v => v > 32767 ? 32767 : v < -32768 ? -32768 : v;
      for (let i = 0; i < nSamples; i++) {
        view.setInt16(44 + i * 4, clamp16((b[i] || 0) * 64), true);
        view.setInt16(44 + i * 4 + 2, clamp16((a[i] || 0) * 64), true);
      }
      return {
        blob: new Blob([buf], { type: 'audio/wav' }),
        name: `${(entry?.name || 'gsf-render').replace(/[\\/:*?"<>|]+/g, '_')}.wav`,
        rate,
        samples: nSamples,
        seconds: nSamples / rate,
        halted,
        reason: halted ? haltReason : null,
      };
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
      const prevDiagnosticProbes = this.cpu.diagnosticProbes;
      const prevCpuFastMode = this.cpu.fastMode;
      const prevBusFastMode = this.bus.fastMode;
      const prevBusDiagnosticProbes = this.bus.diagnosticProbes;
      this.cpu.fastMode = false;
      this.bus.fastMode = false;
      this.bus.diagnosticProbes = true;
      this.cpu.diagnosticProbes = true;
      const cpu = this.cpu.run(maxInstructions);
      this.cpu.diagnosticProbes = prevDiagnosticProbes;
      this.cpu.fastMode = prevCpuFastMode;
      this.bus.fastMode = prevBusFastMode;
      this.bus.diagnosticProbes = prevBusDiagnosticProbes;
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
          // PSG channel register write tally (fastMode-safe).
          psgSummary: [...this.bus.psgRegWrites.entries()].map(([name, n]) => `${name}×${n}`).join(' '),
          // Square1/Square2 final state, for sanity-checking the new PSG synth at a glance.
          psgState: this.bus.psg.map((st, ch) => ({
            ch, enabled: st.enabled, volume: st.volume, freq: st.freqCur,
            dutyFraction: st.dutyFraction, lengthEnabled: st.lengthEnabled,
          })),
          psgWaveState: (() => {
            const st = this.bus.psgWave;
            return { enabled: st.enabled, freq: st.freqCur, outputLevel: st.outputLevel, forceVolume: st.forceVolume };
          })(),
          // CPU-visible WAVE_RAM bytes: hardware exposes the non-playback bank here.
          waveRamHex: Array.from({ length: 16 }, (_, i) => tools.hex(this.bus.read8((0x04000090 + i) >>> 0), 2)),
          waveRamBanksHex: [0, 1].map(bank => Array.from({ length: 16 }, (_, i) => tools.hex(this.bus.waveRam[bank * 16 + i] || 0, 2))),
          soundCnt3LHex: tools.hex(this.bus.read8(0x04000070), 2),
          psgNoiseState: (() => {
            const st = this.bus.psgNoise;
            return { enabled: st.enabled, volume: st.volume, divRatio: st.divRatio, shiftFreq: st.shiftFreq, widthMode: st.widthMode };
          })(),
          noiseTriggerLog: (this.bus.noiseTriggerLog || []).slice(),
          noiseTriggerCount: this.bus._noiseTriggerCount || 0,
          psgFreqLog: (this.bus.psgFreqLog || [[], []]).map(log => log.slice()),
          // Raw SOUNDCNT_L so we can confirm whether ch0/ch1's L/R routing bits (8,9,12,13)
          // are actually what's making pcmA vs pcmB differ, rather than guessing.
          soundCntLHex: tools.hex(this.bus.read16(0x04000080), 4),
          // How many PSG retriggers keep the same frequency (vibrato/pitch-bend re-pokes,
          // which hard-reset phase every time and can sound like clicking) vs land far apart
          // (genuinely new notes). avgGapMs near a single-digit number means very frequent
          // retriggers regardless of cause.
          psgTriggerStats: this.bus.psgTriggerStats.map((s, ch) => ({
            ch, total: s.total, sameFreq: s.sameFreq,
            sameFreqPct: s.total ? Math.round((s.sameFreq / s.total) * 100) : 0,
            avgGapMs: s.gapSamples ? Math.round((s.sumGapCycles / s.gapSamples / GBA_CPU_HZ) * 1000) : null,
            minGapMs: Number.isFinite(s.minGapCycles) ? Math.round((s.minGapCycles / GBA_CPU_HZ) * 1000) : null,
          })),
        },
        audio: this._makeAudioDiagnostics(soundWrites, timerWrites, dmaWrites),
        fifo: {
          samplesA: this.bus.fifoSamplesA.length,
          samplesB: this.bus.fifoSamplesB.length,
          durationMs: Math.round(this.bus.fifoSamplesA.length / 13.379),
          bufferWrites: this.bus.soundBufferWrites.slice(-12).map(w => ({
            addrHex: w.addrHex,
            valueHex: w.valueHex,
            bytes: w.bytes,
            kind: w.kind,
            pcHex: w.pcHex,
          })),
          dmaSadLog: this.bus.dmaSadLog.slice(),
          reloadEffectLog: (this.bus.reloadEffectLog || []).slice(),
          dmaReloadBranchLog: (this.bus.dmaReloadBranchLog || []).slice(),
        },
        interrupts: this._makeInterruptDiagnostics(),
        bios: {
          swiCalls: swiCalls.length,
          swiSummary: (() => {
            const counts = new Map();
            for (const c of swiCalls) counts.set(c.name, (counts.get(c.name) || 0) + 1);
            return [...counts.entries()].map(([name, n]) => `${name}×${n}`).join(' ');
          })(),
          // Cheap per-number tally that survives fastMode (unlike swiCalls/swiSummary above,
          // which are only logged when fastMode is off and so read 0 right after play()).
          swiCountSummary: Array.from(this.cpu.swiCounts)
            .map((n, num) => (n ? `${this.cpu._swiName(num)}×${n}` : null))
            .filter(Boolean)
            .join(' '),
          stubbed: swiCalls.filter(c => c.result === 'stubbed').map(c => c.name).filter((v, i, a) => a.indexOf(v) === i),
          recent: swiCalls.slice(-32).map(call => ({
            ...call,
            pcHex: tools.hex(call.pc),
            r0Hex: tools.hex(call.r0),
            r1Hex: tools.hex(call.r1),
            r2Hex: tools.hex(call.r2),
          })),
          halts: this.cpu.haltEvents.slice(-12),
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
            soundWork2: peek(0x03005fd0, 12),
            mplInitWrites: this.bus.mplInitWrites.slice(),
            // ROM bytes near the suspect init code (to decode the actual instructions)
            romAt081de180: peek(0x081de180, 8),
            romAt081ddc00: peek(0x081ddc00, 8),
            mplTable: peek(0x03007100, 48),
            mplAt7200: peek(0x03007200, 24),
            // Track the write that set the (suspected wrong) song data pointer
            mplKeyWrites: (() => {
              const addrs = [0x03007100, 0x03007104, 0x03007108, 0x0300710c,
                             0x03007110, 0x03007114, 0x03007118, 0x0300711c,
                             0x03007140, 0x03007144, 0x03007148, 0x0300714c,
                             0x03007150, 0x03007154, 0x03007158, 0x0300715c,
                             0x03007160, 0x03007164, 0x03007168, 0x0300716c];
              return addrs.map(a => {
                const w = this.bus.soundBufferWriteMap.get(a);
                return w ? { a: tools.hex(a), v: tools.hex(w.value), pc: tools.hex(w.pc), k: w.kind } : null;
              }).filter(Boolean);
            })(),
            iwramStub: peek(0x03000520, 8),
            iwramDriver: peek(0x03006000, 8),
            // Every fn2CallSnap's m5 (memory at the mixer's r5 buffer-slot pointer) has shown
            // all-zero on this track, in every diagnostic all session — even before any PSG
            // work started. That's consistent with the real ROM mixer NEVER successfully
            // writing real PCM into its own output buffer, contradicting the HLE trace showing
            // multiple continuous "pcm" voices (T2/T6/T7) that should produce plenty of nonzero
            // content. Scan soundBufferWriteMap (tracks the LAST write per aligned word,
            // fastMode-safe) across the whole observed mixer-buffer ring (~7 slots of 0xE0
            // bytes each, seen cycling through r5) to see if ANY write in that whole region was
            // ever nonzero across the full render, not just at our snapshot instants.
            mixerBufferScan: (() => {
              // soundBufferWriteMap keys its entries by word-aligned address regardless of
              // write granularity, so byte/halfword stores (STRB is how an 8-bit PCM mixer
              // writes samples one at a time) clobber each other: only the *last* byte-lane
              // written to a word survives in the map, and its raw entry.value is just that
              // one byte (0-255), not the word's real content. Checking entry.value here was
              // therefore checking one arbitrary byte lane per word, not the actual mixed
              // sample data — read the live word out of memory instead, and use the map only
              // to know whether the word was ever touched at all.
              const base = 0x03006300, span = 0x700; // covers the observed r5 ring + margin
              let tracked = 0, nonZero = 0;
              const nonZeroSamples = [];
              for (let a = base; a < base + span; a += 4) {
                const w = this.bus.soundBufferWriteMap.get(a);
                if (!w) continue;
                tracked++;
                const live = this.bus.read32(a) >>> 0;
                if (live !== 0) {
                  nonZero++;
                  if (nonZeroSamples.length < 8) nonZeroSamples.push({ a: tools.hex(a), v: tools.hex(live), pc: tools.hex(w.pc), k: w.kind });
                }
              }
              return { base: tools.hex(base), span, tracked, nonZero, nonZeroSamples };
            })(),
            fn2Calls: this.bus.fn2CallSnaps || [],
            mixerLoopTrace: this.bus.mixerLoopTrace || [],
            // fn2CallCount only reaches ~57% of vblankCount even with prompt IRQ delivery --
            // compare the last VBlank IRQ dispatch that reached the sound-engine wrapper
            // (0x081dcdc6) against the last one that didn't, to find the divergence point.
            lastHitIrqPcTrace: this.bus.lastHitIrqPcTrace || [],
            lastMissIrqPcTrace: this.bus.lastMissIrqPcTrace || [],
            handlerVblSpan: {
              total: this.bus._handlerVblSpanTotal || 0,
              count: this.bus._handlerVblSpanCount || 0,
              max: this.bus._handlerVblSpanMax || 0,
              capped: this.bus._handlerCappedCount || 0,
            },
            fifoDmaTally: {
              requested: this.bus.fifoDmaReqTally || 0,
              disabled: this.bus.fifoDmaReqDisabled || 0,
              wrongTiming: this.bus.fifoDmaReqWrongTiming || 0,
              ran: this.bus.fifoDmaRunTally || 0,
              bufferSize: this.bus.dsFifoBufferSize || 0,
              sourceBase: (this.bus.dmaSourceBase || []).map(v => tools.hex(v)),
              zeroWords: this.bus.fifoDmaZeroWords || 0,
              nonZeroWords: this.bus.fifoDmaNonZeroWords || 0,
            },
            mixerPcmTrace: this.bus.mixerPcmTrace || [],
            mixVolTrace: this.bus.mixVolTrace || [],
            mixGateTrace: this.bus.mixGateTrace || [],
            mixCmpTrace: this.bus.mixCmpTrace || [],
            spWatchAddr: this.bus._spWatchAddr ? tools.hex(this.bus._spWatchAddr) : null,
            spWatchLog: this.bus.spWatchLog || [],
            spStoreOperands: this.bus.spStoreOperands || [],
            literalWatchAddr: this.bus._literalWatchAddr ? tools.hex(this.bus._literalWatchAddr) : null,
            literalWatchLog: this.bus.literalWatchLog || [],
            stackCrashWatchLog: this.bus.stackCrashWatchLog || [],
            stackCrashReadLog: this.bus.stackCrashReadLog || [],
            dmaStackOverlaps: this.bus.dmaStackOverlaps || [],
            mixCheckpoints: {
              fee: this.bus._cpFee || 0,
              c1000: this.bus._cp1000 || 0,
              c1002: this.bus._cp1002 || 0,
              c1008: this.bus._cp1008 || 0,
              c100c: this.bus._cp100c || 0,
              c1010: this.bus._cp1010 || 0,
              c1012: this.bus._cp1012 || 0,
              c1014: this.bus._cp1014 || 0,
              c1016: this.bus._cp1016 || 0,
              c1018: this.bus._cp1018 || 0,
              c101c: this.bus._cp101c || 0,
              c1056: this.bus._cp1056 || 0,
              c10fc: this.bus._cp10fc || 0,
              c1110: this.bus._cp1110 || 0,
            },
            romAt03001000: (() => { const ws=[]; for(let i=0;i<12;i++) ws.push(tools.hex(this.bus.read16((0x03001000+i*2)>>>0),4)); return ws; })(),
            // [sp+0x14] (r0 in the CMP r1,r0 gate) drops from 0xDE at VBL 1 to a stuck 0x3C for
            // every VBL after — dump the prologue between the thumb entry (0x03000f61) and where
            // our trace starts (0x03000fee) to find whatever writes that stack slot, since it's
            // not set by an external caller (0x03000fee is mid-function, reached by straight-line
            // execution from 0x03000f61, not a fresh call).
            romAt03000f60: (() => { const ws=[]; for(let i=0;i<0x50;i++) ws.push(tools.hex(this.bus.read16((0x03000f60+i*2)>>>0),4)); return ws; })(),
            // spWatch shows PC 0x081dcde6 (thumb-sp-store) pins [sp+0x14] at the constant 0x3C
            // every VBL after the first. Dump the surrounding Thumb code to decode that store and
            // find where the 0x3C comes from (immediate vs. a register that should vary).
            romAt081dcdc0: (() => { const ws=[]; for(let i=0;i<0x30;i++) ws.push(tools.hex(this.bus.read16((0x081dcdc0+i*2)>>>0),4)); return ws; })(),
            // r2 (the operand that goes 0xa2 on VBL 1 -> stuck 0x00000000 forever after) is
            // LDRB r2,[r2,#0] where the base is a ROM literal pool pointer at 0x081dce2c. Dump the
            // literal itself (the RAM/IO address being read) plus its live current byte value.
            literalAt081dce2c: (() => {
              const ptr = this.bus.read32(0x081dce2c);
              return { ptr: tools.hex(ptr), byteAtPtr: tools.hex(this.bus.read8(ptr >>> 0)) };
            })(),
            seqCalls: this.bus.seqCallSnaps || [],
            dmaDrift: this.bus.dmaDriftLog || [],
            // Find SoundInfo by searching for the fn2 pointer stored in IWRAM
            soundInfoSearch: (() => {
              const target = 0x03000F60; // fn2 entry (even, ARM side expects this)
              const results = [];
              for (let a = 0x03000000; a < 0x03008000; a += 4) {
                const v = this.bus.read32(a);
                if (v === target || v === (target | 1)) results.push({ addrHex: tools.hex(a), valueHex: tools.hex(v) });
              }
              // Also peek 32 bytes before each found address (to get SoundInfo base)
              return results.slice(0, 4).map(r => {
                const base = (parseInt(r.addrHex, 16) - 8) >>> 0;
                const words = [];
                for (let i = 0; i < 16; i++) words.push(tools.hex(this.bus.read32((base + i * 4) >>> 0)));
                return { ...r, base: tools.hex(base), words };
              });
            })(),
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
          'IRQ dispatch: Halt/VBlankIntrWait SWIs run the handler at [0x03007FFC] as a nested CPU loop; IF is write-one-to-clear and real handlers acknowledge it manually.',
          'Not implemented: SWP, coprocessor, full IRQ mode register banking for all ARM modes.',
        ],
      };
      return this.diagnostics;
    }

    _makeInterruptDiagnostics() {
      const ime = this.bus.read16(0x04000208) & 1;
      const ie = this.bus.read16(0x04000200);
      const flags = this.bus.read16(0x04000202);
      const handler = this.bus.read32(0x03007FFC);
      return {
        ime,
        ieHex: tools.hex(ie, 4),
        ifHex: tools.hex(flags, 4),
        pendingHex: tools.hex(ime ? (ie & flags) : 0, 4),
        handlerHex: tools.hex(handler),
        vectorWrites: this.bus.irqVectorWrites.slice(-12).map(w => ({
          addrHex: w.addrHex,
          valueHex: w.valueHex,
          bytes: w.bytes,
          kind: w.kind,
          pcHex: w.pcHex,
        })),
        vblankCount: this.bus.vblankCount,
        cycles: this.bus.cycles,
        frameCycles: this.bus.frameCycles,
        recent: this.bus.irqEvents.slice(-24),
        dispatches: this.cpu?.irqDispatches?.slice(-16) || [],
        calls: this.cpu?.irqCallTargets?.slice(-16) || [],
        firstCalls: this.cpu?.irqCallTargetsFirst?.slice(0, 16) || [],
        stepStats: this.cpu?.irqStepStats || {},
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
        const reload = this.bus.timerReload(ch);
        const counter = this.bus.timerCounters[ch] & 0xffff;
        const control = reg16(base + 2);
        const prescaler = TIMER_PRESCALERS[control & 3];
        const period = 0x10000 - reload;
        const enabled = !!(control & 0x80);
        const cascade = !!(control & 0x04);
        timers.push({
          ch,
          reload,
          reloadHex: tools.hex(reload, 4),
          counter,
          counterHex: tools.hex(counter, 4),
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
        timerReloadLog: this.bus.timerReloadLog,
        timerCodeDump: (() => {
          const readThumb = addr => {
            const b0 = this.bus.read8(addr), b1 = this.bus.read8(addr+1);
            return tools.hex((b1 << 8) | b0, 4);
          };
          const readWord = addr => {
            const b0=this.bus.read8(addr),b1=this.bus.read8(addr+1),b2=this.bus.read8(addr+2),b3=this.bus.read8(addr+3);
            return tools.hex(((b3<<24)|(b2<<16)|(b1<<8)|b0)>>>0);
          };
          // Literal pool for path1 — extend by 12 bytes to capture 0x081c24d0
          const pool1 = [];
          for (let i = 0; i < 44; i += 4)
            pool1.push(`${tools.hex(0x081c24b0+i)}:${readWord(0x081c24b0+i)}`);
          // Literal pool for path2
          const pool2 = [];
          for (let i = 0; i < 44; i += 4)
            pool2.push(`${tools.hex(0x081c1250+i)}:${readWord(0x081c1250+i)}`);
          // Division fn region (path1 BL target at 0x08001854; also check 0x08001800-0x08001900)
          const fn1 = [];
          for (let i = 0; i < 128; i += 2)
            fn1.push(`${tools.hex(0x08001800+i)}:${readThumb(0x08001800+i)}`);
          // fn2 trampoline at 0x08002054 → IWRAM; also dump IWRAM fn at 0x03000528
          const fn2 = [];
          for (let i = 0; i < 48; i += 2)
            fn2.push(`${tools.hex(0x08002054+i)}:${readThumb(0x08002054+i)}`);
          const iwramFn = [];
          for (let i = 0; i < 64; i += 2)
            iwramFn.push(`${tools.hex(0x03000528+i)}:${readThumb(0x03000528+i)}`);
          // Also dump IWRAM div fn for path1 BL (0x03000480-0x030004ff)
          const iwramDiv1 = [];
          for (let i = 0; i < 64; i += 2)
            iwramDiv1.push(`${tools.hex(0x03000480+i)}:${readThumb(0x03000480+i)}`);
          return { pool1, pool2, fn1, fn2, iwramFn, iwramDiv1,
            lit24d0: readWord(0x081c24d0),
            regSnaps: this.bus.timerRegSnaps || [] };
        })(),
        // Disassemble the branch that gates the DMA1/DMA2 SAD-reload block (0x081dd78c) --
        // dmaReloadBranch shows it's taken exactly every 14 VBlanks instead of the 7 the
        // 1584-byte buffer geometry implies, so we need the raw instructions/condition to
        // see what counter or flag is actually being tested at the branch site.
        dmaReloadCodeDump: (() => {
          const readThumb = addr => {
            const b0 = this.bus.read8(addr), b1 = this.bus.read8(addr+1);
            return tools.hex((b1 << 8) | b0, 4);
          };
          const code = [];
          for (let i = 0; i < 0x60; i += 2)
            code.push(`${tools.hex(0x081dd750+i)}:${readThumb(0x081dd750+i)}`);
          return { code };
        })(),
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
      parts.push('playback: LLE stream/export available, including PSG mix');
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
    buildSincKernel,
  };
  window.StandardGsfEngine = StandardGsfEngine;
})();
