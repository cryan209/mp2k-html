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

print(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
