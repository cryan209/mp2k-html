// Smoke test for gsf_emulator.js bus/CPU changes, run under jsc.
var window = this;
window.GsfTools = {
  GBA_ROM_BASE: 0x08000000,
  GBA_ROM_LIMIT: 32 * 1024 * 1024,
  hex: function (v, w) { return '0x' + (v >>> 0).toString(16).padStart(w || 8, '0'); },
  gbaRegionFor: function () { return { id: 'rom' }; },
  isZip: function () { return false; },
  isSevenZip: function () { return false; },
  isValid: function () { return false; },
  tagSummary: function () { return ''; },
};
var console = { warn: function (m) { print('WARN: ' + m); }, log: function (m) { print(m); } };

load('gsf_emulator.js'); // run from the repo root: npm test

var E = window.GsfEmulator;
var failures = 0;
function check(cond, msg) {
  if (cond) print('ok: ' + msg);
  else { print('FAIL: ' + msg); failures++; }
}

function freshBus(romBytes) {
  var memory = E.createMemoryImage();
  if (romBytes) memory.rom.set(romBytes, 0);
  return new E.GbaMemoryBus(memory);
}

// --- 0. existing selfTest still passes ---
var st = E.selfTest();
check(st.r0 === 42 && st.r1 === 1, 'selfTest ARM basics (r0=42, r1=1)');

// --- 0b. loaded engines report playable ---
(function () {
  var eng = new E.StandardGsfEngine();
  eng.state = 'loaded';
  eng.memory = E.createMemoryImage();
  eng.entries = [{ name: 'smoke' }];
  eng._initCpu();
  check(eng.canPlay() === true, 'loaded GSF LLE engine reports playable');
  check(eng.summary().indexOf('PSG mix') >= 0, 'GSF LLE summary mentions PSG mix');
})();

// --- 1. ROM mirrors ---
(function () {
  var bus = freshBus([0x11, 0x22, 0x33, 0x44]);
  check(bus.read8(0x08000001) === 0x22, 'ROM read at 0x08000001');
  check(bus.read8(0x0a000001) === 0x22, 'ROM mirror read at 0x0A000001');
  check(bus.read8(0x0c000003) === 0x44, 'ROM mirror read at 0x0C000003');
  check(bus.canonicalAddr(0x0a000002) === 0x08000002, 'ROM mirror canonicalizes to 0x08');
})();

// --- 2. immediate DMA with fixed destination ---
(function () {
  var bus = freshBus();
  // source data in EWRAM
  bus.write32(0x02000000, 0xaabbccdd);
  bus.write32(0x02000004, 0x11223344);
  // DMA3: src 0x02000000, dst 0x02010000 FIXED, 2 words, 32-bit, immediate, enable
  bus.write32(0x040000d4, 0x02000000);
  bus.write32(0x040000d8, 0x02010000);
  bus.write16(0x040000dc, 2);
  // control: enable(15) | 32bit(10) | dstCtl=2 fixed (bits5-6) | srcCtl=0
  bus.write16(0x040000de, 0x8000 | 0x0400 | (2 << 5));
  check(bus.read32(0x02010000) === 0x11223344, 'fixed-dest DMA leaves last word at fixed addr');
  check(bus.read32(0x02010004) === 0, 'fixed-dest DMA did not spray past dest');
  check((bus.read16(0x040000de) & 0x8000) === 0, 'non-repeat DMA cleared enable');
  check(bus.stallCycles > 0, 'DMA charged stall cycles');
})();

// --- 3. VBlank-timed repeat DMA fires each frame and advances src latch ---
(function () {
  var bus = freshBus();
  for (var i = 0; i < 16; i++) bus.write8(0x02000000 + i, 0x50 + i);
  bus.write32(0x040000b0, 0x02000000);       // DMA0 SAD
  bus.write32(0x040000b4, 0x02020000);       // DAD
  bus.write16(0x040000b8, 2);                // 2 units
  // enable | repeat(9) | timing=1 VBlank (bits12-13) | 16-bit
  bus.write16(0x040000ba, 0x8000 | 0x0200 | (1 << 12));
  check(bus.read16(0x02020000) === 0, 'VBlank DMA does not fire on enable');
  bus.stepCycles(197200);                    // cross VBlank
  check(bus.read16(0x02020000) === 0x5150 && bus.read16(0x02020002) === 0x5352, 'VBlank DMA fired at VBlank');
  bus.stepCycles(280896);                    // next frame (wraps; VBlank flag rearms)
  bus.stepCycles(4);                         // next step crosses the rearmed VBlank threshold
  check(bus.read16(0x02020004) === 0x5554, 'repeat VBlank DMA continued from advanced src+dst latches');
  check((bus.read16(0x040000ba) & 0x8000) !== 0, 'repeat DMA stays enabled');
})();

// --- 4. HBlank DMA with dest reload (ctl 3) only on visible lines ---
(function () {
  var bus = freshBus();
  for (var i = 0; i < 400; i++) bus.write8(0x02000000 + i, (i + 1) & 0xff);
  bus.write32(0x040000b0, 0x02000000);
  bus.write32(0x040000b4, 0x02030000);
  bus.write16(0x040000b8, 1);
  // enable | repeat | timing=2 HBlank | dstCtl=3 inc+reload | 16-bit
  bus.write16(0x040000ba, 0x8000 | 0x0200 | (2 << 12) | (3 << 5));
  bus.stepCycles(1232 * 3);  // 3 scanlines -> 3 HBlanks
  check(bus.read16(0x02030000) === 0x0605, 'HBlank DMA ran 3x with dest reload (last transfer visible at DAD)');
  // advance into VBlank region; HBlank DMA must stop firing
  var before = bus.read16(0x02030000);
  bus.stepCycles(1232 * 165); // now inside VBlank lines
  var srcLatch = bus.dmaSourceLatch[0] >>> 0;
  bus.stepCycles(1232 * 10);  // 10 more VBlank lines
  check((bus.dmaSourceLatch[0] >>> 0) === srcLatch, 'HBlank DMA does not fire during VBlank lines');
})();

