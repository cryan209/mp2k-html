// Shared DMG/GBC/GBA PSG (Programmable Sound Generator) chip model.
//
// GBA's 4 "PSG" channels (Square1 w/ sweep, Square2, Wave, Noise) are the same DMG/GBC
// APU channels, just reached through a different address layout and run from a CPU
// clock that is exactly 4x the original DMG rate. This module implements the chip
// itself (register file, frame sequencer, envelope/sweep/length, wave RAM, noise LFSR)
// parameterized by cpuHz so it can back both a GBA host (gsf_emulator.js) and a future
// DMG/GBS host at their native clock rates. Anything host-specific (GBA's SOUNDCNT_L/H
// stereo mixing, wave RAM bank-swap MMIO, master-enable register plumbing) stays in the
// host, not here.
//
// Register API uses canonical DMG offsets relative to 0xFF10 (real hardware addressing),
// since a DMG bus can pass these straight through, while a GBA host translates its own
// SOUNDCNT_* layout into these offsets.
(function () {
  const NR10 = 0x00, NR11 = 0x01, NR12 = 0x02, NR13 = 0x03, NR14 = 0x04;
  const NR21 = 0x06, NR22 = 0x07, NR23 = 0x08, NR24 = 0x09;
  const NR30 = 0x0a, NR31 = 0x0b, NR32 = 0x0c, NR33 = 0x0d, NR34 = 0x0e;
  const NR41 = 0x10, NR42 = 0x11, NR43 = 0x12, NR44 = 0x13;
  const REG_COUNT = 0x14;

  function freshSquare() {
    return {
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
    };
  }

  function freshWave() {
    return {
      enabled: false, triggerCycles: 0, lastSampleCycles: 0,
      freqRaw: 0, freqCur: 0,
      lengthEnabled: false, lengthCounter: 0, lengthCyclesTotal: Infinity,
      outputLevel: 0, forceVolume: false,
      phase: 0,
    };
  }

  function freshNoise() {
    return {
      enabled: false, triggerCycles: 0, lastSampleCycles: 0,
      volInit: 0, volume: 0, envDir: 0, envStep: 0, envStepsApplied: 0,
      envTimer: 0, envActive: false,
      lengthEnabled: false, lengthCounter: 0, lengthCyclesTotal: Infinity,
      divRatio: 0, widthMode: 0, shiftFreq: 0,
      periodCycles: 32,
      lfsr: 0x7fff, phaseCycles: 0,
    };
  }

  class PsgDmg {
    constructor({ cpuHz = 4194304 } = {}) {
      this.cpuHz = cpuHz;
      this.frameSeqPeriod = Math.round(cpuHz / 512);
      this._noisePeriodRatio = cpuHz / 524288; // 32 on GBA, 8 on DMG
      this.reset();
    }

    reset() {
      this.regs = new Uint8Array(REG_COUNT);
      this.wave = freshWave();
      this.waveRam = new Uint8Array(16); // 32 packed 4-bit digits
      this.square = [freshSquare(), freshSquare()];
      this.noise = freshNoise();
      this.frameSeqCycles = 0;
      this.frameSeqStep = 0;
      this.sampleCacheCycles = -1;
      this.sampleCache = [0, 0, 0, 0];
    }

    // Zeroes register/channel state the way a real NR52-power-off does, without touching
    // frame-sequencer phase (hosts may keep their own master-enable bit elsewhere).
    powerOff() {
      this.regs.fill(0);
      for (const st of this.square) {
        st.enabled = false;
        st.envActive = false;
        st.sweepEnabled = false;
        st.volume = 0;
        st.lengthCounter = 0;
      }
      this.wave.enabled = false;
      this.wave.lengthCounter = 0;
      this.noise.enabled = false;
      this.noise.envActive = false;
      this.noise.volume = 0;
      this.noise.lengthCounter = 0;
      this.sampleCacheCycles = -1;
    }

    // 4-bit channel-enabled status (NR52 bits 0-3 on real hardware); master-power bit
    // (NR52 bit 7) is a host concern since powering off also needs host-side bookkeeping.
    channelStatusBits() {
      return (this.square[0].enabled ? 0x01 : 0)
        | (this.square[1].enabled ? 0x02 : 0)
        | (this.wave.enabled ? 0x04 : 0)
        | (this.noise.enabled ? 0x08 : 0);
    }

    _regPair(loOffset) {
      return this.regs[loOffset] | (this.regs[loOffset + 1] << 8);
    }

    // nowCycles is the host's current cycle counter, needed to timestamp triggerCycles/
    // lastSampleCycles on any register write that triggers a channel.
    writeReg(offset, value, nowCycles = 0) {
      value &= 0xff;
      this.regs[offset] = value;
      this.sampleCacheCycles = -1;
      switch (offset) {
        case NR12:
          if ((value & 0xf8) === 0) this.square[0].enabled = false;
          break;
        case NR22:
          if ((value & 0xf8) === 0) this.square[1].enabled = false;
          break;
        case NR14:
          this._updateSquareFreq(0);
          if (value & 0x80) this._triggerSquare(0, nowCycles);
          break;
        case NR24:
          this._updateSquareFreq(1);
          if (value & 0x80) this._triggerSquare(1, nowCycles);
          break;
        case NR30:
          if (!(value & 0x80)) this.wave.enabled = false;
          break;
        case NR34:
          this._updateWaveFreq();
          if (value & 0x80) this._triggerWave(nowCycles);
          break;
        case NR43:
          this._updateNoiseControl();
          break;
        case NR42:
          if ((value & 0xf8) === 0) this.noise.enabled = false;
          break;
        case NR44:
          this.noise.lengthEnabled = !!(this._regPair(NR43) & 0x4000);
          if (value & 0x80) this._triggerNoise(nowCycles);
          break;
        default:
          break;
      }
    }

    // Stores a register byte without any trigger/update side effects. Hosts that need
    // fine-grained control over exactly when side effects fire (e.g. gsf_emulator.js, which
    // wraps triggers with its own diagnostics) poke the register file directly and then call
    // the specific _update*/_trigger* method themselves instead of using writeReg.
    pokeReg(offset, value) {
      this.regs[offset] = value & 0xff;
      this.sampleCacheCycles = -1;
    }

    readReg(offset) {
      return this.regs[offset] ?? 0xff;
    }

    writeWave(index, value) {
      this.waveRam[index & 0xf] = value & 0xff;
      this.sampleCacheCycles = -1;
    }

    readWave(index) {
      return this.waveRam[index & 0xf] || 0;
    }

    // Live frequency/length-enable update: called on every write to NR14/NR24, regardless
    // of the trigger bit. On real hardware the frequency register feeds the channel's timer
    // reload continuously, so a write without Trigger takes effect immediately as a pitch
    // bend rather than only being cached for the next note.
    _updateSquareFreq(ch) {
      const st = this.square[ch];
      const freqReg = this._regPair(ch === 0 ? NR13 : NR23);
      st.freqRaw = freqReg & 0x7ff;
      st.freqCur = st.freqRaw;
      st.lengthEnabled = !!(freqReg & 0x4000);
      if (!st.lengthEnabled && st.lengthCounter <= 0) st.lengthCounter = 64;
    }

    // Trigger ("Initial"/restart): relatch duty/envelope/volume, length, and (Square1 only)
    // sweep, and reset phase only if the channel wasn't already sounding (real hardware does
    // not reset a pulse channel's duty position on Trigger if it's already playing).
    _triggerSquare(ch, nowCycles = 0) {
      const st = this.square[ch];
      const envReg = this._regPair(ch === 0 ? NR11 : NR21);
      let triggerEnabled = ((envReg >>> 8) & 0xf8) !== 0;
      const dutyBits = (envReg >>> 6) & 3;
      st.dutyFraction = [0.125, 0.25, 0.5, 0.75][dutyBits];
      st.dutyStep = [1, 2, 4, 6][dutyBits];
      st.volInit = (envReg >>> 12) & 0xf;
      st.volume = st.volInit;
      st.envDir = (envReg >>> 11) & 1; // 0=decrease, 1=increase
      st.envStep = (envReg >>> 8) & 7;
      st.envStepsApplied = 0;
      st.envTimer = st.envStep || 8;
      st.envActive = st.envStep > 0;
      const lengthData = envReg & 0x3f;
      st.lengthCounter = 64 - lengthData;
      st.lengthCyclesTotal = st.lengthEnabled ? (64 - lengthData) * (this.cpuHz / 256) : Infinity;
      if (ch === 0) {
        const sweepReg = this.regs[NR10];
        st.sweepShift = sweepReg & 7;
        st.sweepDir = (sweepReg >>> 3) & 1; // 0=increase, 1=decrease
        st.sweepPeriod = (sweepReg >>> 4) & 7;
        st.sweepStepsApplied = 0;
        st.sweepTimer = st.sweepPeriod || 8;
        st.sweepShadow = st.freqCur;
        st.sweepEnabled = !!(st.sweepPeriod || st.sweepShift);
        if (st.sweepShift && this._sweepCalc(st, false) > 2047) triggerEnabled = false;
      }
      if (!st.enabled) st.phase = 0;
      st.triggerCycles = nowCycles;
      st.lastSampleCycles = nowCycles;
      st.enabled = triggerEnabled;
    }

    _clockLength(st) {
      if (!st || !st.enabled || !st.lengthEnabled || !(st.lengthCounter > 0)) return;
      st.lengthCounter--;
      if (st.lengthCounter <= 0) st.enabled = false;
    }

    _clockEnvelope(st) {
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

    _sweepCalc(st, commit) {
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

    _clockSweep() {
      const st = this.square[0];
      if (!st?.enabled || !st.sweepEnabled) return;
      st.sweepTimer--;
      if (st.sweepTimer > 0) return;
      st.sweepTimer = st.sweepPeriod || 8;
      st.sweepStepsApplied++;
      if (st.sweepPeriod > 0) {
        const next = this._sweepCalc(st, true);
        if (st.enabled && st.sweepShift > 0 && next <= 2047 && this._sweepCalc(st, false) > 2047) {
          st.enabled = false;
        }
      }
    }

    _clockFrameSequencer(nowCycles) {
      if (nowCycles < this.frameSeqCycles) this.frameSeqCycles = nowCycles;
      while (this.frameSeqCycles + this.frameSeqPeriod <= nowCycles) {
        this.frameSeqCycles += this.frameSeqPeriod;
        const step = this.frameSeqStep & 7;
        if ((step & 1) === 0) {
          this._clockLength(this.square[0]);
          this._clockLength(this.square[1]);
          this._clockLength(this.wave);
          this._clockLength(this.noise);
        }
        if (step === 2 || step === 6) this._clockSweep();
        if (step === 7) {
          this._clockEnvelope(this.square[0]);
          this._clockEnvelope(this.square[1]);
          this._clockEnvelope(this.noise);
        }
        this.frameSeqStep = (this.frameSeqStep + 1) & 7;
      }
    }

    _updateWaveFreq() {
      const st = this.wave;
      const freqReg = this._regPair(NR33);
      st.freqRaw = freqReg & 0x7ff;
      st.freqCur = st.freqRaw;
      st.lengthEnabled = !!(freqReg & 0x4000);
      if (!st.lengthEnabled && st.lengthCounter <= 0) st.lengthCounter = 256;
    }

    _triggerWave(nowCycles = 0) {
      const st = this.wave;
      const cntL = this.regs[NR30];
      const cntH = this._regPair(NR31); // NR31 (length, low byte) + NR32 (volume, high byte)
      // NR30 bit7: DAC power. If off, the channel produces no output regardless of Trigger.
      const dacOn = !!(cntL & 0x80);
      const levelBits = (cntH >>> 13) & 3;
      st.outputLevel = [0, 1, 0.5, 0.25][levelBits];
      st.forceVolume = !!(cntH & 0x8000);
      const lengthData = cntH & 0xff;
      st.lengthCounter = 256 - lengthData;
      st.lengthCyclesTotal = st.lengthEnabled ? (256 - lengthData) * (this.cpuHz / 256) : Infinity;
      st.phase = 0;
      st.triggerCycles = nowCycles;
      st.lastSampleCycles = nowCycles;
      st.enabled = dacOn;
    }

    // Flat 32-digit (16-byte) DMG wave RAM, MSB-first per byte, looping. GBA's dual-bank
    // wave RAM (bank-swap between CPU-visible and playing halves) is host-specific MMIO and
    // stays in the host, which is expected to keep this module's waveRam pointed at whichever
    // 16 bytes are currently "playing".
    _waveSample(index) {
      const sample = ((index % 32) + 32) % 32;
      const byte = this.waveRam[sample >>> 1] || 0;
      const nibble = (index & 1) === 0 ? (byte >>> 4) & 0xf : byte & 0xf;
      return nibble - 8; // center to roughly -8..7
    }

    _waveAdvance(nowCycles) {
      const st = this.wave;
      if (!st.enabled) return 0;
      const digitRate = 2097152 / (2048 - st.freqCur);
      const waveLength = 32;
      const dtCycles = nowCycles - st.lastSampleCycles;
      st.lastSampleCycles = nowCycles;
      const level = st.forceVolume ? 0.75 : st.outputLevel;
      if (!(dtCycles > 0)) return this._waveSample(Math.floor(st.phase) % waveLength) * level;
      const digitPeriodCycles = this.cpuHz / digitRate;
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

    _triggerNoise(nowCycles = 0) {
      const st = this.noise;
      const envReg = this._regPair(NR41);
      const freqReg = this._regPair(NR43);
      st.volInit = (envReg >>> 12) & 0xf;
      st.volume = st.volInit;
      const triggerEnabled = ((envReg >>> 8) & 0xf8) !== 0;
      st.envDir = (envReg >>> 11) & 1;
      st.envStep = (envReg >>> 8) & 7;
      st.envStepsApplied = 0;
      st.envTimer = st.envStep || 8;
      st.envActive = st.envStep > 0;
      st.lengthEnabled = !!(freqReg & 0x4000);
      const lengthData = envReg & 0x3f;
      st.lengthCounter = 64 - lengthData;
      st.lengthCyclesTotal = st.lengthEnabled ? (64 - lengthData) * (this.cpuHz / 256) : Infinity;
      this._updateNoiseControl(freqReg);
      st.lfsr = 0x7fff;
      st.phaseCycles = 0;
      st.triggerCycles = nowCycles;
      st.lastSampleCycles = nowCycles;
      st.enabled = triggerEnabled;
    }

    _updateNoiseControl(freqReg = this._regPair(NR43)) {
      const st = this.noise;
      st.divRatio = freqReg & 7;
      st.widthMode = (freqReg >>> 3) & 1; // 0=15-bit, 1=7-bit
      st.shiftFreq = (freqReg >>> 4) & 0xf;
      // GBATEK: frequency = 524288 / r / 2^(s+1), with r=0 treated as 0.5. In CPU cycles at
      // this.cpuHz that's (cpuHz/524288) * r * 2^(s+1), or half that for r=0.
      const ratio = this._noisePeriodRatio;
      st.periodCycles = (st.divRatio ? ratio * 2 * st.divRatio : ratio) * Math.pow(2, st.shiftFreq);
      this.sampleCacheCycles = -1;
    }

    _noiseAdvance(nowCycles) {
      const st = this.noise;
      if (!st.enabled) return 0;
      const dCycles = nowCycles - st.lastSampleCycles;
      st.lastSampleCycles = nowCycles;
      if (!(dCycles > 0)) return this._noiseOutput(st);
      // Shift periods are integer CPU-cycle counts. Cap iterations defensively so a huge dt
      // (e.g. after a long halt) cannot spin here for an unbounded amount of work.
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

    // GB/CGB noise uses xor feedback from bits 0 and 1, shifts right, writes feedback to
    // bit14, and mirrors it into bit6 in 7-bit mode. The DAC output is the inverted low bit.
    _noiseShift(st) {
      st.lfsr = PsgDmg.noiseShift(st.lfsr, st.widthMode);
    }

    // Pure LFSR-shift step, exposed statically so hosts that keep their own noise state
    // outside a PsgDmg instance (e.g. mp2k.js's offline buffer pre-renderer) can still share
    // the one implementation of the GB/CGB noise polynomial instead of duplicating it.
    static noiseShift(lfsr, widthMode) {
      const feedback = (lfsr ^ (lfsr >>> 1)) & 1;
      lfsr = (lfsr >>> 1) | (feedback << 14);
      if (widthMode) lfsr = (lfsr & ~0x40) | (feedback << 6);
      return lfsr;
    }

    // Advance envelope/length/(ch0)sweep timing to `nowCycles` and return this channel's
    // current waveform sample. Idempotent w.r.t. nowCycles, so it's safe to call once per
    // stereo output channel even if both land on the same cycle.
    _advanceSquare(ch, nowCycles) {
      const st = this.square[ch];
      if (!st.enabled) return 0;
      const stepRate = 1048576 / (2048 - st.freqCur);
      const dt = (nowCycles - st.lastSampleCycles) / this.cpuHz;
      st.lastSampleCycles = nowCycles;
      const stepStart = st.phase;
      const stepInc = stepRate * dt;
      st.phase = ((stepStart + stepInc) % 8 + 8) % 8;
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

    // Pull model: advance frame-sequencer + all four channels up to nowCycles and return
    // the cached [sq1, sq2, wave, noise] sample array (memoized per exact cycle number).
    outputsAt(nowCycles) {
      if (this.sampleCacheCycles === nowCycles) return this.sampleCache;
      this._clockFrameSequencer(nowCycles);
      const out = this.sampleCache || [0, 0, 0, 0];
      out[0] = this._advanceSquare(0, nowCycles);
      out[1] = this._advanceSquare(1, nowCycles);
      out[2] = this._waveAdvance(nowCycles);
      out[3] = this._noiseAdvance(nowCycles);
      this.sampleCache = out;
      this.sampleCacheCycles = nowCycles;
      return out;
    }

    stepCycles(nowCycles) {
      this._clockFrameSequencer(nowCycles);
    }

    // Push model: advance by a wall-clock delta (seconds) and return the four-channel
    // sample, for hosts that drive sample generation from a real-time audio callback
    // instead of a CPU cycle counter.
    advanceSamples(dt) {
      this._pushCycles = (this._pushCycles || 0) + dt * this.cpuHz;
      return this.outputsAt(this._pushCycles);
    }
  }

  window.PsgDmg = PsgDmg;
})();
