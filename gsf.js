// Standard GSF container/LLE engine boundary.
//
// GSF playback is low-level by design: the compressed payload is a GBA program
// image that must be executed by an ARM/Thumb + GBA audio emulator. This module
// owns the GSF format and exposes a distinct LLE engine slot so the MP2K HLE
// player can be compared against the standard path without conflating them.

(function () {
  const GSF_MAGIC = [0x50, 0x53, 0x46, 0x22]; // "PSF", version 0x22
  const GBA_ROM_BASE = 0x08000000;
  const GBA_ROM_LIMIT = 32 * 1024 * 1024;

  function isValid(buf) {
    if (!buf || buf.byteLength < 16) return false;
    const u8 = new Uint8Array(buf, 0, 4);
    return GSF_MAGIC.every((v, i) => u8[i] === v);
  }

  function isZip(buf) {
    if (!buf || buf.byteLength < 4) return false;
    const u8 = new Uint8Array(buf, 0, 4);
    return u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04;
  }

  async function inflate(u8compressed, format = 'deflate') {
    const ds = new DecompressionStream(format);
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    writer.write(u8compressed);
    writer.close();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let pos = 0;
    for (const chunk of chunks) {
      out.set(chunk, pos);
      pos += chunk.length;
    }
    return out;
  }

  function tags(buf) {
    if (!isValid(buf)) return {};
    const view = new DataView(buf);
    const reservedLen = view.getUint32(4, true);
    const compressedLen = view.getUint32(8, true);
    const tagOff = 16 + reservedLen + compressedLen;
    if (tagOff + 5 > buf.byteLength) return {};
    const u8 = new Uint8Array(buf);
    const marker = new TextDecoder('ascii').decode(u8.subarray(tagOff, tagOff + 5));
    if (marker !== '[TAG]') return {};
    const tagText = new TextDecoder().decode(u8.subarray(tagOff + 5));
    const out = {};
    for (const line of tagText.split(/\r?\n/)) {
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim().toLowerCase();
      const value = line.slice(eq + 1).trim();
      if (key && value) out[key] = value;
    }
    return out;
  }

  function tagSummary(gsfTags) {
    if (!gsfTags || !Object.keys(gsfTags).length) return '';
    const parts = [];
    if (gsfTags.game) parts.push(`game ${gsfTags.game}`);
    if (gsfTags.title) parts.push(`title ${gsfTags.title}`);
    if (gsfTags.artist) parts.push(`artist ${gsfTags.artist}`);
    if (gsfTags.copyright) parts.push(gsfTags.copyright);
    return parts.join(' | ');
  }

  async function decompress(buf) {
    const view = new DataView(buf);
    const reservedLen = view.getUint32(4, true);
    const compressedLen = view.getUint32(8, true);
    const compressed = new Uint8Array(buf, 16 + reservedLen, compressedLen);
    return inflate(compressed, 'deflate');
  }

  async function programInfo(buf) {
    if (!isValid(buf)) return null;
    const dec = await decompress(buf);
    const dv = new DataView(dec.buffer, dec.byteOffset, dec.byteLength);
    return {
      loadAddr: dv.getUint32(4, true),
      dataSize: dv.getUint32(8, true),
      reservedSize: new DataView(buf).getUint32(4, true),
      compressedSize: new DataView(buf).getUint32(8, true),
    };
  }

  async function romImage(buf) {
    if (!isValid(buf)) return null;
    const dec = await decompress(buf);
    const dv = new DataView(dec.buffer, dec.byteOffset, dec.byteLength);
    const loadAddr = dv.getUint32(4, true);
    const dataSize = dv.getUint32(8, true);
    const romOffset = loadAddr - GBA_ROM_BASE;
    if (romOffset < 0 || romOffset > GBA_ROM_LIMIT) {
      throw new Error(`GSF load address out of range: 0x${loadAddr.toString(16)}`);
    }
    const rom = new ArrayBuffer(romOffset + dataSize);
    new Uint8Array(rom).set(dec.subarray(12, 12 + dataSize), romOffset);
    return rom;
  }

  async function miniPatch(buf) {
    if (!isValid(buf)) return null;
    const dec = await decompress(buf);
    const dv = new DataView(dec.buffer, dec.byteOffset, dec.byteLength);
    const loadAddr = dv.getUint32(4, true);
    const size = dv.getUint32(8, true);
    return { loadAddr, data: dec.slice(12, 12 + size) };
  }

  async function zipFiles(buf) {
    const u8 = new Uint8Array(buf);
    const dv = new DataView(buf);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65558); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return null;

    const cdCount = dv.getUint16(eocd + 10, true);
    const cdOffset = dv.getUint32(eocd + 16, true);
    const entries = [];
    let pos = cdOffset;
    for (let i = 0; i < cdCount; i++) {
      if (dv.getUint32(pos, true) !== 0x02014b50) break;
      const method = dv.getUint16(pos + 10, true);
      const csize = dv.getUint32(pos + 20, true);
      const usize = dv.getUint32(pos + 24, true);
      const fnLen = dv.getUint16(pos + 28, true);
      const extraLen = dv.getUint16(pos + 30, true);
      const commentLen = dv.getUint16(pos + 32, true);
      const localOff = dv.getUint32(pos + 42, true);
      const name = new TextDecoder().decode(u8.subarray(pos + 46, pos + 46 + fnLen));
      pos += 46 + fnLen + extraLen + commentLen;
      if (!name.endsWith('/')) entries.push({ name, method, csize, usize, localOff });
    }

    const files = {};
    for (const entry of entries) {
      const lhFnLen = dv.getUint16(entry.localOff + 26, true);
      const lhExtraLen = dv.getUint16(entry.localOff + 28, true);
      const dataOff = entry.localOff + 30 + lhFnLen + lhExtraLen;
      let data;
      if (entry.method === 0) {
        data = u8.slice(dataOff, dataOff + entry.usize);
      } else if (entry.method === 8) {
        data = await inflate(u8.subarray(dataOff, dataOff + entry.csize), 'deflate-raw');
      } else {
        continue;
      }
      const base = entry.name.split('/').pop();
      files[base] = data.buffer;
    }
    return files;
  }

  class StandardGsfEngine {
    constructor() {
      this.id = 'gsf-lle';
      this.label = 'Standard GSF LLE';
      this.state = 'empty';
      this.source = null;
      this.library = null;
      this.entries = [];
      this.lastError = null;
    }

    reset() {
      this.state = 'empty';
      this.source = null;
      this.library = null;
      this.entries = [];
      this.lastError = null;
    }

    async loadBuffer(buf, source = {}) {
      this.reset();
      try {
        if (isZip(buf)) return await this._loadZip(buf, source);
        if (!isValid(buf)) return null;
        const info = await programInfo(buf);
        this.source = {
          kind: /\.minigsf$/i.test(source.name || '') ? 'minigsf' : 'gsf',
          name: source.name || 'Dropped GSF',
          tags: tags(buf),
          ...(info || {}),
        };
        this.entries = [{
          name: this.source.tags.title || this.source.name,
          tags: this.source.tags,
          patch: await miniPatch(buf),
        }];
        this.state = 'loaded-no-emulator';
        return this.source;
      } catch (err) {
        this.state = 'error';
        this.lastError = err;
        throw err;
      }
    }

    async _loadZip(buf, source = {}) {
      const files = await zipFiles(buf);
      if (!files) return null;
      const libKey = Object.keys(files).find(k => /\.gsflib$/i.test(k));
      if (!libKey) throw new Error('No .gsflib found in ZIP');
      const libInfo = await programInfo(files[libKey]);
      this.library = {
        key: libKey,
        tags: tags(files[libKey]),
        ...(libInfo || {}),
      };
      const miniKeys = Object.keys(files).filter(k => /\.minigsf$/i.test(k)).sort();
      this.entries = [];
      for (const key of miniKeys) {
        const patch = await miniPatch(files[key]);
        const entryTags = tags(files[key]);
        this.entries.push({
          key,
          name: entryTags.title || key.replace(/\.minigsf$/i, ''),
          tags: entryTags,
          patch,
        });
      }
      this.source = {
        kind: 'gsf-zip',
        name: source.name || 'Dropped ZIP',
        library: libKey,
        tags: this.library.tags,
        minigsfCount: miniKeys.length,
        ...(libInfo || {}),
      };
      this.state = 'loaded-no-emulator';
      return this.source;
    }

    canPlay() {
      return false;
    }

    async play() {
      throw new Error('Standard GSF LLE playback needs a GBA CPU/APU emulator; this engine currently parses and compares payloads only.');
    }

    stop() {}

    summary() {
      if (this.state === 'empty') return 'GSF LLE: no GSF loaded';
      if (this.state === 'error') return `GSF LLE: error ${this.lastError?.message || 'unknown'}`;
      const parts = [`GSF LLE: ${this.label} payload loaded`];
      if (this.source?.name) parts.push(this.source.name);
      if (this.library?.key) parts.push(`library ${this.library.key}`);
      if (this.entries.length) parts.push(`${this.entries.length} minigsf entries`);
      if (this.source?.loadAddr != null && this.source?.dataSize != null) {
        parts.push(`load 0x${this.source.loadAddr.toString(16).padStart(8, '0')} +${this.source.dataSize}`);
      }
      const summaryText = tagSummary(this.source?.tags);
      if (summaryText) parts.push(summaryText);
      parts.push('playback: not emulated yet');
      return parts.join(' | ');
    }
  }

  window.GsfTools = {
    isValid,
    isZip,
    inflate,
    tags,
    tagSummary,
    decompress,
    programInfo,
    romImage,
    miniPatch,
    zipFiles,
  };
  window.StandardGsfEngine = StandardGsfEngine;
})();
