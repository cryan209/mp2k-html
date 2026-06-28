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
    if (region?.id !== 'rom') {
      memory.warnings.push(`${label} loads into ${region?.label || 'unknown memory'}, not ROM; stored as segment only`);
      return false;
    }
    const romOffset = program.loadAddr - tools.GBA_ROM_BASE;
    if (romOffset < 0 || romOffset + program.clippedSize > memory.rom.length) {
      memory.warnings.push(`${label} ROM write ${tools.hex(program.loadAddr)} +${program.clippedSize} is out of range`);
      return false;
    }
    memory.rom.set(program.data, romOffset);
    return true;
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
      this.diagnostics = null;
      this.lastError = null;
    }

    reset() {
      this.state = 'empty';
      this.source = null;
      this.library = null;
      this.entries = [];
      this.memory = null;
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
        this.diagnostics = this._makeInitialDiagnostics();
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
      this.diagnostics = this._makeInitialDiagnostics();
      this.state = 'loaded-no-emulator';
      return this.source;
    }

    canPlay() {
      return false;
    }

    async play() {
      throw new Error('Standard GSF LLE playback needs a GBA CPU/APU emulator; diagnostics scaffold is loaded only.');
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

    _makeInitialDiagnostics() {
      return {
        status: 'decoder-ready',
        hooks: {
          cpu: false,
          ioWrites: false,
          timers: false,
          dma: false,
          sound: false,
        },
        patchPoints: [],
        notes: ['GSF memory image is decoded; CPU, IO hooks, and hot patches are not implemented yet.'],
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
        parts.push(`load ${tools.hex(this.source.loadAddr)} +${this.source.dataSize}`);
      }
      if (this.decodeReport) parts.push(this.reportText());
      const summaryText = tools.tagSummary(this.source?.tags);
      if (summaryText) parts.push(summaryText);
      parts.push('playback: not emulated yet');
      return parts.join(' | ');
    }
  }

  window.GsfEmulator = {
    createMemoryImage,
    applyDecodedProgram,
    StandardGsfEngine,
  };
  window.StandardGsfEngine = StandardGsfEngine;
})();
