// GBS (Game Boy Sound) playback engine boundary — the DMG-side counterpart to
// gsf_emulator.js's StandardGsfEngine. Kept in its own file so z80_emulator.js stays
// CPU-core-only, mirroring the gsf.js/gsf_emulator.js split.
(function () {
  const gbs = window.GbsTools;
  const z80 = window.Z80Emulator;
  if (!gbs) throw new Error('dmg_emulator.js requires gbs.js to be loaded first');
  if (!z80) throw new Error('dmg_emulator.js requires z80_emulator.js to be loaded first');

  const DMG_CPU_HZ = 4194304;
  const DMG_CYCLES_PER_FRAME = 70224;
  const TAC_PERIOD = [1024, 16, 64, 256];
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
      this.nextPlayCycle = 0;
      this.playPeriodCycles = DMG_CYCLES_PER_FRAME;
      this.renderCycle = 0;
      this._isr = null; // in-flight play interrupt, executed incrementally by _advancePlaybackTo
      this.channelMask = 0xf; // host mute/solo mask (bit per channel), survives song switches
      this.scopeRing = null; // per-channel output history for oscilloscope views
      this.scopeRingPos = 0;
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
      this._isr = null;
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
      this._isr = null; // a song switch mid-ISR must not resume the old CPU's interrupt
      const doubleSpeed = !!(this.header.timerControl & 0x80);
      this.bus = new z80.DmgMemoryBus(this.romImage, { cpuHz: DMG_CPU_HZ, cpuSpeed: doubleSpeed ? 2 : 1 });
      this.bus.channelMask8 = (this.channelMask & 0xf) * 0x11; // reapply host mute/solo to the fresh bus
      this.scopeRing = [new Float32Array(1024), new Float32Array(1024), new Float32Array(1024), new Float32Array(1024)];
      this.scopeRingPos = 0;
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
      // Timer cadence: TIMA counts up from TMA at TAC_PERIOD cycles per tick and interrupts
      // on overflow, so the play-call period is (256 - TMA) ticks — not one. TAC bit 7 is
      // the GBS convention for CGB double-speed, which doubles the call rate.
      this.playPeriodCycles = h.usesTimer
        ? Math.max(1, (TAC_PERIOD[h.timerControl & 0x03] * (256 - h.timerModulo)) >> (h.timerControl & 0x80 ? 1 : 0))
        : DMG_CYCLES_PER_FRAME;
      this.nextPlayCycle = this.bus.cycles + this.playPeriodCycles;
      this.renderCycle = this.bus.cycles;
    }

    // Enters the play interrupt WITHOUT running it to completion: the ISR body is executed
    // incrementally by _advancePlaybackTo as the sample clock advances, so its cycle cost
    // lands on the audio timeline exactly where it executes, like real hardware. Running it
    // to completion at one instant jumped bus.cycles ~2k+ cycles past the sample clock,
    // freezing the output waveform for ~25 samples every vblank — an audible ~60Hz buzz.
    _beginPlayInterrupt() {
      const vector = this.header.usesTimer ? TIMER_VECTOR : VBLANK_VECTOR;
      this._isr = { returnPc: this.cpu.pc, guard: 0 };
      const before = this.cpu.cycles;
      this.cpu.serviceVector(this.bus.vectorOverride[vector] ?? vector);
      this.bus.tick(this.cpu.cycles - before);
    }

    // One CPU instruction of the active play ISR. bus.tick must NOT dispatch interrupts
    // here: the routine's own run time accumulates in the bus's synthetic vblank/timer
    // counters, and the stub's closing RETI re-enables IME — with dispatch enabled that
    // immediately re-enters the stub for a bonus play call, making every song run
    // measurably fast (~4% on Pokemon Blue). HALT wake is kept manually.
    _stepIsr(guardLimit = 200000) {
      const isr = this._isr;
      const before = this.cpu.cycles;
      this.cpu.step();
      this.bus.tick(this.cpu.cycles - before);
      if (this.cpu.halted && (this.bus.ie & this.bus.if_ & 0x1f)) this.cpu.wake();
      if (this.cpu.illegal || this.cpu.stopped) {
        this.error = this.cpu.reason || 'GBS routine stopped unexpectedly';
        this._endPlayInterrupt();
        return;
      }
      if (this.cpu.pc === isr.returnPc || ++isr.guard >= guardLimit) this._endPlayInterrupt();
    }

    _endPlayInterrupt() {
      this._isr = null;
      this.cpu.ime = true;
      // Drop the cadence interrupt the bus raised from the routine's own run time; the
      // engine schedules the next call itself via nextPlayCycle.
      this.bus.if_ &= ~(this.header.usesTimer ? 0x04 : 0x01);
    }

    _advancePlaybackTo(targetCycle) {
      for (;;) {
        while (this._isr && this.bus.cycles < targetCycle) this._stepIsr();
        if (this._isr) return; // mid-ISR at the sample boundary; resume on the next sample
        if (this.nextPlayCycle && this.nextPlayCycle <= targetCycle) {
          this.bus.tickPassive(this.nextPlayCycle - this.bus.cycles);
          this._beginPlayInterrupt();
          this.nextPlayCycle += this.playPeriodCycles;
        } else {
          this.bus.tickPassive(targetCycle - this.bus.cycles);
          return;
        }
      }
    }

    // Pure, Web-Audio-agnostic rendering: advances the CPU/bus for enough cycles to produce
    // `count` stereo sample pairs at `sampleRate`, mixing the shared PsgDmg module through
    // DmgMemoryBus.mixSample() each output tick. Returns { left, right } Float32Arrays.
    renderSamples(count, sampleRate = 44100) {
      const left = new Float32Array(count);
      const right = new Float32Array(count);
      const cyclesPerSample = DMG_CPU_HZ / sampleRate;
      for (let i = 0; i < count; i++) {
        this.renderCycle += cyclesPerSample;
        this._advancePlaybackTo(this.renderCycle);
        const [l, r] = this.bus.mixSample();
        left[i] = Math.max(-1, Math.min(1, l / 15));
        right[i] = Math.max(-1, Math.min(1, r / 15));
        if (this.scopeRing) {
          // outputsAt is memoized per cycle, so this reuses the per-channel samples the
          // mix above already computed — pre-NR51, so a host-muted channel still scopes.
          const chOut = this.bus.psg.outputsAt(this.bus.cycles);
          const pos = this.scopeRingPos;
          this.scopeRing[0][pos] = chOut[0] / 15;
          this.scopeRing[1][pos] = chOut[1] / 15;
          this.scopeRing[2][pos] = chOut[2] / 15;
          this.scopeRing[3][pos] = chOut[3] / 15;
          this.scopeRingPos = (pos + 1) & 1023;
        }
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

    // Register-level channel snapshot for UI visualization (piano roll / live keyboard /
    // channel diagnostics). GBS has no sequencer to emit note events, but the PSG registers
    // ARE the notes: the tonal channels' live frequency registers convert to a (fractional)
    // MIDI note, the trigger timestamps give exact note onsets, and the envelope volume
    // distinguishes sounding from silent. Noise has no pitch, so it reports its LFSR shift
    // rate instead. `pan` reflects the game's own NR51 routing (not the host mute mask).
    channelNotes() {
      if (!this.bus) return null;
      const p = this.bus.psg;
      const nr51 = this.bus.io[0x25] | 0;
      const midiFromHz = (hz) => 69 + 12 * Math.log2(hz / 440);
      const pan = (ch) => ((nr51 & (0x10 << ch)) ? 'L' : '') + ((nr51 & (1 << ch)) ? 'R' : '');
      const sq = (i) => {
        const st = p.square[i];
        const hz = 131072 / Math.max(1, 2048 - st.freqCur);
        return {
          kind: i ? 'sq2' : 'sq1',
          on: !!(st.enabled && st.volume > 0 && (nr51 & (0x11 << i))), // routed to either speaker
          hz,
          midi: midiFromHz(hz),
          vol: st.volume / 15,
          triggerVol: st.volInit / 15,
          triggerCycles: st.triggerCycles,
          pan: pan(i),
          duty: st.dutyFraction,
          envDir: st.envDir,
          envStep: st.envStep,
          sweep: i === 0 ? { period: st.sweepPeriod, shift: st.sweepShift, dir: st.sweepDir, enabled: st.sweepEnabled } : null,
        };
      };
      const w = p.wave;
      const n = p.noise;
      const waveHz = 65536 / Math.max(1, 2048 - w.freqCur);
      return [
        sq(0),
        sq(1),
        {
          kind: 'wave',
          on: !!(w.enabled && (w.forceVolume || w.outputLevel > 0) && (nr51 & 0x44)),
          hz: waveHz,
          midi: midiFromHz(waveHz),
          vol: w.forceVolume ? 0.75 : w.outputLevel,
          triggerVol: w.forceVolume ? 0.75 : w.outputLevel,
          triggerCycles: w.triggerCycles,
          pan: pan(2),
          level: w.forceVolume ? 'force75%' : ['mute', '100%', '50%', '25%'][[0, 1, 0.5, 0.25].indexOf(w.outputLevel)] || `${w.outputLevel}`,
        },
        {
          kind: 'noise',
          on: !!(n.enabled && n.volume > 0 && (nr51 & 0x88)),
          rateHz: this.bus.cpuHz / Math.max(1, n.periodCycles || 32),
          vol: n.volume / 15,
          triggerVol: n.volInit / 15,
          triggerCycles: n.triggerCycles,
          pan: pan(3),
          width: n.widthMode ? 7 : 15,
          envDir: n.envDir,
          envStep: n.envStep,
        },
      ];
    }

    // Chronological copy of one channel's recent raw output (normalized -1..1), for
    // oscilloscope views. Captured pre-NR51 during renderSamples.
    channelScope(ch) {
      const ring = this.scopeRing?.[ch];
      if (!ring) return null;
      const out = new Float32Array(ring.length);
      const pos = this.scopeRingPos;
      out.set(ring.subarray(pos));
      out.set(ring.subarray(0, pos), ring.length - pos);
      return out;
    }

    // Host-side mute/solo: a 4-bit channel mask ANDed onto NR51 at mix time only — the
    // driver and PSG keep running normally, exactly like the HLE path's track mute.
    setChannelMask(mask4) {
      this.channelMask = mask4 & 0xf;
      if (this.bus) this.bus.channelMask8 = this.channelMask * 0x11;
    }

    summary() {
      if (!this.canPlay()) return `GBS engine: ${this.state}${this.error ? ' (' + this.error + ')' : ''}`;
      const h = this.header;
      return `GBS: "${h.title}" by ${h.author} | songs: ${h.songCount} | ${h.usesTimer ? 'timer' : 'vblank'}-driven${h.timerControl & 0x80 ? ' | CGB 2x CPU' : ''} | PSG mix via shared PsgDmg module`;
    }
  }

  window.DmgEmulator = { StandardGbsEngine, DMG_CPU_HZ };
})();