// --- 5. HBlank IRQ + VCount IRQ request flags ---
(function () {
  var bus = freshBus();
  bus.write16(0x04000004, 0x10 | 0x20 | (3 << 8)); // hblank irq + vcount irq at line 3
  bus.stepCycles(1100); // past hblank point of line 0
  check((bus.read16(0x04000202) & 0x0002) !== 0, 'HBlank IRQ flag raised');
  bus.write16(0x04000202, 0xffff); // ack
  bus.stepCycles(1232 * 3); // reach line 3
  check((bus.read16(0x04000202) & 0x0004) !== 0, 'VCount IRQ flag raised at match line');
})();

// --- 6. level-triggered FIFO DMA refills after a missed request ---
(function () {
  var bus = freshBus();
  for (var i = 0; i < 64; i++) bus.write8(0x03001000 + i, i);
  bus.write16(0x04000084, 0x80);   // master enable
  bus.write16(0x04000082, 0x0b0e); // enable A, timer0 for A
  bus.write32(0x040000bc, 0x03001000); // DMA1 SAD
  bus.write32(0x040000c0, 0x040000a0); // DAD = FIFO A
  bus.write16(0x040000c6, 0x8000 | 0x0200 | (3 << 12) | 0x0400); // enable, repeat, special, 32-bit
  // timer 0: reload so it overflows every 64 cycles
  bus.write16(0x04000100, 0x10000 - 64);
  bus.write16(0x04000102, 0x0080);
  // FIFO starts empty; first overflow should request + get 16 bytes
  bus.stepCycles(64 * 20);
  check(bus.fifoSamplesA.length >= 19, 'FIFO consumed samples (' + bus.fifoSamplesA.length + ')');
  check(bus.fifoDmaRunTally >= 2, 'FIFO DMA refired repeatedly (' + bus.fifoDmaRunTally + ' runs)');
  var nonZero = bus.fifoSamplesA.filter(function (s) { return s !== 0; }).length;
  check(nonZero > 10, 'FIFO samples carry real data (' + nonZero + ' nonzero)');
})();

// --- 7. unaligned LDR rotation ---
(function () {
  var memory = E.createMemoryImage();
  var view = new DataView(memory.rom.buffer);
  // ldr r1, [r0]  with r0 = 0x02000001 -> expect ror8 of word
  view.setUint32(0, 0xe5901000, true); // ldr r1, [r0]
  view.setUint32(4, 0xe1d020b0, true); // ldrh r2, [r0]  (offset 0 -> odd addr)
  var bus = new E.GbaMemoryBus(memory);
  var cpu = new E.Arm7Cpu(bus, 0x08000000);
  bus.write32(0x02000000, 0x44332211);
  cpu.regs[0] = 0x02000001;
  cpu.step(); // ldr
  check((cpu.regs[1] >>> 0) === 0x11443322, 'unaligned LDR rotates (got ' + (cpu.regs[1] >>> 0).toString(16) + ')');
  cpu.step(); // ldrh at odd address: halfword at 0x2000000 = 0x2211 ror 8 = 0x11000022
  check((cpu.regs[2] >>> 0) === 0x11000022, 'odd LDRH rotates (got ' + (cpu.regs[2] >>> 0).toString(16) + ')');
})();

// --- 8. Halt wakes on mid-frame timer IRQ at scanline granularity ---
(function () {
  var memory = E.createMemoryImage();
  var view = new DataView(memory.rom.buffer);
  view.setUint32(0, 0xef020000, true); // swi 0x02 (Halt)
  var bus = new E.GbaMemoryBus(memory);
  var cpu = new E.Arm7Cpu(bus, 0x08000000);
  bus.write16(0x04000200, 0x0008); // IE: timer0
  bus.write16(0x04000208, 0);      // IME off: halt still wakes on IE&IF
  // timer0 overflow after ~5000 cycles (well before VBlank at 197120)
  bus.write16(0x04000100, 0x10000 - 5000);
  bus.write16(0x04000102, 0x00c0); // enable + irq
  cpu.step(); // executes SWI Halt
  check(bus.cycles > 4000 && bus.cycles < 20000, 'Halt woke mid-frame on timer IRQ (cycles=' + bus.cycles + ')');
  check((bus.read16(0x04000202) & 0x0008) !== 0, 'timer0 IF bit set');
})();

