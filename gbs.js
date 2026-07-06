// GBS (Game Boy Sound) file format loader. Kept separate from gsf.js since GBS shares no
// container/format logic with GSF/PSF (no zlib, no ZIP/7z archive support needed) — it's a
// simple fixed 0x70-byte header followed directly by raw ROM bytes, no compression.
//
// Header layout (all multi-byte fields little-endian):
//   0x00  'GBS' + version byte (0x01)      magic
//   0x04  number of songs (1 byte)
//   0x05  first song, 1-indexed (1 byte)
//   0x06  load address (2 bytes)           where the appended ROM bytes are placed in memory
//   0x08  init address (2 bytes)           called once per song select, with A=song index
//   0x0A  play address (2 bytes)           called periodically (vblank or timer, see below)
//   0x0C  stack pointer (2 bytes)
//   0x0E  timer modulo / TMA (1 byte)
//   0x0F  timer control / TAC (1 byte)     bit 2 clear => vblank-driven play calls
//   0x10  title (32 bytes, null-padded ASCII)
//   0x30  author (32 bytes)
//   0x50  copyright (32 bytes)
//   0x70  ROM data begins
(function () {
  const GBS_MAGIC = [0x47, 0x42, 0x53, 0x01]; // 'GBS' + version 1
  const HEADER_SIZE = 0x70;

  function isValid(buf) {
    if (!buf || buf.byteLength < HEADER_SIZE) return false;
    const u8 = new Uint8Array(buf, 0, 4);
    return GBS_MAGIC.every((v, i) => u8[i] === v);
  }

  function decodeCString(u8, off, len) {
    let end = off;
    while (end < off + len && u8[end] !== 0) end++;
    let out = '';
    for (let i = off; i < end; i++) out += String.fromCharCode(u8[i]);
    return out;
  }

  function decodeHeader(buf) {
    if (!isValid(buf)) return null;
    const view = new DataView(buf);
    const u8 = new Uint8Array(buf);
    return {
      songCount: view.getUint8(0x04),
      firstSong: view.getUint8(0x05),
      loadAddr: view.getUint16(0x06, true),
      initAddr: view.getUint16(0x08, true),
      playAddr: view.getUint16(0x0a, true),
      stackPointer: view.getUint16(0x0c, true),
      timerModulo: view.getUint8(0x0e),
      timerControl: view.getUint8(0x0f),
      title: decodeCString(u8, 0x10, 32),
      author: decodeCString(u8, 0x30, 32),
      copyright: decodeCString(u8, 0x50, 32),
      // Whether the driver expects to be ticked via the timer interrupt (0x50) rather than
      // vblank (0x40) — GBS convention: TAC bit 2 (the hardware timer-enable bit) decides;
      // a nonzero TMA with the timer disabled still means vblank.
      usesTimer: (view.getUint8(0x0f) & 0x04) !== 0,
    };
  }

  // Builds a flat memory image sized to a bank boundary, with the raw appended ROM bytes
  // placed starting at loadAddr (everything before that, and any padding after, is zero) —
  // ready to hand to DmgMemoryBus, whose bank 0 / switchable-bank addressing already assumes
  // ROM content starts at address 0 of this array.
  function romImage(buf, header) {
    header = header || decodeHeader(buf);
    if (!header) return null;
    const data = new Uint8Array(buf, HEADER_SIZE);
    const totalSize = Math.max(0x8000, Math.ceil((header.loadAddr + data.length) / 0x4000) * 0x4000);
    const image = new Uint8Array(totalSize);
    image.set(data, header.loadAddr);
    return image;
  }

  window.GbsTools = { isValid, decodeHeader, romImage, HEADER_SIZE };
})();
