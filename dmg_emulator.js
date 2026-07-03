// GBS (Game Boy Sound) playback engine boundary — the DMG-side counterpart to
// gsf_emulator.js's StandardGsfEngine. Kept in its own file so z80_emulator.js stays
// CPU-core-only, mirroring the gsf.js/gsf_emulator.js split.
(function () {
  const gbs = window.GbsTools;
  const z80 = window.Z80Emulator;
  if (!gbs) throw new Error('dmg_emulator.js requires gbs.js to be loaded first');
  if (!z80) throw new Error('dmg_emulator.js requires z80_emulator.js to be loaded first');

  const DMG_CPU_HZ = 4194304;
  const VBLANK_VECTOR = 0x40, TIMER_VECTOR = 0x50;
  // Scratch memory region used to synthesize interrupt-vector stub routines (CALL playAddr;
  // RETI) — GBS rips generally don't include real vector-table code, since the ripping tool
  // only extracts the driver routines themselves, so the loader is expected to provide this
  // glue. Placed in the middle of WRAM-mapped space isn't valid (WRAM starts at 0xC000 and
  // isn't executable-restricted on real hardware, so it works fine as scratch code space).
  const STUB_ADDR = 0xff80; // HRAM: unused by GBS drivers, always safe scratch space

  class StandardGbsEngine {
    constructor() {
      this.state = 'idle'; // idle -> loading -> loaded -> error
      this.header = null;
      this.bus = null;
      this.cpu = null;
      this.error = null;
      this.source = null;
      this.sources = new Set();
      this.playTimer = null;
      this.nextStartTime = 0;
    }

    // Clears any loaded song, matching StandardGsfEngine.reset()'s role: called when the UI
    // switches away to a non-GBS file so a stale bus/cpu/header can't be played by mistake.
    reset() {
      this.stop();
      this.state = 'idle';
      this.header = null;
      this.romImage = null;
      this.bus = null;
      this.cpu = null;
      this.error = null;
    }

    loadBuffer(buf) {
      this.state = 'loading';
      try {
        if (!gbs.isValid(buf)) throw new Error('not a valid GBS file');
        this.header = gbs.decodeHeader(buf);
        this.romImage = gbs.romImage(buf, this.header);
        this.state = 'loaded';
      } catch (e) {
        this.state = 'error';
        this.error = String(e && e.message || e);
      }
      return this.header;
    }

    canPlay() {
      return this.state === 'loaded' && !!this.header && !!this.romImage;
    }

    // Builds the bus+CPU and runs the song's init routine to completion. `songIndex` is
    // 0-based (GBS convention: init is called with A = 0..songCount-1).
    _initCpu(songIndex = 0) {
      this.bus = new z80.DmgMemoryBus(this.romImage, { cpuHz: DMG_CPU_HZ });
      this.cpu = new z80.Sm83Cpu(this.bus);
      const h = this.header;
      this.cpu.sp = h.stackPointer;

      // Real hardware never runs a cartridge's own code without the boot ROM having already
      // powered on the APU (NR52), set a working volume (NR50), and enabled panning for all
      // 4 channels (NR51) — GBS driver code is written assuming that already happened, and
      // generally doesn't repeat it, so without this every channel would be silently muted
      // by NR51 defaulting to 0 (no channel routed to either speaker) even once the driver
      // triggers them.
      this.bus.write8(0xff26, 0x80); // NR52: power on
      this.bus.write8(0xff24, 0x77); // NR50: max volume both sides, ignore VIN
      this.bus.write8(0xff25, 0xff); // NR51: all 4 channels -> both left and right

      // Synthesize CALL playAddr; RETI in HRAM (writable, unlike ROM — GBS rips don't include
      // a real vector table since the ripping tool only extracts the driver routines) and
      // redirect whichever vector the driver expects to be ticked from at it, per the GBS
      // convention: nonzero TMA/TAC means "use the timer interrupt", otherwise vblank.
      const vector = h.usesTimer ? TIMER_VECTOR : VBLANK_VECTOR;
      this.bus.write8(STUB_ADDR, 0xcd);              // CALL nn
      this.bus.write8(STUB_ADDR + 1, h.playAddr & 0xff);
      this.bus.write8(STUB_ADDR + 2, (h.playAddr >>> 8) & 0xff);
      this.bus.write8(STUB_ADDR + 3, 0xd9);           // RETI
      this.bus.vectorOverride[vector] = STUB_ADDR;

      if (h.usesTimer) {
        this.bus.write8(0xff06, h.timerModulo);
        this.bus.write8(0xff07, h.timerControl);
        this.bus.ie = 0x04; // Timer
      } else {
        this.bus.ie = 0x01; // VBlank
      }

      // Run init(A=songIndex) to completion: push a sentinel return address and stop once
      // the CPU RETs back to it (or after a generous cycle cap, in case init never returns).
      const SENTINEL = 0xfffe;
      this.cpu.a = songIndex;
      this.cpu.pc = h.initAddr;
      this.cpu._push16(SENTINEL);
      let guard = 0;
      while (this.cpu.pc !== SENTINEL && guard++ < 2_000_000) {
        const before = this.cpu.cycles;
        this.cpu.step();
        this.bus.tick(this.cpu.cycles - before, this.cpu);
        if (this.cpu.illegal || this.cpu.stopped) {
          this.error = this.cpu.reason || 'GBS init stopped unexpectedly';
          break;
        }
      }
      this.cpu.ime = true;
    }

    // Pure, Web-Audio-agnostic rendering: advances the CPU/bus for enough cycles to produce
    // `count` stereo sample pairs at `sampleRate`, mixing the shared PsgDmg module through
    // DmgMemoryBus.mixSample() each output tick. Returns { left, right } Float32Arrays.
    renderSamples(count, sampleRate = 44100) {
      const left = new Float32Array(count);
      const right = new Float32Array(count);
      const cyclesPerSample = DMG_CPU_HZ / sampleRate;
      let cycleBudget = 0;
      for (let i = 0; i < count; i++) {
        cycleBudget += cyclesPerSample;
        while (cycleBudget > 0) {
          const before = this.cpu.cycles;
          this.cpu.step();
          const delta = this.cpu.cycles - before;
          this.bus.tick(delta, this.cpu);
          cycleBudget -= delta;
        }
        const [l, r] = this.bus.mixSample();
        left[i] = Math.max(-1, Math.min(1, l / 15));
        right[i] = Math.max(-1, Math.min(1, r / 15));
      }
      return { left, right };
    }

    _scheduleChunk(ctx, count) {
      if (!this.cpu || !this.bus) return 0;
      const { left, right } = this.renderSamples(count, ctx.sampleRate);
      const buffer = ctx.createBuffer(2, count, ctx.sampleRate);
      buffer.getChannelData(0).set(left);
      buffer.getChannelData(1).set(right);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      this.sources.add(src);
      src.onended = () => this.sources.delete(src);
      const startAt = Math.max(ctx.currentTime + 0.02, this.nextStartTime || 0);
      src.start(startAt);
      this.nextStartTime = startAt + buffer.duration;
      this.source = src;
      return buffer.duration;
    }

    // Browser playback: continuously schedules small Web Audio buffers. Rendering a whole
    // song-sized block on click stalls the browser badly for GBS files, since every sample
    // advances the SM83/APU; chunking keeps the UI responsive and avoids one-shot blips.
    async play(songIndex = 0) {
      if (typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') {
        throw new Error('Web Audio is not available in this environment');
      }
      this.stop(); // don't let a previous song's buffer keep playing underneath the new one
      this._initCpu(songIndex);
      const Ctx = typeof AudioContext !== 'undefined' ? AudioContext : webkitAudioContext;
      const ctx = this.audioCtx || (this.audioCtx = new Ctx());
      if (ctx.state === 'suspended') await ctx.resume();
      const chunkSamples = Math.max(1024, Math.floor(ctx.sampleRate * 0.10));
      this.nextStartTime = ctx.currentTime + 0.03;
      const pump = () => {
        if (!this.cpu || !this.bus) return;
        while (this.nextStartTime < ctx.currentTime + 0.25) this._scheduleChunk(ctx, chunkSamples);
        this.playTimer = setTimeout(pump, 60);
      };
      pump();
      return this.source;
    }

    stop() {
      if (this.playTimer) { clearTimeout(this.playTimer); this.playTimer = null; }
      if (this.sources) {
        for (const src of this.sources) { try { src.stop(); } catch (_) {} }
        this.sources.clear();
      }
      this.source = null;
    }

    summary() {
      if (!this.canPlay()) return `GBS engine: ${this.state}${this.error ? ' (' + this.error + ')' : ''}`;
      const h = this.header;
      return `GBS: "${h.title}" by ${h.author} | songs: ${h.songCount} | ${h.usesTimer ? 'timer' : 'vblank'}-driven | PSG mix via shared PsgDmg module`;
    }
  }

  window.DmgEmulator = { StandardGbsEngine, DMG_CPU_HZ };
})();