// --- 9. SWI decompression + MidiKey2Freq ---
(function () {
  var memory = E.createMemoryImage();
  var view = new DataView(memory.rom.buffer);
  view.setUint32(0, 0xef110000, true);  // swi 0x11 LZ77UnCompWram
  view.setUint32(4, 0xef140000, true);  // swi 0x14 RLUnCompWram
  view.setUint32(8, 0xef1f0000, true);  // swi 0x1f MidiKey2Freq
  // LZ77 data at ROM 0x100: header size=8, then literals "ABCD" + backref len3 disp4 + literal 'E'
  var lz = 0x100;
  view.setUint32(lz, 0x10 | (8 << 8), true);
  var bytes = [0x08, 0x41, 0x42, 0x43, 0x44, 0x00, 0x03, 0x45];
  // flag byte 0x08: 5th block (bit 3 counting from MSB... bit7=first) -> blocks: flags=0x08 => block4 (0-indexed) compressed
  for (var i = 0; i < bytes.length; i++) view.setUint8(lz + 4 + i, bytes[i]);
  // RL data at ROM 0x140: size=6; run flag 0x83 -> 6 copies of 0x7f
  view.setUint32(0x140, 0x30 | (6 << 8), true);
  view.setUint8(0x144, 0x83);
  view.setUint8(0x145, 0x7f);
  // WaveData at ROM 0x180: freq field (offset 4) = 0x00100000
  view.setUint32(0x184, 0x00100000, true);
  var bus = new E.GbaMemoryBus(memory);
  var cpu = new E.Arm7Cpu(bus, 0x08000000);
  cpu.regs[0] = 0x08000100; cpu.regs[1] = 0x02000000;
  cpu.step();
  var out = [];
  for (var i = 0; i < 8; i++) out.push(bus.read8(0x02000000 + i));
  // Expect: A B C D then backref disp4 len3 => A B C, then E
  check(out[0] === 0x41 && out[4] === 0x41 && out[5] === 0x42 && out[6] === 0x43 && out[7] === 0x45,
    'LZ77 decompressed correctly [' + out.join(',') + ']');
  cpu.regs[0] = 0x08000140; cpu.regs[1] = 0x02000100;
  cpu.step();
  check(bus.read8(0x02000100) === 0x7f && bus.read8(0x02000105) === 0x7f, 'RL run decoded');
  cpu.regs[0] = 0x08000180; cpu.regs[1] = 180; cpu.regs[2] = 0;
  cpu.step();
  check((cpu.regs[0] >>> 0) === 0x00100000, 'MidiKey2Freq at key 180 returns base freq (got ' + (cpu.regs[0] >>> 0).toString(16) + ')');
})();

// --- 10. SOUNDCNT_X master enable gates output ---
(function () {
  var bus = freshBus();
  bus.write16(0x04000084, 0x0000); // master off
  var v = bus._mixPsgInto('A', 100);
  check(v === 0, 'master-disable silences mix');
  bus.write16(0x04000084, 0x0080);
  bus.write16(0x04000082, 0x0004); // DMA A 100%
  var v2 = bus._mixPsgInto('A', 100);
  check(v2 === 400, 'master-enable passes DS at full scale (got ' + v2 + ')');

  bus.write8(0x04000084, 0x8f);
  check(bus.read8(0x04000084) === 0x80, 'SOUNDCNT_X low status bits are read-only when channels are off');
  bus.psg[0].enabled = true;
  bus.psg[1].enabled = true;
  bus.psgWave.enabled = true;
  bus.psgNoise.enabled = true;
  check(bus.read8(0x04000084) === 0x8f, 'SOUNDCNT_X reports live PSG channel status flags');
  bus.write8(0x04000084, 0x00);
  check(bus.read8(0x04000084) === 0 && !bus.psg[0].enabled && !bus.psgWave.enabled && !bus.psgNoise.enabled,
    'master-disable clears PSG channel status');
  check(bus.read16(0x04000062) === 0 && bus.read16(0x04000080) === 0,
    'master-disable clears PSG control registers');

  bus.write8(0x04000084, 0x80);
  bus.psg[0].enabled = true;
  bus.psg[0].lengthEnabled = true;
  bus.psg[0].lengthCounter = 1;
  bus.cycles = 32768;
  check(bus.read8(0x04000084) === 0x80, 'SOUNDCNT_X polling clocks expired length status');
})();

