// Standard GSF container/LLE engine boundary.
//
// GSF playback is low-level by design: the compressed payload is a GBA program
// image that must be executed by an ARM/Thumb + GBA audio emulator. This module
// owns the GSF format and exposes a distinct LLE engine slot so the MP2K HLE
// player can be compared against the standard path without conflating them.

(function () {
  const GSF_MAGIC = [0x50, 0x53, 0x46, 0x22]; // "PSF", version 0x22
  const SEVEN_ZIP_MAGIC = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];
  const SEVEN_ZIP_MODULE_URL = 'https://cdn.jsdelivr.net/npm/7z-wasm@1.2.0/7zz.es6.js';
  const SEVEN_ZIP_WASM_URL = 'https://cdn.jsdelivr.net/npm/7z-wasm@1.2.0/7zz.wasm';
  const GBA_ROM_BASE = 0x08000000;
  const GBA_ROM_LIMIT = 32 * 1024 * 1024;
  const GBA_REGIONS = [
    { id: 'ewram', label: 'EWRAM', start: 0x02000000, size: 256 * 1024 },
    { id: 'iwram', label: 'IWRAM', start: 0x03000000, size: 32 * 1024 },
    { id: 'io', label: 'I/O', start: 0x04000000, size: 1024 },
    { id: 'palette', label: 'Palette RAM', start: 0x05000000, size: 1024 },
    { id: 'vram', label: 'VRAM', start: 0x06000000, size: 96 * 1024 },
    { id: 'oam', label: 'OAM', start: 0x07000000, size: 1024 },
    { id: 'rom', label: 'Game Pak ROM', start: GBA_ROM_BASE, size: GBA_ROM_LIMIT },
    { id: 'sram', label: 'SRAM', start: 0x0e000000, size: 64 * 1024 },
  ];

  function hex(v, width = 8) {
    return `0x${(v >>> 0).toString(16).padStart(width, '0')}`;
  }

  function gbaRegionFor(addr, size = 1) {
    const start = addr >>> 0;
    const end = (start + Math.max(0, size) - 1) >>> 0;
    return GBA_REGIONS.find(region => start >= region.start && end < region.start + region.size) || null;
  }

  function parseContainerHeader(buf) {
    if (!isValid(buf)) return null;
    const view = new DataView(buf);
    return {
      magic: 'PSF\\x22',
      version: 0x22,
      reservedSize: view.getUint32(4, true),
      compressedSize: view.getUint32(8, true),
      crc32: view.getUint32(12, true),
    };
  }

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

  function isSevenZip(buf) {
    if (!buf || buf.byteLength < SEVEN_ZIP_MAGIC.length) return false;
    const u8 = new Uint8Array(buf, 0, SEVEN_ZIP_MAGIC.length);
    return SEVEN_ZIP_MAGIC.every((v, i) => u8[i] === v);
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

  function decodeProgramBytes(executable, source = {}) {
    const u8 = executable instanceof Uint8Array ? executable : new Uint8Array(executable);
    const warnings = [];
    if (u8.byteLength < 12) throw new Error('GSF executable payload is shorter than 12 bytes');
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const entryAddr = dv.getUint32(0, true);
    const loadAddr = dv.getUint32(4, true);
    const dataSize = dv.getUint32(8, true);
    if (dataSize > u8.byteLength - 12) {
      warnings.push(`declared ${dataSize} bytes but only ${u8.byteLength - 12} payload bytes are present`);
    }
    const clippedSize = Math.min(dataSize, Math.max(0, u8.byteLength - 12));
    const region = gbaRegionFor(loadAddr, clippedSize);
    if (!region) warnings.push(`load address ${hex(loadAddr)} +${clippedSize} is outside a single known GBA memory region`);
    return {
      kind: source.kind || 'gsf-program',
      name: source.name || '',
      entryAddr,
      loadAddr,
      dataSize,
      clippedSize,
      endAddr: (loadAddr + clippedSize) >>> 0,
      region,
      data: u8.slice(12, 12 + clippedSize),
      executableSize: u8.byteLength,
      warnings,
    };
  }

  async function decodeProgram(buf, source = {}) {
    if (!isValid(buf)) return null;
    const container = parseContainerHeader(buf);
    const executable = await decompress(buf);
    const program = decodeProgramBytes(executable, source);
    return {
      container,
      executable,
      program,
      tags: tags(buf),
    };
  }

  function createMemoryImage(size = GBA_ROM_LIMIT) {
    return {
      rom: new Uint8Array(size),
      segments: [],
      warnings: [],
    };
  }

  function applyDecodedProgram(memory, decoded, label = decoded?.program?.name || 'program') {
    const program = decoded?.program || decoded;
    if (!program?.data) return false;
    const region = program.region || gbaRegionFor(program.loadAddr, program.clippedSize);
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
    const romOffset = program.loadAddr - GBA_ROM_BASE;
    if (romOffset < 0 || romOffset + program.clippedSize > memory.rom.length) {
      memory.warnings.push(`${label} ROM write ${hex(program.loadAddr)} +${program.clippedSize} is out of range`);
      return false;
    }
    memory.rom.set(program.data, romOffset);
    return true;
  }

  async function programInfo(buf) {
    if (!isValid(buf)) return null;
    const decoded = await decodeProgram(buf);
    const program = decoded.program;
    return {
      entryAddr: program.entryAddr,
      loadAddr: program.loadAddr,
      dataSize: program.dataSize,
      decodedSize: program.clippedSize,
      region: program.region?.id || 'unknown',
      reservedSize: decoded.container.reservedSize,
      compressedSize: decoded.container.compressedSize,
    };
  }

  async function romImage(buf) {
    if (!isValid(buf)) return null;
    const decoded = await decodeProgram(buf);
    const { loadAddr, clippedSize, region, data } = decoded.program;
    const romOffset = loadAddr - GBA_ROM_BASE;
    if (region?.id !== 'rom' || romOffset < 0 || romOffset > GBA_ROM_LIMIT) {
      throw new Error(`GSF load address out of range: 0x${loadAddr.toString(16)}`);
    }
    const rom = new ArrayBuffer(romOffset + clippedSize);
    new Uint8Array(rom).set(data, romOffset);
    return rom;
  }

  async function miniPatch(buf) {
    if (!isValid(buf)) return null;
    const decoded = await decodeProgram(buf, { kind: 'minigsf' });
    const program = decoded.program;
    return {
      entryAddr: program.entryAddr,
      loadAddr: program.loadAddr,
      size: program.clippedSize,
      region: program.region?.id || 'unknown',
      data: program.data,
      warnings: program.warnings,
    };
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

  async function loadSevenZipModule() {
    const output = [];
    const errors = [];
    const mod = await import(SEVEN_ZIP_MODULE_URL);
    const sevenZip = await mod.default({
      locateFile: name => name === '7zz.wasm' ? SEVEN_ZIP_WASM_URL : name,
      print: str => output.push(str),
      printErr: str => errors.push(str),
    });
    sevenZip.output = output;
    sevenZip.errors = errors;
    return sevenZip;
  }

  function readSevenZipTree(FS, dir = '/out', prefix = '') {
    const files = {};
    for (const name of FS.readdir(dir)) {
      if (name === '.' || name === '..') continue;
      const fullPath = `${dir}/${name}`;
      const relPath = prefix ? `${prefix}/${name}` : name;
      const stat = FS.stat(fullPath);
      if (FS.isDir(stat.mode)) {
        Object.assign(files, readSevenZipTree(FS, fullPath, relPath));
      } else if (FS.isFile(stat.mode)) {
        const data = FS.readFile(fullPath, { encoding: 'binary' });
        files[relPath.split('/').pop()] = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      }
    }
    return files;
  }

  async function sevenZipFiles(buf) {
    if (!isSevenZip(buf)) return null;
    const sevenZip = await loadSevenZipModule();
    const FS = sevenZip.FS;
    try { FS.mkdir('/out'); } catch (_) {}
    FS.writeFile('/input.7z', new Uint8Array(buf));
    let result = 0;
    try {
      result = sevenZip.callMain(['x', '/input.7z', '-o/out', '-y', '-bso0', '-bsp0']);
    } catch (err) {
      if (err?.name === 'ExitStatus' && err.status === 0) {
        result = 0;
      } else {
        const detail = sevenZip.errors?.join('\n') || err?.message || String(err);
        throw new Error(`7z extraction failed: ${detail}`);
      }
    }
    if (typeof result === 'number' && result !== 0) throw new Error(`7z extraction failed with exit code ${result}`);
    const files = readSevenZipTree(FS);
    if (!Object.keys(files).length) throw new Error('7z archive did not contain any supported files');
    return files;
  }

  async function archiveFiles(buf) {
    if (isZip(buf)) return zipFiles(buf);
    if (isSevenZip(buf)) return sevenZipFiles(buf);
    return null;
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
      this.decodeReport = null;
      this.lastError = null;
    }

    reset() {
      this.state = 'empty';
      this.source = null;
      this.library = null;
      this.entries = [];
      this.memory = null;
      this.decodeReport = null;
      this.lastError = null;
    }

    async loadBuffer(buf, source = {}) {
      this.reset();
      try {
        if (isZip(buf) || isSevenZip(buf)) return await this._loadArchive(buf, source);
        if (!isValid(buf)) return null;
        const decoded = await decodeProgram(buf, {
          kind: /\.minigsf$/i.test(source.name || '') ? 'minigsf' : 'gsf',
          name: source.name || 'Dropped GSF',
        });
        const info = await programInfo(buf);
        this.source = {
          kind: /\.minigsf$/i.test(source.name || '') ? 'minigsf' : 'gsf',
          name: source.name || 'Dropped GSF',
          tags: tags(buf),
          ...(info || {}),
        };
        this.memory = createMemoryImage();
        applyDecodedProgram(this.memory, decoded, this.source.name);
        this.entries = [{
          name: this.source.tags.title || this.source.name,
          tags: this.source.tags,
          decoded,
          patch: await miniPatch(buf),
        }];
        this.decodeReport = this._makeDecodeReport();
        this.state = 'loaded-no-emulator';
        return this.source;
      } catch (err) {
        this.state = 'error';
        this.lastError = err;
        throw err;
      }
    }

    async _loadArchive(buf, source = {}) {
      const files = await archiveFiles(buf);
      if (!files) return null;
      const libKey = Object.keys(files).find(k => /\.gsflib$/i.test(k));
      if (!libKey) throw new Error('No .gsflib found in archive');
      const libDecoded = await decodeProgram(files[libKey], { kind: 'gsflib', name: libKey });
      const libInfo = await programInfo(files[libKey]);
      this.library = {
        key: libKey,
        tags: tags(files[libKey]),
        decoded: libDecoded,
        ...(libInfo || {}),
      };
      this.memory = createMemoryImage();
      applyDecodedProgram(this.memory, libDecoded, libKey);
      const miniKeys = Object.keys(files).filter(k => /\.minigsf$/i.test(k)).sort();
      this.entries = [];
      for (const key of miniKeys) {
        const patch = await miniPatch(files[key]);
        const decoded = await decodeProgram(files[key], { kind: 'minigsf', name: key });
        applyDecodedProgram(this.memory, decoded, key);
        const entryTags = tags(files[key]);
        this.entries.push({
          key,
          name: entryTags.title || key.replace(/\.minigsf$/i, ''),
          tags: entryTags,
          decoded,
          patch,
        });
      }
      this.source = {
        kind: isSevenZip(buf) ? 'gsf-7z' : 'gsf-zip',
        name: source.name || (isSevenZip(buf) ? 'Dropped 7z' : 'Dropped ZIP'),
        library: libKey,
        tags: this.library.tags,
        minigsfCount: miniKeys.length,
        ...(libInfo || {}),
      };
      this.decodeReport = this._makeDecodeReport();
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
        parts.push(`load 0x${this.source.loadAddr.toString(16).padStart(8, '0')} +${this.source.dataSize}`);
      }
      if (this.decodeReport) parts.push(this.reportText());
      const summaryText = tagSummary(this.source?.tags);
      if (summaryText) parts.push(summaryText);
      parts.push('playback: not emulated yet');
      return parts.join(' | ');
    }
  }

  window.GsfTools = {
    isValid,
    isZip,
    isSevenZip,
    inflate,
    tags,
    tagSummary,
    decompress,
    decodeProgram,
    decodeProgramBytes,
    createMemoryImage,
    applyDecodedProgram,
    programInfo,
    romImage,
    miniPatch,
    zipFiles,
    sevenZipFiles,
    archiveFiles,
  };
  window.StandardGsfEngine = StandardGsfEngine;
})();