// --- 10b. PSG hardware-ish scaling/cache/noise ---
(function () {
  function armSquare(bus, duty, lastCycles) {
    bus.psg[0].enabled = true;
    bus.psg[0].triggerCycles = 0;
    bus.psg[0].lastSampleCycles = lastCycles == null ? bus.cycles : lastCycles;
    bus.psg[0].freqRaw = 1024;
    bus.psg[0].freqCur = 1024;
    bus.psg[0].dutyFraction = duty == null ? 0.5 : duty;
    bus.psg[0].dutyStep = Math.round((duty == null ? 0.5 : duty) * 8);
    bus.psg[0].volume = 15;
    bus.psg[0].lengthEnabled = false;
    bus.psg[0].phase = 0;
    bus.psgSampleCacheCycles = -1;
  }

  var bus = freshBus();
  bus.write16(0x04000084, 0x0080);
  bus.write16(0x04000080, 0x0107); // ch0 right, right master 7/7
  bus.write16(0x04000082, 0x0000); // PSG ratio 25%
  armSquare(bus);
  var quarter = bus._mixPsgInto('A', 0);
  bus.write16(0x04000082, 0x0002); // PSG ratio 100%
  var full = bus._mixPsgInto('A', 0);
  check(quarter === 32 && full === 128, 'PSG SOUNDCNT_H ratio scales 25%/100% (' + quarter + '/' + full + ')');

  bus = freshBus();
  bus.cycles = 65536;
  bus.write16(0x04000084, 0x0080);
  bus.write16(0x04000080, 0x1177); // ch0 right+left, both master 7/7
  bus.write16(0x04000082, 0x0002);
  armSquare(bus, 0.25, 0);
  var right = bus._mixPsgInto('A', 0);
  var left = bus._mixPsgInto('B', 0);
  check(right === left, 'same-cycle PSG sample is reused for left/right (' + right + '/' + left + ')');

  bus = freshBus();
  armSquare(bus, 0.5, 0);
  bus.psg[0].enabled = true;
  bus._psgAdvance(0, 16384); // 16777216 / (1048576 / (2048 - 1024))
  check(Math.floor(bus.psg[0].phase) === 1, 'square PSG advances at 1048576-derived duty-step rate (phase ' + bus.psg[0].phase + ')');

  bus = freshBus();
  armSquare(bus, 0.5, 0);
  bus.psg[0].lengthEnabled = true;
  bus.psg[0].lengthCounter = 1;
  bus._psgOutputsAt(32768); // one 512Hz frame-sequencer tick
  check(bus.psg[0].enabled === false, 'frame sequencer clocks square length counter');

  bus = freshBus();
  armSquare(bus, 0.5, 0);
  bus.psg[0].volume = 5;
  bus.psg[0].envDir = 1;
  bus.psg[0].envStep = 1;
  bus.psg[0].envTimer = 1;
  bus.psg[0].envActive = true;
  bus._psgOutputsAt(262144); // eight 512Hz ticks => one 64Hz envelope clock
  check(bus.psg[0].volume === 6, 'frame sequencer clocks envelope at 64Hz (vol ' + bus.psg[0].volume + ')');

  bus = freshBus();
  armSquare(bus, 0.5, 0);
  bus.psg[0].freqCur = 1000;
  bus.psg[0].freqRaw = 1000;
  bus.psg[0].sweepShadow = 1000;
  bus.psg[0].sweepShift = 1;
  bus.psg[0].sweepDir = 0;
  bus.psg[0].sweepPeriod = 1;
  bus.psg[0].sweepTimer = 1;
  bus.psg[0].sweepEnabled = true;
  bus._psgOutputsAt(98304); // step 2: first 128Hz sweep clock, next overflow check disables
  check(bus.psg[0].freqCur === 1500 && bus.psg[0].enabled === false, 'sweep updates frequency then disables on overflow check');

  bus = freshBus();
  bus.write16(0x04000062, 0x0000);
  bus.write16(0x04000064, 0x8000);
  check(bus.psg[0].enabled === false && (bus.read8(0x04000084) & 1) === 0, 'zero-volume square trigger does not set channel status');

  bus = freshBus();
  bus.write16(0x04000062, 0xf03f); // vol 15, length data 63 => one length tick
  bus.write16(0x04000064, 0x8000); // trigger, length disabled
  check(bus.psg[0].enabled === true && bus.psg[0].lengthEnabled === false, 'square trigger starts with length disabled');
  bus.write16(0x04000064, 0x4000); // no trigger, live-enable length
  check(bus.psg[0].lengthEnabled === true, 'square length enable updates without retrigger');
  bus._psgOutputsAt(32768);
  check(bus.psg[0].enabled === false, 'live-enabled square length expires on frame sequencer');

  bus = freshBus();
  bus.write8(0x04000070, 0x80);
  bus.write16(0x04000072, 0x2000 | 0x00ff); // 100% volume, length data 255 => one tick
  bus.write16(0x04000074, 0x8000); // trigger, length disabled
  check(bus.psgWave.enabled === true && bus.psgWave.lengthEnabled === false, 'wave trigger starts with length disabled');
  bus.write16(0x04000074, 0x4000); // live-enable length
  check(bus.psgWave.lengthEnabled === true, 'wave length enable updates without retrigger');
  bus._psgOutputsAt(32768);
  check(bus.psgWave.enabled === false, 'live-enabled wave length expires on frame sequencer');

  bus = freshBus();
  bus.write8(0x04000070, 0x80);
  bus.write16(0x04000072, 0x2000);
  bus.write16(0x04000074, 0x8000);
  check(bus.psgWave.enabled === true, 'wave DAC-on trigger enables channel');
  bus.write8(0x04000070, 0x00);
  check(bus.psgWave.enabled === false && (bus.read8(0x04000084) & 4) === 0, 'wave DAC-off clears channel status');

  bus = freshBus();
  bus.write16(0x04000078, 0xf000);
  bus.write16(0x0400007c, 0x0000);
  bus._noiseTrigger();
  check(bus.psgNoise.lfsr === 0x7fff, 'noise trigger seeds all-one LFSR');
  bus._noiseAdvance(32);
  check(bus.psgNoise.lfsr === 0x3fff, 'noise LFSR uses xor feedback after one shift (got 0x' + bus.psgNoise.lfsr.toString(16) + ')');
  bus.psgNoise.lfsr = 0x7fff;
  bus.psgNoise.phaseCycles = 0;
  bus.psgNoise.lastSampleCycles = 0;
  var avgNoise = bus._noiseAdvance(64);
  check(avgNoise === -15 && bus.psgNoise.lfsr === 0x1fff, 'noise output averages interval while clocking exact shifts');
  check(bus.psgNoise.periodCycles === 32, 'noise r=0 s=0 clocks every 32 CPU cycles');
  bus.write8(0x0400007c, 0x01); // r=1, s=0 => 64 cycles
  check(bus.psgNoise.periodCycles === 64, 'noise NR43 live update retimes r=1 to 64 cycles');
  bus.psgNoise.lfsr = 0x7fff;
  bus.psgNoise.phaseCycles = 0;
  bus.psgNoise.lastSampleCycles = 0;
  bus._noiseAdvance(63);
  check(bus.psgNoise.lfsr === 0x7fff, 'noise does not shift before live-updated period');
  bus._noiseAdvance(64);
  check(bus.psgNoise.lfsr === 0x3fff, 'noise shifts at live-updated 64-cycle period');
  bus.write8(0x0400007c, 0x21); // r=1, s=2 => 256 cycles
  check(bus.psgNoise.periodCycles === 256, 'noise shift clock applies shift field (period ' + bus.psgNoise.periodCycles + ')');

  bus = freshBus();
  bus.write16(0x04000078, 0x0000);
  bus.write16(0x0400007c, 0x8000);
  check(bus.psgNoise.enabled === false && (bus.read8(0x04000084) & 8) === 0, 'zero-volume noise trigger does not set channel status');
})();

// --- 10c. GBA wave-channel bank/digit-rate behavior ---
(function () {
  var bus = freshBus();
  bus.write8(0x04000070, 0x00); // play bank 0, CPU accesses bank 1
  bus.write8(0x04000090, 0x12);
  check(bus.waveRam[16] === 0x12 && bus._waveSample(0) === -8, 'wave RAM write targets non-playback bank');
  bus.write8(0x04000084, 0x80);
  bus.write8(0x04000084, 0x00);
  check(bus.waveRam[16] === 0x12, 'master-disable preserves wave RAM');
  bus.write8(0x04000070, 0x40); // play bank 1, CPU accesses bank 0
  check(bus.read8(0x04000090) === 0 && bus._waveSample(0) === -7, 'wave bank select swaps playback/access banks');

  bus.waveRam[0] = 0x10;
  bus.waveRam[16] = 0xf0;
  bus.write8(0x04000070, 0x20); // 64-digit mode, start on bank 0
  check(bus._waveSample(0) === -7 && bus._waveSample(32) === 7, '64-digit wave mode plays selected bank then other bank');

  bus = freshBus();
  bus.waveRam[0] = 0x12;
  bus.write8(0x04000070, 0x80); // playback on, bank 0, 32-digit mode
  bus.psgWave.enabled = true;
  bus.psgWave.triggerCycles = 0;
  bus.psgWave.lastSampleCycles = 0;
  bus.psgWave.freqCur = 1024;
  bus.psgWave.outputLevel = 1;
  var oneDigitCycles = 8192; // 16777216 / (2097152 / (2048 - 1024))
  var sample = bus._waveAdvance(oneDigitCycles);
  check(sample === -7 && Math.floor(bus.psgWave.phase) === 1, 'wave channel averages at GBA digit rate (sample ' + sample + ', phase ' + bus.psgWave.phase + ')');
})();

// --- 11. HuffUnComp (8-bit symbols) ---
(function () {
  var memory = E.createMemoryImage();
  var view = new DataView(memory.rom.buffer);
  view.setUint32(0, 0xef130000, true); // swi 0x13 HuffUnComp
  // Stream at ROM 0x100: header dataBits=8, type=2, size=4 bytes
  var s = 0x100;
  view.setUint32(s, 8 | (2 << 4) | (4 << 8), true);
  view.setUint8(s + 4, 1);    // treeSize byte: table is (1+1)*2 = 4 bytes incl. this byte
  // root at s+5: offset 0, both children are data -> children at (s+5 & ~1)+2 = s+6, s+7
  view.setUint8(s + 5, 0xc0);
  view.setUint8(s + 6, 0x41); // node0 -> 'A'
  view.setUint8(s + 7, 0x42); // node1 -> 'B'
  // bitstream at s+8: "ABBA" = bits 0,1,1,0 MSB-first -> 0110... = 0x60000000
  view.setUint32(s + 8, 0x60000000, true);
  var bus = new E.GbaMemoryBus(memory);
  var cpu = new E.Arm7Cpu(bus, 0x08000000);
  cpu.regs[0] = 0x08000100; cpu.regs[1] = 0x02000200;
  cpu.step();
  var word = bus.read32(0x02000200) >>> 0;
  check(word === ((0x41) | (0x42 << 8) | (0x42 << 16) | (0x41 << 24)) >>> 0,
    'HuffUnComp decoded ABBA (got 0x' + word.toString(16) + ')');
})();

// --- 12. ArcTan / ArcTan2 / Stop ---
(function () {
  var memory = E.createMemoryImage();
  var view = new DataView(memory.rom.buffer);
  view.setUint32(0, 0xef090000, true); // ArcTan
  view.setUint32(4, 0xef0a0000, true); // ArcTan2
  view.setUint32(8, 0xef030000, true); // Stop
  var bus = new E.GbaMemoryBus(memory);
  var cpu = new E.Arm7Cpu(bus, 0x08000000);
  cpu.regs[0] = 16384; // tan = 1.0 -> pi/4 -> 0x2000
  cpu.step();
  check((cpu.regs[0] >>> 0) === 0x2000, 'ArcTan(1.0) = 0x2000 (got 0x' + (cpu.regs[0] >>> 0).toString(16) + ')');
  cpu.regs[0] = 0; cpu.regs[1] = 100; // straight up -> pi/2 -> 0x4000
  cpu.step();
  check((cpu.regs[0] >>> 0) === 0x4000, 'ArcTan2(0,100) = 0x4000 (got 0x' + (cpu.regs[0] >>> 0).toString(16) + ')');
  // Stop behaves like Halt: wakes on enabled timer IRQ mid-frame
  bus.write16(0x04000200, 0x0008);
  bus.write16(0x04000100, 0x10000 - 3000);
  bus.write16(0x04000102, 0x00c0);
  var cyclesBefore = bus.cycles;
  cpu.step();
  var slept = bus.cycles - cyclesBefore;
  check(slept > 2000 && slept < 20000, 'Stop waits like Halt and wakes on timer IRQ (slept ' + slept + ')');
})();

// --- 13. DISPSTAT bit3 gates the VBlank IRQ (with never-written fallback) ---
(function () {
  var busA = freshBus();
  busA.write16(0x04000004, 0x0000); // ROM configures DISPSTAT, VBlank IRQ disabled
  busA.stepCycles(197200);
  check((busA.read16(0x04000202) & 1) === 0, 'VBlank IRQ suppressed when DISPSTAT bit3 clear');
  var busB = freshBus();
  busB.write16(0x04000004, 0x0008); // VBlank IRQ enabled
  busB.stepCycles(197200);
  check((busB.read16(0x04000202) & 1) === 1, 'VBlank IRQ fires when DISPSTAT bit3 set');
  var busC = freshBus(); // ROM never touches DISPSTAT -> fallback keeps firing
  busC.stepCycles(197200);
  check((busC.read16(0x04000202) & 1) === 1, 'VBlank IRQ fallback for DISPSTAT-agnostic ROMs');
})();

// --- 14. BIOS IRQ wrapper frame: r0 = IO base, stacked lr, IRQ sp restored ---
(function () {
  var memory = E.createMemoryImage();
  var view = new DataView(memory.rom.buffer);
  // main: r1 = 0x02000000, then spin
  view.setUint32(0, 0xe3a01402, true); // mov r1, #0x02000000
  view.setUint32(4, 0xeafffffe, true); // b .
  // handler at 0x100: store r0 and stacked lr, ack IF, return
  var h = 0x100;
  view.setUint32(h + 0x00, 0xe5810000, true); // str r0, [r1]        (r0 should be 0x04000000)
  view.setUint32(h + 0x04, 0xe59d2014, true); // ldr r2, [sp, #20]   (stacked lr)
  view.setUint32(h + 0x08, 0xe5812004, true); // str r2, [r1, #4]
  view.setUint32(h + 0x0c, 0xe2803c02, true); // add r3, r0, #0x200
  view.setUint32(h + 0x10, 0xe3e02000, true); // mvn r2, #0
  view.setUint32(h + 0x14, 0xe1c320b2, true); // strh r2, [r3, #2]   (ack all IF)
  view.setUint32(h + 0x18, 0xe12fff1e, true); // bx lr
  var bus = new E.GbaMemoryBus(memory);
  var cpu = new E.Arm7Cpu(bus, 0x08000000);
  bus.write32(0x03007ffc, 0x08000100);
  bus.write16(0x04000200, 0x0001); // IE: vblank
  bus.write16(0x04000208, 1);      // IME
  cpu.run(60000); // ROM-ARM instructions cross VBlank at 197120 cycles (cost varies with WAITCNT)
  check((bus.read32(0x02000000) >>> 0) === 0x04000000, 'handler saw r0 = 0x04000000 (IO base)');
  check((bus.read32(0x02000004) >>> 0) === 0x08000008, 'stacked lr = interrupted PC + 4 (got 0x' + (bus.read32(0x02000004) >>> 0).toString(16) + ')');
  check((cpu.r13_irq >>> 0) === 0x03007fa0, 'IRQ sp restored after BIOS frame pop (got 0x' + (cpu.r13_irq >>> 0).toString(16) + ')');
  check((cpu.regs[1] >>> 0) === 0x02000000, 'interrupted registers restored after handler');
})();

// --- 15. CPSR.I gates dispatch; handler clearing I allows nested IRQs ---
(function () {
  var memory = E.createMemoryImage();
  var view = new DataView(memory.rom.buffer);
  view.setUint32(0, 0xeafffffe, true); // main: b .
  // Handler: first (timer) entry marks 0x02000010, acks timer IF, clears CPSR.I and
  // busy-waits until a nested (VBlank) entry marks 0x02000014.
  var h = 0x100;
  view.setUint32(h + 0x00, 0xe59f1064, true); // ldr r1, [pc, #0x64]  ; =0x02000010 (lit at h+0x6c)
  view.setUint32(h + 0x04, 0xe5912000, true); // ldr r2, [r1]
  view.setUint32(h + 0x08, 0xe3520000, true); // cmp r2, #0
  view.setUint32(h + 0x0c, 0x1a00000b, true); // bne nested (h+0x40)
  view.setUint32(h + 0x10, 0xe3a02001, true); // mov r2, #1
  view.setUint32(h + 0x14, 0xe5812000, true); // str r2, [r1]         ; outer-entry flag
  view.setUint32(h + 0x18, 0xe2803c02, true); // add r3, r0, #0x200
  view.setUint32(h + 0x1c, 0xe3a02008, true); // mov r2, #8
  view.setUint32(h + 0x20, 0xe1c320b2, true); // strh r2, [r3, #2]    ; ack timer0 IF
  view.setUint32(h + 0x24, 0xe10f2000, true); // mrs r2, cpsr
  view.setUint32(h + 0x28, 0xe3c22080, true); // bic r2, r2, #0x80
  view.setUint32(h + 0x2c, 0xe121f002, true); // msr cpsr_c, r2       ; clear I -> allow nesting
  view.setUint32(h + 0x30, 0xe5912004, true); // wait: ldr r2, [r1, #4]
  view.setUint32(h + 0x34, 0xe3520000, true); // cmp r2, #0
  view.setUint32(h + 0x38, 0x0afffffc, true); // beq wait
  view.setUint32(h + 0x3c, 0xe12fff1e, true); // bx lr
  view.setUint32(h + 0x40, 0xe3a02001, true); // nested: mov r2, #1
  view.setUint32(h + 0x44, 0xe5812004, true); // str r2, [r1, #4]     ; nested-entry flag
  view.setUint32(h + 0x48, 0xe2803c02, true); // add r3, r0, #0x200
  view.setUint32(h + 0x4c, 0xe3a02001, true); // mov r2, #1
  view.setUint32(h + 0x50, 0xe1c320b2, true); // strh r2, [r3, #2]    ; ack vblank IF
  view.setUint32(h + 0x54, 0xe12fff1e, true); // bx lr
  view.setUint32(h + 0x6c, 0x02000010, true); // literal
  var bus = new E.GbaMemoryBus(memory);
  var cpu = new E.Arm7Cpu(bus, 0x08000000);
  bus.write32(0x03007ffc, 0x08000100);
  bus.write16(0x04000200, 0x0009); // IE: vblank | timer0
  bus.write16(0x04000208, 1);
  bus.write16(0x04000100, 0x10000 - 3000); // timer0 fires early in the frame
  bus.write16(0x04000102, 0x00c0);
  cpu.run(120000);
  check(bus.read32(0x02000010) === 1, 'outer (timer) handler entered');
  check(bus.read32(0x02000014) === 1, 'VBlank IRQ nested into handler after it cleared CPSR.I');
  check(!cpu.halted, 'CPU healthy after nested dispatch (' + cpu.reason + ')');
  // CPSR.I set blocks dispatch entirely
  var memB = E.createMemoryImage();
  new DataView(memB.rom.buffer).setUint32(0, 0xe1a00000, true); // nop (mov r0, r0)
  var busB = new E.GbaMemoryBus(memB);
  var cpuB = new E.Arm7Cpu(busB, 0x08000000);
  busB.write32(0x03007ffc, 0x08000100);
  busB.write16(0x04000200, 1);
  busB.write16(0x04000208, 1);
  busB.write16(0x04000202, 0); busB.requestIrq(1, 'test');
  cpuB.cpsr |= 0x80; // I set
  cpuB.step();
  check(cpuB.irqDispatches.length === 0, 'CPSR.I=1 blocks IRQ dispatch');
  cpuB.cpsr &= ~0x80;
  cpuB.step();
  check(cpuB.irqDispatches.length > 0, 'clearing CPSR.I allows dispatch');
})();

// --- 16. open bus: unmapped and BIOS-region reads return latches, not 0 ---
(function () {
  var memory = E.createMemoryImage();
  var view = new DataView(memory.rom.buffer);
  view.setUint32(0, 0xe1a00000, true); // mov r0, r0 (nop)
  var bus = new E.GbaMemoryBus(memory);
  var cpu = new E.Arm7Cpu(bus, 0x08000000);
  check((bus.read32(0x00000000) >>> 0) === 0xe129f000, 'BIOS region reads startup latch');
  cpu.step(); // fetch loads the prefetch latch
  check((bus.read32(0x01000000) >>> 0) === 0xe1a00000, 'unmapped read returns last fetched opcode');
  check((bus.read8(0x01000002)) === 0xa0, 'open bus is byte-laned');
  // SWI updates the BIOS latch
  var memB = E.createMemoryImage();
  new DataView(memB.rom.buffer).setUint32(0, 0xef060000, true); // swi Div
  var busB = new E.GbaMemoryBus(memB);
  var cpuB = new E.Arm7Cpu(busB, 0x08000000);
  cpuB.regs[0] = 6; cpuB.regs[1] = 2;
  cpuB.step();
  check((busB.read32(0x00000000) >>> 0) === 0xe3a02004, 'BIOS latch reflects post-SWI value');
})();

// --- 17. LDM/STM edge cases ---
(function () {
  var memory = E.createMemoryImage();
  var view = new DataView(memory.rom.buffer);
  view.setUint32(0x00, 0xe8b00003, true); // ldmia r0!, {r0, r1}   base in list -> loaded value wins
  view.setUint32(0x04, 0xe8a20004, true); // stmia r2!, {r2}       base first -> stores OLD base
  view.setUint32(0x08, 0xe8a4000c, true); // stmia r4!, {r2, r3}   r4 not in list, normal
  view.setUint32(0x0c, 0xe8a50060, true); // stmia r5!, {r5, r6}   base NOT first -> stores NEW base
  view.setUint32(0x10, 0xe8a70000, true); // stmia r7!, {}         empty rlist: stores PC+12, r7 += 0x40
  var bus = new E.GbaMemoryBus(memory);
  var cpu = new E.Arm7Cpu(bus, 0x08000000);
  bus.write32(0x02000300, 0x11111111);
  bus.write32(0x02000304, 0x22222222);
  cpu.regs[0] = 0x02000300;
  cpu.step(); // ldmia r0!, {r0, r1}
  check((cpu.regs[0] >>> 0) === 0x11111111, 'LDM base-in-list: loaded value wins over writeback');
  check((cpu.regs[1] >>> 0) === 0x22222222, 'LDM second register loaded');
  cpu.regs[2] = 0x02000400;
  cpu.step(); // stmia r2!, {r2}
  check((bus.read32(0x02000400) >>> 0) === 0x02000400, 'STM base-first stores OLD base');
  check((cpu.regs[2] >>> 0) === 0x02000404, 'STM writeback applied');
  cpu.regs[2] = 0xdead0001; cpu.regs[3] = 0xdead0002; cpu.regs[4] = 0x02000410;
  cpu.step(); // stmia r4!, {r2, r3}
  check((bus.read32(0x02000414) >>> 0) === 0xdead0002, 'normal STM stores registers');
  cpu.regs[5] = 0x02000420; cpu.regs[6] = 0x66666666;
  cpu.step(); // stmia r5!, {r5, r6}: r6 is below? no - r5 is first (bit5 < bit6) so OLD base...
  check((bus.read32(0x02000420) >>> 0) === 0x02000420, 'STM base-first-of-two stores OLD base');
  cpu.regs[7] = 0x02000440;
  cpu.step(); // stmia r7!, {}
  check((bus.read32(0x02000440) >>> 0) === 0x08000010 + 12 >>> 0, 'empty-rlist STM stores PC+12 (got 0x' + (bus.read32(0x02000440) >>> 0).toString(16) + ')');
  check((cpu.regs[7] >>> 0) === 0x02000480, 'empty-rlist STM advances base by 0x40');
})();

// --- 18. WAITCNT reprograms ROM fetch costs ---
(function () {
  var bus = freshBus();
  check(bus.romCostThumb[0] === 3 && bus.romCostArm[0] === 5, 'default WS0 costs (s=2)');
  check(bus.romCostThumb[2] === 9, 'default WS2 thumb cost (s=8)');
  bus.write16(0x04000204, 0x4317); // typical game setting: WS0 3,1 + prefetch
  check(bus.romCostThumb[0] === 2 && bus.romCostArm[0] === 3, 'WS0 costs after WAITCNT=0x4317');
})();

// --- 19. timer 2-cycle start delay ---
(function () {
  var bus = freshBus();
  bus.write16(0x04000100, 0x1000); // reload
  bus.write16(0x04000102, 0x0080); // enable, prescaler 1
  bus.stepCycles(2);
  check(bus.read16(0x04000100) === 0x1000, 'timer holds reload during 2-cycle start delay');
  bus.stepCycles(4);
  check(bus.read16(0x04000100) === 0x1004, 'timer ticks after start delay (got 0x' + bus.read16(0x04000100).toString(16) + ')');
})();

// --- 20. windowed-sinc resampler suppresses the imaging linear interp leaks ---
(function () {
  var srcRate = 21024, outRate = 48000, f = 6000; // image lands at 15024Hz, in-band
  var n = 8192;
  var src = [];
  for (var i = 0; i < n; i++) src.push(400 * Math.sin(2 * Math.PI * f * i / srcRate));
  var ratio = srcRate / outRate;
  var TAPS = 24, PHASES = 512, HALF = 12;
  var kernel = E.buildSincKernel(Math.min(1, 1 / ratio) * 0.92, TAPS, PHASES);
  var rowSum = 0;
  for (var k = 0; k < TAPS; k++) rowSum += kernel[100 * TAPS + k];
  check(Math.abs(rowSum - 1) < 1e-5, 'sinc kernel rows are DC-normalized');
  function clampAt(idx) { return src[idx < 0 ? 0 : idx >= src.length ? src.length - 1 : idx]; }
  function goertzel(sig, freq, rate) {
    var w = 2 * Math.PI * freq / rate, c = 2 * Math.cos(w), s0, s1 = 0, s2 = 0;
    for (var i = 0; i < sig.length; i++) { s0 = sig[i] + c * s1 - s2; s2 = s1; s1 = s0; }
    return Math.sqrt(Math.max(1e-12, s1 * s1 + s2 * s2 - c * s1 * s2)) / sig.length;
  }
  var outN = Math.floor((n - TAPS * 2) / ratio);
  var sincOut = [], linOut = [];
  var pos = TAPS;
  for (var i = 0; i < outN; i++) {
    var idxAbs = Math.floor(pos), frac = pos - idxAbs;
    var phase = Math.min(PHASES - 1, (frac * PHASES) | 0), rowOff = phase * TAPS;
    var acc = 0;
    for (var k = 0; k < TAPS; k++) acc += kernel[rowOff + k] * clampAt(idxAbs - (HALF - 1) + k);
    sincOut.push(acc);
    linOut.push(clampAt(idxAbs) + (clampAt(idxAbs + 1) - clampAt(idxAbs)) * frac);
    pos += ratio;
  }
  var imageFreq = srcRate - f;
  var sincDb = 20 * Math.log10(goertzel(sincOut, imageFreq, outRate) / goertzel(sincOut, f, outRate));
  var linDb = 20 * Math.log10(goertzel(linOut, imageFreq, outRate) / goertzel(linOut, f, outRate));
  // Reference is the SOURCE tone's own level: linear interp droops a 6kHz fundamental
  // to ~76% (sinc^2 rolloff), so it is not a valid comparison baseline.
  var srcFund = goertzel(src, f, srcRate);
  var sincRel = goertzel(sincOut, f, outRate) / srcFund;
  var linRel = goertzel(linOut, f, outRate) / srcFund;
  check(Math.abs(sincRel - 1) < 0.1, 'sinc preserves the fundamental (' + (sincRel * 100).toFixed(1) + '% vs linear ' + (linRel * 100).toFixed(1) + '%)');
  check(sincDb < -50, 'sinc image below -50dB (got ' + sincDb.toFixed(1) + 'dB)');
  check(sincDb < linDb - 20, 'sinc beats linear by >=20dB (sinc ' + sincDb.toFixed(1) + 'dB vs linear ' + linDb.toFixed(1) + 'dB)');
})();

print(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
