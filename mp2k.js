// ── Constants ─────────────────────────────────────────────────────────────────
let GBA_MIX_RATE    = 18157;  // MP2k mixer output rate — common: 5734 7884 10512 13379 15768 18157 21024 26758 31536 36314
let GBA_VOICE_LIMIT = 8;      // MP2k software voice (polyphony) limit
const MP2K_RATE_TABLE = [0, 5734, 7884, 10512, 13379, 15768, 18157, 21024, 26758, 31536, 36314, 40137, 42048, 0, 0, 0];
const SYNTH_PRESETS = {
  rom: { label:'ROM tiny wave (64-step held)' },
  romInterp: { label:'ROM tiny wave (8-point interp)' },
  romBits: { label:'ROM tiny wave (bit unpack test)' },
  romArm: { label:'ROM tiny wave (ARM interp path, 8-byte looping oscillator)' },
  pulse12: { label:'GBC Pulse 12.5%', duty:0.125, gbc: true, dutyPattern:[0,0,0,0,0,0,0,1] },
  pulse25: { label:'GBC Pulse 25%', duty:0.25, gbc: true, dutyPattern:[1,0,0,0,0,0,0,1] },
  pulse50: { label:'GBC Pulse 50%', duty:0.5, gbc: true, dutyPattern:[1,0,0,0,0,1,1,1] },
  pulse75: { label:'GBC Pulse 75%', duty:0.75, gbc: true, dutyPattern:[0,1,1,1,1,1,1,0] },
  triangle: { label:'GBC-style Triangle', gbc: true },
  sine: { label:'GBC-style Sine', gbc: true },
};
const GBC_DAC_BITS = 4;
const GBC_ENVELOPE_HZ = 64;
const DMG_APU_CLOCK = 4194304;
const DMG_FRAME_SEQUENCER_HZ = 512;
const AGB_EXACT_FPS = 16777216 / 280896;
const CAMELOT_SYNTH_INTERFRAMES = 4;
const GBC_WAVE_DAC_LEVELS = 16;
const GBA_SOUND_REG_BASE = 0x60;
const GBA_SOUND_REG_END = 0xa0;
const PLAYER_BUILD = 'sample-preview-waveform-2026-06-25';
const ROM_SYNTH_TINY_LOOP_MAX = 8;
const ROM_SYNTH_EFFECTIVE_PERIOD = 64;
const ROM_SYNTH_BIT_AMPLITUDE = 0.72;
const ROM_SYNTH_DC_CENTER = true;
const PSG_CLICK_FADE_SEC = 0.003;
const PSG_HIGHPASS_HZ = 90;

const ENGINE_PROFILES = {
  genericMp2k: {
    id: 'genericMp2k',
    label: 'Generic MP2K/Sappy',
    family: 'nintendo-mp2k',
    tempoScale: 2,
    tuneMode: 'signed',
    psgRegisterCommand: true,
    gbaDacNegativeSlope: true,
    gbaWaveChannelInverts: true,
  },
  pokemonGba: {
    id: 'pokemonGba',
    label: 'Pokemon GBA Sappy',
    family: 'pokemon-sappy',
    tempoScale: 2,
    tuneMode: 'signed',
    psgRegisterCommand: true,
    gbaDacNegativeSlope: true,
    gbaWaveChannelInverts: true,
    pokemonExtendedCommands: true,
    pitchFormula: 'agb-mplay',
    cgbPitchUsesPlayedKey: true,
    rhythmPcmGain: 0.45,
    cgbOutputGain: 0.35,
    directSoundOutputGain: 0.75,
    noiseGain: 1,
    psg2Gain: 1,
    extendedCommandArgCounts: {
      0x01: 4,
      0x02: 1,
      0x04: 1,
      0x05: 1,
      0x06: 1,
      0x07: 1,
      0x08: 1,
      0x09: 1,
      0x0a: 1,
      0x0b: 1,
      0x0c: 2,
      0x0d: 4,
    },
  },
  camelotGs1: {
    id: 'camelotGs1',
    label: 'Camelot Golden Sun',
    family: 'camelot-mp2k',
    tempoScale: 2,
    tuneMode: 'minus64',
    psgRegisterCommand: true,
    gbaDacNegativeSlope: true,
    gbaWaveChannelInverts: true,
    camelotSynths: true,
    reverbType: 'gs1',
  },
  camelotGs2: {
    id: 'camelotGs2',
    label: 'Camelot Golden Sun 2',
    family: 'camelot-mp2k',
    tempoScale: 2,
    tuneMode: 'minus64',
    psgRegisterCommand: true,
    gbaDacNegativeSlope: true,
    gbaWaveChannelInverts: true,
    camelotSynths: true,
    reverbType: 'gs2',
  },
  camelotSports: {
    id: 'camelotSports',
    label: 'Camelot Sports',
    family: 'camelot-mp2k',
    tempoScale: 2,
    tuneMode: 'minus64',
    psgRegisterCommand: true,
    gbaDacNegativeSlope: true,
    gbaWaveChannelInverts: true,
    camelotSynths: true,
    reverbType: 'mgat',
  },
};
const DEFAULT_ENGINE_PROFILE = ENGINE_PROFILES.genericMp2k;

// Duration/wait lookup table (MP2k standard)
const FBA14 = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,28,30,32,36,40,42,44,48,52,54,56,60,64,66,68,72,76,78,80,84,88,90,92,96];

const CMD_NAMES = {
  0xb1:'FINE', 0xb2:'GOTO', 0xb3:'PATT', 0xb4:'PEND', 0xb5:'PATL',
  0xb9:'VM', 0xba:'PRI', 0xbb:'TEMPO', 0xbc:'KEYSH', 0xbd:'INST',
  0xbe:'LVL', 0xbf:'PAN', 0xc0:'PB', 0xc1:'PBR', 0xc2:'LFOS',
  0xc3:'LFODL', 0xc4:'LFOD', 0xc5:'MODE', 0xc8:'TUNE',
  0xcc:'PSG', 0xcd:'EXT', 0xce:'REL'
};

const XCMD_NAMES = {
  0x01: 'xwave',
  0x02: 'xtype',
  0x04: 'xatta',
  0x05: 'xdeca',
  0x06: 'xsust',
  0x07: 'xrele',
  0x08: 'xiecv',
  0x09: 'xiecl',
  0x0a: 'xleng',
  0x0b: 'xswee',
  0x0c: 'xwait',
  0x0d: 'xcmd0D',
};

function hex(v, width = 2) {
  if (v == null || Number.isNaN(v)) return '—';
  return '0x' + (v >>> 0).toString(16).padStart(width, '0');
}

function noteName(midi) {
  if (midi == null || midi < 0) return '—';
  const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  return names[((midi % 12) + 12) % 12] + Math.floor(midi / 12);
}

function s8(v) {
  v &= 0xff;
  return v >= 0x80 ? v - 0x100 : v;
}

function cmdName(byte) {
  if (byte == null) return '—';
  if (byte < 0x80) return `ARG ${hex(byte)}`;
  if (byte <= 0xb0) return `WAIT ${FBA14[byte - 0x80] ?? '?'}`;
  if (byte <= 0xce) return CMD_NAMES[byte] || `CMD ${hex(byte)}`;
  return `NOTE ${FBA14[byte - 0xcf] ?? '?'}t`;
}

function channelGroupVoiceCount(_group) {
  return GBA_VOICE_LIMIT;
}

function signedPcm(bytes) {
  return [...bytes].map(b => b >= 128 ? b - 256 : b);
}

function waveformSvgDataUrl(values, { width = 720, height = 180, label = 'waveform' } = {}) {
  const sourceVals = values && values.length ? values : [0];
  const vals = sourceVals.length > width
    ? Array.from({ length: width }, (_, i) => sourceVals[Math.floor((i / Math.max(1, width - 1)) * (sourceVals.length - 1))])
    : sourceVals;
  const mid = height / 2;
  const amp = Math.max(1, Math.max(...vals.map(v => Math.abs(v))));
  const points = vals.map((v, i) => {
    const x = vals.length === 1 ? 0 : (i / (vals.length - 1)) * (width - 1);
    const y = mid - (v / amp) * (height * 0.42);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
  const zero = mid.toFixed(2);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="#0b1020"/>
<line x1="0" y1="${zero}" x2="${width}" y2="${zero}" stroke="#334155" stroke-width="1"/>
<polyline points="${points}" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
<text x="10" y="18" fill="#94a3b8" font-family="monospace" font-size="12">${label}</text>
</svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

function instSummary(entry, idx = -1) {
  if (!entry) return '—';
  const base = `${idx >= 0 ? `vg:${idx} ` : ''}type:${entry.type} key:${entry.keyAdj} ptr:${hex(entry.sptr, 8)}`;
  return `${base} ADSR:${hex(entry.A)} ${hex(entry.D)} ${hex(entry.S)} ${hex(entry.R)}`;
}

function sampleSummary(rom, entry) {
  if (!rom || !entry || (entry.sptr >>> 24) !== 8) return 'no ROM sample';
  const s = parseSample(rom, entry.sptr);
  if (!s) return 'invalid sample pointer';
  const loopLen = s.loopEnd - s.loopStart;
  const camelotKind = s.data?.[1] === 0 ? 'pwm' : s.data?.[1] === 1 ? 'saw' : 'tri';
  const camelotSynth = s.looped && s.rawLoopEnd === 0 && loopLen > 0 && loopLen <= ROM_SYNTH_TINY_LOOP_MAX
    ? ` zeroEndSynth:${camelotKind}`
    : '';
  const tinySynth = s.looped && s.rawLoopEnd > s.loopStart && loopLen > 0 && loopLen <= 64
    ? ` effectivePeriod:${ROM_SYNTH_EFFECTIVE_PERIOD}`
    : '';
  const modeTag = s.gamefreakCompressed ? ' mode:gf-dpcm' : (s.sampleMode ? ` mode:${s.sampleMode}` : '');
  return `sampleHz:${s.sampleHz}${modeTag} loop:${s.loopStart}-${s.loopEnd} rawEnd:${s.rawLoopEnd} looped:${s.looped} bytes:${s.data.length}${camelotSynth}${tinySynth}`;
}

// ── ROM Reader ────────────────────────────────────────────────────────────────
class ROM {
  constructor(buf) {
    this.data = new Uint8Array(buf);
    this.view = new DataView(buf);
  }
  u8(off)  { return this.data[off]; }
  u16(off) { return this.view.getUint16(off, true); }
  u32(off) { return this.view.getUint32(off, true); }
  ptr(off) { // Convert ROM pointer 0x08xxxxxx → byte offset
    const v = this.u32(off);
    return (v >>> 24) === 8 ? (v & 0x1ffffff) : 0;
  }
  bytes(off, len) { return this.data.slice(off, off + len); }
}

// ── Song / Voicegroup Parsing ─────────────────────────────────────────────────
function parseSongTable(rom, tableAddr) {
  const songs = [];
  const seenHdr = new Set();
  let nullRun = 0;
  for (let i = 0; i < 1024; i++) {
    const entryOff = tableAddr + i * 8;
    if (entryOff + 8 > rom.data.length) break;
    const hdrRaw = rom.u32(entryOff);
    if ((hdrRaw >>> 24) !== 8) {
      // Not a GBA pointer at all — reliable sign we've left the table.
      if (++nullRun >= 8) break;
      continue;
    }
    // Any GBA-pointer slot resets the non-table run, whether it's a real
    // song or a null/placeholder entry pointing to a dummy header.
    nullRun = 0;
    const grp = rom.u16(entryOff + 4);
    const hdrOff = hdrRaw & 0x1ffffff;
    const tc = rom.u8(hdrOff);
    const vgPtr = rom.ptr(hdrOff + 4);
    if (tc < 1 || tc > 16 || !vgPtr || hdrOff + 8 + tc * 4 > rom.data.length) {
      continue; // null/placeholder song — skip, stay in table
    }
    const reverb = rom.u8(hdrOff + 3);
    const tracks = [];
    for (let t = 0; t < tc; t++) {
      const tptr = rom.ptr(hdrOff + 8 + t * 4);
      if (tptr) tracks.push(tptr);
    }
    if (tracks.length > 0 && !seenHdr.has(hdrOff)) {
      seenHdr.add(hdrOff);
      songs.push({ idx: i, hdrOff, tc, reverb, vgPtr, tracks, grp });
    }
  }
  return songs;
}

function parseVoicegroup(rom, vgOff) {
  const entries = [];
  for (let i = 0; i < 256; i++) {
    entries.push(parseVoiceEntry(rom, vgOff + i * 12, i));
  }
  return entries;
}

function detectMp2kSongTables(rom) {
  // A valid song header: tc 1-16, valid vgPtr, all tc track ptrs are GBA pointers.
  function isValidHeader(off) {
    if (off < 0 || off + 12 > rom.data.length) return false;
    const tc = rom.u8(off);
    if (tc < 1 || tc > 16) return false;
    const vg = rom.u32(off + 4);
    if ((vg >>> 24) !== 8) return false;
    if (off + 8 + tc * 4 > rom.data.length) return false;
    for (let t = 0; t < tc; t++) {
      if ((rom.u32(off + 8 + t * 4) >>> 24) !== 8) return false;
    }
    return true;
  }
  function isValidEntry(off) {
    if (off + 8 > rom.data.length) return false;
    const raw = rom.u32(off);
    if ((raw >>> 24) !== 8) return false;
    return isValidHeader(raw & 0x1ffffff);
  }

  // Collect candidates: any starting position where ≥5 of the next 32 slots are valid.
  const WINDOW = 32;
  const seen = new Set();
  const candidates = [];
  for (let align = 0; align < 2; align++) {
    for (let i = align * 4; i + WINDOW * 8 <= rom.data.length; i += 8) {
      if (!isValidEntry(i)) continue;
      let score = 1;
      for (let j = 1; j < WINDOW; j++) {
        if (isValidEntry(i + j * 8)) score++;
      }
      if (score < 5) continue;
      // Deduplicate: treat candidates within 512 bytes of each other as the same table.
      const key = Math.floor(i / 512);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(i);
    }
  }

  // Walk backwards from a detected candidate to find the real table start.
  // MP2k tables often begin with null/placeholder slots (GBA pointers to a dummy song header)
  // before the first real song. The window scan starts at the first valid entry, so we
  // step back through slots that all point to the SAME null-song target — the one
  // consistent address all null slots in a given table share.
  // Stopping on "any GBA pointer" is too permissive; stopping on "same null target" avoids
  // overshooting into unrelated ROM data that happens to use GBA pointers.
  function findTableStart(pos) {
    if (pos < 8) return pos;
    const prevRaw = rom.u32(pos - 8);
    if ((prevRaw >>> 24) !== 8) return pos;   // slot before us isn't a GBA ptr → already at start
    if (isValidEntry(pos - 8)) return pos;    // slot before is a real song → already at start
    const nullTarget = prevRaw & 0x1ffffff;   // the address all placeholder slots point to
    while (pos >= 8) {
      const prev = pos - 8;
      const raw = rom.u32(prev);
      if ((raw >>> 24) !== 8) break;
      if ((raw & 0x1ffffff) !== nullTarget) break; // different target → before the table
      pos = prev;
    }
    return pos;
  }

  // Full-scan each candidate. Sort by avg track count descending: music songs typically
  // have 3-10 tracks while SFX entries have 1-2, so this reliably picks music first.
  const seenAddr = new Set();
  return candidates
    .map(addr => {
      const actualAddr = findTableStart(addr);
      if (seenAddr.has(actualAddr)) return null; // dedup after backwards walk
      seenAddr.add(actualAddr);
      const songs = parseSongTable(rom, actualAddr);
      const avgTc = songs.length ? songs.reduce((s, x) => s + x.tc, 0) / songs.length : 0;
      return { addr: actualAddr, songs, avgTc };
    })
    .filter(x => x && x.songs.length >= 3)
    .sort((a, b) => b.avgTc - a.avgTc || b.songs.length - a.songs.length);
}

function detectMp2kSongTable(rom) {
  const tables = detectMp2kSongTables(rom);
  return tables.length ? tables[0].addr : null;
}

function parseVoiceEntry(rom, off, idx = -1) {
  const typeWord = rom.u32(off);
  const typeB   = typeWord & 0xff;
  const keyAdj  = (typeWord >>> 8) & 0xff;
  const p2      = (typeWord >>> 16) & 0xff;
  const p3      = (typeWord >>> 24) & 0xff;
  const sptr    = rom.u32(off + 4);
  const adsr    = rom.u32(off + 8);
  const A = adsr & 0xff;
  const D = (adsr >>> 8) & 0xff;
  const S = (adsr >>> 16) & 0xff;
  const R = (adsr >>> 24) & 0xff;
  return { idx, off, typeB, type: typeB & 7, keyAdj, p2, p3, length: p2, panSweep: p3, sptr, adsr, A, D, S, R };
}

function applyToneOverride(entry, override = null) {
  if (!entry || !override) return entry;
  const next = { ...entry };
  if (override.typeB != null) {
    next.typeB = override.typeB & 0xff;
    next.type = next.typeB & 7;
  }
  if (override.sptr != null) next.sptr = override.sptr >>> 0;
  if (override.A != null) next.A = override.A & 0xff;
  if (override.D != null) next.D = override.D & 0xff;
  if (override.S != null) next.S = override.S & 0xff;
  if (override.R != null) next.R = override.R & 0xff;
  const a = next.A & 0xff;
  const d = next.D & 0xff;
  const s = next.S & 0xff;
  const r = next.R & 0xff;
  next.adsr = (a | (d << 8) | (s << 16) | (r << 24)) >>> 0;
  if (override.length != null) next.length = override.length & 0xff;
  if (override.length != null) next.p2 = next.length;
  if (override.panSweep != null) {
    next.panSweep = override.panSweep & 0xff;
    next.p3 = next.panSweep;
  }
  return next;
}

function resolveTrackVoiceEntry(rom, instEntry, noteMidi, toneOverride = null, profile = null) {
  const resolved = resolveVoiceEntry(rom, instEntry, noteMidi, profile);
  if (!resolved) return null;
  if (!toneOverride) return resolved;
  return {
    ...resolved,
    entry: applyToneOverride(resolved.entry, toneOverride),
  };
}

function detectEngineProfile(info = {}, rom = null) {
  const header = info.header || {};
  const tags = info.gsfTags || {};
  const haystack = [
    header.title,
    header.gameCode,
    header.makerCode,
    tags.game,
    tags.title,
    info.name,
    info.gsfLibrary,
  ].filter(Boolean).join(' ').toLowerCase();
  const code = (header.gameCode || '').toUpperCase();
  const title = (header.title || '').toLowerCase();
  const compactHaystack = haystack.replace(/[^a-z0-9]/g, '');

  if (
    code === 'AGFE' ||
    title.includes('golden_sun_b') ||
    haystack.includes('lost age') ||
    haystack.includes('lost_age') ||
    compactHaystack.includes('goldensun2') ||
    compactHaystack.includes('goldensunthelostage')
  ) {
    return ENGINE_PROFILES.camelotGs2;
  }
  if (
    code === 'AGSE' ||
    title.includes('golden_sun_a') ||
    (compactHaystack.includes('goldensun') && !compactHaystack.includes('lostage'))
  ) {
    return ENGINE_PROFILES.camelotGs1;
  }
  if (
    haystack.includes('mario golf') ||
    haystack.includes('mariogolf') ||
    haystack.includes('mario tennis') ||
    haystack.includes('mariotennis') ||
    haystack.includes('camelot') ||
    /^BM[GT]/.test(code)
  ) {
    return ENGINE_PROFILES.camelotSports;
  }
  if (
    haystack.includes('pokemon') ||
    /^BP[GRE]/.test(code) ||
    /^AXV/.test(code) ||
    /^AXP/.test(code) ||
    /^BPE/.test(code)
  ) {
    return ENGINE_PROFILES.pokemonGba;
  }
  return DEFAULT_ENGINE_PROFILE;
}

function detectMp2kSoundMode(rom) {
  if (!rom) return null;
  const validRomPtr = word => (word >>> 24) === 8 && (word & 0x1ffffff) < rom.data.length - 1;
  const validRamPtr = word => (
    (word >= 0x02000000 && word <= 0x0203ffff) ||
    (word >= 0x03000000 && word <= 0x03007fff)
  );
  const validIwramPtr = word => word >= 0x03000000 && word <= 0x03007fff;
  const parseMode = (pos, metroid = false) => {
    const mode = rom.u32(pos);
    if (!metroid && (mode & 0xff) !== 0) return null;
    const reverb = mode & 0xff;
    const maxChannels = (mode >>> 8) & 0x0f;
    const volume = (mode >>> 12) & 0x0f;
    const freq = (mode >>> 16) & 0x0f;
    const dacConfig = (mode >>> 20) & 0x0f;
    const rate = MP2K_RATE_TABLE[freq] || 0;
    if (maxChannels < 1 || maxChannels > 12) return null;
    if (freq < 1 || freq > 12 || rate <= 0) return null;
    if (dacConfig < 8 || dacConfig > 11) return null;
    return { mode, pos, reverb, maxChannels, volume, freq, dacConfig, rate, source: metroid ? 'metroid literal pool' : 'm4aSoundInit literal pool' };
  };

  for (let pos = 0x200; pos + 0x24 <= rom.data.length; pos += 4) {
    if (!validRomPtr(rom.u32(pos + 0x00))) continue;
    if (!validRamPtr(rom.u32(pos + 0x04))) continue;
    const cpusetArg = rom.u32(pos + 0x08);
    if ((cpusetArg & (1 << 26)) === 0 || (cpusetArg & 0x1fffff) >= 0x800) continue;
    if (!validRamPtr(rom.u32(pos + 0x0c))) continue;
    if (!validRamPtr(rom.u32(pos + 0x10))) continue;
    const mode = parseMode(pos + 0x14, false);
    if (!mode) continue;
    const playerTableLen = rom.u32(pos + 0x18);
    if (playerTableLen > 32) continue;
    if (!validRomPtr(rom.u32(pos + 0x1c))) continue;
    if (!validRamPtr(rom.u32(pos + 0x20))) continue;
    return mode;
  }

  for (let pos = 0x200; pos + 0x78 <= rom.data.length; pos += 4) {
    if (!validRamPtr(rom.u32(pos + 0x00))) continue;
    if (rom.u32(pos + 0x04) !== 0x04000200) continue;
    if (rom.u32(pos + 0x08) !== 0x04000084) continue;
    if (rom.u32(pos + 0x0c) !== 0x04000082) continue;
    if (rom.u32(pos + 0x14) !== 0x04000089) continue;
    if (rom.u32(pos + 0x18) !== 0x04000063) continue;
    if (rom.u32(pos + 0x1c) !== 0x04000080) continue;
    if (!validRamPtr(rom.u32(pos + 0x20))) continue;
    if (!validIwramPtr(rom.u32(pos + 0x24))) continue;
    if (!validRomPtr(rom.u32(pos + 0x28))) continue;
    if (!validRamPtr(rom.u32(pos + 0x30))) continue;
    if (!validIwramPtr(rom.u32(pos + 0x34))) continue;
    if (!validRomPtr(rom.u32(pos + 0x38))) continue;
    if (!validRamPtr(rom.u32(pos + 0x40))) continue;
    if (!validIwramPtr(rom.u32(pos + 0x44))) continue;
    if (!validRomPtr(rom.u32(pos + 0x48))) continue;
    if (rom.u32(pos + 0x58) > 32) continue;
    const mode = parseMode(pos + 0x5c, true);
    if (!mode) continue;
    if (!validRamPtr(rom.u32(pos + 0x60))) continue;
    if (rom.u32(pos + 0x68) !== 0x040000d4) continue;
    if (!validRomPtr(rom.u32(pos + 0x6c))) continue;
    return mode;
  }

  return null;
}

function countCamelotSynthPrograms(rom) {
  if (!rom) return 0;
  let count = 0;
  for (let off = 0x200; off + 24 <= rom.data.length; off += 4) {
    if (rom.u32(off) !== 0x40000000) continue;
    const rate = rom.u32(off + 4);
    if (rate < 0x100000 || rate > 0x4000000) continue;
    if (rom.u32(off + 8) !== 0 || rom.u32(off + 12) !== 0) continue;
    const typeByte = rom.u8(off + 17);
    if (typeByte > 2) continue;
    count++;
  }
  return count;
}

function refineCamelotProfileFromRom(profile, rom, soundMode) {
  if (profile && profile !== DEFAULT_ENGINE_PROFILE && profile.id !== 'genericMp2k') return profile;
  const synthPrograms = countCamelotSynthPrograms(rom);
  if (synthPrograms < 3) return profile;
  if (soundMode?.rate === 31536) return ENGINE_PROFILES.camelotGs2;
  if (soundMode?.rate === 21024) return ENGINE_PROFILES.camelotGs1;
  if (soundMode?.rate === 15768) return ENGINE_PROFILES.camelotSports;
  return profile;
}

function resolveVoiceEntry(rom, instEntry, noteMidi, profile = null) {
  if (!instEntry) return null;
  if ((instEntry.typeB & 0xc0) === 0) return { entry: instEntry, tableIndex: -1, parent: null, pitchOffset: 0, pitchNote: noteMidi, noteMidi };

  let tableIndex = Math.max(0, Math.min(127, noteMidi | 0));
  const gbaOff = ptr => (ptr >>> 24) === 8 ? (ptr & 0x1ffffff) : 0;
  const readCandidate = (tablePtr, mapPtr = 0) => {
    const tableOff = gbaOff(tablePtr);
    if (!tableOff) return null;
    let idx = tableIndex;
    const mapOff = gbaOff(mapPtr);
    if (mapOff) idx = rom.u8(mapOff + idx);
    const entry = parseVoiceEntry(rom, tableOff + idx * 12, idx);
    if (entry.typeB & 0xc0) return null; // ARM rejects nested keyed entries.
    return { entry, tableIndex: idx };
  };

  let candidate = null;
  if ((instEntry.typeB & 0x40) && profile?.family === 'pokemon-sappy') {
    const normal = readCandidate(instEntry.sptr, instEntry.adsr);
    const swapped = readCandidate(instEntry.adsr, instEntry.sptr);
    const score = c => {
      if (!c) return -1;
      let s = 0;
      if (c.entry.type >= 0 && c.entry.type <= 4) s += 2;
      if (c.entry.type === 0 && gbaOff(c.entry.sptr)) s += 3;
      if (c.entry.keyAdj > 0 && c.entry.keyAdj < 128) s += 2;
      if (c.entry.A || c.entry.D || c.entry.S || c.entry.R) s += 1;
      return s;
    };
    candidate = score(swapped) > score(normal) ? swapped : normal;
  } else {
    candidate = readCandidate(instEntry.sptr, (instEntry.typeB & 0x40) ? instEntry.adsr : 0);
  }
  if (!candidate) return null;
  const { entry } = candidate;
  tableIndex = candidate.tableIndex;
  let pitchOffset = 0;
  let pitchNote = noteMidi;
  let rhythmPan = 0;
  if ((instEntry.typeB & 0x80) && (entry.p3 & 0x80)) {
    rhythmPan = ((entry.p3 - 0xc0) << 1);
  }
  if (instEntry.typeB & 0x80) {
    pitchNote = entry.keyAdj;
  }
  return { entry, tableIndex, parent: instEntry, pitchOffset, pitchNote, rhythmPan, noteMidi };
}

function parseSample(rom, sptr) {
  if ((sptr >>> 24) !== 8) return null;
  const off = sptr & 0x1ffffff;
  const flags    = rom.u32(off);
  const sampleMode = flags & 0xff;
  const rate     = rom.u32(off + 4);
  const loopStart = rom.u32(off + 8);
  const rawLoopEnd = rom.u32(off + 12);
  const sampleHz = rate >> 11;
  const looped   = !!(flags & 0x40000000);
  // The mixer consumes signed 8-bit PCM bytes. Some tiny waveform entries are
  // flagged looped with raw loopEnd=0; in practice they run to the next header.
  const sampleEnd = rom.sampleEndByHeader?.get(off);
  const boundedCount = sampleEnd ? Math.max(0, sampleEnd - off - 16) : 0x4000;
  let loopEnd = rawLoopEnd > 0 ? rawLoopEnd : (looped ? boundedCount : 0);
  const maxCount = Math.max(0, rom.data.length - (off + 16));
  let data;
  if (sampleMode === 1) {
    const decodedCount = rawLoopEnd > 0
      ? rawLoopEnd
      : Math.floor(Math.min(boundedCount, maxCount) / 0x21) * 64;
    const encodedMax = Math.min(maxCount, Math.ceil(decodedCount / 64) * 0x21);
    data = decodeGameFreakDpcm(rom.bytes(off + 16, encodedMax), decodedCount);
    if (rawLoopEnd === 0 && looped) loopEnd = decodedCount;
  } else {
    const sampleCount = loopEnd > 0 ? loopEnd : boundedCount;
    data = rom.bytes(off + 16, Math.min(sampleCount, maxCount));
  }
  return { rate, sampleHz, loopStart, loopEnd, rawLoopEnd, looped, sampleMode, gamefreakCompressed: sampleMode === 1, data };
}

function decodeGameFreakDpcm(encoded, decodedSamples) {
  const deltaTable = [0, 1, 4, 9, 16, 25, 36, 49, -64, -49, -36, -25, -16, -9, -4, -1];
  const out = new Uint8Array(Math.max(0, decodedSamples | 0));
  let outPos = 0;
  for (let block = 0; outPos < out.length; block++) {
    const blockPos = block * 0x21;
    if (blockPos >= encoded.length) break;
    let acc = (encoded[blockPos] << 24) >> 24;
    out[outPos++] = acc < 0 ? acc + 256 : acc;
    if (outPos >= out.length || blockPos + 1 >= encoded.length) break;
    acc = ((acc + deltaTable[encoded[blockPos + 1] & 0x0f]) << 24) >> 24;
    out[outPos++] = acc < 0 ? acc + 256 : acc;
    for (let j = 2, h = 2; j < 64 && outPos < out.length; j += 2, h++) {
      if (blockPos + h >= encoded.length) break;
      const byte = encoded[blockPos + h];
      acc = ((acc + deltaTable[(byte >>> 4) & 0x0f]) << 24) >> 24;
      out[outPos++] = acc < 0 ? acc + 256 : acc;
      if (outPos >= out.length) break;
      acc = ((acc + deltaTable[byte & 0x0f]) << 24) >> 24;
      out[outPos++] = acc < 0 ? acc + 256 : acc;
    }
  }
  return out;
}

function indexSampleBounds(rom, voiceGroup) {
  const offsets = new Set();
  const addEntry = entry => {
    if (entry?.type === 0 && (entry.sptr >>> 24) === 8) offsets.add(entry.sptr & 0x1ffffff);
  };
  for (const entry of voiceGroup) {
    addEntry(entry);
    if (entry && (entry.typeB & 0xc0) && (entry.sptr >>> 24) === 8) {
      const tableOff = entry.sptr & 0x1ffffff;
      for (let i = 0; i < 128; i++) addEntry(parseVoiceEntry(rom, tableOff + i * 12, i));
    }
  }
  const sorted = [...offsets].sort((a, b) => a - b);
  rom.sampleEndByHeader = new Map();
  for (let i = 0; i < sorted.length; i++) {
    const next = sorted[i + 1] || rom.data.length;
    rom.sampleEndByHeader.set(sorted[i], next);
  }
}

// ── Audio Engine ──────────────────────────────────────────────────────────────
class AudioEngine {
  constructor() {
    this.ctx = null;
    this.sampleCache = new Map(); // sptr → AudioBuffer
    this.synthCache = new Map();  // short loop + pitch → GBA-rate generated buffer
    this.gbcWaveCache = new Map();
    this.gbcBufferCache = new Map(); // quantized DMG/GBC APU waveform buffers
    this.synthMode = 'rom';
    this.synthInstrumentModes = new Map();
    this.voiceGroup = null;
    this.noiseCache = new Map();
    this.profile = DEFAULT_ENGINE_PROFILE;
    this.scheduledTime = null;
    this.pcmReverbInfo = null;
  }

  now() {
    return this.scheduledTime ?? this.ctx?.currentTime ?? 0;
  }

  withScheduledTime(time, fn) {
    const prev = this.scheduledTime;
    this.scheduledTime = time == null ? null : Math.max(this.ctx?.currentTime ?? 0, time);
    try {
      return fn();
    } finally {
      this.scheduledTime = prev;
    }
  }

  setProfile(profile) {
    this.profile = profile || DEFAULT_ENGINE_PROFILE;
  }

  _soundModeMasterGain() {
    const volume = this.soundMode?.volume;
    return volume == null ? 1 : Math.max(0, Math.min(1, (volume + 1) / 16));
  }

  _soundModeNoiseDacRate() {
    const rates = [32768, 65536, 131072, 262144];
    const dac = this.soundMode?.dacConfig ?? 10;
    return rates[dac % rates.length];
  }

  async ensure() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  loadSamples(rom, voiceGroup) {
    this.voiceGroup = voiceGroup;
    this.rom = rom;
    this.sampleCache.clear();
    this.synthCache.clear();
    this.gbcWaveCache.clear();
    this.gbcBufferCache.clear();
  }

  setSynthMode(mode = 'rom', instIdx = null) {
    if (!SYNTH_PRESETS[mode]) return this.synthDebugState(`unknown synth mode "${mode}"`);
    if (instIdx == null || instIdx === 'global') {
      this.synthMode = mode;
    } else {
      this.synthInstrumentModes.set(Number(instIdx), mode);
    }
    this.synthCache.clear();
    this.gbcWaveCache.clear();
    this.gbcBufferCache.clear();
    return this.synthDebugState('changes apply to newly-triggered synth notes; restart the song for a clean A/B');
  }

  clearSynthMode(instIdx = null) {
    if (instIdx == null || instIdx === 'global') {
      this.synthMode = 'rom';
      this.synthInstrumentModes.clear();
    } else {
      this.synthInstrumentModes.delete(Number(instIdx));
    }
    this.synthCache.clear();
    this.gbcWaveCache.clear();
    this.gbcBufferCache.clear();
    return this.synthDebugState('synth override cleared');
  }

  synthDebugState(message = '') {
    return {
      message,
      profile: this.profile?.id || DEFAULT_ENGINE_PROFILE.id,
      global: this.synthMode,
      presets: Object.fromEntries(Object.entries(SYNTH_PRESETS).map(([k, v]) => [k, v.label])),
      instrumentOverrides: Object.fromEntries(this.synthInstrumentModes),

      romSynthPeriodRule: `legacy tiny-loop synth override: <=64 bytes can use a ${ROM_SYNTH_EFFECTIVE_PERIOD}-sample effective pitch period; Camelot rawLoopEnd=0 entries use procedural PWM/saw/triangle synth`,
      romSynthDcCenter: ROM_SYNTH_DC_CENTER,
      gbcModel: {
        apuClock: DMG_APU_CLOCK,
        frameSequencerHz: DMG_FRAME_SEQUENCER_HZ,
        pulseCore: '8-step DMG pulse timer: freqReg=round(2048 - 131072/Hz), period=(2048-freqReg)*4 CPU cycles',
        waveCore: '32-sample CGB wave channel timer: freqReg=round(2048 - 65536/Hz), period=(2048-freqReg)*2 CPU cycles',
        dacBits: GBC_DAC_BITS,
        waveDacLevels: GBC_WAVE_DAC_LEVELS,
        envelope: `${GBC_ENVELOPE_HZ}Hz stepped volume for converted GBC voices`,
        sweep: 'SOUND1 sweep is applied when CC/PSG writes provide NR10/REG_SOUND1CNT_L',
        length: 'hardware length counters are applied when CC/PSG writes set the NRx4 length-enable bit',
      },
    };
  }

  getBuffer(sptr) {
    if (this.sampleCache.has(sptr)) return this.sampleCache.get(sptr);
    const s = parseSample(this.rom, sptr);
    if (!s || s.data.length === 0) return null;

    const bufferSampleHz = Math.max(3000, Math.min(768000, s.sampleHz || GBA_MIX_RATE));
    const buf = this.ctx.createBuffer(1, s.data.length, bufferSampleHz);
    const ch = buf.getChannelData(0);
    const raw = s.data;
    for (let i = 0; i < raw.length; i++) {
      const b = raw[i];
      ch[i] = (b >= 128 ? b - 256 : b) / 128.0;
    }
    this.sampleCache.set(sptr, { buf, rate: s.rate, sampleHz: s.sampleHz, bufferSampleHz, loopStart: s.loopStart, loopEnd: s.loopEnd, rawLoopEnd: s.rawLoopEnd, looped: s.looped, sampleMode: s.sampleMode, gamefreakCompressed: s.gamefreakCompressed });
    return this.sampleCache.get(sptr);
  }

  _mulHigh32(a, b) {
    return Number((BigInt(a >>> 0) * BigInt(b >>> 0)) >> 32n) >>> 0;
  }

  _pitchTableValue(note) {
    // Compute the MP2k fixed-point pitch table value mathematically.
    // pitchValue(60) = 2^22; pitchValue(n) = 2^((n-60)/12 + 22).
    // This gives rawRate = step/sampleHz = 2.0 at unity (note == keyAdj), matching ARM behavior.
    const clamped = Math.max(0, Math.min(0xb3, note | 0));
    return (Math.pow(2, (clamped - 60) / 12 + 22) + 0.5) >>> 0;
  }

  _armPitchStep(sampleRateRaw, pitchMidi) {
    let note = Math.floor(pitchMidi);
    let frac = Math.round((pitchMidi - note) * 256);
    while (frac < 0) { note--; frac += 256; }
    while (frac > 255) { note++; frac -= 256; }
    if (note > 0xb2) {
      note = 0xb2;
      frac = 0xff;
    }
    if (note < 0) {
      note = 0;
      frac = 0;
    }
    const a = this._pitchTableValue(note);
    const b = this._pitchTableValue(note + 1);
    const interp = this._mulHigh32((b - a) >>> 0, (frac << 24) >>> 0);
    const pitch = (a + interp) >>> 0;
    const step = this._mulHigh32(sampleRateRaw >>> 0, pitch);
    return { step, note, frac, pitch };
  }

  _synthModeFor(sampleInfo) {
    return this.synthInstrumentModes.get(sampleInfo.instrumentIndex) || this.synthMode || 'rom';
  }

  _synthModeSourceFor(sampleInfo) {
    if (this.synthInstrumentModes.has(sampleInfo.instrumentIndex)) return 'instrument override';
    return 'global';
  }

  _romSynthEffectivePeriod(sampleInfo, loopLen) {
    if (
      sampleInfo?.looped &&
      sampleInfo.rawLoopEnd === 0 &&
      loopLen > 0 &&
      loopLen <= ROM_SYNTH_TINY_LOOP_MAX
    ) {
      return ROM_SYNTH_EFFECTIVE_PERIOD;
    }
    return loopLen;
  }

  _isGbcSynthMode(mode) {
    return !!SYNTH_PRESETS[mode]?.gbc;
  }

  _noteFrequency(pitchMidi, tuneSemis = 0) {
    return 440 * Math.pow(2, (pitchMidi - 69 + tuneSemis) / 12);
  }

  _psgAdjustedNote(pitchMidi, keyAdj, tuneSemis = 0) {
    if (this.profile.cgbPitchUsesPlayedKey) return pitchMidi + tuneSemis;
    return pitchMidi - keyAdj + 60 + tuneSemis;
  }

  _psgNoteFrequency(pitchMidi, keyAdj, tuneSemis = 0) {
    return this._noteFrequency(this._psgAdjustedNote(pitchMidi, keyAdj, tuneSemis), 0);
  }

  _splitNoteFraction(noteFloat) {
    let note = Math.floor(noteFloat);
    let frac = Math.round((noteFloat - note) * 256);
    while (frac < 0) { note--; frac += 256; }
    while (frac > 255) { note++; frac -= 256; }
    return { note, frac };
  }

  _psgPitchWord(type, note, frac = 0) {
    // Compute GBC frequency register from MP2k PSG note index mathematically.
    // Generic MP2K transposes by tone key; Pokemon's CGB path uses the played key.
    if (type === 4) {
      // Noise: note index → NR43 byte, verbatim from the MP2k PSG noise table.
      // Higher note = smaller NR43 = higher frequency noise.
      // Source: ARM sPsgNoise[] table (Pokemon Emerald / standard MP2k).
      if (note <= 0x14) return 0;
      const idx = Math.max(0, Math.min(0x3b, (note - 0x15) | 0));
      const PSG_NOISE_TABLE = [
        0xD7,0xD6,0xD5,0xD4, 0xC7,0xC6,0xC5,0xC4,
        0xB7,0xB6,0xB5,0xB4, 0xA7,0xA6,0xA5,0xA4,
        0x97,0x96,0x95,0x94, 0x87,0x86,0x85,0x84,
        0x77,0x76,0x75,0x74, 0x67,0x66,0x65,0x64,
        0x57,0x56,0x55,0x54, 0x47,0x46,0x45,0x44,
        0x37,0x36,0x35,0x34, 0x27,0x26,0x25,0x24,
        0x18,0x17,0x16,0x15, 0x14,0x08,0x07,0x06,
        0x05,0x04,0x03,0x02,
      ];
      return PSG_NOISE_TABLE[idx] ?? 0;
    }
    const isWave = type === 3;
    const numerator = isWave ? 65536 : 131072;
    const noteF = Math.max(0, note + (frac | 0) / 256);
    const hz = 261.6255 * Math.pow(2, (noteF - 60) / 12);
    return Math.max(0, Math.min(2047, Math.round(2048 - numerator / Math.max(1, hz))));
  }

  _psgQuantFromEngine(type, pitchMidi, keyAdj, tuneSemis = 0) {
    if (!type) return null;
    const adjusted = this._psgAdjustedNote(pitchMidi, keyAdj, tuneSemis);
    const { note, frac } = this._splitNoteFraction(adjusted);
    const word = this._psgPitchWord(type, note, frac);
    if (word == null) return null;
    if (type === 4) {
      return {
        ...this._gbcQuantizeNoise(word & 0xff),
        note,
        noteFrac: frac,
        registerSource: 'ARM Func_facf8 PSG noise table',
      };
    }

    const isWave = type === 3;
    const numerator = isWave ? 65536 : 131072;
    const freqReg = word & 0x7ff;
    return this._gbcQuantFromRegister(type, freqReg, isWave ? 'wave' : 'pulse', {
      note,
      noteFrac: frac,
      registerSource: 'ARM Func_facf8 PSG pitch table',
    });
  }

  _gbcQuantFromRegister(type, freqReg, channel, extra = {}) {
    const isWave = channel === 'wave';
    const numerator = isWave ? 65536 : 131072;
    const fixedReg = Math.max(0, Math.min(2047, freqReg | 0));
    const divisor = Math.max(1, 2048 - fixedReg);
    return {
      ...extra,
      targetFrequency: numerator / divisor,
      frequencyRegister: fixedReg,
      actualFrequency: numerator / divisor,
      timerPeriodCycles: divisor * (isWave ? 2 : 4),
      stepsPerCycle: isWave ? 32 : 8,
      channel,
    };
  }

  _applyCgbFixQuant(type, entry, quant) {
    if (!quant || type >= 4 || !(entry?.typeB & 0x08) || quant.frequencyRegister == null) return quant;
    const fixedReg = (quant.frequencyRegister + 2) & 0x7fc;
    return this._gbcQuantFromRegister(type, fixedReg, quant.channel, {
      ...quant,
      rawFrequencyRegister: quant.frequencyRegister,
      registerSource: `${quant.registerSource || 'computed note pitch'} + CGB FIX`,
    });
  }

  _gbcDac(level) {
    const q = Math.max(0, Math.min(15, Math.round(level)));
    return this.profile.gbaDacNegativeSlope ? 1 - (q / 15) * 2 : (q / 15) * 2 - 1;
  }

  _gbcWaveTable(mode) {
    if (mode === 'triangle') {
      return Array.from({ length: 32 }, (_, i) => {
        const phase = i / 32;
        return Math.round((1 - Math.abs(phase * 2 - 1)) * 15);
      });
    }
    if (mode === 'sine') {
      return Array.from({ length: 32 }, (_, i) => {
        const s = Math.sin((i / 32) * Math.PI * 2);
        return Math.round((s * 0.5 + 0.5) * 15);
      });
    }
    return null;
  }

  _waveTableFromRomPtr(ptr) {
    if (!this.rom || (ptr >>> 24) !== 8) return null;
    const off = ptr & 0x1ffffff;
    if (off + 16 > this.rom.data.length) return null;
    const table = [];
    for (let i = 0; i < 16; i++) {
      const byte = this.rom.u8(off + i);
      table.push((byte >>> 4) & 0x0f, byte & 0x0f);
    }
    return table;
  }

  _waveTableFromPsgRegs(psgState, baseTable = null) {
    const regs = psgState?.regs || {};
    let found = false;
    const table = [];
    for (let i = 0; i < 16; i++) {
      const off = 0x90 + i;
      const rel = 0x30 + i;
      const byte = Object.prototype.hasOwnProperty.call(regs, off)
        ? regs[off]
        : Object.prototype.hasOwnProperty.call(regs, rel)
        ? regs[rel]
        : null;
      if (byte == null) {
        table.push(baseTable?.[i * 2] ?? 0, baseTable?.[i * 2 + 1] ?? 0);
      } else {
        found = true;
        table.push((byte >>> 4) & 0x0f, byte & 0x0f);
      }
    }
    return found ? table : null;
  }

  _psgReg(psgState, offset, fallback = null) {
    const regs = psgState?.regs || {};
    const a = offset & 0xff;
    const b = (offset - GBA_SOUND_REG_BASE) & 0xff;
    if (Object.prototype.hasOwnProperty.call(regs, a)) return regs[a];
    if (Object.prototype.hasOwnProperty.call(regs, b)) return regs[b];
    return fallback;
  }

  _dutyPatternFromCode(code) {
    const patterns = [
      SYNTH_PRESETS.pulse12.dutyPattern,
      SYNTH_PRESETS.pulse25.dutyPattern,
      SYNTH_PRESETS.pulse50.dutyPattern,
      SYNTH_PRESETS.pulse75.dutyPattern,
    ];
    return patterns[Math.max(0, Math.min(3, code | 0))];
  }

  _gbcModeConfig(mode, options = {}) {
    const type = options.type || 0;
    const entry = options.entry || null;
    const psgState = options.psgState || null;
    const preset = SYNTH_PRESETS[mode] || {};
    const hiOffsets = { 1: 0x65, 2: 0x6d, 3: 0x75, 4: 0x7d };
    const hiOffset = hiOffsets[type] ?? -1;
    const hiReg = type ? this._psgReg(psgState, hiOffset, null) : null;
    const lastWrite = psgState?.lastWrite || null;
    const lastOff = lastWrite ? (lastWrite.absoluteOffset ?? lastWrite.offset) & 0xff : -1;
    const triggerWrite = hiOffset >= 0 && lastWrite && (lastOff === hiOffset || lastOff === ((hiOffset - GBA_SOUND_REG_BASE) & 0xff)) && !!(lastWrite.value & 0x80);
    const config = {
      channel: mode === 'triangle' || mode === 'sine' || type === 3 ? 'wave' : 'pulse',
      dutyPattern: preset.dutyPattern || SYNTH_PRESETS.pulse50.dutyPattern,
      waveTable: this._gbcWaveTable(mode),
      waveVolumeScale: 1,
      waveInvertOutput: false,
      noise: false,
      noiseWidth7: false,
      noiseShift: 0,
      noiseDivisorCode: 0,
      noiseControl: 0,
      trigger: !!triggerWrite,
      lengthEnabled: !!((hiReg ?? 0) & 0x40),
      source: 'preset',
    };

    if (type === 1 || type === 2) {
      const regLo = type === 1
        ? this._psgReg(psgState, 0x62, null)
        : this._psgReg(psgState, 0x68, null);
      const dutyCode = regLo == null ? ((entry?.sptr ?? 2) & 3) : ((regLo >>> 6) & 3);
      config.channel = 'pulse';
      config.dutyPattern = this._dutyPatternFromCode(dutyCode);
      config.dutyCode = dutyCode;
      config.source = regLo == null ? 'voice ptr duty' : 'CC/GBA duty register';
    } else if (type === 3) {
      config.channel = 'wave';
      const waveEnable = this._psgReg(psgState, 0x70, null);
      const waveLevel = this._psgReg(psgState, 0x73, null);
      const volumeCode = waveLevel == null ? 1 : ((waveLevel >>> 5) & 3);
      const forceVolume = !!((waveLevel ?? 0) & 0x80);
      const liveWave = this._waveTableFromPsgRegs(psgState, options.waveTableBase || null);
      config.waveTable = liveWave || this._waveTableFromRomPtr(entry?.sptr || 0) || config.waveTable || this._gbcWaveTable('triangle');
      config.waveVolumeScale = waveEnable != null && !(waveEnable & 0x80)
        ? 0
        : forceVolume ? 0.75 : ([0, 1, 0.5, 0.25][volumeCode] ?? 1);
      config.waveVolumeCode = volumeCode;
      config.waveDacEnabled = waveEnable == null ? true : !!(waveEnable & 0x80);
      config.waveInvertOutput = !!this.profile.gbaWaveChannelInverts;
      config.source = liveWave ? 'CC/GBA wave RAM register' : ((entry?.sptr >>> 24) === 8 ? 'voice ptr wave RAM' : 'fallback wave table');
    } else if (type === 4) {
      const reg = this._psgReg(psgState, 0x7c, ((entry?.sptr || 0) << 3) & 0xff);
      config.channel = 'noise';
      config.noise = true;
      config.noiseControl = reg & 0xff;
      config.noiseDivisorCode = reg & 7;
      config.noiseWidth7 = !!(reg & 8);
      config.noiseShift = (reg >>> 4) & 0x0f;
      config.noiseDacRate = this._soundModeNoiseDacRate();
      config.source = this._psgReg(psgState, 0x7c, null) == null ? 'voice ptr noise control' : 'CC/GBA noise register';
    }

    return config;
  }

  _psgEnvelopeConfig(type, psgState, entry = null) {
    const envOffsets = { 1: 0x63, 2: 0x69, 4: 0x79 };
    const reg = this._psgReg(psgState, envOffsets[type] ?? -1, null);
    if (reg == null) {
      if (type === 1 || type === 2 || type === 4) {
        const initialVolume = Math.max(0, Math.min(15, entry?.S ?? 15));
        return {
          register: null,
          initialVolume,
          direction: -1,
          period: 0,
          source: 'voice ADSR sustain nibble as fixed PSG volume',
        };
      }
      return null;
    }
    return {
      register: reg & 0xff,
      initialVolume: (reg >>> 4) & 0x0f,
      direction: (reg & 0x08) ? 1 : -1,
      period: reg & 0x07,
      source: 'CC/GBA envelope register',
    };
  }

  _pokemonCgbEnvelopeGoal(volume, velocity, panOffset = 0) {
    const vol = Math.max(0, Math.min(255, volume | 0));
    const vel = Math.max(0, Math.min(255, velocity | 0));
    const pan = Math.max(-128, Math.min(127, panOffset | 0));
    const x = (vol * 127) >> 5; // default volX is 127
    const volMR = ((pan + 128) * x) >> 8;
    const volML = ((127 - pan) * x) >> 8;
    const right = Math.min(255, (((pan + 128) * vel * volMR) >> 14));
    const left = Math.min(255, (((127 - pan) * vel * volML) >> 14));
    return Math.max(0, Math.min(15, Math.floor((left + right) / 16)));
  }

  _makeAutomationParam(initialValue) {
    return {
      value: initialValue,
      events: [],
      setValueAtTime(value, time) {
        this.events.push({ time, value });
        this.events.sort((a, b) => a.time - b.time);
        if (time <= this.contextTime?.()) this.value = value;
      },
      cancelScheduledValues(time) {
        this.events = this.events.filter(ev => ev.time < time);
      },
      valueAt(time) {
        let value = this.value;
        for (const ev of this.events) {
          if (ev.time > time) break;
          value = ev.value;
        }
        return value;
      },
      contextTime: null,
    };
  }

  _schedulePsgSourceEnvelope(levelParam, now, entry, envelope = null, retrigger = true, maxLevel = 15) {
    if (!levelParam) return 15;
    const peak = Math.max(0, Math.min(15, Math.round(maxLevel)));
    const set = (level, time) => levelParam.setValueAtTime(Math.max(0, Math.min(15, Math.round(level))), time);
    levelParam.cancelScheduledValues(now);

    if (envelope?.register != null) {
      let level = Math.max(0, Math.min(peak, envelope.initialVolume | 0));
      if (retrigger) set(level, now);
      const period = envelope.period || 0;
      if (period > 0) {
        const stepSec = period / GBC_ENVELOPE_HZ;
        for (let i = 1; i <= 15; i++) {
          level += envelope.direction > 0 ? 1 : -1;
          if (level < 0 || level > 15) break;
          set(level, now + i * stepSec);
        }
      }
      return level;
    }

    const A = entry?.A ?? 0;
    const D = entry?.D ?? 0;
    const S = entry?.S ?? 15;
    const sustain = Math.min(peak, Math.round(peak * (Math.max(0, Math.min(15, S & 0x0f)) / 15)));
    const attackPeriod = A & 0x07;
    const decayPeriod = D & 0x07;
    let t = now;
    let level = A > 0 ? 0 : peak;
    if (retrigger) set(level, now);

    if (A > 0) {
      const stepSec = (attackPeriod || 8) / GBC_ENVELOPE_HZ;
      for (level = 1; level <= peak; level++) {
        t = now + level * stepSec;
        set(level, t);
      }
      level = peak;
    }

    if (D > 0 && sustain < level) {
      const stepSec = (decayPeriod || 8) / GBC_ENVELOPE_HZ;
      const start = t || now;
      let step = 1;
      while (level > sustain) {
        level--;
        set(level, start + step * stepSec);
        step++;
      }
    }

    return level;
  }

  _psgSweepConfig(type, psgState, entry = null) {
    if (type !== 1) return null;
    const reg = this._psgReg(psgState, 0x60, entry?.panSweep ?? entry?.p3 ?? null);
    if (reg == null) return null;
    const period = (reg >>> 4) & 0x07;
    const shift = reg & 0x07;
    return {
      register: reg & 0xff,
      period,
      effectivePeriod: period || 8,
      direction: (reg & 0x08) ? -1 : 1,
      shift,
      enabled: period > 0 || shift > 0,
      clockHz: 128,
      source: this._psgReg(psgState, 0x60, null) == null ? 'voice pan/sweep byte' : 'CC/GBA SOUND1 sweep register',
    };
  }

  _psgLengthConfig(type, psgState) {
    const lenOffsets = { 1: 0x62, 2: 0x68, 3: 0x72, 4: 0x78 };
    const hiOffsets = { 1: 0x65, 2: 0x6d, 3: 0x75, 4: 0x7d };
    const lenReg = this._psgReg(psgState, lenOffsets[type] ?? -1, null);
    const hiReg = this._psgReg(psgState, hiOffsets[type] ?? -1, null);
    if (lenReg == null && hiReg == null) return null;
    const isWave = type === 3;
    const rawLength = isWave ? (lenReg ?? 0) : ((lenReg ?? 0) & 0x3f);
    const maxLength = isWave ? 256 : 64;
    const lengthTicks = rawLength === 0 ? maxLength : Math.max(0, maxLength - rawLength);
    return {
      lengthRegister: lenReg == null ? null : lenReg & 0xff,
      controlRegister: hiReg == null ? null : hiReg & 0xff,
      enabled: !!((hiReg ?? 0) & 0x40),
      trigger: !!((hiReg ?? 0) & 0x80),
      rawLength,
      maxLength,
      lengthTicks,
      seconds: lengthTicks / 256,
      clockHz: 256,
      source: 'CC/GBA length register',
    };
  }

  _psgFrequencyFromRegs(type, psgState, fallbackHz = 440) {
    const regOffsets = {
      1: [0x64, 0x65, 131072, 'pulse'],
      2: [0x6c, 0x6d, 131072, 'pulse'],
      3: [0x74, 0x75, 65536, 'wave'],
    };
    const map = regOffsets[type];
    if (!map) return null;
    const [loOff, hiOff, numerator, channel] = map;
    const lo = this._psgReg(psgState, loOff, null);
    const hi = this._psgReg(psgState, hiOff, null);
    if (lo == null && hi == null) return null;
    const fallbackReg = Math.max(0, Math.min(2047, Math.round(2048 - numerator / Math.max(1, fallbackHz))));
    const freqReg = ((lo ?? (fallbackReg & 0xff)) | (((hi ?? (fallbackReg >>> 8)) & 0x07) << 8)) & 0x7ff;
    const divisor = Math.max(1, 2048 - freqReg);
    return {
      frequencyRegister: freqReg,
      actualFrequency: numerator / divisor,
      timerPeriodCycles: divisor * (channel === 'wave' ? 2 : 4),
      stepsPerCycle: channel === 'wave' ? 32 : 8,
      channel,
      registerSource: 'CC/GBA frequency register',
    };
  }

  _gbcQuantizeFrequency(mode, targetHz) {
    const hz = Math.max(1, Math.min(131072, targetHz || 440));
    const isWave = mode === 'triangle' || mode === 'sine';
    const numerator = isWave ? 65536 : 131072;
    const freqReg = Math.max(0, Math.min(2047, Math.round(2048 - numerator / hz)));
    return { ...this._gbcQuantFromRegister(isWave ? 3 : 1, freqReg, isWave ? 'wave' : 'pulse'), targetFrequency: hz };
  }

  _gbcQuantizeNoise(control) {
    const divisorCode = control & 7;
    const divisor = divisorCode === 0 ? 8 : divisorCode * 16;
    const shift = (control >>> 4) & 0x0f;
    const timerPeriodCycles = Math.max(8, divisor << shift);
    return {
      targetFrequency: DMG_APU_CLOCK / timerPeriodCycles,
      frequencyRegister: control & 0xff,
      actualFrequency: DMG_APU_CLOCK / timerPeriodCycles,
      timerPeriodCycles,
      stepsPerCycle: 1,
      channel: 'noise',
    };
  }

  _applyNoiseControlConfig(config, control, source = null) {
    if (!config?.noise) return config;
    config.noiseControl = control & 0xff;
    config.noiseDivisorCode = control & 7;
    config.noiseWidth7 = !!(control & 8);
    config.noiseShift = (control >>> 4) & 0x0f;
    if (source) config.source = source;
    return config;
  }

  _renderGbcApuBuffer(mode, quant, config = {}) {
    const pattern = config.dutyPattern || SYNTH_PRESETS[mode]?.dutyPattern || SYNTH_PRESETS.pulse50.dutyPattern;
    const waveTable = config.waveTable || this._gbcWaveTable(mode);
    const fullCycleCycles = quant.timerPeriodCycles * quant.stepsPerCycle;
    const cyclesToRender = Math.max(fullCycleCycles * 32, DMG_APU_CLOCK * 0.18);
    const len = Math.max(256, Math.round(cyclesToRender / (DMG_APU_CLOCK / GBA_MIX_RATE)));
    const buf = this.ctx.createBuffer(1, len, GBA_MIX_RATE);
    const ch = buf.getChannelData(0);
    const cyclesPerSample = DMG_APU_CLOCK / GBA_MIX_RATE;
    let timerCycles = 0;
    let step = 0;
    let lfsr = 0x7fff;
    for (let i = 0; i < len; i++) {
      let level;
      if (config.noise) {
        let remainingCycles = cyclesPerSample;
        let accumLevel = 0;
        while (remainingCycles > 0) {
          const cyclesToEdge = Math.max(0, quant.timerPeriodCycles - timerCycles);
          const segmentCycles = Math.min(remainingCycles, cyclesToEdge || quant.timerPeriodCycles);
          accumLevel += ((lfsr & 1) ? 0 : 15) * segmentCycles;
          timerCycles += segmentCycles;
          remainingCycles -= segmentCycles;
          while (timerCycles >= quant.timerPeriodCycles) {
            timerCycles -= quant.timerPeriodCycles;
            const bit = (lfsr ^ (lfsr >>> 1)) & 1;
            lfsr = (lfsr >>> 1) | (bit << 14);
            if (config.noiseWidth7) lfsr = (lfsr & ~0x40) | (bit << 6);
          }
        }
        level = accumLevel / cyclesPerSample;
      } else {
        level = waveTable ? waveTable[step & 31] : (pattern[step & 7] ? 15 : 0);
      }
      ch[i] = this._gbcDac(level) * (config.channel === 'wave' && config.waveInvertOutput ? -0.78 : 0.78);
      if (config.noise) continue;
      timerCycles += cyclesPerSample;
      while (timerCycles >= quant.timerPeriodCycles) {
        timerCycles -= quant.timerPeriodCycles;
        if (config.noise) {
          const bit = (lfsr ^ (lfsr >>> 1)) & 1;
          lfsr = (lfsr >>> 1) | (bit << 14);
          if (config.noiseWidth7) lfsr = (lfsr & ~0x40) | (bit << 6);
        } else {
          step = (step + 1) % quant.stepsPerCycle;
        }
      }
    }
    return buf;
  }

  _makeLiveApuSource(mode, quant, config) {
    const processor = this.ctx.createScriptProcessor(512, 0, 1);
    const levelParam = this._makeAutomationParam(config.outputLevel ?? 15);
    levelParam.contextTime = () => processor.context.currentTime;
    const state = {
      active: false,
      startTime: 0,
      stopTime: Infinity,
      quant: { ...quant },
      config: {
        ...config,
        dutyPattern: [...(config.dutyPattern || SYNTH_PRESETS.pulse50.dutyPattern)],
        waveTable: config.waveTable ? [...config.waveTable] : null,
      },
      timerCycles: 0,
      step: 0,
      lfsr: 0x7fff,
      noiseDacRemainder: 0,
      noiseHeldLevel: 0,
    };
    const playbackRate = {
      value: 1,
      events: [],
      setValueAtTime(value, time) {
        this.events.push({ time, value });
        this.events.sort((a, b) => a.time - b.time);
        if (time <= processor.context.currentTime) this.value = value;
      },
      cancelScheduledValues(time) {
        this.events = this.events.filter(ev => ev.time < time);
      },
      valueAt(time) {
        let value = this.value;
        for (const ev of this.events) {
          if (ev.time > time) break;
          value = ev.value;
        }
        return value;
      },
    };

    processor.onaudioprocess = event => {
      const out = event.outputBuffer.getChannelData(0);
      const sampleRate = event.outputBuffer.sampleRate;
      const cyclesPerSample = DMG_APU_CLOCK / sampleRate;
      const baseTime = event.playbackTime ?? processor.context.currentTime;
      for (let i = 0; i < out.length; i++) {
        const t = baseTime + i / sampleRate;
        if (!state.active || t < state.startTime || t >= state.stopTime) {
          out[i] = 0;
          continue;
        }
        const cfg = state.config;
        const quantNow = state.quant;
        const outputLevel = Math.max(0, Math.min(15, levelParam.valueAt(t)));
        let level;
        if (cfg.noise) {
          const rate = Math.max(0.001, playbackRate.valueAt(t));
          const periodCycles = Math.max(1, quantNow.timerPeriodCycles / rate);
          const noiseDacRate = Math.max(1, cfg.noiseDacRate || sampleRate);
          const cyclesPerDacSample = DMG_APU_CLOCK / noiseDacRate;
          let dacTicks = state.noiseDacRemainder + noiseDacRate / sampleRate;
          const wholeTicks = Math.floor(dacTicks);
          state.noiseDacRemainder = dacTicks - wholeTicks;
          let sampleSum = 0;
          for (let tick = 0; tick < wholeTicks; tick++) {
            let remainingCycles = cyclesPerDacSample;
            let accumLevel = 0;
            while (remainingCycles > 0) {
              const cyclesToEdge = Math.max(0, periodCycles - state.timerCycles);
              const segmentCycles = Math.min(remainingCycles, cyclesToEdge || periodCycles);
              accumLevel += ((state.lfsr & 1) ? 0 : outputLevel) * segmentCycles;
              state.timerCycles += segmentCycles;
              remainingCycles -= segmentCycles;
              while (state.timerCycles >= periodCycles) {
                state.timerCycles -= periodCycles;
                const bit = (state.lfsr ^ (state.lfsr >>> 1)) & 1;
                state.lfsr = (state.lfsr >>> 1) | (bit << 14);
                if (cfg.noiseWidth7) state.lfsr = (state.lfsr & ~0x40) | (bit << 6);
              }
            }
            state.noiseHeldLevel = accumLevel / cyclesPerDacSample;
            sampleSum += state.noiseHeldLevel;
          }
          level = wholeTicks > 0 ? sampleSum / wholeTicks : state.noiseHeldLevel;
          out[i] = outputLevel <= 0 ? 0 : this._gbcDac(level) * 0.78;
          continue;
        } else if (cfg.channel === 'wave') {
          const table = cfg.waveTable || this._gbcWaveTable('triangle');
          level = (table[state.step & 31] ?? 0) * (cfg.waveVolumeScale ?? 1) * (outputLevel / 15);
        } else {
          const pattern = cfg.dutyPattern || SYNTH_PRESETS.pulse50.dutyPattern;
          level = pattern[state.step & 7] ? outputLevel : 0;
        }
        out[i] = outputLevel <= 0 && cfg.channel !== 'wave' ? 0 : this._gbcDac(level) * (cfg.channel === 'wave' && cfg.waveInvertOutput ? -0.78 : 0.78);

        const rate = Math.max(0.001, playbackRate.valueAt(t));
        const periodCycles = Math.max(1, quantNow.timerPeriodCycles / rate);
        state.timerCycles += cyclesPerSample;
        while (state.timerCycles >= periodCycles) {
          state.timerCycles -= periodCycles;
          if (cfg.noise) {
            const bit = (state.lfsr ^ (state.lfsr >>> 1)) & 1;
            state.lfsr = (state.lfsr >>> 1) | (bit << 14);
            if (cfg.noiseWidth7) state.lfsr = (state.lfsr & ~0x40) | (bit << 6);
          } else {
            state.step = (state.step + 1) % quantNow.stepsPerCycle;
          }
        }
      }
    };

    return {
      playbackRate,
      apuLevel: levelParam,
      apuState: state,
      connect: dest => processor.connect(dest),
      disconnect: () => processor.disconnect(),
      start: time => {
        state.active = true;
        state.startTime = time ?? processor.context.currentTime;
      },
      stop: time => {
        state.stopTime = Math.min(state.stopTime, time ?? processor.context.currentTime);
        const delayMs = Math.max(0, (state.stopTime - processor.context.currentTime + 0.05) * 1000);
        window.setTimeout(() => {
          try { processor.disconnect(); } catch (_) {}
        }, delayMs);
      },
      apuUpdate: (nextQuant, nextConfig) => {
        state.quant = { ...state.quant, ...nextQuant };
        if (nextConfig) {
          const wasNoise = !!state.config.noise;
          const nextIsNoise = !!nextConfig.noise;
          const controlChanged = nextConfig.noiseControl != null && nextConfig.noiseControl !== state.config.noiseControl;
          const triggered = !!nextConfig.trigger;
          state.config = {
            ...state.config,
            ...nextConfig,
            dutyPattern: nextConfig.dutyPattern ? [...nextConfig.dutyPattern] : state.config.dutyPattern,
            waveTable: nextConfig.waveTable ? [...nextConfig.waveTable] : state.config.waveTable,
          };
          if (triggered || nextIsNoise && (!wasNoise || controlChanged)) {
            state.lfsr = 0x7fff;
            state.timerCycles = 0;
            state.step = 0;
          }
        }
      },
    };
  }

  _gbcModelFor(mode, quant = null, config = null, envelope = null, sweep = null, length = null) {
    const preset = SYNTH_PRESETS[mode] || {};
    return {
      mode,
      apuClock: DMG_APU_CLOCK,
      frameSequencerHz: DMG_FRAME_SEQUENCER_HZ,
      channel: config?.channel || quant?.channel || (mode === 'triangle' || mode === 'sine' ? 'wave' : 'pulse'),
      targetFrequency: quant?.targetFrequency || 0,
      frequencyRegister: quant?.frequencyRegister ?? null,
      rawFrequencyRegister: quant?.rawFrequencyRegister ?? null,
      actualFrequency: quant?.actualFrequency || 0,
      timerPeriodCycles: quant?.timerPeriodCycles || 0,
      stepsPerCycle: quant?.stepsPerCycle || 0,
      frequencySource: quant?.registerSource || 'computed note pitch',
      dutyCode: config?.dutyCode ?? null,
      dutyPattern: (config?.dutyPattern || preset.dutyPattern || []).join(''),
      waveTable: config?.waveTable ? config.waveTable.map(v => v.toString(16)).join('') : '',
      waveVolumeScale: config?.channel === 'wave' ? config.waveVolumeScale : null,
      waveDacEnabled: config?.channel === 'wave' ? config.waveDacEnabled : null,
      waveInvertOutput: config?.channel === 'wave' ? config.waveInvertOutput : null,
      noiseControl: config?.noise ? config.noiseControl : null,
      noiseWidth7: config?.noise ? config.noiseWidth7 : null,
      noiseShift: config?.noise ? config.noiseShift : null,
      noiseDivisorCode: config?.noise ? config.noiseDivisorCode : null,
      noiseDacRate: config?.noise ? config.noiseDacRate : null,
      registerSource: config?.source || 'preset',
      dacBits: GBC_DAC_BITS,
      waveDacLevels: GBC_WAVE_DAC_LEVELS,
      envelope: envelope || '64Hz stepped volume',
      sweep: sweep || 'none: no GB sweep register exists in these GBA sample entries',
      length: length || 'none: length counter not configured',
    };
  }

  _makeGbcApuSource(mode, pitchMidi, tuneSemis, options = {}) {
    const targetFrequency = options.targetFrequency || (options.type ? this._psgNoteFrequency(pitchMidi, options.entry?.keyAdj || 60, tuneSemis) : this._noteFrequency(pitchMidi, tuneSemis));
    const config = this._gbcModeConfig(mode, options);
    const regFrequency = this._psgFrequencyFromRegs(options.type || 0, options.psgState || null, targetFrequency);
    const engineFrequency = options.type
      ? this._applyCgbFixQuant(options.type, options.entry || null, this._psgQuantFromEngine(options.type, pitchMidi, options.entry?.keyAdj || 60, tuneSemis))
      : null;
    const quant = config.noise
      ? regFrequency || engineFrequency || this._gbcQuantizeNoise(config.noiseControl)
      : regFrequency || engineFrequency || this._gbcQuantizeFrequency(config.channel === 'wave' ? 'triangle' : mode, targetFrequency);
    if (config.noise && engineFrequency && !regFrequency) {
      this._applyNoiseControlConfig(config, engineFrequency.frequencyRegister, engineFrequency.registerSource);
    }
    const src = this._makeLiveApuSource(mode, quant, config);
    const envelope = this._psgEnvelopeConfig(options.type || 0, options.psgState || null, options.entry || null);
    const sweep = this._psgSweepConfig(options.type || 0, options.psgState || null, options.entry || null);
    const length = this._psgLengthConfig(options.type || 0, options.psgState || null);
    return {
      src,
      buffer: null,
      targetFrequency,
      frequency: quant.actualFrequency,
      quant,
      model: this._gbcModelFor(mode, quant, config, envelope, sweep, length),
    };
  }

  _schedulePsgSweep(playbackRateParam, now, baseFrequency, sweep, channel, baseRegister = null) {
    if (!playbackRateParam || !sweep?.enabled || channel !== 'pulse') return null;
    const baseReg = baseRegister == null
      ? Math.max(0, Math.min(2047, Math.round(2048 - 131072 / Math.max(1, baseFrequency || 440))))
      : Math.max(0, Math.min(2047, baseRegister | 0));
    let reg = baseReg;
    let lastFrequency = 131072 / Math.max(1, 2048 - reg);
    const events = [];
    const stepSec = sweep.effectivePeriod / sweep.clockHz;
    for (let i = 1; i <= 24; i++) {
      if (sweep.shift <= 0) break;
      const delta = reg >> sweep.shift;
      reg += sweep.direction < 0 ? -delta : delta;
      if (reg < 0 || reg > 2047) {
        events.push({ time: now + i * stepSec, overflow: true, frequencyRegister: reg });
        break;
      }
      const freq = 131072 / Math.max(1, 2048 - reg);
      playbackRateParam.setValueAtTime(freq / baseFrequency, now + i * stepSec);
      events.push({ time: i * stepSec, frequencyRegister: reg, frequency: freq });
      lastFrequency = freq;
    }
    return { baseRegister: baseReg, finalRegister: reg, finalFrequency: lastFrequency, events };
  }

  applyPsgRegisterWrite(voice, psgState, write = null) {
    if (!voice || voice.released || !voice.gbcModel || !voice.hardwareType) return;
    const now = this.now();
    voice.psgState = psgState;
    const type = voice.hardwareType;
    const mode = voice.synthMode || (type === 3 ? 'triangle' : type === 4 ? 'noise' : 'pulse50');
    const config = this._gbcModeConfig(mode, { entry: voice.instrument, type, psgState, waveTableBase: voice.src.apuState?.config?.waveTable || null });
    let liveQuant = null;
    const freq = this._psgFrequencyFromRegs(type, psgState, voice.gbcTargetFrequency || voice.gbcFrequency || 440);
    if (freq && voice.src.playbackRate && voice.gbcBaseFrequency) {
      voice.gbcFrequency = freq.actualFrequency;
      voice.gbcTargetFrequency = freq.actualFrequency;
      voice.gbcModel = { ...voice.gbcModel, ...freq, frequencySource: freq.registerSource, liveFrequencyRegister: freq.frequencyRegister };
      voice.psgFrequencyLocked = true;
      voice.src.playbackRate.cancelScheduledValues(now);
      voice.src.playbackRate.setValueAtTime(1, now);
      voice.gbcBaseFrequency = freq.actualFrequency;
      liveQuant = freq;
    } else if (config.noise) {
      liveQuant = this._gbcQuantizeNoise(config.noiseControl);
    }
    if (voice.src.apuUpdate) {
      voice.src.apuUpdate(liveQuant || {}, config);
      voice.gbcModel = this._gbcModelFor(mode, liveQuant || voice.gbcModel, config,
        typeof voice.gbcModel.envelope === 'object' ? voice.gbcModel.envelope : null,
        typeof voice.gbcModel.sweep === 'object' ? voice.gbcModel.sweep : null,
        typeof voice.gbcModel.length === 'object' ? voice.gbcModel.length : null);
      if (freq) {
        voice.gbcModel = { ...voice.gbcModel, ...freq, frequencySource: freq.registerSource, liveFrequencyRegister: freq.frequencyRegister };
      }
    }

    const envelope = this._psgEnvelopeConfig(type, psgState, voice.instrument || null);
    if (envelope && voice.src?.apuLevel) {
      voice.gbcModel = { ...voice.gbcModel, envelope };
      this._schedulePsgSourceEnvelope(voice.src.apuLevel, now, voice.instrument || null, envelope, !!config.trigger, voice.psgDacMaxLevel || 15);
    } else if (envelope && voice.gainNode) {
      voice.gbcModel = { ...voice.gbcModel, envelope };
      voice.gainNode.gain.setValueAtTime(voice.volume, now);
    }

    const sweep = this._psgSweepConfig(type, psgState, voice.instrument || null);
    if (sweep && voice.src.playbackRate && voice.gbcBaseFrequency) {
      voice.gbcModel = { ...voice.gbcModel, sweep };
      const trace = this._schedulePsgSweep(voice.src.playbackRate, now, voice.gbcFrequency || voice.gbcBaseFrequency, sweep, voice.gbcModel.channel, voice.gbcModel.frequencyRegister);
      if (trace) voice.gbcSweepTrace = trace;
    }

    const length = this._psgLengthConfig(type, psgState);
    if (length) {
      voice.gbcModel = { ...voice.gbcModel, length };
      voice.hardwareLengthSec = length.enabled ? length.seconds : 0;
      if (length.enabled && length.seconds > 0) {
        try { voice.src.stop(now + length.seconds + 0.001); } catch (_) {}
      }
    }

    voice.psgLastLiveWrite = write;
  }

  _scheduleGbcEnvelope(gainParam, now, vol, sustainLvl, D, tickSec, envelope = null, retrigger = true) {
    const initialLevel = envelope?.initialVolume ?? 15;
    const sustainLevel = Math.max(0, Math.min(15, Math.round(initialLevel * (vol > 0 ? sustainLvl / vol : 0))));
    const initialGain = vol * (initialLevel / 15);
    const quantGain = level => vol * (Math.max(0, Math.min(15, level)) / 15);
    const periodTicks = envelope ? envelope.period : (D > 0 ? Math.max(1, Math.min(7, Math.round(256 / D))) : 0);
    const stepSec = periodTicks ? periodTicks / GBC_ENVELOPE_HZ : tickSec;

    if (retrigger) {
      gainParam.setValueAtTime(0, now);
      gainParam.linearRampToValueAtTime(initialGain, now + 0.001);
    } else {
      gainParam.setValueAtTime(gainParam.value, now);
    }
    if (envelope && envelope.period === 0) return initialGain;
    if (envelope && envelope.direction > 0) {
      for (let level = initialLevel + 1; level <= 15; level++) {
        gainParam.setValueAtTime(quantGain(level), now + 0.001 + (level - initialLevel) * stepSec);
      }
      return quantGain(15);
    } else if (sustainLevel < initialLevel) {
      for (let level = initialLevel - 1; level >= sustainLevel; level--) {
        const stepIdx = initialLevel - level;
        gainParam.setValueAtTime(quantGain(level), now + 0.001 + stepIdx * stepSec);
      }
    }
    return quantGain(sustainLevel);
  }

  _scheduleArmAdsrEnvelope(gainParam, now, vol, A, D, S) {
    const frameSec = 1 / AGB_EXACT_FPS;
    let level = 0;
    let t = now;
    gainParam.setValueAtTime(0, now);

    if (A <= 0) {
      return 0;
    }

    if (A >= 255) {
      level = 255;
      gainParam.setValueAtTime(vol, now + 0.001);
      t = now + frameSec;
    } else {
      for (let i = 0; i < 64 && level < 255; i++) {
        level = Math.min(255, level + A);
        gainParam.setValueAtTime(vol * (level / 255), t);
        t += frameSec;
      }
    }

    const sustainLevel = Math.max(0, Math.min(255, S));
    if (sustainLevel < 255) {
      if (D <= 0) {
        level = sustainLevel;
        gainParam.setValueAtTime(vol * (level / 255), t);
      } else {
        for (let i = 0; i < 240 && level > sustainLevel; i++) {
          level = (level * D) >> 8;
          if (level < sustainLevel) level = sustainLevel;
          gainParam.setValueAtTime(vol * (level / 255), t);
          t += frameSec;
        }
      }
    }

    const sustainGain = vol * (level / 255);
    gainParam.setValueAtTime(sustainGain, t);
    return sustainGain;
  }

  _armAdsrGainAt(elapsedSec, vol, A, D, S) {
    if (A <= 0 || vol <= 0) return 0;
    const frames = Math.max(0, Math.floor(elapsedSec * AGB_EXACT_FPS));
    const sustainLevel = Math.max(0, Math.min(255, S));
    let level = 0;
    let frame = 0;

    if (A >= 255) {
      level = 255;
      frame = 1;
    } else {
      while (frame <= frames && level < 255) {
        level = Math.min(255, level + A);
        frame++;
      }
    }

    if (frames < frame || level <= sustainLevel) {
      return vol * (level / 255);
    }

    if (sustainLevel < 255) {
      if (D <= 0) {
        level = sustainLevel;
      } else {
        while (frame <= frames && level > sustainLevel) {
          level = (level * D) >> 8;
          if (level < sustainLevel) level = sustainLevel;
          frame++;
        }
      }
    }
    return vol * (level / 255);
  }

  _scheduleArmRelease(gainParam, now, currentGain, R) {
    const frameSec = 1 / AGB_EXACT_FPS;
    gainParam.cancelScheduledValues(now);
    gainParam.setValueAtTime(currentGain, now);
    if (R <= 0) {
      gainParam.setValueAtTime(0, now + 0.001);
      return 0.005;
    }
    let gain = currentGain;
    let t = now + frameSec;
    for (let i = 0; i < 240 && gain > 0.0005; i++) {
      gain *= R / 256;
      gainParam.setValueAtTime(gain, t);
      t += frameSec;
    }
    gainParam.setValueAtTime(0, t);
    return Math.max(0.02, t - now);
  }

  _synthSample(mode, phase, loop, n) {
    if (mode === 'romArm') {
      // Signed PCM with linear interpolation, looping through the 8-byte waveform.
      // This is a manual preview mode for byte-loop experiments. Golden Sun's
      // rawLoopEnd=0 programs are handled separately by the Camelot synth path.
      const idx = Math.floor(phase) % n;
      const next = (idx + 1) % n;
      const frac = phase - Math.floor(phase);
      const a = loop[idx] >= 128 ? loop[idx] - 256 : loop[idx];
      const b = loop[next] >= 128 ? loop[next] - 256 : loop[next];
      return (a + (b - a) * frac) / 128;
    }
    if (mode === 'romInterp') {
      const idx = Math.floor(phase) % n;
      const next = (idx + 1) % n;
      const frac = phase - Math.floor(phase);
      const a = loop[idx] >= 128 ? loop[idx] - 256 : loop[idx];
      const b = loop[next] >= 128 ? loop[next] - 256 : loop[next];
      return (a + (b - a) * frac) / 128;
    }
    if (mode === 'rom') {
      const idx = Math.floor(phase) % n;
      const a = loop[idx] >= 128 ? loop[idx] - 256 : loop[idx];
      return a / 128;
    }
    if (mode === 'romBits') {
      const idx = Math.floor(phase) % n;
      return loop[idx] ? ROM_SYNTH_BIT_AMPLITUDE : -ROM_SYNTH_BIT_AMPLITUDE;
    }
    const cycle = phase - Math.floor(phase);
    if (mode.startsWith('pulse')) {
      const duty = SYNTH_PRESETS[mode]?.duty ?? 0.5;
      return cycle < duty ? 0.72 : -0.72;
    }
    if (mode === 'triangle') return (Math.abs(cycle * 4 - 2) - 1) * 0.82;
    if (mode === 'sine') return Math.sin(cycle * Math.PI * 2) * 0.82;
    return 0;
  }

  getGbaSynthBuffer(sptr, sampleInfo, rateInfo) {
    const mode = this._synthModeFor(sampleInfo);
    const freqKey = Math.round((rateInfo.foldedFreq || rateInfo.rawFreq || 0) * 10);
    const periodKey = rateInfo.effectivePeriod || 0;
    const key = `${sptr}:${sampleInfo.loopStart}:${sampleInfo.loopEnd}:${periodKey}:${freqKey}:${mode}:${sampleInfo.instrumentIndex ?? -1}`;
    if (this.synthCache.has(key)) return this.synthCache.get(key);
    const s = parseSample(this.rom, sptr);
    if (!s) return null;
    const sourceLoop = s.data.slice(sampleInfo.loopStart, sampleInfo.loopEnd);
    const effectivePeriod = mode === 'romArm' ? sourceLoop.length : (rateInfo.effectivePeriod || sourceLoop.length);
    const loop = this._renderLoopForSynthMode(mode, sourceLoop, effectivePeriod);
    const n = loop.length;
    if (n < 2) return null;
    const freq = rateInfo.rawFreq || rateInfo.foldedFreq || 440;
    const phaseStep = mode === 'romArm'
      ? Math.max(0.0001, (rateInfo.armStep || 0) / (2 * GBA_MIX_RATE))
      : mode === 'rom' || mode === 'romInterp' || mode === 'romBits'
      ? (freq * n) / GBA_MIX_RATE
      : freq / GBA_MIX_RATE;
    const phasePeriod = mode === 'rom' || mode === 'romInterp' || mode === 'romBits' || mode === 'romArm' ? n : 1;
    const samplesPerCycle = Math.max(1, Math.round(phasePeriod / phaseStep));
    const cycles = Math.max(1, Math.ceil(Math.max(512, GBA_MIX_RATE * 0.18) / samplesPerCycle));
    const len = samplesPerCycle * cycles;
    const renderPhaseStep = phasePeriod / samplesPerCycle;
    const synthBaseFreq = GBA_MIX_RATE / samplesPerCycle;

    const buf = this.ctx.createBuffer(1, len, GBA_MIX_RATE);
    const ch = buf.getChannelData(0);
    let phase = 0;
    let sum = 0;
    for (let i = 0; i < len; i++) {
      const sample = this._synthSample(mode, phase, loop, n);
      ch[i] = sample;
      sum += sample;
      phase += renderPhaseStep;
      if (phase >= phasePeriod) phase %= phasePeriod;
    }
    if (ROM_SYNTH_DC_CENTER && (mode === 'rom' || mode === 'romInterp') && sampleInfo.rawLoopEnd === 0) {
      const mean = sum / len;
      for (let i = 0; i < len; i++) ch[i] = Math.max(-1, Math.min(1, ch[i] - mean));
      buf.dcOffsetRemoved = mean;
    }
    buf.synthMode = mode;
    buf.effectivePeriod = rateInfo.effectivePeriod || n;
    buf.renderLoopLength = n;
    buf.synthBaseFreq = synthBaseFreq;
    buf.loopEnabled = true;
    this.synthCache.set(key, buf);
    return buf;
  }

  _camelotSynthKind(sampleInfo) {
    const modeByte = sampleInfo?.synthParams?.[1] ?? 2;
    if (modeByte === 0) return 'camelot-pwm';
    if (modeByte === 1) return 'camelot-saw';
    return 'camelot-tri';
  }

  _signedSynthByte(params, idx) {
    const v = params?.[idx] || 0;
    return v >= 128 ? v - 256 : v;
  }

  _camelotPwmThreshold(params, val) {
    const dutyBase = params?.[2] || 0;
    const depth = params?.[4] || 0;
    const initDuty = params?.[5] || 0;
    let threshold = ((initDuty << 24) >>> 0) + (val >>> 0);
    threshold = (threshold & 0x80000000) ? ((~threshold >>> 8) >>> 0) : (threshold >>> 8);
    threshold = (Math.imul(threshold, depth) + ((dutyBase << 24) >>> 0)) >>> 0;
    return threshold / 0x100000000;
  }

  getCamelotPwmBuffer(sptr, sampleInfo, targetFreq, renderSec) {
    const params = sampleInfo.synthParams || new Uint8Array(8);
    const dutyStep = (this._signedSynthByte(params, 3) << 24) >>> 0;
    const len = Math.max(128, Math.round(GBA_MIX_RATE * Math.max(0.1, renderSec)));
    const key = dutyStep === 0 ? `camelot:${sptr}:camelot-pwm:static` : null;
    if (key && this.synthCache.has(key)) return this.synthCache.get(key);
    const buf = this.ctx.createBuffer(1, len, GBA_MIX_RATE);
    const ch = buf.getChannelData(0);
    const phaseStep = targetFreq / GBA_MIX_RATE;
    const interframeSamples = GBA_MIX_RATE / (AGB_EXACT_FPS * CAMELOT_SYNTH_INTERFRAMES);
    let interPos = 0;
    let envInterStep = 0;
    let segPos = interframeSamples;
    let pwmPos = 0;
    let threshold = this._camelotPwmThreshold(params, 0);
    let thresholdStep = 0;

    const beginInterframe = () => {
      if (envInterStep === 0) pwmPos = (pwmPos + dutyStep) >>> 0;
      const fromThreshold = this._camelotPwmThreshold(params, pwmPos);
      const toThreshold = this._camelotPwmThreshold(params, (pwmPos + dutyStep) >>> 0);
      const delta = toThreshold - fromThreshold;
      threshold = fromThreshold + delta * (envInterStep / CAMELOT_SYNTH_INTERFRAMES);
      thresholdStep = delta / CAMELOT_SYNTH_INTERFRAMES / interframeSamples;
      segPos = 0;
    };

    for (let i = 0; i < len; i++) {
      if (segPos >= interframeSamples) {
        beginInterframe();
      }
      let sample = interPos < threshold ? 0.5 : -0.5;
      sample += 0.5 - threshold;
      ch[i] = sample;
      threshold += thresholdStep;
      segPos++;
      if (segPos >= interframeSamples) envInterStep = (envInterStep + 1) % CAMELOT_SYNTH_INTERFRAMES;
      interPos += phaseStep;
      if (interPos >= 1) interPos -= Math.floor(interPos);
    }
    buf.synthMode = 'camelot-pwm';
    buf.synthBaseFreq = targetFreq;
    buf.synthTargetFreq = targetFreq;
    buf.effectivePeriod = 64;
    buf.renderLoopLength = len;
    buf.loopEnabled = dutyStep === 0;
    if (key) this.synthCache.set(key, buf);
    return buf;
  }

  getCamelotSynthBuffer(sptr, sampleInfo, pitchMidi, tuneSemis) {
    const baseFreq = (sampleInfo.rate / 1024) / 64;
    const targetFreq = baseFreq * Math.pow(2, (pitchMidi - 60 + tuneSemis) / 12);
    const kind = this._camelotSynthKind(sampleInfo);
    const key = `camelot:${sptr}:${kind}:cycle`;
    if (this.synthCache.has(key)) return this.synthCache.get(key);
    const len = Math.max(8, Math.round(GBA_MIX_RATE / Math.max(1, baseFreq)));
    const buf = this.ctx.createBuffer(1, len, GBA_MIX_RATE);
    const ch = buf.getChannelData(0);
    const params = sampleInfo.synthParams || new Uint8Array(8);
    let pos = 0;

    const pwmThreshold = this._camelotPwmThreshold(params, 0);
    const warmupCycles = kind === 'camelot-saw' ? 4 : 0;
    const total = len * (warmupCycles + 1);
    if (kind === 'camelot-saw') {
      const fix = 0x70;
      for (let j = 0; j < total; j++) {
        const interPos = ((j + 1) % len) / len;
        const var1 = ((interPos * 256) >>> 0) - fix;
        const var2 = (((interPos * 65536) >>> 0) << 17) >>> 0;
        const var3 = (var1 - (var2 >>> 27)) | 0;
        pos = (var3 + (pos >> 1)) | 0;
        if (j >= warmupCycles * len) {
          ch[j - warmupCycles * len] = Math.max(-1, Math.min(1, pos / 256));
        }
      }
    } else {
      for (let i = 0; i < len; i++) {
        const interPos = kind === 'camelot-pwm' ? i / len : ((i + 1) % len) / len;
        let sample = 0;
        if (kind === 'camelot-pwm') {
        sample = interPos < pwmThreshold ? 0.5 : -0.5;
        sample += 0.5 - pwmThreshold;
        } else {
          sample = interPos < 0.5 ? (4 * interPos) - 1 : 3 - (4 * interPos);
        }
        ch[i] = sample;
      }
    }
    buf.synthMode = kind;
    buf.synthBaseFreq = baseFreq;
    buf.synthTargetFreq = targetFreq;
    buf.effectivePeriod = 64;
    buf.renderLoopLength = len;
    buf.loopEnabled = true;
    this.synthCache.set(key, buf);
    return buf;
  }

  _renderLoopForSynthMode(mode, sourceLoop, effectivePeriod) {
    if (mode === 'romBits') {
      const bits = [];
      for (const byte of sourceLoop) {
        for (let bit = 7; bit >= 0; bit--) bits.push((byte >> bit) & 1);
      }
      if (bits.length === 0) return sourceLoop;
      while (bits.length < effectivePeriod) bits.push(...bits.slice(0, Math.min(bits.length, effectivePeriod - bits.length)));
      return bits.slice(0, effectivePeriod);
    }

    if ((mode === 'rom' || mode === 'romInterp') && effectivePeriod > sourceLoop.length) {
      const expanded = new Uint8Array(effectivePeriod);
      for (let i = 0; i < effectivePeriod; i++) {
        if (mode === 'romInterp') {
          const pos = (i * sourceLoop.length) / effectivePeriod;
          const idx = Math.floor(pos) % sourceLoop.length;
          const next = (idx + 1) % sourceLoop.length;
          const frac = pos - Math.floor(pos);
          const a = sourceLoop[idx] >= 128 ? sourceLoop[idx] - 256 : sourceLoop[idx];
          const b = sourceLoop[next] >= 128 ? sourceLoop[next] - 256 : sourceLoop[next];
          const v = Math.max(-128, Math.min(127, Math.round(a + (b - a) * frac)));
          expanded[i] = v < 0 ? v + 256 : v;
        } else {
          expanded[i] = sourceLoop[Math.floor((i * sourceLoop.length) / effectivePeriod)];
        }
      }
      return expanded;
    }

    return sourceLoop;
  }

  _foldGbaFrequency(freq) {
    const nyquist = GBA_MIX_RATE / 2;
    if (freq <= nyquist) return freq;
    let folded = freq % GBA_MIX_RATE;
    if (folded > nyquist) folded = GBA_MIX_RATE - folded;
    return Math.max(1, folded);
  }

  _playbackRateForVoice(pitchMidi, keyAdj, tuneSemis, sampleInfo = null) {
    if (sampleInfo?.fixedPitch) return (this.soundMode?.rate || GBA_MIX_RATE) / Math.max(1, sampleInfo?.sampleHz || GBA_MIX_RATE);
    const arm = sampleInfo?.rate ? this._armPitchStep(sampleInfo.rate, pitchMidi) : null;
    const rawRate = arm ? arm.step / Math.max(1, sampleInfo.sampleHz) : 2 * Math.pow(2, (pitchMidi - keyAdj + tuneSemis) / 12);
    if (!sampleInfo || !sampleInfo.looped) return rawRate;
    const loopLen = sampleInfo.loopEnd - sampleInfo.loopStart;
    if (loopLen <= 0 || loopLen > 64) return rawRate;
    return rawRate;
  }

  _voiceRateInfo(pitchMidi, keyAdj, tuneSemis, sampleInfo = null) {
    if (sampleInfo?.fixedPitch) {
      const fixedRate = this.soundMode?.rate || GBA_MIX_RATE;
      const rawRate = fixedRate / Math.max(1, sampleInfo.sampleHz || fixedRate);
      if (!sampleInfo || !sampleInfo.looped) return { rate: rawRate, rawRate, folded: false, rawFreq: 0, foldedFreq: 0, fixedPitch: true, armStep: 0, armNote: 0, armFrac: 0 };
      const loopLen = sampleInfo.loopEnd - sampleInfo.loopStart;
      if (loopLen <= 0 || loopLen > 64) return { rate: rawRate, rawRate, folded: false, rawFreq: 0, foldedFreq: 0, loopLen, fixedPitch: true, armStep: 0, armNote: 0, armFrac: 0 };
      const effectivePeriod = this._romSynthEffectivePeriod(sampleInfo, loopLen);
      const rawFreq = fixedRate / effectivePeriod;
      const foldedFreq = this._foldGbaFrequency(rawFreq);
      return { rate: rawRate, rawRate, folded: rawFreq > GBA_MIX_RATE / 2, rawFreq, foldedFreq, loopLen, effectivePeriod, fixedPitch: true, armStep: 0, armNote: 0, armFrac: 0 };
    }
    const arm = sampleInfo?.rate ? this._armPitchStep(sampleInfo.rate, pitchMidi) : null;
    const rawRate = arm ? arm.step / Math.max(1, sampleInfo.sampleHz) : 2 * Math.pow(2, (pitchMidi - keyAdj + tuneSemis) / 12);
    if (!sampleInfo || !sampleInfo.looped) return { rate: rawRate, rawRate, folded: false, rawFreq: 0, foldedFreq: 0, armStep: arm?.step || 0, armNote: arm?.note ?? 0, armFrac: arm?.frac ?? 0 };
    const loopLen = sampleInfo.loopEnd - sampleInfo.loopStart;
    if (loopLen <= 0 || loopLen > 64) return { rate: rawRate, rawRate, folded: false, rawFreq: 0, foldedFreq: 0, loopLen, armStep: arm?.step || 0, armNote: arm?.note ?? 0, armFrac: arm?.frac ?? 0 };
    const effectivePeriod = this._romSynthEffectivePeriod(sampleInfo, loopLen);
    const rawFreq = (sampleInfo.sampleHz * rawRate) / effectivePeriod;
    const foldedFreq = this._foldGbaFrequency(rawFreq);
    return { rate: rawRate, rawRate, folded: rawFreq > GBA_MIX_RATE / 2, rawFreq, foldedFreq, loopLen, effectivePeriod, armStep: arm?.step || 0, armNote: arm?.note ?? 0, armFrac: arm?.frac ?? 0 };
  }

  triggerNote(instEntry, noteMidi, velocity, volume, panOffset, tune, pitchOffsetSemis, tickSec, durationTicks, adsr, outputNode = null, psgState = null) {
    if (!this.ctx) return null;
    const resolved = instEntry?.__resolvedVoice || resolveVoiceEntry(this.rom, instEntry, noteMidi, this.profile);
    if (!resolved) return null;
    const { entry, tableIndex, parent, pitchOffset, pitchNote } = resolved;
    const sourceNoteMidi = resolved.noteMidi ?? noteMidi;
    const { type, keyAdj, sptr, A, D, S, R } = entry;
    const now = this.now();
    const dryOutput = outputNode?.dry || outputNode || this.ctx.destination;
    const pcmReverbSend = outputNode?.pcmReverbSend || null;

    const gainNode = this.ctx.createGain();
    gainNode.connect(dryOutput);
    const scopeAnalyser = this.ctx.createAnalyser();
    scopeAnalyser.fftSize = 512;
    scopeAnalyser.smoothingTimeConstant = 0;
    const scopeData = new Uint8Array(scopeAnalyser.fftSize);
    const scopeSink = this.ctx.createGain();
    scopeSink.gain.value = 0;
    gainNode.connect(scopeAnalyser);
    scopeAnalyser.connect(scopeSink);
    scopeSink.connect(this.ctx.destination);

    // Pan
    const panNode = this.ctx.createStereoPanner();
    panNode.pan.value = Math.max(-1, Math.min(1, panOffset / 64));
    panNode.connect(gainNode);

    // Func_fa1fc computes the PCM phase step from ROM pitch tables and the
    // sample header's raw rate. The fallback below is only for non-PCM sources.
    const tuneSemis = ((tune & 0xff) - 0x40) / 64;
    const pitchMidi = pitchNote + pitchOffset + pitchOffsetSemis;
    let playbackRate = 2 * Math.pow(2, (pitchMidi - keyAdj + tuneSemis) / 12);
    let src = null;
    let sourceKind = 'pcm';
    let sourceConnected = false;
    let sampleInfo = null;
    let autoEndTime = 0;

    if (type === 0 && (sptr >>> 24) === 8) {
      if (pcmReverbSend) gainNode.connect(pcmReverbSend);
      else if (this.pcmReverbBus) gainNode.connect(this.pcmReverbBus);
      const cached = this.getBuffer(sptr);
      if (!cached) return null;
      const { buf, rate, sampleHz, bufferSampleHz, loopStart, loopEnd, rawLoopEnd, looped, sampleMode, gamefreakCompressed } = cached;
      const camelotSynth = !!this.profile.camelotSynths && rawLoopEnd === 0;
      const synthParams = camelotSynth ? this.rom.bytes((sptr & 0x1ffffff) + 16, 8) : null;
      sampleInfo = { rate, sampleHz, bufferSampleHz, loopStart, loopEnd, rawLoopEnd, looped, sampleMode, gamefreakCompressed, camelotSynth, synthParams, instrumentIndex: entry.idx, fixedPitch: !!(entry.typeB & 0x08) };
      const rateInfo = this._voiceRateInfo(pitchMidi, keyAdj, tuneSemis, sampleInfo);
      playbackRate = rateInfo.rate;
      sampleInfo.rateInfo = rateInfo;
      const loopLen = loopEnd - loopStart;
      if (sampleInfo.camelotSynth) {
        const synthKind = this._camelotSynthKind(sampleInfo);
        const synthBaseFreq = Math.max(1, (rate / 1024) / 64);
        const synthTargetFreq = Math.max(1, rateInfo.rawFreq || synthBaseFreq * Math.pow(2, (pitchMidi - 60 + tuneSemis) / 12));
        const pwmDutyStep = synthKind === 'camelot-pwm' ? (this._signedSynthByte(sampleInfo.synthParams, 3) << 24) >>> 0 : 0;
        const renderSec = Math.min(12, Math.max(0.25, (durationTicks > 0 ? durationTicks * tickSec : 6) + 1.25));
        const synthBuf = synthKind === 'camelot-pwm' && pwmDutyStep !== 0
          ? this.getCamelotPwmBuffer(sptr, sampleInfo, synthTargetFreq, renderSec)
          : this.getCamelotSynthBuffer(sptr, sampleInfo, pitchMidi, tuneSemis);
        if (!synthBuf) return null;
        src = this.ctx.createBufferSource();
        src.buffer = synthBuf;
        src.loop = !!synthBuf.loopEnabled;
        const sourceBaseFreq = Math.max(1, synthBuf.synthBaseFreq || synthBaseFreq);
        const sourceTargetFreq = Math.max(1, rateInfo.rawFreq || synthBuf.synthTargetFreq || sourceBaseFreq);
        playbackRate = sourceTargetFreq / sourceBaseFreq;
        src.playbackRate.value = playbackRate;
        sourceKind = 'synth';
        sampleInfo.synthMode = synthBuf.synthMode;
        sampleInfo.synthModeSource = 'Camelot ARM synth';
        sampleInfo.synthBaseFreq = sourceBaseFreq;
        sampleInfo.synthDynamicPwm = synthKind === 'camelot-pwm' && pwmDutyStep !== 0;
        sampleInfo.synthEffectivePeriod = 64;
        sampleInfo.synthRenderLoopLength = synthBuf.renderLoopLength || 0;
        src.connect(panNode);
        sourceConnected = true;
      } else if (sampleInfo.looped && loopLen > 0 && loopLen <= 64) {
        const synthMode = this._synthModeFor(sampleInfo);
        if (this._isGbcSynthMode(synthMode)) {
          const targetFrequency = Math.max(16, Math.min(8192, rateInfo.foldedFreq || rateInfo.rawFreq || this._noteFrequency(pitchMidi, tuneSemis)));
          const gbc = this._makeGbcApuSource(synthMode, pitchMidi, tuneSemis, { entry, type, psgState, targetFrequency });
          src = gbc.src;
          playbackRate = 1;
          sourceKind = `gbc:${synthMode}`;
          sampleInfo.synthMode = synthMode;
          sampleInfo.synthModeSource = this._synthModeSourceFor(sampleInfo);
          sampleInfo.gbcFrequency = gbc.frequency;
          sampleInfo.gbcBaseFrequency = gbc.frequency;
          sampleInfo.gbcTargetFrequency = gbc.targetFrequency;
          sampleInfo.gbcModel = gbc.model;
          const filter = this.ctx.createBiquadFilter();
          filter.type = 'lowpass';
          filter.frequency.value = Math.min(7600, GBA_MIX_RATE * 0.42);
          filter.Q.value = 0.45;
          const highpass = this.ctx.createBiquadFilter();
          highpass.type = 'highpass';
          highpass.frequency.value = PSG_HIGHPASS_HZ;
          highpass.Q.value = 0.707;
          src.connect(filter);
          filter.connect(highpass);
          highpass.connect(panNode);
        } else {
          const synthBuf = this.getGbaSynthBuffer(sptr, sampleInfo, rateInfo);
          if (!synthBuf) return null;
          src = this.ctx.createBufferSource();
          src.buffer = synthBuf;
          src.loop = synthBuf.loopEnabled !== false;
          src.playbackRate.value = 1;
          sourceKind = 'synth';
          sampleInfo.synthMode = synthBuf.synthMode || synthMode;
          sampleInfo.synthModeSource = this._synthModeSourceFor(sampleInfo);
          sampleInfo.synthEffectivePeriod = synthBuf.effectivePeriod || rateInfo.effectivePeriod || loopLen;
          sampleInfo.synthRenderLoopLength = synthBuf.renderLoopLength || loopLen;
          sampleInfo.synthDcOffsetRemoved = synthBuf.dcOffsetRemoved || 0;
          sampleInfo.synthBaseFreq = Math.max(1, synthBuf.synthBaseFreq || rateInfo.rawFreq || rateInfo.foldedFreq || 440);
          src.connect(panNode);
        }
        sourceConnected = true;
      } else {
        src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = playbackRate * (sampleHz / Math.max(1, bufferSampleHz || sampleHz));
      }
      if (sourceKind === 'pcm' && sampleInfo.looped && loopEnd > loopStart && rawLoopEnd > 0) {
        src.loop = true;
        src.loopStart = loopStart / Math.max(1, bufferSampleHz || sampleHz);
        src.loopEnd   = loopEnd   / Math.max(1, bufferSampleHz || sampleHz);
      }
    } else if (type === 1 || type === 2) {
      const dutyCode = (entry.sptr ?? 2) & 3;
      const mode = ['pulse12', 'pulse25', 'pulse50', 'pulse75'][dutyCode] || 'pulse50';
      const gbc = this._makeGbcApuSource(mode, pitchMidi, tuneSemis, { entry, type, psgState });
      src = gbc.src;
      playbackRate = 1;
      sampleInfo = { instrumentIndex: entry.idx, psgChannel: type, gbcFrequency: gbc.frequency, gbcBaseFrequency: gbc.frequency, gbcTargetFrequency: gbc.targetFrequency, gbcModel: gbc.model };
      sourceKind = type === 1 ? 'psg1' : 'psg2';
    } else if (type === 3) {
      const gbc = this._makeGbcApuSource('triangle', pitchMidi, tuneSemis, { entry, type, psgState });
      src = gbc.src;
      playbackRate = 1;
      sampleInfo = { instrumentIndex: entry.idx, psgChannel: type, gbcFrequency: gbc.frequency, gbcBaseFrequency: gbc.frequency, gbcTargetFrequency: gbc.targetFrequency, gbcModel: gbc.model };
      sourceKind = 'psg3';
    } else if (type === 4) {
      const gbc = this._makeGbcApuSource('noise', pitchMidi, tuneSemis, { entry, type, psgState });
      src = gbc.src;
      playbackRate = 1;
      sampleInfo = { instrumentIndex: entry.idx, psgChannel: type, gbcFrequency: gbc.frequency, gbcBaseFrequency: gbc.frequency, gbcTargetFrequency: gbc.targetFrequency, gbcModel: gbc.model };
      sourceKind = 'psg4-noise';
    } else {
      return null;
    }
    if (!sourceConnected) {
      const isLivePsgSource = sourceKind === 'psg1' || sourceKind === 'psg2' || sourceKind === 'psg3' || sourceKind === 'psg4-noise' || sourceKind.startsWith('gbc:');
      if (isLivePsgSource) {
        const highpass = this.ctx.createBiquadFilter();
        highpass.type = 'highpass';
        highpass.frequency.value = PSG_HIGHPASS_HZ;
        highpass.Q.value = 0.707;
        src.connect(highpass);
        highpass.connect(panNode);
      } else {
        src.connect(panNode);
      }
    }

    // ADSR
    const isGbcSynth = sourceKind.startsWith('gbc:');
    const isActualPsg = type === 1 || type === 2 || type === 4;
    const isHardwareApu = isGbcSynth || type === 1 || type === 2 || type === 3 || type === 4;
    const isPsg = type !== 0 || isGbcSynth;
    let psgDacLevel = Math.max(1, Math.min(15, Math.round((velocity / 127) * 15)));
    const cgbOutputGain = this.profile.cgbOutputGain ?? 0.35;
    const directSoundOutputGain = this.profile.directSoundOutputGain ?? 1;
    const soundModeGain = this._soundModeMasterGain();
    let vol = (isActualPsg || type === 3)
      ? (volume / 127) * cgbOutputGain
      : (volume / 127) * (velocity / 127) * (isPsg ? cgbOutputGain : directSoundOutputGain);
    let gainScale = 1;
    const isPokemon = this.profile.family === 'pokemon-sappy';
    const isRhythmPcm = isPokemon && type === 0 && !!(parent?.typeB & 0x80);
    if (isPokemon && type >= 1 && type <= 4) {
      psgDacLevel = this._pokemonCgbEnvelopeGoal(volume, velocity, panOffset);
      vol = cgbOutputGain;
    }
    if (isRhythmPcm) gainScale *= this.profile.rhythmPcmGain ?? 1;
    if (isPokemon && type === 4) gainScale *= this.profile.noiseGain ?? 1;
    if (isPokemon && type === 2) gainScale *= this.profile.psg2Gain ?? 1;
    gainScale *= soundModeGain;
    vol *= gainScale;
    const sustainRaw = isPsg && S === 0 && D === 0 ? 255 : S;
    let sustainLvl = (sustainRaw / 255) * vol;

    if (isHardwareApu) {
      const psgEnvelope = sampleInfo?.gbcModel && typeof sampleInfo.gbcModel.envelope === 'object' ? sampleInfo.gbcModel.envelope : null;
      gainNode.gain.setValueAtTime(0, now);
      gainNode.gain.linearRampToValueAtTime(vol, now + PSG_CLICK_FADE_SEC);
      sustainLvl = vol * (this._schedulePsgSourceEnvelope(src.apuLevel, now, entry, psgEnvelope, true, (isActualPsg || isPokemon && type === 3) ? psgDacLevel : 15) / 15);
      const psgSweep = sampleInfo?.gbcModel && typeof sampleInfo.gbcModel.sweep === 'object' ? sampleInfo.gbcModel.sweep : null;
      const sweepTrace = this._schedulePsgSweep(src.playbackRate, now, sampleInfo?.gbcBaseFrequency || sampleInfo?.gbcFrequency || 0, psgSweep, sampleInfo?.gbcModel?.channel, sampleInfo?.gbcModel?.frequencyRegister);
      if (sweepTrace) {
        sampleInfo.gbcSweepTrace = sweepTrace;
        const overflow = sweepTrace.events.find(ev => ev.overflow);
        if (overflow) {
          gainNode.gain.setValueAtTime(vol, overflow.time);
          gainNode.gain.linearRampToValueAtTime(0, overflow.time + PSG_CLICK_FADE_SEC);
          try { src.stop(overflow.time + PSG_CLICK_FADE_SEC + 0.001); } catch (_) {}
        }
      }
    } else {
      sustainLvl = this._scheduleArmAdsrEnvelope(gainNode.gain, now, vol, A, D, sustainRaw);
    }

    const psgLength = sampleInfo?.gbcModel && typeof sampleInfo.gbcModel.length === 'object' ? sampleInfo.gbcModel.length : null;
    if (psgLength?.enabled && psgLength.seconds > 0) {
      const stopAt = now + psgLength.seconds;
      gainNode.gain.setValueAtTime(vol, stopAt);
      gainNode.gain.linearRampToValueAtTime(0, stopAt + PSG_CLICK_FADE_SEC);
      try { src.stop(stopAt + PSG_CLICK_FADE_SEC + 0.001); } catch (_) {}
    }

    src.start(now);

    return {
      src, gainNode, panNode,
      scopeAnalyser,
      scopeSink,
      scopeData,
      scopePeak: 0,
      scopeRms: 0,
      released: false,
      justStarted: true,
      durationTicks,
      startTime: now,
      noteMidi: sourceNoteMidi,
      velocity,
      R,
      A,
      D,
      S,
      tickSec,
      volume: vol,
      gainScale,
      outputMixGain: isPsg ? cgbOutputGain : directSoundOutputGain,
      soundModeGain,
      panOffset,
      sustainLvl,
      psgDacMaxLevel: isActualPsg ? psgDacLevel : 15,
      playbackRate,
      rawPlaybackRate: sampleInfo?.rateInfo?.rawRate ?? playbackRate,
      foldedFrequency: sampleInfo?.rateInfo?.foldedFreq ?? 0,
      rawFrequency: sampleInfo?.rateInfo?.rawFreq ?? 0,
      synthEffectivePeriod: sampleInfo?.rateInfo?.effectivePeriod ?? 0,
      synthRenderLoopLength: sampleInfo?.synthRenderLoopLength ?? 0,
      synthBaseFrequency: sampleInfo?.synthBaseFreq ?? 0,
      synthDcOffsetRemoved: sampleInfo?.synthDcOffsetRemoved ?? 0,
      synthLoopEnabled: true,
      armStep: sampleInfo?.rateInfo?.armStep ?? 0,
      armNote: sampleInfo?.rateInfo?.armNote ?? 0,
      armFrac: sampleInfo?.rateInfo?.armFrac ?? 0,
      gbcFrequency: sampleInfo?.gbcFrequency ?? 0,
      gbcBaseFrequency: sampleInfo?.gbcBaseFrequency ?? 0,
      gbcTargetFrequency: sampleInfo?.gbcTargetFrequency ?? 0,
      gbcSweepTrace: sampleInfo?.gbcSweepTrace || null,
      hardwareLengthSec: psgLength?.enabled ? psgLength.seconds : 0,
      gbcModel: sampleInfo?.gbcModel || null,
      hardwareType: sampleInfo?.psgChannel || 0,
      psgFrequencyLocked: sampleInfo?.gbcModel?.frequencySource === 'CC/GBA frequency register',
      psgLastLiveWrite: null,
      aliasFolded: !!sampleInfo?.rateInfo?.folded,
      autoEndTime,
      synthMode: sampleInfo?.synthMode || '',
      synthModeSource: sampleInfo?.synthModeSource || '',
      sampleInfo,
      psgState,
      keyAdj,
      tuneSemis,
      pitchNote,
      instrumentPitchOffset: pitchOffset,
      trackPitchOffset: pitchOffsetSemis,
      sourceKind,
      instrument: entry,
      parentInstrument: parent,
      tableIndex,
    };
  }

  updateVoicePitch(voice, trackPitchOffset) {
    if (!voice || voice.released) return;
    voice.trackPitchOffset = trackPitchOffset;
    const pitchMidi = voice.pitchNote + voice.instrumentPitchOffset + trackPitchOffset;
    if (voice.sourceKind === 'pcm' && voice.src.playbackRate) {
      const rateInfo = this._voiceRateInfo(pitchMidi, voice.keyAdj, voice.tuneSemis, voice.sampleInfo);
      const rate = rateInfo.rate;
      voice.playbackRate = rate;
      voice.rawPlaybackRate = rateInfo.rawRate;
      voice.rawFrequency = rateInfo.rawFreq;
      voice.foldedFrequency = rateInfo.foldedFreq;
      voice.synthEffectivePeriod = rateInfo.effectivePeriod || 0;
      voice.aliasFolded = rateInfo.folded;
      voice.armStep = rateInfo.armStep;
      voice.armNote = rateInfo.armNote;
      voice.armFrac = rateInfo.armFrac;
      const bufferHz = voice.sampleInfo?.bufferSampleHz || voice.sampleInfo?.sampleHz || 1;
      const sampleHz = voice.sampleInfo?.sampleHz || bufferHz;
      voice.src.playbackRate.setValueAtTime(rate * (sampleHz / Math.max(1, bufferHz)), this.now());
    } else if (voice.sourceKind === 'synth' && voice.src.playbackRate) {
      const rateInfo = this._voiceRateInfo(pitchMidi, voice.keyAdj, voice.tuneSemis, voice.sampleInfo);
      voice.playbackRate = rateInfo.rate;
      voice.rawPlaybackRate = rateInfo.rawRate;
      voice.rawFrequency = rateInfo.rawFreq;
      voice.foldedFrequency = rateInfo.foldedFreq;
      voice.synthEffectivePeriod = rateInfo.effectivePeriod || 0;
      voice.aliasFolded = rateInfo.folded;
      voice.armStep = rateInfo.armStep;
      voice.armNote = rateInfo.armNote;
      voice.armFrac = rateInfo.armFrac;
      const baseFreq = voice.sampleInfo?.synthBaseFreq || rateInfo.rawFreq || rateInfo.foldedFreq || 1;
      const newFreq = Math.max(1, rateInfo.rawFreq || rateInfo.foldedFreq || baseFreq);
      voice.src.playbackRate.setValueAtTime(newFreq / baseFreq, this.now());
    } else if ((voice.hardwareType || voice.sourceKind?.startsWith('gbc:') || voice.sourceKind === 'psg1' || voice.sourceKind === 'psg2' || voice.sourceKind === 'psg3' || voice.sourceKind === 'psg4-noise' || voice.sourceKind === 'noise') && voice.src.playbackRate) {
      if (voice.psgFrequencyLocked) return;
      const mode = voice.synthMode || (voice.hardwareType === 3 ? 'triangle' : voice.hardwareType === 4 ? 'noise' : voice.hardwareType ? 'pulse50' : voice.sourceKind.slice(4));
      const psgKeyAdj = voice.hardwareType ? (voice.keyAdj || 60) : voice.keyAdj;
      let target = voice.hardwareType
        ? this._psgNoteFrequency(pitchMidi, psgKeyAdj, voice.tuneSemis)
        : this._noteFrequency(pitchMidi, voice.tuneSemis);
      if (voice.sourceKind?.startsWith('gbc:') && voice.sampleInfo?.rateInfo) {
        const rateInfo = this._voiceRateInfo(pitchMidi, voice.keyAdj, voice.tuneSemis, voice.sampleInfo);
        voice.rawPlaybackRate = rateInfo.rawRate;
        voice.rawFrequency = rateInfo.rawFreq;
        voice.foldedFrequency = rateInfo.foldedFreq;
        voice.synthEffectivePeriod = rateInfo.effectivePeriod || 0;
        target = Math.max(16, Math.min(8192, rateInfo.foldedFreq || rateInfo.rawFreq || target));
      }
      const quant = voice.hardwareType
        ? this._applyCgbFixQuant(voice.hardwareType, voice.instrument || null, this._psgQuantFromEngine(voice.hardwareType, pitchMidi, psgKeyAdj, voice.tuneSemis)) || this._gbcQuantizeFrequency(voice.gbcModel?.channel === 'wave' ? 'triangle' : mode, target)
        : this._gbcQuantizeFrequency(voice.gbcModel?.channel === 'wave' ? 'triangle' : mode, target);
      const base = voice.gbcBaseFrequency || quant.actualFrequency || 1;
      voice.gbcTargetFrequency = target;
      voice.gbcFrequency = quant.actualFrequency;
      voice.gbcModel = { ...(voice.gbcModel || this._gbcModelFor(mode)), ...quant };
      if (voice.src.apuUpdate && (voice.sourceKind?.startsWith('gbc:') || voice.hardwareType)) {
        const nextConfig = quant.channel === 'noise'
          ? this._applyNoiseControlConfig({ ...(voice.src.apuState?.config || {}), noise: true }, quant.frequencyRegister, quant.registerSource)
          : null;
        voice.src.apuUpdate(quant, nextConfig);
        voice.gbcBaseFrequency = quant.actualFrequency;
        voice.src.playbackRate.setValueAtTime(1, this.now());
      } else {
        voice.src.playbackRate.setValueAtTime(quant.actualFrequency / base, this.now());
      }
    } else if (voice.src.frequency) {
      const freq = this._noteFrequency(pitchMidi, voice.tuneSemis);
      voice.src.frequency.setValueAtTime(freq, this.now());
    }
  }

  updateVoiceMix(voice, volumeScale = 1, panMod = 0) {
    if (!voice || voice.released || !this.ctx) return;
    const now = this.now();
    if (voice.gainNode?.gain) {
      const target = Math.max(0, Math.min(2, volumeScale)) * (voice.volume || 0);
      voice.gainNode.gain.setTargetAtTime(target, now, 0.006);
    }
    if (voice.panNode?.pan) {
      const pan = Math.max(-1, Math.min(1, ((voice.panOffset || 0) + panMod) / 64));
      voice.panNode.pan.setTargetAtTime(pan, now, 0.006);
    }
  }

  _makeNoiseSource(seconds) {
    const sampleRate = this.ctx.sampleRate;
    const len = Math.max(1, Math.ceil(seconds * sampleRate));
    const key = Math.ceil(seconds * 10) / 10;
    let buf = this.noiseCache.get(key);
    if (!buf) {
      buf = this.ctx.createBuffer(1, len, sampleRate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
      this.noiseCache.set(key, buf);
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    return src;
  }

  _dmaBufferCount(rate = GBA_MIX_RATE) {
    const samplesPerVblank = Math.max(1, rate / AGB_EXACT_FPS);
    return Math.max(2, Math.floor(0x630 / samplesPerVblank));
  }

  _makeReverbImpulse(type, depth, numDmaBuffers) {
    const sr = this.ctx.sampleRate;
    const frameLen = Math.max(1, Math.round(sr / AGB_EXACT_FPS));
    const mainLen = Math.max(frameLen * numDmaBuffers, frameLen * 2);
    const tailLen = Math.max(mainLen * 5, Math.round(sr * 0.22));
    const impulse = this.ctx.createBuffer(2, tailLen, sr);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);
    const add = (idx, l, r) => {
      if (idx < 0 || idx >= tailLen) return;
      left[idx] += l * depth;
      right[idx] += r * depth;
    };
    const writeGs2 = (rPrimFac, rSecFac) => {
      let amp = 1;
      let delay = mainLen - Math.floor(frameLen / 3);
      for (let tap = 0; tap < 12; tap++) {
        add(delay, amp * rPrimFac, amp * rPrimFac);
        add(delay + Math.floor(frameLen / 2), amp * rSecFac, amp * rSecFac);
        add(delay + frameLen, amp * 0.25, amp * 0.25);
        amp *= 0.62;
        delay += frameLen;
      }
    };
    if (type === 'gs2') {
      writeGs2(0.4140625, -0.0625);
    } else if (type === 'mgat') {
      writeGs2(0.25, -0.046875);
    } else if (type === 'gs1') {
      for (let tap = 0; tap < 10; tap++) {
        const delay = frameLen * (tap + 1);
        const amp = Math.pow(0.55, tap);
        add(delay, amp * 0.25, amp * 0.18);
        add(delay + Math.floor(frameLen / 2), amp * 0.18, amp * 0.25);
      }
    } else {
      for (let tap = 0; tap < 8; tap++) {
        const amp = Math.pow(0.5, tap);
        add(frameLen * (tap + 1), amp * 0.25, amp * 0.25);
      }
    }
    return impulse;
  }

  _makeGsReverbProcessor(type, numDmaBuffers) {
    const processor = this.ctx.createScriptProcessor(512, 2, 2);
    const sr = this.ctx.sampleRate;
    const frameLen = Math.max(1, Math.round(sr / AGB_EXACT_FPS));
    const mainLen = Math.max(frameLen * numDmaBuffers, frameLen * 2);
    const bufL = new Float32Array(mainLen);
    const bufR = new Float32Array(mainLen);
    const auxLen = Math.max(2, frameLen);
    const auxL = new Float32Array(auxLen);
    const auxR = new Float32Array(auxLen);
    let pos = 0;
    let pos2 = type === 'gs1' ? 0 : mainLen - Math.floor(auxLen / 3);
    let auxPos = 0;
    const rPrimFac = type === 'mgat' ? 0.25 : 0.4140625;
    const rSecFac = type === 'mgat' ? -0.046875 : -0.0625;

    processor.onaudioprocess = event => {
      const inL = event.inputBuffer.getChannelData(0);
      const inR = event.inputBuffer.numberOfChannels > 1 ? event.inputBuffer.getChannelData(1) : inL;
      const outL = event.outputBuffer.getChannelData(0);
      const outR = event.outputBuffer.getChannelData(1);
      for (let i = 0; i < outL.length; i++) {
        const wetL = auxL[auxPos];
        const wetR = auxR[auxPos];
        const mixL = inL[i] + wetL;
        const mixR = inR[i] + wetR;
        const lA = bufL[pos];
        const rA = bufR[pos];
        bufL[pos] = mixL;
        bufR[pos] = mixR;
        if (type === 'gs1') {
          auxL[auxPos] = 0.25 * mixL + 0.25 * rA;
          auxR[auxPos] = 0.25 * mixR + 0.25 * lA;
        } else {
          const lRMix = lA * rPrimFac + rA * rSecFac;
          const rRMix = rA * rPrimFac + lA * rSecFac;
          const lB = bufR[pos2] * 0.25;
          const rB = mixR * 0.25;
          auxL[auxPos] = lRMix + lB;
          auxR[auxPos] = rRMix + rB;
          pos2 = (pos2 + 1) % mainLen;
        }
        outL[i] = wetL;
        outR[i] = wetR;
        pos = (pos + 1) % mainLen;
        auxPos++;
        if (type === 'gs1') {
          if (auxPos >= auxLen) auxPos = 0;
        } else if (auxPos >= Math.max(1, Math.floor(auxLen / 2))) {
          auxPos = 0;
        }
      }
    };
    return processor;
  }

  createPcmReverbBus(ctx, reverbRaw, profile, soundMode = null) {
    const reverbEnabled = !!(reverbRaw & 0x80);
    const reverbDepth = reverbRaw & 0x7f;
    const type = profile?.reverbType || 'normal';
    if (!reverbEnabled || reverbDepth <= 0) {
      this.pcmReverbBus = null;
      this.pcmReverbInfo = { raw: reverbRaw, depth: reverbDepth, wetLevel: 0, feedback: 0, delaySec: 0, type };
      return null;
    }
    const depth = reverbDepth / 128;
    const numDmaBuffers = this._dmaBufferCount(soundMode?.rate || GBA_MIX_RATE);
    const sendGain = ctx.createGain();
    sendGain.gain.value = depth;
    const wetGain = ctx.createGain();
    wetGain.gain.value = type === 'gs1' || type === 'gs2' || type === 'mgat' ? 1 : 0.75;
    if (type === 'gs1' || type === 'gs2' || type === 'mgat') {
      const processor = this._makeGsReverbProcessor(type, numDmaBuffers);
      sendGain.connect(processor);
      processor.connect(wetGain);
    } else {
      const convolver = ctx.createConvolver();
      convolver.normalize = false;
      convolver.buffer = this._makeReverbImpulse(type, depth, numDmaBuffers);
      sendGain.connect(convolver);
      convolver.connect(wetGain);
    }
    wetGain.connect(ctx.destination);
    this.pcmReverbBus = sendGain;
    this.pcmReverbInfo = {
      raw: reverbRaw,
      depth: reverbDepth,
      wetLevel: depth,
      feedback: 0,
      delaySec: numDmaBuffers / AGB_EXACT_FPS,
      type,
      numDmaBuffers,
    };
    return sendGain;
  }

  stopVoiceNow(voice) {
    if (!voice || voice.forceStopped) return;
    voice.released = true;
    voice.forceStopped = true;
    const now = this.now();
    const stopAt = now + PSG_CLICK_FADE_SEC;
    voice.releaseEndTime = stopAt;
    try {
      voice.gainNode?.gain?.cancelScheduledValues(now);
      voice.gainNode?.gain?.setValueAtTime(voice.gainNode.gain.value || voice.volume || 0, now);
      voice.gainNode?.gain?.linearRampToValueAtTime(0, stopAt);
    } catch (_) {}
    try {
      voice.src?.apuLevel?.cancelScheduledValues(now);
      voice.src?.apuLevel?.setValueAtTime(voice.src.apuLevel.valueAt?.(now) ?? 0, now);
      voice.src?.apuLevel?.setValueAtTime(0, stopAt);
    } catch (_) {}
    try { voice.src?.stop?.(stopAt + 0.001); } catch (_) {}
  }

  releaseVoice(voice) {
    if (!voice || voice.released) return;
    voice.released = true;
    const now = this.now();
    const { gainNode, src, R, tickSec } = voice;
    const isHardwareApu = voice.sourceKind?.startsWith('gbc:') || voice.sourceKind?.startsWith('psg') || voice.gbcModel;
    const cur = isHardwareApu
      ? gainNode.gain.value
      : this._armAdsrGainAt(now - voice.startTime, voice.volume, voice.A, voice.D, voice.S);
    if (isHardwareApu) {
      gainNode.gain.cancelScheduledValues(now);
      gainNode.gain.setValueAtTime(cur, now);
      if (src.apuLevel) {
        const level = Math.max(0, Math.min(15, Math.round(src.apuLevel.valueAt(now))));
        if (R === 0 || level <= 0) {
          src.apuLevel.cancelScheduledValues(now);
          gainNode.gain.linearRampToValueAtTime(0, now + PSG_CLICK_FADE_SEC);
          src.apuLevel.setValueAtTime(0, now + PSG_CLICK_FADE_SEC);
          voice.releaseEndTime = now + PSG_CLICK_FADE_SEC + 0.005;
          try { src.stop(now + PSG_CLICK_FADE_SEC + 0.005); } catch (_) {}
        } else {
          // Let the existing GBC envelope schedule complete naturally (hardware-accurate:
          // ARM Sappy doesn't re-trigger a new decay on PSG release, it just stops the channel)
          const lastFuture = [...src.apuLevel.events].reverse().find(ev => ev.time > now);
          if (!lastFuture) {
            src.apuLevel.cancelScheduledValues(now);
            gainNode.gain.linearRampToValueAtTime(0, now + PSG_CLICK_FADE_SEC);
            src.apuLevel.setValueAtTime(0, now + PSG_CLICK_FADE_SEC);
            voice.releaseEndTime = now + PSG_CLICK_FADE_SEC + 0.005;
            try { src.stop(now + PSG_CLICK_FADE_SEC + 0.005); } catch (_) {}
          } else {
            const endTime = lastFuture.time;
            if (voice.sourceKind === 'psg3') {
              gainNode.gain.linearRampToValueAtTime(0, endTime);
            }
            voice.releaseEndTime = endTime + 0.01;
            try { src.stop(endTime + 0.01); } catch (_) {}
          }
        }
      } else if (R === 0) {
        gainNode.gain.linearRampToValueAtTime(0, now + PSG_CLICK_FADE_SEC);
        voice.releaseEndTime = now + PSG_CLICK_FADE_SEC + 0.005;
        try { src.stop(now + PSG_CLICK_FADE_SEC + 0.005); } catch (_) {}
      } else {
        const halfTicks = Math.log(0.5) / Math.log(R / 256);
        const tc = Math.max(0.001, Math.abs(halfTicks) * tickSec / Math.LN2);
        gainNode.gain.setTargetAtTime(0, now, tc);
        voice.releaseEndTime = now + tc * 8;
        try { src.stop(now + tc * 8); } catch (_) {}
      }
    } else {
      const releaseSec = this._scheduleArmRelease(gainNode.gain, now, cur, R);
      voice.releaseEndTime = now + releaseSec + 0.01;
      try { src.stop(now + releaseSec + 0.01); } catch (_) {}
    }
  }

  stop() {
    this.pcmReverbBus = null;
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
      this.sampleCache.clear();
      this.synthCache.clear();
      this.gbcWaveCache.clear();
      this.gbcBufferCache.clear();
      this.noiseCache.clear();
    }
  }
}

class SoftwareMixerAudioEngine extends AudioEngine {
  constructor() {
    super();
    this.backendId = 'software';
    this.backendLabel = 'Software mixer (experimental)';
    this.softwareVoices = [];
    this.softwareSampleCache = new Map();
    this.softwareRoutes = new Map();
  }

  async ensure() {
    await super.ensure();
  }

  loadSamples(rom, voiceGroup) {
    super.loadSamples(rom, voiceGroup);
    this.softwareSampleCache.clear();
  }

  _makeSoftParam(initialValue) {
    return {
      value: initialValue,
      setValueAtTime(value) { this.value = value; },
      linearRampToValueAtTime(value) { this.value = value; },
      setTargetAtTime(value) { this.value = value; },
      cancelScheduledValues() {},
    };
  }

  _softGainNode(initialValue) {
    return { gain: this._makeSoftParam(initialValue) };
  }

  _softPanNode(initialValue) {
    return { pan: this._makeSoftParam(initialValue) };
  }

  _softwareSample(sptr) {
    if (this.softwareSampleCache.has(sptr)) return this.softwareSampleCache.get(sptr);
    const sample = parseSample(this.rom, sptr);
    if (!sample || !sample.data?.length) return null;
    const data = new Float32Array(sample.data.length);
    for (let i = 0; i < sample.data.length; i++) {
      const v = sample.data[i] >= 128 ? sample.data[i] - 256 : sample.data[i];
      data[i] = v / 128;
    }
    const cached = { ...sample, floatData: data, sourceSampleRate: sample.sampleHz || Math.max(3000, sample.rate || GBA_MIX_RATE) };
    this.softwareSampleCache.set(sptr, cached);
    return cached;
  }

  _bufferData(buffer) {
    if (!buffer) return null;
    const data = new Float32Array(buffer.length);
    data.set(buffer.getChannelData(0));
    return data;
  }

  _ensureSoftwareRoute(outputNode = null) {
    const dryOutput = outputNode?.dry || outputNode || this.ctx.destination;
    const key = dryOutput || this.ctx.destination;
    let route = this.softwareRoutes.get(key);
    if (route) return route;
    const node = this.ctx.createScriptProcessor(1024, 0, 2);
    route = {
      key,
      node,
      dryOutput,
      pcmReverbSend: outputNode?.pcmReverbSend || null,
    };
    node.onaudioprocess = event => this._processSoftwareMix(event, route);
    node.connect(dryOutput);
    if (route.pcmReverbSend) node.connect(route.pcmReverbSend);
    this.softwareRoutes.set(key, route);
    return route;
  }

  _initSoftEnvelope(voice) {
    voice.envState = 'INIT';
    voice.envLevelCur = 0;
    voice.envLevelPrev = 0;
    voice.envInterStep = 0;
    voice.envNextStepTime = voice.startTime;
    voice.envDeadTime = 0;
    voice.stopRequested = false;
    voice.releaseRequested = false;
    voice.releaseRequestTime = Infinity;
  }

  _stepSoftEnvelope(voice) {
    if (voice.envState === 'DEAD') return;
    if (voice.envState === 'INIT') {
      if (voice.stopRequested) {
        voice.envLevelPrev = voice.A >= 0xff ? 0xff : 0;
        voice.envLevelCur = 0;
        voice.envInterStep = 0;
        voice.envState = 'ATK';
      } else {
        voice.envLevelPrev = voice.A >= 0xff ? 0xff : 0;
        voice.envLevelCur = 0;
        voice.envInterStep = 0;
        voice.envState = 'ATK';
      }
    } else {
      voice.envInterStep++;
      if (voice.envInterStep < CAMELOT_SYNTH_INTERFRAMES) return;
      voice.envLevelPrev = voice.envLevelCur;
      voice.envInterStep = 0;
    }

    if (voice.stopRequested) {
      if (voice.envState === 'DIE') {
        voice.envState = 'DEAD';
        voice.envDeadTime = voice.envNextStepTime || this.now();
        voice.softDone = true;
        voice.envLevelCur = 0;
      } else {
        voice.envLevelCur = (voice.envLevelCur * Math.max(0, Math.min(255, voice.R))) >> 8;
        if (voice.envLevelCur <= 0) {
          voice.envState = 'DIE';
          voice.envLevelCur = 0;
        }
      }
      return;
    }

    if (voice.envState === 'DEC') {
      voice.envLevelCur = (voice.envLevelCur * Math.max(0, Math.min(255, voice.D))) >> 8;
      if (voice.envLevelCur <= voice.S) {
        voice.envLevelCur = Math.max(0, Math.min(255, voice.S));
        if (voice.envLevelCur === 0) {
          voice.envState = 'DIE';
          voice.envLevelCur = 0;
        } else {
          voice.envState = 'SUS';
        }
      }
    } else if (voice.envState === 'ATK') {
      const next = voice.envLevelCur + Math.max(0, Math.min(255, voice.A));
      if (next >= 0xff) {
        voice.envLevelCur = 0xff;
        voice.envState = 'DEC';
      } else {
        voice.envLevelCur = next;
      }
    } else if (voice.envState === 'DIE') {
      voice.envState = 'DEAD';
      voice.envDeadTime = voice.envNextStepTime || this.now();
      voice.softDone = true;
      voice.envLevelCur = 0;
    }
  }

  _advanceSoftEnvelopeTo(voice, time) {
    const stepSec = 1 / (AGB_EXACT_FPS * CAMELOT_SYNTH_INTERFRAMES);
    if (!voice.envNextStepTime) voice.envNextStepTime = voice.startTime;
    let guard = 0;
    while (!voice.softDone && time >= voice.envNextStepTime && guard++ < 2048) {
      if (voice.releaseRequested && voice.envNextStepTime >= voice.releaseRequestTime) voice.stopRequested = true;
      this._stepSoftEnvelope(voice);
      voice.envNextStepTime += stepSec;
    }
  }

  _softEnvelopeGain(voice) {
    if (voice.envState === 'DEAD') return 0;
    const interp = Math.max(0, Math.min(CAMELOT_SYNTH_INTERFRAMES, voice.envInterStep || 0)) / CAMELOT_SYNTH_INTERFRAMES;
    const level = (voice.envLevelPrev || 0) + ((voice.envLevelCur || 0) - (voice.envLevelPrev || 0)) * interp;
    return voice.volume * (level / 255);
  }

  triggerNote(instEntry, noteMidi, velocity, volume, panOffset, tune, pitchOffsetSemis, tickSec, durationTicks, adsr, outputNode = null, psgState = null) {
    if (!this.ctx) return null;
    const resolved = instEntry?.__resolvedVoice || resolveVoiceEntry(this.rom, instEntry, noteMidi, this.profile);
    if (!resolved) return null;
    const { entry, tableIndex, parent, pitchOffset, pitchNote } = resolved;
    const sourceNoteMidi = resolved.noteMidi ?? noteMidi;
    const { type, keyAdj, sptr, A, D, S, R } = entry;
    if (type !== 0 || (sptr >>> 24) !== 8) {
      return super.triggerNote(instEntry, noteMidi, velocity, volume, panOffset, tune, pitchOffsetSemis, tickSec, durationTicks, adsr, outputNode, psgState);
    }

    const cached = this.getBuffer(sptr);
    if (!cached) return null;
    const { rate, sampleHz, bufferSampleHz, loopStart, loopEnd, rawLoopEnd, looped, sampleMode, gamefreakCompressed } = cached;
    const now = this.now();
    const tuneSemis = ((tune & 0xff) - 0x40) / 64;
    const pitchMidi = pitchNote + pitchOffset + pitchOffsetSemis;
    const camelotSynth = !!this.profile.camelotSynths && rawLoopEnd === 0;
    const synthParams = camelotSynth ? this.rom.bytes((sptr & 0x1ffffff) + 16, 8) : null;
    const sampleInfo = {
      rate,
      sampleHz,
      bufferSampleHz,
      loopStart,
      loopEnd,
      rawLoopEnd,
      looped,
      sampleMode,
      gamefreakCompressed,
      camelotSynth,
      synthParams,
      instrumentIndex: entry.idx,
      fixedPitch: !!(entry.typeB & 0x08),
    };
    const rateInfo = this._voiceRateInfo(pitchMidi, keyAdj, tuneSemis, sampleInfo);
    sampleInfo.rateInfo = rateInfo;

    let data = null;
    let sourceSampleRate = sampleHz || GBA_MIX_RATE;
    let playbackRate = rateInfo.rate;
    let sourceKind = 'pcm';
    let synthLoopEnabled = false;
    const loopLen = loopEnd - loopStart;

    if (sampleInfo.camelotSynth) {
      const synthKind = this._camelotSynthKind(sampleInfo);
      const synthBaseFreq = Math.max(1, (rate / 1024) / 64);
      const synthTargetFreq = Math.max(1, rateInfo.rawFreq || synthBaseFreq * Math.pow(2, (pitchMidi - 60 + tuneSemis) / 12));
      const pwmDutyStep = synthKind === 'camelot-pwm' ? (this._signedSynthByte(sampleInfo.synthParams, 3) << 24) >>> 0 : 0;
      const renderSec = Math.min(12, Math.max(0.25, (durationTicks > 0 ? durationTicks * tickSec : 6) + 1.25));
      const synthBuf = synthKind === 'camelot-pwm' && pwmDutyStep !== 0
        ? this.getCamelotPwmBuffer(sptr, sampleInfo, synthTargetFreq, renderSec)
        : this.getCamelotSynthBuffer(sptr, sampleInfo, pitchMidi, tuneSemis);
      if (!synthBuf) return null;
      data = this._bufferData(synthBuf);
      sourceSampleRate = synthBuf.sampleRate || GBA_MIX_RATE;
      const sourceBaseFreq = Math.max(1, synthBuf.synthBaseFreq || synthBaseFreq);
      const sourceTargetFreq = Math.max(1, rateInfo.rawFreq || synthBuf.synthTargetFreq || sourceBaseFreq);
      playbackRate = sourceTargetFreq / sourceBaseFreq;
      sourceKind = 'synth';
      synthLoopEnabled = !!synthBuf.loopEnabled;
      sampleInfo.synthMode = synthBuf.synthMode;
      sampleInfo.synthModeSource = 'Camelot ARM synth';
      sampleInfo.synthBaseFreq = sourceBaseFreq;
      sampleInfo.synthDynamicPwm = synthKind === 'camelot-pwm' && pwmDutyStep !== 0;
      sampleInfo.synthEffectivePeriod = 64;
      sampleInfo.synthRenderLoopLength = synthBuf.renderLoopLength || 0;
    } else if (sampleInfo.looped && loopLen > 0 && loopLen <= 64 && !this._isGbcSynthMode(this._synthModeFor(sampleInfo))) {
      const synthMode = this._synthModeFor(sampleInfo);
      const synthBuf = this.getGbaSynthBuffer(sptr, sampleInfo, rateInfo);
      if (!synthBuf) return null;
      data = this._bufferData(synthBuf);
      sourceSampleRate = synthBuf.sampleRate || GBA_MIX_RATE;
      playbackRate = 1;
      sourceKind = 'synth';
      synthLoopEnabled = synthBuf.loopEnabled !== false;
      sampleInfo.synthMode = synthBuf.synthMode || synthMode;
      sampleInfo.synthModeSource = this._synthModeSourceFor(sampleInfo);
      sampleInfo.synthEffectivePeriod = synthBuf.effectivePeriod || rateInfo.effectivePeriod || loopLen;
      sampleInfo.synthRenderLoopLength = synthBuf.renderLoopLength || loopLen;
      sampleInfo.synthDcOffsetRemoved = synthBuf.dcOffsetRemoved || 0;
      sampleInfo.synthBaseFreq = Math.max(1, synthBuf.synthBaseFreq || rateInfo.rawFreq || rateInfo.foldedFreq || 440);
    } else if (sampleInfo.looped && loopLen > 0 && loopLen <= 64) {
      return super.triggerNote(instEntry, noteMidi, velocity, volume, panOffset, tune, pitchOffsetSemis, tickSec, durationTicks, adsr, outputNode, psgState);
    } else {
      const softSample = this._softwareSample(sptr);
      if (!softSample) return null;
      data = softSample.floatData;
      sourceSampleRate = softSample.sourceSampleRate;
    }

    const directSoundOutputGain = this.profile.directSoundOutputGain ?? 1;
    const soundModeGain = this._soundModeMasterGain();
    let vol = (volume / 127) * (velocity / 127) * directSoundOutputGain;
    let gainScale = soundModeGain;
    const isPokemon = this.profile.family === 'pokemon-sappy';
    const isRhythmPcm = isPokemon && !!(parent?.typeB & 0x80);
    if (isRhythmPcm) gainScale *= this.profile.rhythmPcmGain ?? 1;
    vol *= gainScale;
    const sustainLvl = (S / 255) * vol;
    const gainNode = this._softGainNode(vol);
    const panNode = this._softPanNode(Math.max(-1, Math.min(1, panOffset / 64)));
    const scopeData = new Uint8Array(512);
    const route = this._ensureSoftwareRoute(outputNode);
    const src = {
      playbackRate: this._makeSoftParam(playbackRate),
      start() {},
      stop() {},
    };
    const voice = {
      src,
      gainNode,
      panNode,
      scopeAnalyser: null,
      scopeSink: null,
      scopeData,
      scopePeak: 0,
      scopeRms: 0,
      released: false,
      justStarted: true,
      durationTicks,
      startTime: now,
      noteMidi: sourceNoteMidi,
      velocity,
      R,
      A,
      D,
      S,
      tickSec,
      volume: vol,
      gainScale,
      outputMixGain: directSoundOutputGain,
      soundModeGain,
      panOffset,
      panMod: 0,
      sustainLvl,
      psgDacMaxLevel: 15,
      playbackRate,
      rawPlaybackRate: rateInfo.rawRate ?? playbackRate,
      foldedFrequency: rateInfo.foldedFreq ?? 0,
      rawFrequency: rateInfo.rawFreq ?? 0,
      synthEffectivePeriod: sampleInfo?.rateInfo?.effectivePeriod ?? 0,
      synthRenderLoopLength: sampleInfo?.synthRenderLoopLength ?? 0,
      synthBaseFrequency: sampleInfo?.synthBaseFreq ?? 0,
      synthDcOffsetRemoved: sampleInfo?.synthDcOffsetRemoved ?? 0,
      synthLoopEnabled,
      armStep: rateInfo.armStep ?? 0,
      armNote: rateInfo.armNote ?? 0,
      armFrac: rateInfo.armFrac ?? 0,
      gbcFrequency: 0,
      gbcBaseFrequency: 0,
      gbcTargetFrequency: 0,
      gbcSweepTrace: null,
      hardwareLengthSec: 0,
      gbcModel: null,
      hardwareType: 0,
      psgFrequencyLocked: false,
      psgLastLiveWrite: null,
      aliasFolded: !!rateInfo.folded,
      autoEndTime: 0,
      synthMode: sampleInfo?.synthMode || '',
      synthModeSource: sampleInfo?.synthModeSource || '',
      sampleInfo,
      psgState,
      keyAdj,
      tuneSemis,
      pitchNote,
      instrumentPitchOffset: pitchOffset,
      trackPitchOffset: pitchOffsetSemis,
      sourceKind,
      instrument: entry,
      parentInstrument: parent,
      tableIndex,
      softwareMixed: true,
      softwareRouteKey: route.key,
      sampleData: data,
      sourceSampleRate,
      position: 0,
      softLoopStart: sourceKind === 'pcm' ? loopStart : 0,
      softLoopEnd: sourceKind === 'pcm' ? loopEnd : data.length,
      softLooped: sourceKind === 'pcm' ? (looped && rawLoopEnd > 0 && loopEnd > loopStart) : synthLoopEnabled,
      softDone: false,
      currentGain: 0,
      releaseStartGain: 0,
      releaseStartTime: 0,
    };
    this._initSoftEnvelope(voice);
    this.softwareVoices.push(voice);
    return voice;
  }

  updateVoicePitch(voice, trackPitchOffset) {
    if (!voice?.softwareMixed) return super.updateVoicePitch(voice, trackPitchOffset);
    if (voice.released) return;
    voice.trackPitchOffset = trackPitchOffset;
    const pitchMidi = voice.pitchNote + voice.instrumentPitchOffset + trackPitchOffset;
    const rateInfo = this._voiceRateInfo(pitchMidi, voice.keyAdj, voice.tuneSemis, voice.sampleInfo);
    voice.playbackRate = rateInfo.rate;
    voice.rawPlaybackRate = rateInfo.rawRate;
    voice.rawFrequency = rateInfo.rawFreq;
    voice.foldedFrequency = rateInfo.foldedFreq;
    voice.synthEffectivePeriod = rateInfo.effectivePeriod || 0;
    voice.aliasFolded = rateInfo.folded;
    voice.armStep = rateInfo.armStep;
    voice.armNote = rateInfo.armNote;
    voice.armFrac = rateInfo.armFrac;
    if (voice.sourceKind === 'synth') {
      const baseFreq = voice.sampleInfo?.synthBaseFreq || rateInfo.rawFreq || rateInfo.foldedFreq || 1;
      const newFreq = Math.max(1, rateInfo.rawFreq || rateInfo.foldedFreq || baseFreq);
      voice.src.playbackRate.setValueAtTime(newFreq / baseFreq, this.now());
    } else {
      voice.src.playbackRate.setValueAtTime(rateInfo.rate, this.now());
    }
  }

  updateVoiceMix(voice, volumeScale = 1, panMod = 0) {
    if (!voice?.softwareMixed) return super.updateVoiceMix(voice, volumeScale, panMod);
    if (!voice || voice.released) return;
    voice.mixVolumeScale = Math.max(0, Math.min(2, volumeScale));
    voice.panMod = panMod || 0;
  }

  releaseVoice(voice) {
    if (!voice?.softwareMixed) return super.releaseVoice(voice);
    if (!voice || voice.released) return;
    const now = this.now();
    voice.released = true;
    voice.releaseStartTime = now;
    voice.releaseRequested = true;
    voice.releaseRequestTime = Math.max(now, voice.startTime);
    voice.releaseEndTime = Infinity;
  }

  stopVoiceNow(voice) {
    if (!voice?.softwareMixed) return super.stopVoiceNow(voice);
    if (!voice || voice.forceStopped) return;
    voice.released = true;
    voice.forceStopped = true;
    voice.releaseEndTime = this.now() + PSG_CLICK_FADE_SEC;
    voice.softDone = true;
  }

  _processSoftwareMix(event, route) {
    const outL = event.outputBuffer.getChannelData(0);
    const outR = event.outputBuffer.numberOfChannels > 1 ? event.outputBuffer.getChannelData(1) : outL;
    outL.fill(0);
    if (outR !== outL) outR.fill(0);
    const sr = event.outputBuffer.sampleRate;
    const baseTime = event.playbackTime ?? this.ctx?.currentTime ?? 0;

    for (const voice of this.softwareVoices) {
      if (!voice || voice.forceStopped || voice.softDone || voice.softwareRouteKey !== route.key) continue;
      const data = voice.sampleData;
      if (!data?.length) continue;
      let pos = voice.position || 0;
      let peak = 0;
      let sumSq = 0;
      let active = false;
      for (let i = 0; i < outL.length; i++) {
        const t = baseTime + i / sr;
        if (t < voice.startTime) continue;
        this._advanceSoftEnvelopeTo(voice, t);
        if (voice.softDone) break;
        const idx = Math.floor(pos);
        if (idx >= data.length - 1) {
          if (voice.softLooped && voice.softLoopEnd > voice.softLoopStart) {
            pos = voice.softLoopStart + ((pos - voice.softLoopStart) % Math.max(1, voice.softLoopEnd - voice.softLoopStart));
          } else {
            voice.softDone = true;
            break;
          }
        }
        const p0 = Math.max(0, Math.min(data.length - 1, Math.floor(pos)));
        const p1 = voice.softLooped && p0 + 1 >= voice.softLoopEnd ? voice.softLoopStart : Math.min(data.length - 1, p0 + 1);
        const frac = pos - p0;
        let sample = data[p0] + (data[p1] - data[p0]) * frac;
        let gain = this._softEnvelopeGain(voice);
        gain *= voice.mixVolumeScale == null ? 1 : voice.mixVolumeScale;
        voice.currentGain = gain;
        const pan = Math.max(-1, Math.min(1, ((voice.panOffset || 0) + (voice.panMod || 0)) / 64));
        const left = Math.cos((pan + 1) * Math.PI / 4);
        const right = Math.sin((pan + 1) * Math.PI / 4);
        const v = sample * gain;
        outL[i] += v * left;
        outR[i] += v * right;
        const abs = Math.abs(v);
        peak = Math.max(peak, abs);
        sumSq += v * v;
        active = true;
        pos += Math.max(0, voice.src.playbackRate.value) * voice.sourceSampleRate / sr;
        if (voice.softLooped && voice.softLoopEnd > voice.softLoopStart && pos >= voice.softLoopEnd) {
          pos = voice.softLoopStart + ((pos - voice.softLoopStart) % Math.max(1, voice.softLoopEnd - voice.softLoopStart));
        }
      }
      voice.position = pos;
      if (active) {
        voice.scopePeak = Math.min(1, peak);
        voice.scopeRms = Math.min(1, Math.sqrt(sumSq / outL.length));
        if (voice.scopeData) {
          const mid = Math.max(0, Math.min(data.length - 1, Math.floor(pos)));
          for (let i = 0; i < voice.scopeData.length; i++) {
            const sample = data[(mid + i) % data.length] || 0;
            voice.scopeData[i] = Math.max(0, Math.min(255, Math.round(sample * 64 + 128)));
          }
        }
      }
    }
    this.softwareVoices = this.softwareVoices.filter(voice => !voice.softDone && !voice.forceStopped);
  }

  stop() {
    for (const route of this.softwareRoutes.values()) {
      try { route.node.disconnect(); } catch (_) {}
      route.node.onaudioprocess = null;
    }
    this.softwareRoutes.clear();
    this.softwareVoices = [];
    this.softwareSampleCache.clear();
    super.stop();
  }
}

// ── Sequencer ─────────────────────────────────────────────────────────────────

function makeTrackState(ptr) {
  return {
    ptr,                // current read position (ROM byte offset)
    wait: 0,            // remaining ticks to wait
    active: false,
    volume: 64,         // track loudness scalar from BE / track[0x12]
    pitchCoarse: 0,     // Standard/GS1: BC whole-semitone key shift
    priority: 0,        // BA / track[0x1d]
    pan: 0,             // track pan offset (from BF command, signed)
    pitchFine: 0,       // Standard: C8 TUNE 1/64-semitone units  |  GS1: C8 fine tune after subtracting 0x40
    pitchBend: 0,       // C0 BEND
    pitchBendRange: 2,  // C1 BENDR
    lfoSpeed: 0,        // C2 LFOS
    lfoDelay: 0,        // C3 LFODL
    lfoDelayCounter: 0,
    lfoDepth: 0,        // C4 MOD
    lfoMode: 0,         // C5 (both profiles)
    lfoPhase: 0,
    lfoValue: 0,
    velocity: 127,      // note velocity, reused when omitted
    lastKey: 0x80,      // cached note byte for repeat encoding
    runningStatus: 0,   // track[7]: repeated when the stream byte is < 0x80
    callStack: [0, 0, 0],
    callDepth: 0,
    loopPtr: 0,
    loopCount: 0,
    xwaitTimer: 0,
    lfoCtrl: 0,           // 0xBC in camelot: GS1 modulation/expression controller (not pitch)
    toneOverride: null,
    pseudoEchoVolume: 0,
    pseudoEchoLength: 0,
    xcmd0D: 0,
    instEntry: null,    // current instrument voicegroup entry
    voices: [],         // active AudioEngine voices
    outputGain: null,
    scopeAnalyser: null,
    scopeData: null,
    scopePeak: 0,
    scopeRms: 0,
    muted: false,
    solo: false,
    audible: true,
    noteOn: false,
    lastMidi: 0,        // last MIDI note played
    lastCmd: null,
    lastCmdPtr: ptr,
    lastArgs: [],
    lastNoteName: '',
    lastSourceKind: '',
    lastResolvedInst: null,
    psgRegs: {},
    psgLastWrite: null,
    noteCount: 0,
    cmdCount: 0,
    waitCount: 0,
  };
}

class Sequencer {
  constructor(rom, song, voiceGroup, audioEng) {
    this.rom = rom;
    this.song = song;
    this.voiceGroup = voiceGroup;
    this.audioEng = audioEng;
    this.profile = audioEng.profile || DEFAULT_ENGINE_PROFILE;
    this.tracks = song.tracks.map(ptr => makeTrackState(ptr));
    this.tracks.forEach(t => { t.active = true; });
    this._initTrackOutputs();
    this.tickCount = 0;
    this.softwareVoiceLimit = channelGroupVoiceCount(song.grp);
    this.tempoIncrement = 150; // channel_state[0x20] default
    this.tempoCounter   = 0;   // channel_state[0x22]
    this.running = false;
    this.onTrackUpdate = null; // callback(trackIdx, trackState)
    this.onDebug = null;       // callback(event)
  }

  _initTrackOutputs() {
    const ctx = this.audioEng.ctx;
    if (!ctx) return;

    // GBA reverb only applies to the PCM mixer output, not PSG channels. The
    // ARM mixer seeds each PCM buffer from the previous buffer using the song
    // reverb byte, then mixes new directsound channels on top.
    const reverbRaw = this.song ? (this.song.reverb || 0) : 0;
    this.audioEng.createPcmReverbBus(ctx, reverbRaw, this.profile, this.audioEng.soundMode);

    for (const t of this.tracks) {
      t.outputGain = ctx.createGain();
      t.outputGain.gain.value = 1;
      t.pcmReverbSend = ctx.createGain();
      t.pcmReverbSend.gain.value = 1;
      t.scopeAnalyser = ctx.createAnalyser();
      t.scopeAnalyser.fftSize = 512;
      t.scopeAnalyser.smoothingTimeConstant = 0;
      t.scopeData = new Uint8Array(t.scopeAnalyser.fftSize);
      if (this.audioEng.pcmReverbBus) t.pcmReverbSend.connect(this.audioEng.pcmReverbBus);
      t.outputGain.connect(t.scopeAnalyser);
      t.scopeAnalyser.connect(ctx.destination);
    }
  }

  setTrackMute(index, muted) {
    const t = this.tracks[index];
    if (!t) return;
    t.muted = !!muted;
    this.updateTrackGains();
    if (this.onTrackUpdate) this.onTrackUpdate(index, t);
  }

  setTrackSolo(index, solo) {
    const t = this.tracks[index];
    if (!t) return;
    t.solo = !!solo;
    this.updateTrackGains();
    for (let i = 0; i < this.tracks.length; i++) {
      if (this.onTrackUpdate) this.onTrackUpdate(i, this.tracks[i]);
    }
  }

  clearTrackIsolation() {
    for (const t of this.tracks) {
      t.muted = false;
      t.solo = false;
    }
    this.updateTrackGains();
    for (let i = 0; i < this.tracks.length; i++) {
      if (this.onTrackUpdate) this.onTrackUpdate(i, this.tracks[i]);
    }
  }

  updateTrackGains() {
    const anySolo = this.tracks.some(t => t.solo);
    const now = this.audioEng.ctx ? this.audioEng.ctx.currentTime : 0;
    for (const t of this.tracks) {
      const audible = anySolo ? (t.solo && !t.muted) : !t.muted;
      t.audible = audible;
      if (t.outputGain) {
        t.outputGain.gain.cancelScheduledValues(now);
        t.outputGain.gain.setTargetAtTime(audible ? 1 : 0, now, 0.006);
      }
      if (t.pcmReverbSend) {
        t.pcmReverbSend.gain.cancelScheduledValues(now);
        t.pcmReverbSend.gain.setTargetAtTime(audible ? 1 : 0, now, 0.006);
      }
    }
  }

  get tickSec() {
    // ticks per second = GBA VBlank * tempoIncrement / 150
    const tps = AGB_EXACT_FPS * this.tempoIncrement / 150;
    return 1 / Math.max(1, tps);
  }

  // Call this every GBA VBlank.
  tick(scheduledTime = null) {
    const run = () => {
      this.tempoCounter += this.tempoIncrement;
      while (this.tempoCounter >= 150) {
        this.tempoCounter -= 150;
        this._advanceTracks();
        this._updateVoices();
        this.tickCount++;
      }
    };
    if (scheduledTime == null || !this.audioEng.withScheduledTime) run();
    else this.audioEng.withScheduledTime(scheduledTime, run);
  }

  _advanceTracks() {
    for (let i = 0; i < this.tracks.length; i++) {
      const t = this.tracks[i];
      if (!t.active) continue;
      // Decrement wait counter
      if (t.wait > 0) {
        t.wait--;
        continue;
      }
      // Process commands until we hit a wait
      this._processTrack(t, i);
    }
  }

  _processTrack(t, trackIdx) {
    const rom = this.rom;
    let steps = 0;
    while (t.active && t.wait === 0 && steps < 256) {
      steps++;
      const ptrBefore = t.ptr;
      const rawByte = rom.u8(t.ptr);
      const repeatsStatus = rawByte < 0x80;
      let byte = rawByte;
      if (repeatsStatus) {
        byte = t.runningStatus || 0;
      } else if (byte >= 0xbd) {
        t.runningStatus = byte;
      }
      t.lastCmd = byte;
      t.lastCmdPtr = ptrBefore;
      t.lastArgs = [];

      if (byte === 0) {
        t.ptr++;
        this._emit('cmd', trackIdx, t, `missing running status at ${hex(ptrBefore, 6)}`);
        return;
      } else if (byte <= 0xb0) {
        // Wait command: byte - 0x80 indexes FBA14
        if (!repeatsStatus) t.ptr++;
        const idx = byte - 0x80;
        t.wait = (idx < FBA14.length) ? FBA14[idx] : 0;
        if (t.wait > 0) t.wait--; // Func_f9c90 decrements a newly-set wait immediately.
        t.waitCount++;
        this._emit('wait', trackIdx, t, `${cmdName(byte)} at ${hex(ptrBefore, 6)}`);
        if (this.onTrackUpdate) this.onTrackUpdate(trackIdx, t);
        return;
      } else if (byte <= 0xce) {
        // Control command
        if (!repeatsStatus) t.ptr++;
        t.cmdCount++;
        this._controlCmd(t, byte, trackIdx);
      } else {
        // Note-on (0xcf - 0xff)
        if (!repeatsStatus) t.ptr++;
        t.lastKey = byte;
        this._noteOn(t, byte, trackIdx);
      }
    }
  }

  _noteOn(t, noteByte, trackIdx) {
    const rom = this.rom;
    // Key = noteByte - 0xCF (0-48)
    const key = Math.max(0, noteByte - 0xcf);
    let durationTicks = (key < FBA14.length) ? FBA14[key] : 0;

    // Read inline args: up to 3 bytes < 0x80
    let noteMidi = -1, velocity = -1;
    for (let n = 0; n < 3; n++) {
      const b = rom.u8(t.ptr);
      if (b >= 0x80) break;
      t.ptr++;
      t.lastArgs.push(b);
      if (n === 0) noteMidi = b;
      else if (n === 1) velocity = b;
      else durationTicks = Math.min(255, durationTicks + b);
    }

    if (noteMidi < 0) noteMidi = t.lastMidi; // reuse last
    t.lastMidi = noteMidi;
    if (velocity >= 0) t.velocity = velocity;

    if (!t.instEntry) return;
    const effMidi = noteMidi;
    t.lastNoteName = noteName(effMidi);
    t.noteCount++;
    t.lfoDelayCounter = t.lfoDelay;
    if (t.lfoDelayCounter) {
      t.lfoPhase = 0;
      t.lfoValue = 0;
    }
    const pitchOffsetSemis = this._trackPitchOffset(t);
    const resolved = resolveTrackVoiceEntry(this.rom, t.instEntry, effMidi, t.toneOverride, this.profile);
    if (!resolved) return;
    const voicePan = Math.max(-64, Math.min(63, t.pan + (resolved.rhythmPan || 0)));
    const voice = this.audioEng.triggerNote(
      { ...resolved.entry, __resolvedVoice: resolved }, effMidi, t.velocity, t.volume, voicePan,
      0x40, pitchOffsetSemis, this.tickSec, durationTicks, null,
      { dry: t.outputGain, pcmReverbSend: t.pcmReverbSend },
      { regs: { ...t.psgRegs }, lastWrite: t.psgLastWrite }
    );
    if (voice) {
      t.lastSourceKind = voice.sourceKind;
      t.lastResolvedInst = voice.instrument;
      const overrideTag = t.toneOverride ? ' xcmdTone' : '';
      const rhythmPanTag = resolved.rhythmPan ? ` rpan:${resolved.rhythmPan}` : '';
      const backendTag = voice.softwareMixed ? ' swmix' : '';
      const sampleModeTag = voice.sampleInfo?.gamefreakCompressed ? ' dpcm' : '';
      const fixedTag = voice.sampleInfo?.fixedPitch ? ' fix' : '';
      const gainTag = voice.gainScale && Math.abs(voice.gainScale - 1) > 0.001 ? ` gain:${voice.gainScale.toFixed(2)}` : '';
      const mixTag = voice.outputMixGain != null ? ` mix:${voice.outputMixGain.toFixed(2)}${voice.soundModeGain != null && Math.abs(voice.soundModeGain - 1) > 0.001 ? `/sm:${voice.soundModeGain.toFixed(2)}` : ''}` : '';
      const firstSweep = voice.gbcSweepTrace?.events?.find(ev => !ev.overflow);
      const psgTag = voice.gbcFrequency
        ? ` hz:${voice.gbcFrequency.toFixed(1)} reg:${voice.gbcModel?.frequencyRegister ?? '—'}${voice.gbcModel?.rawFrequencyRegister != null ? ` rawReg:${voice.gbcModel.rawFrequencyRegister}` : ''}${voice.psgDacMaxLevel != null ? ` cgbLvl:${voice.psgDacMaxLevel}` : ''}${voice.gbcModel?.sweep && typeof voice.gbcModel.sweep === 'object' ? ` sw:${hex(voice.gbcModel.sweep.register)}` : ''}${firstSweep ? ` sw1:${firstSweep.frequencyRegister}/${firstSweep.frequency.toFixed(1)}` : ''}`
        : '';
      let rateTag = psgTag;
      if (voice.sourceKind === 'pcm') {
        rateTag = ` rate:${voice.playbackRate.toFixed(3)} arm:${voice.armNote}.${String(voice.armFrac).padStart(3, '0')} key:${voice.keyAdj}`;
      } else if (voice.sourceKind === 'synth') {
        rateTag = ` mode:${voice.synthMode || 'synth'}${voice.sampleInfo?.synthDynamicPwm ? ':dyn' : ''} hz:${(voice.rawFrequency || voice.synthBaseFrequency || 0).toFixed(1)} arm:${voice.armNote}.${String(voice.armFrac).padStart(3, '0')}`;
      }
      this._emit('note', trackIdx, t, `${t.lastNoteName} ${voice.sourceKind}${backendTag}${sampleModeTag}${fixedTag} hw:${voice.hardwareType || 0} selType:${t.instEntry.type}/${hex(t.instEntry.typeB)} resType:${voice.instrument.type}/${hex(voice.instrument.typeB)}${overrideTag}${rhythmPanTag}${gainTag}${mixTag} vol:${t.volume} vel:${t.velocity} pitch:${pitchOffsetSemis.toFixed(2)}${rateTag} dur:${durationTicks} inst:${this.voiceGroup.indexOf(t.instEntry)}${voice.tableIndex >= 0 ? `:${voice.tableIndex}` : ''}`, {
        noteMidi: effMidi,
        noteName: t.lastNoteName,
        durationTicks,
        velocity: t.velocity,
        volume: t.volume,
        bendSemis: this._trackBendOffset(t),
        pitchOffsetSemis,
        sourceKind: voice.sourceKind,
        hardwareType: voice.hardwareType || 0,
        activeUntilTick: this.tickCount + Math.max(1, durationTicks || 1),
      });
      if (voice.hardwareType) this._releaseHardwareChannel(voice.hardwareType);
      t.voices.push(voice);
      if (!voice.hardwareType) this._enforceSoftwareVoiceLimit();
      if (this.onTrackUpdate) this.onTrackUpdate(trackIdx, t);
    }
    // Track continues immediately — the next wait byte controls timing
  }

  _enforceSoftwareVoiceLimit() {
    const softwareVoices = [];
    for (const track of this.tracks) {
      for (const voice of track.voices) {
        if (!voice.hardwareType && !voice.forceStopped) softwareVoices.push({ track, voice });
      }
    }
    softwareVoices.sort((a, b) => {
      if (a.voice.released !== b.voice.released) return a.voice.released ? -1 : 1;
      const pa = a.track.priority || 0;
      const pb = b.track.priority || 0;
      if (pa !== pb) return pa - pb;
      return a.voice.startTime - b.voice.startTime;
    });
    while (softwareVoices.length > this.softwareVoiceLimit) {
      const victim = softwareVoices.shift();
      if (victim.voice.released) this.audioEng.stopVoiceNow(victim.voice);
      else this.audioEng.releaseVoice(victim.voice);
      const idx = victim.track.voices.indexOf(victim.voice);
      if (idx >= 0) victim.track.voices.splice(idx, 1);
    }
  }

  _releaseHardwareChannel(hardwareType) {
    for (const track of this.tracks) {
      for (let i = track.voices.length - 1; i >= 0; i--) {
        const existing = track.voices[i];
        if (existing.hardwareType === hardwareType) {
          this.audioEng.stopVoiceNow(existing);
          track.voices.splice(i, 1);
        }
      }
    }
  }

  _releaseTrackVoices(t) {
    for (const v of t.voices) this.audioEng.releaseVoice(v);
    t.voices = [];
  }

  _controlCmd(t, cmd, trackIdx) {
    const rom = this.rom;

    const readByte = () => {
      const b = rom.u8(t.ptr);
      t.ptr++;
      t.lastArgs.push(b);
      return b;
    };
    const readPtr = () => {
      const v = rom.u32(t.ptr);
      t.ptr += 4;
      t.lastArgs.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
      return (v >>> 24) === 8 ? (v & 0x1ffffff) : 0;
    };
    const readRawPtr = () => {
      const v = rom.u32(t.ptr) >>> 0;
      t.ptr += 4;
      t.lastArgs.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
      return v;
    };

    this._emit('cmd', trackIdx, t, `${cmdName(cmd)} at ${hex(t.lastCmdPtr, 6)}`);

    switch (cmd) {
      case 0xb1: // FINE / end track
      case 0xb6:
      case 0xb7:
      case 0xb8:
      case 0xc6:
      case 0xc7:
      case 0xc9:
      case 0xca:
      case 0xcb:
        t.active = false;
        this._releaseTrackVoices(t);
        if (this.onTrackUpdate) this.onTrackUpdate(trackIdx, t);
        return;

      case 0xb2: { // GOTO: 4-byte absolute address
        const dest = readPtr();
        if (dest) t.ptr = dest;
        return;
      }

      case 0xb3: { // PATT: call pattern
        const dest = readPtr();
        if (t.callDepth < 3) {
          t.callStack[t.callDepth++] = t.ptr;
          if (dest) t.ptr = dest;
        }
        return;
      }

      case 0xb4: // PEND: return from pattern
        if (t.callDepth > 0) {
          t.ptr = t.callStack[--t.callDepth];
        }
        return;

      case 0xb5: { // PATL: counted branch/pattern loop
        const count = rom.u8(t.ptr);
        if (count === 0) {
          t.ptr++;
          const dest = readPtr();
          if (dest) t.ptr = dest;
          return;
        }
        t.loopCount = (t.loopCount + 1) & 0xff;
        t.ptr++;
        const dest = readPtr();
        if (t.loopCount < count) {
          if (dest) t.ptr = dest;
        } else {
          t.loopCount = 0;
        }
        return;
      }

      case 0xb9: { // GS1 script VM: opcode, workspace offset, value; optional branch ptr.
        const op = readByte();
        readByte();
        readByte();
        if (op >= 0x06) t.ptr += 4;
        return;
      }

      case 0xba: { // priority/voice stealing bias
        t.priority = readByte();
        return;
      }

      case 0xbb: { // TEMPO
        const arg = readByte();
        this.tempoIncrement = Math.max(1, arg * (this.profile.tempoScale || 1));
        return;
      }

      case 0xbc: {
        const arg = readByte();
        if (this.profile.tuneMode === 'minus64') {
          t.pitchCoarse = s8(arg); // GS1: whole-semitone key shift
        } else {
          t.pitchCoarse = s8(arg); // Standard: KEYSH coarse semitone shift
        }
        this._emitPitch(trackIdx, t, 'KEYSH');
        return;
      }

      case 0xbd: { // INST: instrument select from voicegroup
        const instIdx = readByte();
        if (instIdx < this.voiceGroup.length) {
          t.instEntry = this.voiceGroup[instIdx];
          t.toneOverride = null;
        }
        if (this.onTrackUpdate) this.onTrackUpdate(trackIdx, t);
        return;
      }

      case 0xbe: { // track[0x12]: loudness scalar used by stereo coefficient calc.
        t.volume = readByte();
        return;
      }

      case 0xbf: { // PAN: arg - 0x40 → signed -64..+63
        t.pan = readByte() - 0x40;
        return;
      }

      case 0xc0: {
        const arg = readByte();
        if (this.profile.tuneMode === 'minus64') {
          t.pitchBend = s8(arg - 0x40); // GS1: pitch bend
        } else {
          t.pitchBend = s8(arg - 0x40); // Standard: BEND
        }
        this._emitPitch(trackIdx, t, 'BEND');
        return;
      }

      case 0xc1: {
        const arg = readByte();
        if (this.profile.tuneMode === 'minus64') {
          t.pitchBendRange = arg; // GS1: pitch-bend range/depth
        } else {
          t.pitchBendRange = arg; // Standard: BENDR
        }
        this._emitPitch(trackIdx, t, 'BENDR');
        return;
      }

      case 0xc2: { // LFO speed (both profiles)
        t.lfoSpeed = readByte();
        return;
      }

      case 0xc3: {
        const arg = readByte();
        if (this.profile.tuneMode === 'minus64') {
          t.lfoDelay = arg; // GS1: LFODL
        } else {
          t.lfoDelay = arg; // Standard: LFODL
        }
        return;
      }

      case 0xc4: {
        t.lfoDepth = readByte(); // Standard MOD / GS1 modulation depth
        return;
      }

      case 0xc5: { // track[0x18]: LFO/reverb mode
        t.lfoMode = readByte();
        return;
      }

      case 0xc8: {
        const arg = readByte();
        if (this.profile.tuneMode === 'minus64') {
          t.pitchFine = arg - 0x40; // GS1: fine tune in 1/64-semitone units
        } else {
          t.pitchFine = s8(arg); // Standard: TUNE fine tune in 1/64 semitone units
        }
        this._emitPitch(trackIdx, t, 'TUNE');
        return;
      }

      case 0xcc: { // PSG register write in some Sappy branches; LFOC/controller in Camelot.
        if (!this.profile.psgRegisterCommand) {
          t.lfoMode = readByte();
          return;
        }
        const offset = readByte();
        const value = readByte();
        t.psgRegs[offset & 0xff] = value & 0xff;
        if (offset >= GBA_SOUND_REG_BASE && offset < GBA_SOUND_REG_END) {
          t.psgRegs[(offset - GBA_SOUND_REG_BASE) & 0xff] = value & 0xff;
        }
        t.psgLastWrite = { offset, value, absoluteOffset: offset >= GBA_SOUND_REG_BASE ? offset : offset + GBA_SOUND_REG_BASE };
        const psgState = { regs: { ...t.psgRegs }, lastWrite: t.psgLastWrite };
        for (const voice of t.voices) this.audioEng.applyPsgRegisterWrite(voice, psgState, t.psgLastWrite);
        return;
      }

      case 0xcd: { // EXT/XCMD: Pokemon track-local tone and timing extensions.
        if (!this.profile.pokemonExtendedCommands) {
          readByte();
          return;
        }
        const subcmd = readByte();
        t.lastXcmd = subcmd;
        this._emit('xcmd', trackIdx, t, `${XCMD_NAMES[subcmd] || `x${hex(subcmd)}`} at ${hex(t.lastCmdPtr, 6)}`);
        const ensureOverride = () => (t.toneOverride ||= {});
        switch (subcmd) {
          case 0x01: { // xwave
            ensureOverride().sptr = readRawPtr();
            return;
          }
          case 0x02: // xtype
            ensureOverride().typeB = readByte();
            return;
          case 0x04: // xatta
            ensureOverride().A = readByte();
            return;
          case 0x05: // xdeca
            ensureOverride().D = readByte();
            return;
          case 0x06: // xsust
            ensureOverride().S = readByte();
            return;
          case 0x07: // xrele
            ensureOverride().R = readByte();
            return;
          case 0x08: // xiecv
            t.pseudoEchoVolume = readByte();
            return;
          case 0x09: // xiecl
            t.pseudoEchoLength = readByte();
            return;
          case 0x0a: // xleng
            ensureOverride().length = readByte();
            return;
          case 0x0b: // xswee
            ensureOverride().panSweep = readByte();
            return;
          case 0x0c: { // xwait
            const lenLo = readByte();
            const lenHi = readByte();
            const len = lenLo | (lenHi << 8);
            if (t.xwaitTimer < len) {
              t.xwaitTimer++;
              t.ptr = t.lastCmdPtr;
              t.wait = 1;
            } else {
              t.xwaitTimer = 0;
            }
            return;
          }
          case 0x0d: // Pokemon cry extension slot.
            t.xcmd0D = readRawPtr();
            return;
          default: {
            const argCount = this.profile.extendedCommandArgCounts?.[subcmd] ?? 0;
            for (let i = 0; i < argCount; i++) readByte();
            return;
          }
        }
      }

      case 0xce: { // REL: release newest active voice matching track[5]/note byte.
        const note = rom.u8(t.ptr) < 0x80 ? readByte() : t.lastMidi;
        this._releaseNote(t, note);
        return;
      }

      default:
        // Unknown command: try to skip 1 byte to avoid infinite loop
        if (cmd >= 0xb1 && cmd <= 0xce) readByte();
        return;
    }
  }

  _updateVoices() {
    for (const t of this.tracks) {
      this._updateTrackControllers(t);
      const pitchOffset = this._trackPitchOffset(t);
      const mixMod = this._trackMixMod(t);
      for (let i = t.voices.length - 1; i >= 0; i--) {
        const v = t.voices[i];
        if (v.softDone || v.forceStopped) {
          t.voices.splice(i, 1);
          continue;
        }
        if (v.released) {
          const now = this.audioEng.ctx?.currentTime ?? Infinity;
          if (v.forceStopped || v.softDone || now >= (v.releaseEndTime ?? now)) t.voices.splice(i, 1);
          continue;
        }
        const now = this.audioEng.ctx?.currentTime ?? Infinity;
        if (v.autoEndTime && now >= v.autoEndTime) {
          t.voices.splice(i, 1);
          continue;
        }
        this.audioEng.updateVoicePitch(v, pitchOffset);
        this.audioEng.updateVoiceMix(v, mixMod.volumeScale, mixMod.panMod);
        if (v.justStarted) {
          v.justStarted = false;
          continue;
        }
        if (v.durationTicks > 0) {
          v.durationTicks--;
          if (v.durationTicks === 0) {
            this.audioEng.releaseVoice(v);
          }
        }
        // durationTicks === 0 at start means hold indefinitely (released by track end/new note)
      }
    }
  }

  _updateTrackControllers(t) {
    if (!t.active || !t.lfoSpeed || !t.lfoDepth) {
      t.lfoValue = 0;
      return;
    }
    if (t.lfoDelayCounter > 0) {
      t.lfoDelayCounter--;
      t.lfoValue = 0;
      return;
    }
    t.lfoPhase = (t.lfoPhase + t.lfoSpeed) & 0xff;
    const tri = t.lfoPhase < 0x40
      ? t.lfoPhase
      : (t.lfoPhase < 0xc0 ? 0x80 - t.lfoPhase : t.lfoPhase - 0x100);
    t.lfoValue = (tri * t.lfoDepth) >> 8; // ARM: (tri * depth) >> 8, in 1/64-semitone units
  }

  _trackPitchOffset(t) {
    // AGB MPlay stores tune+bend in quarter-256ths before the final >> 8,
    // so bend/tune are 4x finer than Camelot's local approximation.
    if (this.profile.pitchFormula === 'agb-mplay') {
      const bend = (t.pitchBend * t.pitchBendRange) / 256;
      const fine = t.pitchFine / 256;
      const lfo = t.lfoMode === 0 ? t.lfoValue / 16 : 0;
      return t.pitchCoarse + bend + fine + lfo;
    }
    // Generic: coarse = BC(KEYSH), fine = C8(TUNE)/64, bend = C0*C1/64.
    // GS1: same accumulator fields after profile-specific command decoding.
    const coarse = t.pitchCoarse;
    const bend = (t.pitchBend * t.pitchBendRange) / 64;
    const fine = t.pitchFine / 64;
    const lfo = t.lfoMode === 0 ? t.lfoValue / 64 : 0;
    return coarse + bend + fine + lfo;
  }

  _trackBendOffset(t) {
    if (this.profile.pitchFormula === 'agb-mplay') {
      return (t.pitchBend * t.pitchBendRange) / 256;
    }
    return (t.pitchBend * t.pitchBendRange) / 64;
  }

  _trackMixMod(t) {
    if (t.lfoMode === 1) {
      return { volumeScale: Math.max(0, (128 + t.lfoValue) / 128), panMod: 0 };
    }
    if (t.lfoMode === 2) {
      return { volumeScale: 1, panMod: t.lfoValue };
    }
    return { volumeScale: 1, panMod: 0 };
  }

  _releaseNote(t, noteMidi) {
    for (let i = t.voices.length - 1; i >= 0; i--) {
      const v = t.voices[i];
      if (v.noteMidi === noteMidi) {
        this.audioEng.releaseVoice(v);
        break;
      }
    }
  }

  stopAll() {
    for (const t of this.tracks) {
      t.active = false;
      this._releaseTrackVoices(t);
    }
  }

  _emit(type, trackIdx, track, message, extra = null) {
    if (!this.onDebug) return;
    this.onDebug({
      type,
      trackIdx,
      tick: this.tickCount,
      ptr: track.lastCmdPtr,
      cmd: track.lastCmd,
      xcmd: type === 'xcmd' ? track.lastXcmd : null,
      message,
      ...(extra || {}),
    });
  }

  _emitPitch(trackIdx, track, label) {
    this._emit('pitch', trackIdx, track, `${label} pitch:${this._trackPitchOffset(track).toFixed(2)} bend:${this._trackBendOffset(track).toFixed(2)}`, {
      pitchCoarse: track.pitchCoarse,
      pitchFine: track.pitchFine,
      pitchBend: track.pitchBend,
      pitchBendRange: track.pitchBendRange,
      bendSemis: this._trackBendOffset(track),
      pitchOffsetSemis: this._trackPitchOffset(track),
    });
  }
}

// ── Player ────────────────────────────────────────────────────────────────────
class GS1Player {
  constructor() {
    this.rom = null;
    this.songs = [];
    this.voiceGroup = null;
    this.voiceGroupOff = 0;
    this.peakVoices = 0;
    this.backendId = 'webaudio';
    this.audioEng = this._makeAudioEngine(this.backendId);
    this.seq = null;
    this.tickInterval = null;
    this.lastFrameTime = 0;
    this.frameRemainder = 0;
    this.currentSongIdx = -1;
    this.trackCells = [];
    this.debugOpen = false;
    this.debugEvents = [];
    this.debugLastRender = 0;
    this.pianoRollEvents = [];
    this.pianoRollPitchEvents = [];
    this.pianoRollLastTick = 0;
    this.previewVoices = [];
    this.loadedInfo = null;
    this.soundMode = null;
  }

  _makeAudioEngine(backendId = 'webaudio') {
    const eng = backendId === 'software' ? new SoftwareMixerAudioEngine() : new AudioEngine();
    eng.backendId = backendId === 'software' ? 'software' : 'webaudio';
    eng.backendLabel = backendId === 'software' ? 'Software mixer (experimental)' : 'Web Audio graph';
    eng.setProfile(this.profile || DEFAULT_ENGINE_PROFILE);
    eng.soundMode = this.soundMode || null;
    if (this.rom && this.voiceGroup) eng.loadSamples(this.rom, this.voiceGroup);
    return eng;
  }

  setAudioBackend(backendId = 'webaudio') {
    const nextId = backendId === 'software' ? 'software' : 'webaudio';
    if (nextId === this.backendId) return this.audioEng;
    const selectedSong = this.currentSongIdx;
    this.stop();
    this.backendId = nextId;
    this.audioEng = this._makeAudioEngine(nextId);
    const sel = document.getElementById('backendSelect');
    if (sel) sel.value = nextId;
    updateInfoText();
    this.updateDebugPanel(true);
    this.currentSongIdx = selectedSong;
    return this.audioEng;
  }

  async loadROM(arrayBuffer, loadedInfo = null) {
    this.rom = new ROM(arrayBuffer);
    this.loadedInfo = {
      ...(loadedInfo || {}),
      header: readGbaHeader(arrayBuffer),
      size: arrayBuffer.byteLength,
    };
    this.profile = detectEngineProfile(this.loadedInfo, this.rom);
    this.soundMode = detectMp2kSoundMode(this.rom);
    this.profile = refineCamelotProfileFromRom(this.profile, this.rom, this.soundMode);
    this.loadedInfo.profile = this.profile;
    this.loadedInfo.soundMode = this.soundMode;
    this.audioEng.setProfile(this.profile);
    this.audioEng.soundMode = this.soundMode;
    if (this.soundMode?.rate) {
      GBA_MIX_RATE = this.soundMode.rate;
      const mixSel = document.getElementById('mixRateSelect');
      if (mixSel) mixSel.value = String(GBA_MIX_RATE);
    }
    if (this.soundMode?.maxChannels) {
      GBA_VOICE_LIMIT = this.soundMode.maxChannels;
      const voiceSel = document.getElementById('voiceLimitSelect');
      if (voiceSel) voiceSel.value = String(GBA_VOICE_LIMIT);
    }
    this.songTables = detectMp2kSongTables(this.rom);
    if (!this.songTables.length) throw new Error('No MP2k song table found. Is this an MP2k GBA ROM?');
    this._applySongTable(this.songTables[0]);
    return this.songs.length;
  }

  _applySongTable({ addr, songs }) {
    this.songTableAddr = addr;
    this.songs = songs;
    const firstSong = songs[0];
    this.voiceGroupOff = firstSong ? firstSong.vgPtr : 0;
    this.voiceGroup = this.voiceGroupOff ? parseVoicegroup(this.rom, this.voiceGroupOff) : [];
    indexSampleBounds(this.rom, this.voiceGroup);
  }

  setProfile(profileId) {
    const profile = ENGINE_PROFILES[profileId] || DEFAULT_ENGINE_PROFILE;
    this.profile = profile;
    if (this.loadedInfo) this.loadedInfo.profile = profile;
    this.audioEng.setProfile(profile);
    updateInfoText();
    this.updateDebugPanel(true);
    return profile;
  }

  async playSong(songTableIdx) {
    this.stop();
    const song = this.songs.find(s => s.idx === songTableIdx);
    if (!song) return;
    this.currentSongIdx = songTableIdx;
    this.peakVoices = 0;
    this.pianoRollEvents = [];
    this.pianoRollPitchEvents = [];
    this.pianoRollLastTick = 0;
    document.getElementById('polyRow').style.display = '';
    this.setVoiceGroupForSong(songTableIdx);
    const vpSel = document.getElementById('voicePoolSelect');
    if (vpSel) vpSel.value = String(this.voiceGroupOff);

    await this.audioEng.ensure();
    this.audioEng.loadSamples(this.rom, this.voiceGroup);

    this.seq = new Sequencer(this.rom, song, this.voiceGroup, this.audioEng);
    this.seq.onTrackUpdate = (i, t) => this._updateCell(i, t);
    this.seq.onDebug = ev => this._debugEvent(ev);

    // Build track cells UI
    this._buildTrackUI(song.tracks.length);
    const patchTag = song.gsfPatch ? ` patch:${song.gsfPatch.key}@${hex(song.gsfPatch.loadAddr, 8)}+${song.gsfPatch.size}` : '';
    this._debugEvent({ type:'play', trackIdx:-1, tick:0, ptr:song.hdrOff, message:`song ${songTableIdx} hdr:${hex(song.hdrOff, 6)} tracks:${song.tracks.length} grp:${song.grp} vg:${hex(this.voiceGroupOff, 6)}${patchTag}` });
    this.updateDebugPanel(true);

    // Tick at GBA VBlank cadence; schedule audio on the AudioContext timeline so
    // browser timer jitter does not collapse multiple emulated frames together.
    const VBLANK_MS = 1000 / AGB_EXACT_FPS;
    const VBLANK_SEC = VBLANK_MS / 1000;
    const AUDIO_LOOKAHEAD_SEC = 0.035;
    this.lastFrameTime = performance.now();
    this.frameRemainder = 0;
    this.audioFrameTime = (this.audioEng.ctx?.currentTime ?? 0) + AUDIO_LOOKAHEAD_SEC;
    this.tickInterval = setInterval(() => {
      if (!this.seq) return;
      const now = performance.now();
      const elapsed = Math.max(0, now - this.lastFrameTime);
      this.lastFrameTime = now;
      this.frameRemainder += elapsed / VBLANK_MS;
      const frames = Math.min(8, Math.floor(this.frameRemainder));
      if (frames === 0) return;
      this.frameRemainder -= frames;
      const minAudioTime = (this.audioEng.ctx?.currentTime ?? 0) + 0.005;
      if (this.audioFrameTime < minAudioTime) this.audioFrameTime = minAudioTime;
      for (let i = 0; i < frames; i++) {
        this.seq.tick(this.audioFrameTime);
        this.audioFrameTime += VBLANK_SEC;
      }
      this._drawLiveKeyboard();
      this.updateDebugPanel();
      // Check if all tracks ended
    if (this.seq.tracks.every(t => !t.active)) {
        this.stop();
        setStatus(`Song ${songTableIdx} ended`);
      }
    }, VBLANK_MS);

    setStatus(`Playing song ${songTableIdx} (${song.tracks.length} tracks)`);
    updateSynthPanel(`Song ${songTableIdx} voicegroup ${hex(this.voiceGroupOff, 6)} loaded.`);
    if (window.gs1Debug) updatePreviewWaveform(true);
  }

  setVoiceGroupForSong(songTableIdx) {
    const song = this.songs.find(s => s.idx === songTableIdx);
    if (!song || !this.rom || !song.vgPtr) return false;
    return this.setVoiceGroup(song.vgPtr);
  }

  setVoiceGroup(addr) {
    if (!this.rom || !addr) return false;
    if (addr !== this.voiceGroupOff) {
      this.voiceGroupOff = addr;
      this.voiceGroup = parseVoicegroup(this.rom, addr);
    }
    indexSampleBounds(this.rom, this.voiceGroup);
    return true;
  }

  allVoiceGroupAddrs() {
    const seen = new Set();
    for (const s of this.songs) if (s.vgPtr) seen.add(s.vgPtr);
    return [...seen].sort((a, b) => a - b);
  }

  stop() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    this.lastFrameTime = 0;
    this.frameRemainder = 0;
    if (this.seq) {
      this.seq.stopAll();
      this.seq = null;
    }
    this.audioEng.stop();
    this.previewVoices = [];
    this._clearTrackUI();
    document.getElementById('polyRow').style.display = 'none';
    this._drawLiveKeyboard();
    this.updateDebugPanel(true);
  }

  stopPreview() {
    for (const voice of this.previewVoices) this.audioEng.releaseVoice(voice);
    this.previewVoices = [];
  }

  _buildTrackUI(count) {
    const grid = document.getElementById('tracksGrid');
    grid.innerHTML = '';
    this.trackCells = [];
    for (let i = 0; i < count; i++) {
      const cell = document.createElement('div');
      cell.className = 'track-cell';
      cell.style.setProperty('--track-color', this._trackColor(i, 1));
      cell.style.setProperty('--track-color-soft', this._trackColor(i, 0.18));
      cell.innerHTML = `
        <div class="track-top">
          <div class="track-label">T${i}</div>
          <div class="track-buttons">
            <button class="track-toggle mute" id="tc-mute-${i}" title="Mute track ${i}">M</button>
            <button class="track-toggle solo" id="tc-solo-${i}" title="Solo track ${i}">S</button>
          </div>
        </div>
        <div class="track-inst" id="tc-inst-${i}">–</div>
        <div class="track-meter"><div class="track-meter-fill" id="tc-meter-${i}"></div></div>
        <div class="track-note" id="tc-note-${i}"></div>
      `;
      grid.appendChild(cell);
      cell.querySelector(`#tc-mute-${i}`).addEventListener('click', e => {
        e.stopPropagation();
        this.toggleTrackMute(i);
      });
      cell.querySelector(`#tc-solo-${i}`).addEventListener('click', e => {
        e.stopPropagation();
        this.toggleTrackSolo(i);
      });
      this.trackCells.push(cell);
    }
  }

  _clearTrackUI() {
    const grid = document.getElementById('tracksGrid');
    grid.innerHTML = '';
    this.trackCells = [];
  }

  toggleTrackMute(i) {
    if (!this.seq) return;
    const t = this.seq.tracks[i];
    if (!t) return;
    this.seq.setTrackMute(i, !t.muted);
    this.updateDebugPanel(true);
  }

  toggleTrackSolo(i) {
    if (!this.seq) return;
    const t = this.seq.tracks[i];
    if (!t) return;
    this.seq.setTrackSolo(i, !t.solo);
    this.updateDebugPanel(true);
  }

  clearTrackIsolation() {
    if (!this.seq) return;
    this.seq.clearTrackIsolation();
    this.updateDebugPanel(true);
  }

  _updatePolyBar() {
    if (!this.seq) return;
    const cur = this.seq.tracks.reduce((sum, t) =>
      sum + t.voices.filter(v => !v.hardwareType && !v.forceStopped).length, 0);
    const hardLim = this.seq.softwareVoiceLimit;
    if (cur > this.peakVoices) this.peakVoices = cur;
    const unlimited = hardLim >= 9999;
    const displayLim = unlimited ? this.peakVoices + 2 : hardLim;
    const pct = n => Math.min(100, displayLim > 0 ? n / displayLim * 100 : 0).toFixed(1) + '%';
    document.getElementById('polyFill').style.width = pct(cur);
    document.getElementById('polyPeak').style.left  = pct(this.peakVoices);
    document.getElementById('polyLabel').textContent = unlimited
      ? `${cur}  ↑${this.peakVoices}`
      : `${cur} / ${hardLim}  ↑${this.peakVoices}`;
  }

  _updateCell(i, t) {
    if (i === 0) this._updatePolyBar();
    const cell = this.trackCells[i];
    if (!cell) return;
    cell.style.setProperty('--track-color', this._trackColor(i, 1));
    cell.style.setProperty('--track-color-soft', this._trackColor(i, 0.18));
    cell.className = 'track-cell'
      + (t.active && t.voices.length ? ' active' : '')
      + (t.muted ? ' muted' : '')
      + (t.solo ? ' solo' : '');

    const instEl  = document.getElementById(`tc-inst-${i}`);
    const meterEl = document.getElementById(`tc-meter-${i}`);
    const noteEl  = document.getElementById(`tc-note-${i}`);
    const muteEl  = document.getElementById(`tc-mute-${i}`);
    const soloEl  = document.getElementById(`tc-solo-${i}`);

    if (muteEl) muteEl.classList.toggle('active', !!t.muted);
    if (soloEl) soloEl.classList.toggle('active', !!t.solo);

    if (t.instEntry) {
      const { typeB, keyAdj } = t.instEntry;
      instEl.textContent = `vg:${this.voiceGroup.indexOf(t.instEntry)} k${keyAdj}`;
    }
    const vol = t.voices.length ? Math.round((t.volume / 127) * 100) : 0;
    meterEl.style.width = vol + '%';

    if (t.voices.length && t.lastMidi >= 0) {
      const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
      const n = t.lastMidi;
      noteEl.textContent = NOTE_NAMES[((n % 12) + 12) % 12] + Math.floor(n / 12);
    } else {
      noteEl.textContent = '';
    }
    this._drawLiveKeyboard();
  }

  _debugEvent(ev) {
    const full = {
      time: new Date().toLocaleTimeString(),
      tick: this.seq ? this.seq.tickCount : (ev.tick || 0),
      ...ev,
    };
    this.pianoRollLastTick = Math.max(this.pianoRollLastTick, full.tick || 0);
    this.debugEvents.push(full);
    if (this.debugEvents.length > 160) this.debugEvents.shift();
    if (full.type === 'note' && full.trackIdx >= 0 && Number.isFinite(full.noteMidi)) {
      if (full.hardwareType) {
        for (let i = this.pianoRollEvents.length - 1; i >= 0; i--) {
          const prev = this.pianoRollEvents[i];
          if (prev.hardwareType !== full.hardwareType) continue;
          if ((prev.activeUntilTick ?? prev.tick) > full.tick) prev.activeUntilTick = full.tick;
          break;
        }
      }
      this.pianoRollEvents.push(full);
      if (this.pianoRollEvents.length > 900) this.pianoRollEvents.splice(0, this.pianoRollEvents.length - 900);
    } else if (full.type === 'pitch' && full.trackIdx >= 0 && Number.isFinite(full.pitchOffsetSemis)) {
      this.pianoRollPitchEvents.push(full);
      if (this.pianoRollPitchEvents.length > 1200) this.pianoRollPitchEvents.splice(0, this.pianoRollPitchEvents.length - 1200);
    }
    this._drawLiveKeyboard();
    this.updateDebugPanel();
  }

  setDebug(open) {
    this.debugOpen = open;
    const panel = document.getElementById('debugPanel');
    const btn = document.getElementById('btnDebug');
    panel.classList.toggle('open', open);
    btn.classList.toggle('active', open);
    this.updateDebugPanel(true);
  }

  clearDebugLog() {
    this.debugEvents = [];
    this.pianoRollEvents = [];
    this.pianoRollPitchEvents = [];
    this.pianoRollLastTick = 0;
    this.updateDebugPanel(true);
  }

  _readScopeNode(scopeOwner) {
    if (!scopeOwner?.scopeData) return null;
    if (!scopeOwner.scopeAnalyser) return scopeOwner.scopeData;
    scopeOwner.scopeAnalyser.getByteTimeDomainData(scopeOwner.scopeData);
    let peak = 0;
    let sumSq = 0;
    for (let i = 0; i < scopeOwner.scopeData.length; i++) {
      const v = (scopeOwner.scopeData[i] - 128) / 128;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sumSq += v * v;
    }
    scopeOwner.scopePeak = peak;
    scopeOwner.scopeRms = Math.sqrt(sumSq / scopeOwner.scopeData.length);
    return scopeOwner.scopeData;
  }

  _scopeColor(sourceKind) {
    if (sourceKind?.startsWith('gbc:')) return '#f59e0b';
    if (sourceKind === 'synth') return '#818cf8';
    if (sourceKind === 'noise' || sourceKind === 'psg4-noise') return '#e879f9';
    if (sourceKind?.startsWith('psg')) return '#38bdf8';
    return '#22c55e';
  }

  _trackColor(trackIdx, alpha = 1) {
    const palette = [
      [34, 197, 94],
      [56, 189, 248],
      [251, 191, 36],
      [244, 114, 182],
      [129, 140, 248],
      [45, 212, 191],
      [248, 113, 113],
      [163, 230, 53],
      [251, 146, 60],
      [216, 180, 254],
      [96, 165, 250],
      [250, 204, 21],
      [52, 211, 153],
      [251, 113, 133],
      [125, 211, 252],
      [192, 132, 252],
    ];
    const c = palette[((trackIdx % palette.length) + palette.length) % palette.length];
    return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
  }

  _activeKeyboardNotes() {
    if (!this.seq) return new Map();
    const nowTick = this.seq.tickCount;
    const active = new Map();
    for (const ev of this.pianoRollEvents) {
      const midi = ev.noteMidi | 0;
      const endTick = Math.max(ev.tick + 1, ev.activeUntilTick ?? (ev.tick + (ev.durationTicks || 1)));
      if (ev.tick > nowTick || endTick <= nowTick) continue;
      if (!active.has(midi)) active.set(midi, []);
      const trackIdxs = active.get(midi);
      if (!trackIdxs.includes(ev.trackIdx)) trackIdxs.push(ev.trackIdx);
    }
    return active;
  }

  _drawLiveKeyboard() {
    const canvas = document.getElementById('liveKeyboardCanvas');
    if (!canvas) return;
    const g = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    g.fillStyle = '#05070d';
    g.fillRect(0, 0, w, h);

    const minMidi = 36; // C3 in this player's note naming.
    const maxMidi = 96; // C8.
    const whiteMidis = [];
    const isBlack = midi => [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
    for (let midi = minMidi; midi <= maxMidi; midi++) if (!isBlack(midi)) whiteMidis.push(midi);
    const keyGap = 1;
    const whiteW = w / whiteMidis.length;
    const whiteH = h - 18;
    const blackW = Math.max(5, whiteW * 0.62);
    const blackH = whiteH * 0.62;
    const xByMidi = new Map();
    whiteMidis.forEach((midi, i) => xByMidi.set(midi, i * whiteW));
    const active = this._activeKeyboardNotes();
    const activeNames = [];

    const fillActive = (midi, x, y, kw, kh) => {
      const tracks = active.get(midi);
      if (!tracks?.length) return;
      activeNames.push(`${noteName(midi)}:T${[...new Set(tracks)].join('/T')}`);
      const stripeW = kw / tracks.length;
      tracks.forEach((trackIdx, i) => {
        g.fillStyle = this._trackColor(trackIdx, 0.9);
        g.fillRect(x + i * stripeW, y, stripeW, kh);
      });
    };

    for (const midi of whiteMidis) {
      const x = xByMidi.get(midi);
      g.fillStyle = '#dbe4ef';
      g.fillRect(x + keyGap / 2, 0, whiteW - keyGap, whiteH);
      fillActive(midi, x + keyGap / 2, 0, whiteW - keyGap, whiteH);
      g.strokeStyle = '#64748b';
      g.strokeRect(x + keyGap / 2, 0, whiteW - keyGap, whiteH);
      if (midi % 12 === 0) {
        g.fillStyle = active.has(midi) ? '#f8fafc' : '#334155';
        g.font = '10px monospace';
        g.textAlign = 'center';
        g.fillText(noteName(midi), x + whiteW / 2, h - 5);
      }
    }

    for (let midi = minMidi; midi <= maxMidi; midi++) {
      if (!isBlack(midi)) continue;
      const prevWhite = midi - 1;
      if (!xByMidi.has(prevWhite)) continue;
      const x = xByMidi.get(prevWhite) + whiteW - blackW / 2;
      g.fillStyle = '#020617';
      g.fillRect(x, 0, blackW, blackH);
      fillActive(midi, x, 0, blackW, blackH);
      g.strokeStyle = '#0f172a';
      g.strokeRect(x, 0, blackW, blackH);
    }

    const activeEl = document.getElementById('liveKeyboardActive');
    if (activeEl) activeEl.textContent = activeNames.length ? activeNames.slice(0, 8).join('  ') : '';
  }

  _pianoRollPitchPoints(noteEvent, endTick) {
    const points = [{ tick: noteEvent.tick, pitchOffsetSemis: noteEvent.pitchOffsetSemis || 0 }];
    for (const ev of this.pianoRollPitchEvents) {
      if (ev.trackIdx !== noteEvent.trackIdx) continue;
      if (ev.tick <= noteEvent.tick || ev.tick > endTick) continue;
      points.push({ tick: ev.tick, pitchOffsetSemis: ev.pitchOffsetSemis || 0 });
    }
    points.sort((a, b) => a.tick - b.tick);
    if (points[points.length - 1].tick < endTick) {
      points.push({ tick: endTick, pitchOffsetSemis: points[points.length - 1].pitchOffsetSemis });
    }
    return points;
  }

  _drawPianoRoll() {
    const canvas = document.getElementById('pianoRollCanvas');
    if (!canvas) return;
    const g = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    g.fillStyle = '#05070d';
    g.fillRect(0, 0, w, h);

    const seq = this.seq;
    const nowTick = seq ? seq.tickCount : this.pianoRollLastTick;
    const windowTicks = 168;
    const startTick = Math.max(0, nowTick - windowTicks);
    const notes = this.pianoRollEvents.filter(ev =>
      (ev.activeUntilTick ?? (ev.tick + (ev.durationTicks || 1))) >= startTick &&
      ev.tick <= nowTick + 2
    );
    const noteViews = notes.map(ev => {
      const midi = ev.noteMidi | 0;
      const endTick = Math.max(ev.tick + 1, ev.activeUntilTick ?? (ev.tick + (ev.durationTicks || 1)));
      const pitchPoints = this._pianoRollPitchPoints(ev, endTick);
      const pitchValues = pitchPoints.map(point => midi + point.pitchOffsetSemis);
      return { ev, midi, endTick, pitchPoints, minPitch: Math.min(...pitchValues), maxPitch: Math.max(...pitchValues) };
    });
    const visiblePitches = noteViews.flatMap(view => [view.minPitch, view.maxPitch]);
    const minNote = visiblePitches.length ? Math.max(24, Math.floor(Math.min(...visiblePitches)) - 4) : 36;
    const maxNote = visiblePitches.length ? Math.min(108, Math.ceil(Math.max(...visiblePitches)) + 4) : 96;
    const keyW = 46;
    const top = 8;
    const bottom = 18;
    const rollX = keyW;
    const rollW = w - rollX - 8;
    const rollH = h - top - bottom;
    const noteCount = Math.max(1, maxNote - minNote + 1);
    const rowH = rollH / noteCount;
    const isBlack = midi => [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
    const yFor = pitch => top + (maxNote - pitch) * rowH;
    const xFor = tick => rollX + ((tick - startTick) / windowTicks) * rollW;

    for (let midi = minNote; midi <= maxNote; midi++) {
      const y = yFor(midi);
      g.fillStyle = isBlack(midi) ? '#070b13' : '#0a1020';
      g.fillRect(0, y, w, Math.max(1, rowH));
      if (midi % 12 === 0) {
        g.strokeStyle = '#1f2937';
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(w, y);
        g.stroke();
        g.fillStyle = '#64748b';
        g.font = '8px monospace';
        g.textBaseline = 'middle';
        g.fillText(noteName(midi), 5, y + rowH / 2);
      }
    }

    g.strokeStyle = '#111827';
    for (let i = 0; i <= 4; i++) {
      const x = rollX + (rollW * i / 4);
      g.beginPath();
      g.moveTo(x, top);
      g.lineTo(x, h - bottom);
      g.stroke();
    }

    const activePitches = [];
    const pitchTraces = [];
    for (const view of noteViews) {
      const { ev, midi, endTick, pitchPoints } = view;
      const x0 = Math.max(rollX, xFor(ev.tick));
      const x1 = Math.min(rollX + rollW, xFor(endTick));
      const startPitch = midi + (pitchPoints[0]?.pitchOffsetSemis || 0);
      const y = yFor(startPitch) + 1;
      const height = Math.max(2, rowH - 2);
      const active = ev.tick <= nowTick && endTick > nowTick;
      const alpha = active ? 0.95 : 0.58;
      g.fillStyle = this._trackColor(ev.trackIdx, alpha);
      g.fillRect(x0, y, Math.max(2, x1 - x0), height);
      if (Math.abs(startPitch - midi) >= 0.01) {
        g.strokeStyle = this._trackColor(ev.trackIdx, 0.45);
        g.lineWidth = 1;
        g.setLineDash([3, 3]);
        const baseY = yFor(midi) + rowH / 2;
        g.beginPath();
        g.moveTo(x0, baseY);
        g.lineTo(x1, baseY);
        g.stroke();
        g.setLineDash([]);
      }
      if (pitchPoints.some(point => Math.abs(point.pitchOffsetSemis) >= 0.01)) {
        pitchTraces.push({ ev, midi, endTick, x0, x1, y, height, pitchPoints });
      }
      if (active) {
        let activePitch = startPitch;
        for (const point of pitchPoints) {
          if (point.tick <= nowTick) activePitch = midi + point.pitchOffsetSemis;
        }
        activePitches.push({ pitch: activePitch, midi, trackIdx: ev.trackIdx });
      }
    }

    for (const trace of pitchTraces) {
      g.strokeStyle = '#f8fafc';
      g.lineWidth = 1.25;
      g.beginPath();
      trace.pitchPoints.forEach((point, i) => {
        const x = Math.max(trace.x0, Math.min(trace.x1, xFor(point.tick)));
        const y = Math.max(top, Math.min(h - bottom, yFor(trace.midi + point.pitchOffsetSemis) + rowH / 2));
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      });
      g.stroke();
      g.strokeStyle = this._trackColor(trace.ev.trackIdx, 0.95);
      g.lineWidth = 0.75;
      g.stroke();
    }

    const activeGroups = new Map();
    for (const item of activePitches) {
      const key = item.pitch.toFixed(2);
      if (!activeGroups.has(key)) activeGroups.set(key, { pitch: item.pitch, midi: item.midi, trackIdxs: [] });
      const group = activeGroups.get(key);
      if (!group.trackIdxs.includes(item.trackIdx)) group.trackIdxs.push(item.trackIdx);
    }
    for (const { pitch, midi, trackIdxs } of activeGroups.values()) {
      const y = yFor(pitch);
      const sliceW = keyW / Math.max(1, trackIdxs.length);
      trackIdxs.forEach((trackIdx, i) => {
        g.fillStyle = this._trackColor(trackIdx, 0.9);
        g.fillRect(i * sliceW, y, sliceW, Math.max(2, rowH));
      });
      g.fillStyle = '#f8fafc';
      g.font = '8px monospace';
      g.textBaseline = 'middle';
      g.fillText(Math.abs(pitch - midi) >= 0.01 ? `${noteName(midi)}>${noteName(Math.round(pitch))}` : noteName(midi), 5, y + rowH / 2);
    }

    g.strokeStyle = '#e5e7eb';
    g.beginPath();
    g.moveTo(rollX + rollW, top);
    g.lineTo(rollX + rollW, h - bottom);
    g.stroke();
    g.fillStyle = '#64748b';
    g.font = '8px monospace';
    g.textAlign = 'right';
    g.fillText(`tick ${nowTick}`, w - 8, h - 6);
    g.textAlign = 'left';
  }

  _drawScope(canvas, scopeOwner, sourceKind, active = true) {
    const data = this._readScopeNode(scopeOwner);
    const g = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    g.fillStyle = '#05070d';
    g.fillRect(0, 0, w, h);
    g.strokeStyle = '#1f2937';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, h / 2);
    g.lineTo(w, h / 2);
    g.stroke();

    if (!data || !active || scopeOwner.scopePeak < 0.004) {
      g.fillStyle = '#374151';
      g.fillRect(0, h / 2 - 1, w, 2);
      return;
    }

    g.strokeStyle = this._scopeColor(sourceKind);
    g.lineWidth = 1.5;
    g.beginPath();
    const step = data.length / w;
    for (let x = 0; x < w; x++) {
      const idx = Math.min(data.length - 1, Math.floor(x * step));
      const v = (data[idx] - 128) / 128;
      const y = h / 2 + v * (h * 0.44);
      if (x === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }

  _drawScopes() {
    if (!this.seq) return;
    document.querySelectorAll('canvas[data-scope-track]').forEach(canvas => {
      const idx = Number(canvas.dataset.scopeTrack);
      const t = this.seq.tracks[idx];
      if (t) this._drawScope(canvas, t, t.lastSourceKind, !!t.voices.length);
    });
    document.querySelectorAll('canvas[data-scope-voice]').forEach(canvas => {
      const trackIdx = Number(canvas.dataset.scopeTrackVoice);
      const voiceIdx = Number(canvas.dataset.scopeVoice);
      const voice = this.seq.tracks[trackIdx]?.voices[voiceIdx];
      if (voice) this._drawScope(canvas, voice, voice.sourceKind, !voice.released);
    });
  }

  updateDebugPanel(force = false) {
    if (!this.debugOpen && !force) return;
    const now = performance.now();
    if (!force && now - this.debugLastRender < 120) return;
    this.debugLastRender = now;

    const statsEl = document.getElementById('debugStats');
    const tracksEl = document.getElementById('debugTracks');
    const logEl = document.getElementById('debugLog');
    const infoEl = document.getElementById('debugInfo');
    const rollLegendEl = document.getElementById('pianoRollLegend');
    const song = this.songs.find(s => s.idx === this.currentSongIdx);
    const seq = this.seq;

    const activeVoices = seq ? seq.tracks.reduce((sum, t) => sum + t.voices.length, 0) : 0;
    const softwareVoiceUse = seq ? seq.tracks.reduce((sum, t) => sum + t.voices.filter(v => !v.hardwareType && !v.forceStopped).length, 0) : 0;
    statsEl.innerHTML = [
      ['Song', song ? `${song.idx}` : '—'],
      ['Header', song ? hex(song.hdrOff, 6) : '—'],
      ['Tick/Tempo', seq ? `${seq.tickCount} / ${seq.tempoIncrement}` : '—'],
      ['Voices', activeVoices],
      ['Soft Pool', seq ? `${seq.softwareVoiceLimit} (${softwareVoiceUse} used)` : '—'],
      ['Tracks', song ? `${song.tracks.length} / hdr ${song.tc}` : '—'],
      ['Group', song ? song.grp : '—'],
      ['Reverb', song ? `${hex(song.reverb)}${this.audioEng.pcmReverbInfo?.wetLevel ? ` ${this.audioEng.pcmReverbInfo.type || 'normal'} wet ${this.audioEng.pcmReverbInfo.wetLevel.toFixed(2)} buffers ${this.audioEng.pcmReverbInfo.numDmaBuffers || 0}` : ''}` : '—'],
      ['Profile', this.profile ? this.profile.id : '—'],
      ['Audio', `${this.audioEng.backendLabel || this.backendId || 'Web Audio graph'} / ${this.audioEng.ctx ? this.audioEng.ctx.state : 'closed'}`],
    ].map(([k, v]) => `<div class="debug-stat"><span>${k}</span><b>${v}</b></div>`).join('');

    if (rollLegendEl) {
      rollLegendEl.innerHTML = seq
        ? seq.tracks.map((t, i) => `<span title="Track ${i}${t.lastSourceKind ? ` ${t.lastSourceKind}` : ''}"><i style="background:${this._trackColor(i, 1)}"></i>T${i}</span>`).join('')
        : '';
    }

    tracksEl.innerHTML = seq ? seq.tracks.map((t, i) => {
      const instIdx = t.instEntry ? this.voiceGroup.indexOf(t.instEntry) : -1;
      const nextByte = this.rom ? this.rom.u8(t.ptr) : null;
      const lastVoice = t.voices[t.voices.length - 1];
      const pitchOffset = seq._trackPitchOffset(t);
      const voiceScopes = t.voices.map((v, vi) => {
        const label = `${vi}:${v.noteMidi >= 0 ? noteName(v.noteMidi) : '—'}`;
        return `<div class="voice-scope-row">
          <span class="voice-scope-label" title="${v.sourceKind} peak ${(v.scopePeak || 0).toFixed(3)} rms ${(v.scopeRms || 0).toFixed(3)}">${label}</span>
          <canvas class="scope-canvas voice-scope" width="128" height="18" data-scope-track-voice="${i}" data-scope-voice="${vi}" title="${v.sourceKind} peak ${(v.scopePeak || 0).toFixed(3)} rms ${(v.scopeRms || 0).toFixed(3)}"></canvas>
        </div>`;
      }).join('');
      return `<tr style="border-left:2px solid ${this._trackColor(i, 1)}">
        <td style="color:${this._trackColor(i, 1)}">${i}</td>
        <td>${t.active ? 'run' : 'off'}</td>
        <td>${hex(t.ptr, 6)}</td>
        <td>${cmdName(nextByte)}</td>
        <td>${t.wait}</td>
        <td>${instIdx >= 0 ? instIdx : '—'}</td>
        <td>${t.lastSourceKind || '—'}</td>
        <td class="scope-cell">
          <div class="scope-stack">
            <canvas class="scope-canvas" width="172" height="30" data-scope-track="${i}" title="mix peak ${(t.scopePeak || 0).toFixed(3)} rms ${(t.scopeRms || 0).toFixed(3)}"></canvas>
            ${voiceScopes || '<div class="voice-scope-row"><span class="voice-scope-label">no voice</span><canvas class="scope-canvas voice-scope" width="128" height="18"></canvas></div>'}
          </div>
        </td>
        <td>${t.volume}</td>
        <td>${t.velocity}</td>
        <td>${t.pan}</td>
        <td>${pitchOffset.toFixed(2)}</td>
        <td>${t.pitchBend}/${t.pitchBendRange}</td>
        <td>${t.lfoSpeed}/${t.lfoDepth}/${t.lfoDelayCounter}${t.lfoMode ? ` m${t.lfoMode}` : ''}</td>
        <td>${t.lastNoteName || '—'}</td>
        <td>${lastVoice ? (lastVoice.gbcFrequency ? `${lastVoice.gbcFrequency.toFixed(1)}Hz` : (lastVoice.rawFrequency ? `${lastVoice.rawFrequency.toFixed(1)}Hz${lastVoice.synthEffectivePeriod ? `/p${lastVoice.synthEffectivePeriod}` : ''}` : lastVoice.playbackRate.toFixed(3))) : '—'}</td>
        <td>${t.voices.length}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="17">No active sequencer.</td></tr>';
    this._drawPianoRoll();
    this._drawScopes();

    logEl.textContent = this.debugEvents.slice(-80).map(ev => {
      const tr = ev.trackIdx >= 0 ? `T${ev.trackIdx}` : '--';
      return `${String(ev.tick).padStart(5, ' ')} ${tr} ${ev.type.padEnd(5)} ${ev.message || cmdName(ev.cmd)}`;
    }).join('\n');
    logEl.scrollTop = logEl.scrollHeight;

    const activeInst = seq && seq.tracks.find(t => t.instEntry)?.instEntry;
    const activeInstIdx = activeInst ? this.voiceGroup.indexOf(activeInst) : -1;
    infoEl.textContent = activeInst
      ? `${instSummary(activeInst, activeInstIdx)}\n${sampleSummary(this.rom, activeInst)}\nBuild: ${PLAYER_BUILD} | Voicegroup: ${hex(this.voiceGroupOff, 6)}\nScopes: top trace is channel mix; rows below are active voices. Green PCM, violet ROM synth loop, amber GBC-style synth, blue PSG, magenta noise.\nConsole helpers: gs1Debug.state(), song(id), auditSong(id,ticks), polyphony(song,min), psgUsage(), playInst(inst,note), waveform(inst,mode), waveformUrl(inst,mode), synth(mode,inst), synthState(), clearSynth(inst), mute(i), solo(i), clearSolo(), track(i), inst(i), resolveInst(i,note), sample(i), bytes(offset,len), setDebug(true|false).`
      : `Build: ${PLAYER_BUILD} | Voicegroup: ${hex(this.voiceGroupOff, 6)}\nScopes: top trace is channel mix; rows below are active voices. Green PCM, violet ROM synth loop, amber GBC-style synth, blue PSG, magenta noise.\nConsole helpers: gs1Debug.state(), song(id), auditSong(id,ticks), polyphony(song,min), psgUsage(), playInst(inst,note), waveform(inst,mode), waveformUrl(inst,mode), synth(mode,inst), synthState(), clearSynth(inst), mute(i), solo(i), clearSolo(), track(i), inst(i), resolveInst(i,note), sample(i), bytes(offset,len), setDebug(true|false).`;
  }

  debugSnapshot() {
    const song = this.songs.find(s => s.idx === this.currentSongIdx) || null;
    const softwareVoices = this.seq ? this.seq.tracks.flatMap((t, trackIdx) =>
      t.voices
        .filter(v => !v.hardwareType && !v.forceStopped)
        .map(v => ({ trackIdx, released: !!v.released, note: v.noteMidi, sourceKind: v.sourceKind }))
    ) : [];
    return {
      currentSongIdx: this.currentSongIdx,
      build: PLAYER_BUILD,
      song,
      voiceGroupOff: this.voiceGroupOff,
      backend: this.audioEng.backendId || this.backendId || 'webaudio',
      audioState: this.audioEng.ctx ? this.audioEng.ctx.state : 'closed',
      cacheSize: this.audioEng.sampleCache.size,
      softwareVoicePool: {
        limit: this.seq ? this.seq.softwareVoiceLimit : (song ? channelGroupVoiceCount(song.grp) : 8),
        active: softwareVoices.filter(v => !v.released).length,
        releaseTails: softwareVoices.filter(v => v.released).length,
        total: softwareVoices.length,
        voices: softwareVoices,
      },
      synth: this.audioEng.synthDebugState(),
      sequencer: this.seq ? {
        tickCount: this.seq.tickCount,
        softwareVoiceLimit: this.seq.softwareVoiceLimit,
        tempoIncrement: this.seq.tempoIncrement,
        tempoCounter: this.seq.tempoCounter,
        tracks: this.seq.tracks.map((t, i) => this.debugTrack(i)),
      } : null,
      recentEvents: this.debugEvents.slice(-20),
    };
  }

  auditSong(songTableIdx = this.currentSongIdx, maxTicks = 7200) {
    const song = this.songs.find(s => s.idx === songTableIdx) || this.songs[songTableIdx] || null;
    if (!song) return null;

    const silentAudio = {
      profile: this.profile || DEFAULT_ENGINE_PROFILE,
      triggerNote: (instEntry, noteMidi, velocity, volume, panOffset, tune, pitchOffsetSemis, tickSec, durationTicks) => {
        const resolved = instEntry?.__resolvedVoice || resolveVoiceEntry(this.rom, instEntry, noteMidi, this.profile);
        if (!resolved) return null;
        return {
          released: false,
          durationTicks,
          noteMidi,
          pitchNote: resolved.pitchNote,
          velocity,
          playbackRate: 0,
          sourceKind: resolved.entry.type === 0 ? 'pcm' : `type${resolved.entry.type}`,
          instrument: resolved.entry,
          parentInstrument: resolved.parent,
          tableIndex: resolved.tableIndex,
        };
      },
      updateVoicePitch: () => {},
      updateVoiceMix: () => {},
      releaseVoice: voice => { if (voice) voice.released = true; },
    };

    const seq = new Sequencer(this.rom, song, this.voiceGroup, silentAudio);
    const commands = {};
    const recent = [];
    seq.onDebug = ev => {
      const name = ev.type === 'xcmd'
        ? `EXT:${XCMD_NAMES[ev.xcmd] || hex(ev.xcmd)}`
        : (ev.cmd != null ? cmdName(ev.cmd) : ev.type);
      commands[name] = (commands[name] || 0) + 1;
      if (recent.length < 80) recent.push({ tick: ev.tick, track: ev.trackIdx, type: ev.type, cmd: name, ptr: hex(ev.ptr, 6), message: ev.message });
    };

    let frames = 0;
    while (frames < maxTicks && seq.tracks.some(t => t.active)) {
      seq.tick();
      frames++;
    }

    return {
      song: {
        idx: song.idx,
        name: `Song ${song.idx}`,
        header: hex(song.hdrOff, 6),
        tracks: song.tracks.length,
        group: song.grp,
      },
      frames,
      ended: seq.tracks.every(t => !t.active),
      tempoIncrement: seq.tempoIncrement,
      commands,
      tracks: seq.tracks.map((t, i) => ({
        index: i,
        active: t.active,
        ptr: hex(t.ptr, 6),
        next: cmdName(this.rom.u8(t.ptr)),
        notes: t.noteCount,
        waits: t.waitCount,
        commands: t.cmdCount,
        instIdx: t.instEntry ? this.voiceGroup.indexOf(t.instEntry) : -1,
        volume: t.volume,
        velocity: t.velocity,
        pan: t.pan,
        muted: t.muted,
        solo: t.solo,
        audible: t.audible,
        pitchFine: t.pitchFine,
        pitchCoarse: t.pitchCoarse,
        pitchBend: t.pitchBend,
        pitchBendRange: t.pitchBendRange,
        lfoSpeed: t.lfoSpeed,
        lfoDelay: t.lfoDelay,
        lfoDepth: t.lfoDepth,
        lfoMode: t.lfoMode,
        pitchOffset: seq._trackPitchOffset(t),
        voices: t.voices.length,
      })),
      recent,
    };
  }

  debugTrack(i) {
    if (!this.seq || !this.seq.tracks[i]) return null;
    const t = this.seq.tracks[i];
    const instIdx = t.instEntry ? this.voiceGroup.indexOf(t.instEntry) : -1;
    return {
      index: i,
      active: t.active,
      ptr: t.ptr,
      ptrHex: hex(t.ptr, 6),
      nextByte: this.rom ? this.rom.u8(t.ptr) : null,
      next: this.rom ? cmdName(this.rom.u8(t.ptr)) : '—',
      wait: t.wait,
      muted: t.muted,
      solo: t.solo,
      audible: t.audible,
      volume: t.volume,
      velocity: t.velocity,
      priority: t.priority,
      runningStatus: hex(t.runningStatus),
      pitchCoarse: t.pitchCoarse,
      pan: t.pan,
        pitchFine: t.pitchFine,
      pitchBend: t.pitchBend,
      pitchBendRange: t.pitchBendRange,
      lfoSpeed: t.lfoSpeed,
      lfoDelay: t.lfoDelay,
      lfoDelayCounter: t.lfoDelayCounter,
      lfoDepth: t.lfoDepth,
      lfoMode: t.lfoMode,
      lfoValue: t.lfoValue,
      pitchOffset: this.seq ? this.seq._trackPitchOffset(t) : 0,
      lastCmd: t.lastCmd,
      lastCmdName: cmdName(t.lastCmd),
      lastCmdPtr: t.lastCmdPtr,
      lastArgs: [...t.lastArgs],
      instIdx,
      instrument: t.instEntry,
      lastMidi: t.lastMidi,
      lastNoteName: t.lastNoteName,
      lastSourceKind: t.lastSourceKind,
      lastResolvedInst: t.lastResolvedInst,
      voices: t.voices.length,
      playbackRates: t.voices.map(v => v.playbackRate),
      rawPlaybackRates: t.voices.map(v => v.rawPlaybackRate),
      aliasFolded: t.voices.map(v => v.aliasFolded),
      synthModes: t.voices.map(v => v.synthMode),
      synthModeSources: t.voices.map(v => v.synthModeSource),
      synthEffectivePeriods: t.voices.map(v => v.synthEffectivePeriod || 0),
      synthRenderLoopLengths: t.voices.map(v => v.synthRenderLoopLength || 0),
      synthDcOffsetsRemoved: t.voices.map(v => v.synthDcOffsetRemoved || 0),
      synthLoopEnabled: t.voices.map(v => v.synthLoopEnabled),
      armPitch: t.voices.map(v => ({ step: v.armStep || 0, note: v.armNote || 0, frac: v.armFrac || 0 })),
      rawFrequencies: t.voices.map(v => v.rawFrequency),
      foldedFrequencies: t.voices.map(v => v.foldedFrequency),
      psgRegs: Object.fromEntries(Object.entries(t.psgRegs || {}).map(([k, v]) => [hex(Number(k)), hex(v)])),
      psgLastWrite: t.psgLastWrite ? { offset: hex(t.psgLastWrite.offset), absoluteOffset: hex(t.psgLastWrite.absoluteOffset), value: hex(t.psgLastWrite.value) } : null,
      psgLiveWrites: t.voices.map(v => v.psgLastLiveWrite ? { offset: hex(v.psgLastLiveWrite.offset), absoluteOffset: hex(v.psgLastLiveWrite.absoluteOffset), value: hex(v.psgLastLiveWrite.value) } : null),
      psgFrequencyLocked: t.voices.map(v => !!v.psgFrequencyLocked),
      psgDacLevels: t.voices.map(v => v.src?.apuLevel ? v.src.apuLevel.valueAt(this.audioEng.ctx?.currentTime ?? 0) : null),
      psgDacMaxLevels: t.voices.map(v => v.psgDacMaxLevel ?? null),
      gbcFrequencies: t.voices.map(v => v.gbcFrequency || 0),
      gbcSweepTraces: t.voices.map(v => v.gbcSweepTrace || null),
      hardwareLengthSeconds: t.voices.map(v => v.hardwareLengthSec || 0),
      gbcModels: t.voices.map(v => v.gbcModel),
      scope: {
        peak: t.scopePeak,
        rms: t.scopeRms,
        analyserFftSize: t.scopeAnalyser?.fftSize || 0,
        voices: t.voices.map((v, i) => ({
          index: i,
          note: v.noteMidi,
          noteName: v.noteMidi >= 0 ? noteName(v.noteMidi) : '',
          sourceKind: v.sourceKind,
          peak: v.scopePeak || 0,
          rms: v.scopeRms || 0,
          analyserFftSize: v.scopeAnalyser?.fftSize || 0,
        })),
      },
      noteCount: t.noteCount,
      cmdCount: t.cmdCount,
      waitCount: t.waitCount,
    };
  }

  debugSample(i) {
    if (!this.rom || !this.voiceGroup) return null;
    const entry = this.voiceGroup[i];
    if (!entry) return null;
    const sample = parseSample(this.rom, entry.sptr);
    return {
      instrument: i,
      instrumentSummary: instSummary(entry, i),
      sampleSummary: sampleSummary(this.rom, entry),
      sample,
    };
  }
}

// ── UI ─────────────────────────────────────────────────────────────────────────
const player = new GS1Player();
const standardGsfEngine = window.StandardGsfEngine ? new window.StandardGsfEngine() : null;
player._drawLiveKeyboard();
let currentSongListIdx = 0;

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

function synthOptionHTML(selected = 'rom') {
  return Object.entries(SYNTH_PRESETS)
    .map(([mode, preset]) => `<option value="${mode}"${mode === selected ? ' selected' : ''}>${mode} - ${preset.label}</option>`)
    .join('');
}

function sampleForVoiceEntry(entry) {
  if (!player.rom || !entry || entry.type !== 0) return null;
  const sample = parseSample(player.rom, entry.sptr);
  return sample && sample.data.length ? sample : null;
}

function resolveSampleVoice(instEntry, preferredNote = 60) {
  if (!player.rom || !instEntry) return null;
  const tryNote = note => {
    const resolved = resolveVoiceEntry(player.rom, instEntry, note, player.profile);
    const sample = sampleForVoiceEntry(resolved?.entry);
    return sample ? { ...resolved, sample, note } : null;
  };
  const preferred = tryNote(preferredNote);
  if (preferred) return preferred;
  const key = tryNote(instEntry.keyAdj || 60);
  if (key) return key;
  for (let note = 0; note < 128; note++) {
    const resolved = tryNote(note);
    if (resolved) return resolved;
  }
  return null;
}

function isVoiceEntryAvailable(entry, kind = 'sample') {
  if (!entry) return false;
  if (kind === 'playable') {
    if (entry.type >= 1 && entry.type <= 4) return true;
    if (entry.typeB & 0xc0) return !!resolveSampleVoice(entry);
    return !!sampleForVoiceEntry(entry);
  }
  if (kind === 'synth') {
    const resolved = resolveSampleVoice(entry);
    const sample = resolved?.sample;
    const loopLen = sample ? sample.loopEnd - sample.loopStart : 0;
    const camelotSynth = player.profile?.camelotSynths && sample?.looped && sample.rawLoopEnd === 0 && loopLen > 0 && loopLen <= ROM_SYNTH_TINY_LOOP_MAX;
    const loopSynth = sample?.looped && sample.rawLoopEnd > sample.loopStart && loopLen > 0 && loopLen <= 64;
    return !!(camelotSynth || loopSynth);
  }
  return !!resolveSampleVoice(entry);
}

function voiceEntryKind(entry) {
  if (!entry) return 'missing';
  if (entry.type === 1) return 'psg1 pulse';
  if (entry.type === 2) return 'psg2 pulse';
  if (entry.type === 3) return 'psg3 wave';
  if (entry.type === 4) return 'psg4 noise';
  const resolved = resolveSampleVoice(entry);
  const sample = resolved?.sample;
  const loopLen = sample ? sample.loopEnd - sample.loopStart : 0;
  const isLoopSynth = sample?.looped && sample.rawLoopEnd > sample.loopStart && loopLen > 0 && loopLen <= 64;
  const isCamelotSynth = player.profile?.camelotSynths && sample?.looped && sample.rawLoopEnd === 0 && loopLen > 0 && loopLen <= ROM_SYNTH_TINY_LOOP_MAX;
  if (entry.typeB & 0xc0) {
    if (isLoopSynth) return `key split loop synth`;
    if (isCamelotSynth) return `key split camelot synth`;
    if (sample) return `key split ${sample.looped ? 'looped pcm' : 'pcm'}`;
    return 'key split';
  }
  if (!player.rom) return `type ${entry.type}`;
  if (isLoopSynth) return 'loop synth';
  if (isCamelotSynth) return 'camelot synth';
  if (sample) return sample.looped ? 'looped pcm' : 'pcm';
  return `type ${entry.type}`;
}

function voiceOptionLabel(entry, idx) {
  const kind = voiceEntryKind(entry);
  const key = noteName(entry.keyAdj || 60);
  const resolved = resolveSampleVoice(entry);
  const child = resolved && resolved.tableIndex >= 0 ? ` -> ${resolved.tableIndex}@${noteName(resolved.note)}` : '';
  const ptr = resolved?.entry?.sptr ?? entry.sptr;
  return `${idx} - ${kind}${child} key ${key} ptr ${hex(ptr, 8)}`;
}

function availableVoiceIndices(kind = 'sample') {
  if (!player.voiceGroup) return [];
  return player.voiceGroup
    .map((entry, idx) => ({ entry, idx }))
    .filter(({ entry }) => isVoiceEntryAvailable(entry, kind))
    .map(({ idx }) => idx);
}

function populateVoiceSelect(id, preferred = null, kind = 'sample') {
  const sel = document.getElementById(id);
  if (!sel) return null;
  const current = sel.value === '' ? NaN : Number(sel.value);
  const previous = Number.isFinite(current) ? current : preferred;
  const indices = availableVoiceIndices(kind);
  if (!indices.length) {
    sel.innerHTML = '<option value="0">No sample-backed voices</option>';
    return null;
  }
  sel.innerHTML = indices.map(idx => {
    const entry = player.voiceGroup[idx];
    return `<option value="${idx}">${voiceOptionLabel(entry, idx)}</option>`;
  }).join('');
  const next = indices.includes(previous) ? previous : indices[0];
  sel.value = String(next);
  return next;
}

function populateVoiceSelects() {
  populateVoiceSelect('previewInst', 89, 'sample');
  populateVoiceSelect('synthCustomInst', 80, 'synth');
}

function quickSynthInstrumentIndices() {
  return availableVoiceIndices('synth').slice(0, 8);
}

function setSynthStatus(message = '') {
  const el = document.getElementById('synthStatus');
  if (el) el.textContent = message;
}

function setPreviewStatus(message = '') {
  const el = document.getElementById('previewStatus');
  if (el) el.textContent = message;
}

function previewValues() {
  const instIdx = Number(document.getElementById('previewInst').value);
  const note = Number(document.getElementById('previewNote').value);
  const velocity = Number(document.getElementById('previewVelocity').value);
  const mode = document.getElementById('previewMode').value;
  return {
    instIdx: Number.isFinite(instIdx) ? Math.max(0, Math.min(224, instIdx)) : 0,
    note: Number.isFinite(note) ? Math.max(0, Math.min(127, note)) : 60,
    velocity: Number.isFinite(velocity) ? Math.max(1, Math.min(127, velocity)) : 100,
    mode,
  };
}

function updatePreviewWaveform(rendered = true) {
  if (!player.rom || !player.voiceGroup) {
    setPreviewStatus('Load a ROM first.');
    return;
  }
  const { instIdx, note, mode } = previewValues();
  const wave = window.gs1Debug.waveform(instIdx, mode, note);
  if (!wave) {
    setPreviewStatus(`Inst ${instIdx}: no synth/sample waveform available.`);
    return;
  }
  const url = window.gs1Debug.waveformUrl(instIdx, mode, rendered, note);
  const img = document.getElementById('previewWaveform');
  if (img && url) img.src = url;
  const child = wave.tableIndex >= 0 ? ` child ${wave.tableIndex}` : '';
  setPreviewStatus(`Inst ${instIdx}${child} ${mode}: loop ${wave.loopLen}, effective ${wave.effectivePeriod}, ${rendered ? 'rendered' : 'raw'} waveform.`);
}

function updateSynthPanel(message = '') {
  const state = player.audioEng.synthDebugState();
  const globalSel = document.getElementById('synthGlobal');
  const customSel = document.getElementById('synthCustomMode');
  const previewSel = document.getElementById('previewMode');
  if (globalSel) globalSel.innerHTML = synthOptionHTML(state.global);
  if (customSel) customSel.innerHTML = synthOptionHTML('rom');
  if (previewSel && !previewSel.innerHTML) previewSel.innerHTML = synthOptionHTML('romInterp');
  populateVoiceSelects();

  const rowsEl = document.getElementById('synthRows');
  if (rowsEl) {
    const rowIndices = quickSynthInstrumentIndices();
    rowsEl.innerHTML = rowIndices.map(instIdx => {
      const entry = player.voiceGroup ? player.voiceGroup[instIdx] : null;
      const selected = state.instrumentOverrides[String(instIdx)] || 'rom';
      const betaMode = state.betaGbcTestInstruments?.[String(instIdx)] || '';
      const label = entry ? `${voiceEntryKind(entry)} key ${noteName(entry.keyAdj || 60)}${betaMode ? ` beta→${betaMode}` : ''}` : 'not loaded';
      return `<div class="synth-row">
        <div><b>Inst ${instIdx}</b><span>${label}</span></div>
        <select data-synth-inst="${instIdx}">${synthOptionHTML(selected)}</select>
      </div>`;
    }).join('') || '<div class="synth-row"><div><b>No voices</b><span>Load a ROM/song first</span></div></div>';
    rowsEl.querySelectorAll('select[data-synth-inst]').forEach(sel => {
      sel.addEventListener('change', async e => {
        const instIdx = Number(e.target.dataset.synthInst);
        const mode = e.target.value;
        if (mode === 'rom') player.audioEng.clearSynthMode(instIdx);
        else player.audioEng.setSynthMode(mode, instIdx);
        await applySynthChange(`Instrument ${instIdx} set to ${mode}.`);
      });
    });
  }
  setSynthStatus(message || `Global: ${state.global}. Overrides: ${Object.keys(state.instrumentOverrides).length}`);
}

async function applySynthChange(message) {
  const wasPlaying = !!player.seq;
  updateSynthPanel(message + (wasPlaying ? ' Restarting song...' : ' Press play to hear it.'));
  if (!wasPlaying) return;
  const sel = document.getElementById('songSelect');
  const idx = parseInt(sel.value, 10);
  if (!Number.isFinite(idx)) return;
  await player.playSong(idx);
  updateSynthPanel(message + ' Applied and restarted.');
}

function populateSongList(songs) {
  const sel = document.getElementById('songSelect');
  sel.innerHTML = '';
  songs.forEach((s, i) => {
    const opt = document.createElement('option');
    opt.value = s.idx;
    opt.textContent = s.name
      ? `${s.name}  (${s.tracks.length}tr)`
      : `[${s.idx}] Song ${s.idx}  (${s.tracks.length}tr)`;
    sel.appendChild(opt);
  });
  sel.disabled = false;
  document.getElementById('btnPlay').disabled = false;
  currentSongListIdx = 0;
  if (songs[0]) player.setVoiceGroupForSong(songs[0].idx);
  updateSynthPanel();
  if (window.gs1Debug) updatePreviewWaveform(true);
}

document.getElementById('btnPlay').addEventListener('click', async () => {
  if (document.getElementById('engineSelect')?.value === 'gsf-lle') {
    try {
      const sel = document.getElementById('songSelect');
      const selectedSong = player.songs.find(s => String(s.idx) === sel?.value) || player.songs[sel?.selectedIndex || 0];
      const mappedKey = selectedSong?.gsfPatch?.key;
      const mappedIndex = mappedKey && standardGsfEngine?.entries
        ? standardGsfEngine.entries.findIndex(entry => entry.key === mappedKey)
        : -1;
      const entryIndex = mappedIndex >= 0 ? mappedIndex : (sel?.selectedIndex >= 0 ? sel.selectedIndex : 0);
      const diagnostics = await standardGsfEngine?.play(10, entryIndex);
      const cpu = diagnostics?.cpu;
      const audio = diagnostics?.audio;
      const run = diagnostics?.run;
      const fifoA = diagnostics?.fifo?.renderSamplesA ?? diagnostics?.fifo?.samplesA ?? 0;
      const fifoB = diagnostics?.fifo?.renderSamplesB ?? diagnostics?.fifo?.samplesB ?? 0;
      const fifoFill = diagnostics?.fifo ? ` fill:${diagnostics.fifo.fillBytesA || 0}/${diagnostics.fifo.fillBytesB || 0} q:${diagnostics.fifo.queueA || 0}/${diagnostics.fifo.queueB || 0}` : '';
      const dsTimerA = audio?.timers?.[audio?.sound?.directSoundA?.timer || 0];
      const dsTimerB = audio?.timers?.[audio?.sound?.directSoundB?.timer || 0];
      const timerDetail = dsTimerA ? ` tmA:${dsTimerA.ch}/${dsTimerA.reloadHex}/${dsTimerA.counterHex}/${dsTimerA.controlHex}/${dsTimerA.rateHz}Hz` : '';
      const timerDetailB = dsTimerB && dsTimerB !== dsTimerA ? ` tmB:${dsTimerB.ch}/${dsTimerB.reloadHex}/${dsTimerB.counterHex}/${dsTimerB.controlHex}/${dsTimerB.rateHz}Hz` : '';
      const reloadLog = audio?.timerReloadLog?.length ? ` reloadLog:[${audio.timerReloadLog.map(e => `${e.addr}=${e.value}@${e.cycles}(pc=${e.pc}/${e.thumb?'T':'A'}:${e.instrHex})`).join(' ')}]` : '';
      const soundDetail = audio ? ` snd:${audio.sound.soundCntHHex}/${audio.sound.soundBiasHex}` : '';
      const audioSummary = audio
        ? ` | timers:${audio.activeTimers.length ? audio.activeTimers.join(',') : '-'} dma:${audio.soundDma.length ? audio.soundDma.join(',') : '-'} xfer:${audio.dmaTransfers.length} fifoA:${audio.sound.directSoundA.fifoWrites}/${fifoA} fifoB:${audio.sound.directSoundB.fifoWrites}/${fifoB}${fifoFill}${timerDetail}${timerDetailB}${soundDetail}${reloadLog}`
        : '';
      const irq = diagnostics?.interrupts;
      const irqSummary = irq ? ` | vbl:${irq.vblankCount} irq:${irq.pendingHex} ime:${irq.ime}` : '';
      const branch = run?.lastBranch;
      const sourceBranch = run?.faultSourceBranch;
      const branchSummary = branch ? ` via:${branch.kind}@${branch.pcHex}->${branch.targetHex || branch.pcHex}` : '';
      const sourceReg = sourceBranch?.rsName ? ` ${sourceBranch.rsName}=${sourceBranch.rsValueHex}` : '';
      const writeSummary = write => write ? `${write.kind}@${write.pcHex}->${write.valueHex}` : '';
      const stackReadSummary = write => write?.addrHex ? ` read:${write.addrHex}=${write.readValueHex || write.valueHex}` : '';
      const slotWriteSummary = write => write?.addrHex ? ` slot:${write.slotWrite ? `${write.slotWrite.kind}@${write.slotWrite.pcHex}->${write.slotWrite.valueHex}` : '<never>'}` : '';
      const stackSpSummary = write => write?.spBeforeHex ? ` sp:${write.spBeforeHex}${write.spWrite ? `<-${writeSummary(write.spWrite)}` : ''}` : '';
      const sourceWrite = sourceBranch?.rsWrite ? ` last:${writeSummary(sourceBranch.rsWrite)}${stackReadSummary(sourceBranch.rsWrite)}${slotWriteSummary(sourceBranch.rsWrite)}${stackSpSummary(sourceBranch.rsWrite)}` : '';
      const sourceStack = sourceBranch?.addrHex ? ` read:${sourceBranch.addrHex}=${sourceBranch.readValueHex || sourceBranch.targetHex}` : '';
      const sourceSp = sourceBranch?.spBeforeHex ? ` sp:${sourceBranch.spBeforeHex}${sourceBranch.spWrite ? `<-${writeSummary(sourceBranch.spWrite)}` : ''}` : '';
      const sourceSummary = sourceBranch ? ` from:${sourceBranch.kind}@${sourceBranch.pcHex}->${sourceBranch.targetHex}${sourceReg}${sourceWrite}${sourceStack}${sourceSp}` : '';
      const trailSummary = run?.branchTrail?.length
        ? ` trail:${run.branchTrail.map(b => `${b.kind}@${b.pcHex}->${b.targetHex}${b.rsName ? `(${b.rsName}=${b.rsValueHex}${b.rsWrite ? `<-${b.rsWrite.kind}@${b.rsWrite.pcHex}${stackReadSummary(b.rsWrite)}${slotWriteSummary(b.rsWrite)}${stackSpSummary(b.rsWrite)}` : ''})` : ''}${b.addrHex ? `(read:${b.addrHex}=${b.readValueHex || b.targetHex}${b.spBeforeHex ? ` sp:${b.spBeforeHex}` : ''})` : ''}`).join(',')}`
        : '';
      const pcSummary = run ? ` | +${run.ranInstructions} pc:${run.pcHex}${run.hotPcHex ? ` hot:${run.hotPcHex}/${run.hotPcHits}` : ''}${branchSummary}${sourceSummary}${trailSummary}` : '';
      const bios = diagnostics?.bios;
      const biosSummary = bios?.swiCalls ? ` | swi:${bios.swiSummary || bios.swiCalls}${bios.stubbed?.length ? ` stub:[${bios.stubbed.join(',')}]` : ''}` : '';
      const render = diagnostics?.render;
      const statA = render?.sampleStatsA;
      const statB = render?.sampleStatsB;
      const sampleStats = statA ? ` pcmA:${statA.min}..${statA.max}/r${statA.rms}/[${statA.head.slice(0, 6).join(',')}]${statB ? ` pcmB:${statB.min}..${statB.max}/r${statB.rms}/[${statB.head.slice(0, 6).join(',')}]` : ''}` : '';
      const renderSummary = render ? ` | render:${(render.renderedMs / 1000).toFixed(1)}s/${render.stopReason} fifo:${render.fifoFillRate || render.sourceRate || 0}Hz play:${render.outputRate || render.sampleRate}Hz bias:${render.biasOutputRate || '?'}Hz dac:${render.dacBits || '?'}b${render.timerSourceRate ? ` timer:${render.timerSourceRate}` : ''} inst:${render.instructions}${sampleStats}` : '';
      const codeDump = audio?.timerCodeDump;
      const codeDumpSummary = codeDump
        ? ` | lit24d0:${codeDump.lit24d0} fn1:[${(codeDump.fn1||[]).filter(e=>!e.endsWith(':0x0000')).join(' ')}] fn2:[${codeDump.fn2.join(' ')}] iwram:[${(codeDump.iwramFn||[]).join(' ')}] iwramDiv1:[${(codeDump.iwramDiv1||[]).join(' ')}] snaps:[${(codeDump.regSnaps||[]).map(s=>`${s.label}@${s.pc}(c=${s.cycles} r0=${s.r0} r1=${s.r1} r5=${s.r5} lr=${s.lr})`).join(' ')}]`
        : '';
      setStatus(cpu
        ? `GSF CPU diagnostics: ${cpu.instructions} instructions, ${diagnostics.io.totalWrites} IO writes, ${cpu.reason || 'running'}${audioSummary}${irqSummary}${biosSummary}${renderSummary}${pcSummary}${codeDumpSummary}`
        : 'GSF CPU diagnostics unavailable.');
    } catch (err) {
      setStatus(err.message);
    }
    updateInfoText();
    return;
  }
  const sel = document.getElementById('songSelect');
  const idx = parseInt(sel.value, 10);
  await player.playSong(idx);
});

document.getElementById('btnStop').addEventListener('click', () => {
  player.stop();
  setStatus('Stopped');
});

document.getElementById('btnPrev').addEventListener('click', async () => {
  if (document.getElementById('engineSelect')?.value === 'gsf-lle') {
    setStatus('GSF LLE playback is not emulated yet; switch to MP2K HLE to play detected songs.');
    updateInfoText();
    return;
  }
  if (player.songs.length === 0) return;
  currentSongListIdx = Math.max(0, currentSongListIdx - 1);
  const sel = document.getElementById('songSelect');
  sel.selectedIndex = currentSongListIdx;
  await player.playSong(player.songs[currentSongListIdx].idx);
});

document.getElementById('btnNext').addEventListener('click', async () => {
  if (document.getElementById('engineSelect')?.value === 'gsf-lle') {
    setStatus('GSF LLE playback is not emulated yet; switch to MP2K HLE to play detected songs.');
    updateInfoText();
    return;
  }
  if (player.songs.length === 0) return;
  currentSongListIdx = Math.min(player.songs.length - 1, currentSongListIdx + 1);
  const sel = document.getElementById('songSelect');
  sel.selectedIndex = currentSongListIdx;
  await player.playSong(player.songs[currentSongListIdx].idx);
});

document.getElementById('btnAllTracks').addEventListener('click', () => {
  player.clearTrackIsolation();
});

document.getElementById('synthGlobal').addEventListener('change', async e => {
  const mode = e.target.value;
  player.audioEng.setSynthMode(mode);
  await applySynthChange(`Global synth mode set to ${mode}.`);
});

document.getElementById('btnSynthReset').addEventListener('click', async () => {
  player.audioEng.clearSynthMode();
  await applySynthChange('All synth overrides reset to retail ROM waveform.');
});

document.getElementById('btnSynthApply').addEventListener('click', async () => {
  const instIdx = Number(document.getElementById('synthCustomInst').value);
  const mode = document.getElementById('synthCustomMode').value;
  const entry = player.voiceGroup?.[instIdx];
  if (!Number.isFinite(instIdx) || !isVoiceEntryAvailable(entry, 'synth')) {
    updateSynthPanel('Select a ROM synth instrument from this voicegroup.');
    return;
  }
  if (mode === 'rom') player.audioEng.clearSynthMode(instIdx);
  else player.audioEng.setSynthMode(mode, instIdx);
  await applySynthChange(`Instrument ${instIdx} set to ${mode}.`);
});

document.getElementById('btnSynthClearInst').addEventListener('click', async () => {
  const instIdx = Number(document.getElementById('synthCustomInst').value);
  const entry = player.voiceGroup?.[instIdx];
  if (!Number.isFinite(instIdx) || !isVoiceEntryAvailable(entry, 'synth')) {
    updateSynthPanel('Select a ROM synth instrument from this voicegroup.');
    return;
  }
  player.audioEng.clearSynthMode(instIdx);
  await applySynthChange(`Instrument ${instIdx} override cleared.`);
});

document.getElementById('btnPreviewPlay').addEventListener('click', async () => {
  if (!player.rom || !player.voiceGroup) {
    setPreviewStatus('Load a ROM first.');
    return;
  }
  const { instIdx, note, velocity, mode } = previewValues();
  try {
    const result = await window.gs1Debug.playInst(instIdx, note, velocity, 1.25, mode);
    if (!result) {
      setPreviewStatus(`Inst ${instIdx}: could not preview.`);
      return;
    }
    const detail = result.voice?.synthEffectivePeriod
      ? ` period ${result.voice.synthEffectivePeriod}`
      : (result.voice?.rawFrequency ? ` ${result.voice.rawFrequency.toFixed(1)}Hz` : '');
    setPreviewStatus(`Playing inst ${instIdx} note ${note} vel ${velocity} as ${result.sourceKind}${detail}.`);
    updatePreviewWaveform(true);
  } catch (err) {
    console.error(err);
    setPreviewStatus(`Preview error: ${err.message}`);
  }
});

document.getElementById('btnPreviewStop').addEventListener('click', () => {
  window.gs1Debug.stopPreview();
  setPreviewStatus('Preview stopped.');
});

document.getElementById('btnPreviewWaveRaw').addEventListener('click', () => updatePreviewWaveform(false));
document.getElementById('btnPreviewWaveRendered').addEventListener('click', () => updatePreviewWaveform(true));

['previewInst', 'previewNote', 'previewMode'].forEach(id => {
  document.getElementById(id).addEventListener('change', () => updatePreviewWaveform(true));
});

document.getElementById('voiceLimitSelect').addEventListener('change', e => {
  GBA_VOICE_LIMIT = Number(e.target.value);
  player.peakVoices = 0;
  if (player.seq) player.seq.softwareVoiceLimit = GBA_VOICE_LIMIT;
});

document.getElementById('mixRateSelect').addEventListener('change', async e => {
  GBA_MIX_RATE = Number(e.target.value);
  if (player.loadedInfo) player.loadedInfo.soundModeManualRate = GBA_MIX_RATE;
  player.audioEng.synthCache.clear();
  player.audioEng.gbcWaveCache.clear();
  player.audioEng.gbcBufferCache.clear();
  player.audioEng.softwareSampleCache?.clear?.();
  if (player.songTableAddr) updateInfoText();
  if (player.seq) {
    const sel = document.getElementById('songSelect');
    const idx = parseInt(sel.value, 10);
    if (Number.isFinite(idx)) await player.playSong(idx);
  }
});

document.getElementById('backendSelect').addEventListener('change', async e => {
  const wasPlaying = !!player.seq;
  const idx = parseInt(document.getElementById('songSelect').value, 10);
  const eng = player.setAudioBackend(e.target.value);
  setStatus(`Audio backend: ${eng.backendLabel}`);
  if (wasPlaying && Number.isFinite(idx)) await player.playSong(idx);
});

document.getElementById('engineSelect').addEventListener('change', e => {
  player.stop();
  if (e.target.value === 'gsf-lle') {
    setStatus(standardGsfEngine?.canPlay()
      ? 'GSF LLE engine selected'
      : 'GSF LLE engine selected — payload comparison only until a GBA emulator is wired in');
  } else {
    setStatus(player.songs.length
      ? `${player.songs.length} songs loaded — select one and press ▶`
      : 'MP2K HLE engine selected');
  }
  updateInfoText();
});

document.getElementById('btnDebug').addEventListener('click', () => {
  player.setDebug(!player.debugOpen);
});

document.getElementById('btnRefreshDebug').addEventListener('click', () => {
  player.updateDebugPanel(true);
});

document.getElementById('btnClearLog').addEventListener('click', () => {
  player.clearDebugLog();
});

document.getElementById('songSelect').addEventListener('change', (e) => {
  const sel = e.target;
  currentSongListIdx = sel.selectedIndex;
  const idx = parseInt(sel.value, 10);
  if (!player.seq && Number.isFinite(idx) && player.setVoiceGroupForSong(idx)) {
    updateSynthPanel(`Selected song ${idx} voicegroup ${hex(player.voiceGroupOff, 6)} loaded for preview.`);
    updatePreviewWaveform(true);
  }
});

window.gs1Debug = {
  state: () => player.debugSnapshot(),
  gsf: () => standardGsfEngine,
  gsfReport: () => standardGsfEngine?.decodeReport || null,
  gsfDiagnostics: (maxInstructions = 20000) => standardGsfEngine?.runDiagnostics?.(maxInstructions) || null,
  profiles: () => Object.fromEntries(Object.entries(ENGINE_PROFILES).map(([id, profile]) => [id, profile.label])),
  profile: (id = null) => {
    if (id == null) return player.profile || DEFAULT_ENGINE_PROFILE;
    const profile = player.setProfile(id);
    return {
      ...profile,
      message: player.seq ? 'Profile changed for new notes; restart the song for a clean A/B.' : 'Profile changed.',
    };
  },
  auditSong: (id = player.currentSongIdx, ticks = 7200) => player.auditSong(id, ticks),
  synthState: () => player.audioEng.synthDebugState(),
  synth: (mode, instIdx = null) => {
    const result = player.audioEng.setSynthMode(mode, instIdx);
    updateSynthPanel(result.message);
    return result;
  },
  clearSynth: (instIdx = null) => {
    const result = player.audioEng.clearSynthMode(instIdx);
    updateSynthPanel(result.message);
    return result;
  },
  playInst: async (instIdx, note = 60, velocity = 100, seconds = 1.25, mode = null) => {
    if (!player.rom || !player.voiceGroup) return null;
    const entry = player.voiceGroup[instIdx];
    if (!entry) return null;
    await player.audioEng.ensure();
    player.audioEng.loadSamples(player.rom, player.voiceGroup);
    const hadOverride = player.audioEng.synthInstrumentModes.has(instIdx);
    const previousMode = player.audioEng.synthInstrumentModes.get(instIdx);
    if (mode) {
      player.audioEng.synthInstrumentModes.set(instIdx, mode);
      player.audioEng.synthCache.clear();
    }
    const resolved = resolveVoiceEntry(player.rom, entry, note, player.profile);
    const triggerEntry = resolved ? { ...resolved.entry, __resolvedVoice: resolved } : entry;
    const voice = player.audioEng.triggerNote(triggerEntry, note, velocity, 100, 0, 0x40, 0, 1 / AGB_EXACT_FPS, Math.max(1, Math.round(seconds * AGB_EXACT_FPS)), null, null, null);
    if (mode) {
      if (hadOverride) player.audioEng.synthInstrumentModes.set(instIdx, previousMode);
      else player.audioEng.synthInstrumentModes.delete(instIdx);
      player.audioEng.synthCache.clear();
    }
    if (!voice) return null;
    player.previewVoices.push(voice);
    window.setTimeout(() => player.audioEng.releaseVoice(voice), Math.max(50, seconds * 1000));
    return {
      instIdx,
      note,
      velocity,
      seconds,
      mode: mode || player.audioEng._synthModeFor({ instrumentIndex: instIdx }),
      sourceKind: voice.sourceKind,
      sample: player.debugSample(instIdx),
      voice: {
        playbackRate: voice.playbackRate,
        rawFrequency: voice.rawFrequency,
        foldedFrequency: voice.foldedFrequency,
        synthEffectivePeriod: voice.synthEffectivePeriod,
        synthRenderLoopLength: voice.synthRenderLoopLength,
      },
    };
  },
  stopPreview: () => player.stopPreview(),
  mute: i => player.toggleTrackMute(i),
  solo: i => player.toggleTrackSolo(i),
  clearSolo: () => player.clearTrackIsolation(),
  song: id => {
    const song = player.songs.find(s => s.idx === id) || player.songs[id] || null;
    if (!song) return null;
    return {
      ...song,
      name: `Song ${song.idx}`,
      trackPtrs: song.tracks.map(p => hex(p, 6)),
      header: hex(song.hdrOff, 6),
      softwareVoiceLimit: channelGroupVoiceCount(song.grp),
      voicegroup: hex(song.vgPtr, 6),
    };
  },
  track: i => player.debugTrack(i),
  inst: i => {
    const entry = player.voiceGroup ? player.voiceGroup[i] : null;
    if (!entry) return null;
    return { index: i, summary: instSummary(entry, i), ...entry };
  },
  resolveInst: (i, note = 60) => {
    if (!player.rom || !player.voiceGroup) return null;
    const entry = player.voiceGroup[i];
    const resolved = resolveVoiceEntry(player.rom, entry, note, player.profile);
    if (!resolved) return null;
    const sample = parseSample(player.rom, resolved.entry.sptr);
    let rateInfo = null;
    if (sample) {
      const pitchMidi = resolved.pitchNote + resolved.pitchOffset;
      rateInfo = player.audioEng._voiceRateInfo(pitchMidi, resolved.entry.keyAdj, 0, {
        rate: sample.rate,
        sampleHz: sample.sampleHz,
        loopStart: sample.loopStart,
        loopEnd: sample.loopEnd,
        rawLoopEnd: sample.rawLoopEnd,
        looped: sample.looped,
        fixedPitch: !!(resolved.entry.typeB & 0x08),
      });
    }
    return {
      parent: { index: i, summary: instSummary(entry, i), ...entry },
      tableIndex: resolved.tableIndex,
      pitchOffset: resolved.pitchOffset,
      pitchNote: resolved.pitchNote,
      noteMidi: resolved.noteMidi,
      entry: { summary: instSummary(resolved.entry, resolved.tableIndex), ...resolved.entry },
      rateInfo,
      sampleSummary: sampleSummary(player.rom, resolved.entry),
    };
  },
  polyphony: (songId = null, minBurst = 4, maxTicks = 7200) => {
    if (!player.rom || !player.voiceGroup) return [];
    const songs = songId == null
      ? player.songs
      : [player.songs.find(s => s.idx === songId) || player.songs[songId]].filter(Boolean);
    const rows = [];
    const silentAudio = {
      profile: player.profile || DEFAULT_ENGINE_PROFILE,
      triggerNote: (instEntry, noteMidi, velocity, volume, panOffset, tune, pitchOffsetSemis, tickSec, durationTicks) => {
        const resolved = instEntry?.__resolvedVoice || resolveVoiceEntry(player.rom, instEntry, noteMidi, player.profile);
        if (!resolved) return null;
        return {
          released: false,
          forceStopped: false,
          durationTicks,
          noteMidi,
          velocity,
          sourceKind: resolved.entry.type === 0 ? 'pcm' : `type${resolved.entry.type}`,
          hardwareType: resolved.entry.type >= 1 && resolved.entry.type <= 4 ? resolved.entry.type : 0,
          instrument: resolved.entry,
          tableIndex: resolved.tableIndex,
          startTime: 0,
        };
      },
      updateVoicePitch: () => {},
      updateVoiceMix: () => {},
      releaseVoice: voice => { if (voice) { voice.released = true; voice.releaseEndTime = 0; } },
      stopVoiceNow: voice => { if (voice) { voice.released = true; voice.forceStopped = true; } },
    };
    for (const song of songs) {
      if (!song.vgPtr) continue;
      const voiceGroup = parseVoicegroup(player.rom, song.vgPtr);
      const seq = new Sequencer(player.rom, song, voiceGroup, silentAudio);
      const byTickTrack = new Map();
      seq.onDebug = ev => {
        if (ev.type !== 'note' || ev.trackIdx < 0) return;
        const key = `${ev.tick}:${ev.trackIdx}`;
        const row = byTickTrack.get(key) || {
          song: song.idx,
          group: song.grp,
          softwareVoiceLimit: seq.softwareVoiceLimit,
          tick: ev.tick,
          track: ev.trackIdx,
          count: 0,
          notes: [],
        };
        row.count++;
        row.notes.push(ev.message);
        byTickTrack.set(key, row);
      };
      let frames = 0;
      while (frames < maxTicks && seq.tracks.some(t => t.active)) {
        seq.tick();
        frames++;
      }
      for (const row of byTickTrack.values()) {
        if (row.count >= minBurst) rows.push(row);
      }
    }
    return rows.sort((a, b) => b.count - a.count || a.song - b.song || a.tick - b.tick).slice(0, 200);
  },
  psgUsage: () => {
    if (!player.rom) return [];
    const scanTrack = (ptr, voiceGroup, maxSteps = 2000) => {
      let p = ptr;
      let instIdx = 0;
      let lastMidi = 0x80;
      const hits = [];
      const readPtrAt = off => {
        const raw = player.rom.u32(off);
        return (raw >>> 24) === 8 ? (raw & 0x1ffffff) : 0;
      };
      for (let steps = 0; steps < maxSteps; steps++) {
        const b = player.rom.u8(p++);
        if (b < 0x80 || b >= 0xcf) {
          const note = b < 0x80 ? b : (player.rom.u8(p) < 0x80 ? player.rom.u8(p++) : lastMidi);
          lastMidi = note;
          if (player.rom.u8(p) < 0x80) p++;
          if (player.rom.u8(p) < 0x80) p++;
          const resolved = resolveVoiceEntry(player.rom, voiceGroup[instIdx], note, player.profile);
          const type = resolved?.entry?.type || 0;
          if (type >= 1 && type <= 4) {
            hits.push({ inst: instIdx, note, type, typeB: resolved.entry.typeB, tableIndex: resolved.tableIndex });
          }
          continue;
        }
        if (b <= 0xb0) continue;
        switch (b) {
          case 0xb1: return hits;
          case 0xb2: {
            const dest = readPtrAt(p);
            p = dest || p + 4;
            break;
          }
          case 0xb3:
            p += 4;
            break;
          case 0xb4:
            return hits;
          case 0xb5:
            p += 5;
            break;
          case 0xb9: {
            const op = player.rom.u8(p);
            p += op >= 0x06 ? 7 : 3;
            break;
          }
          case 0xbd:
            instIdx = player.rom.u8(p++);
            break;
          case 0xcc:
            p += 2;
            break;
          default:
            p += 1;
            break;
        }
      }
      return hits;
    };
    const rows = [];
    for (const song of player.songs) {
      if (!song.vgPtr) continue;
      const voiceGroup = parseVoicegroup(player.rom, song.vgPtr);
      const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
      const insts = { 1: new Set(), 2: new Set(), 3: new Set(), 4: new Set() };
      for (const ptr of song.tracks) {
        for (const hit of scanTrack(ptr, voiceGroup)) {
          counts[hit.type]++;
          insts[hit.type].add(hit.tableIndex >= 0 ? `${hit.inst}:${hit.tableIndex}` : `${hit.inst}`);
        }
      }
      if (counts[1] || counts[2] || counts[3] || counts[4]) {
        rows.push({
          song: song.idx,
          voicegroup: hex(song.vgPtr, 6),
          sound1: counts[1],
          sound2: counts[2],
          sound3: counts[3],
          sound4: counts[4],
          inst1: [...insts[1]],
          inst2: [...insts[2]],
          inst3: [...insts[3]],
          inst4: [...insts[4]],
        });
      }
    }
    return rows;
  },
  sample: i => player.debugSample(i),
  waveform: (i, mode = null, note = 60) => {
    if (!player.rom || !player.voiceGroup) return null;
    const entry = player.voiceGroup[i];
    if (!entry) return null;
    const resolved = resolveSampleVoice(entry, note);
    const sample = resolved?.sample;
    if (!sample) return null;
    const waveEntry = resolved.entry;
    const loopLen = Math.max(0, sample.loopEnd - sample.loopStart);
    const hasLoopWindow = loopLen > 0 && sample.loopStart < sample.data.length;
    const sourceStart = hasLoopWindow ? sample.loopStart : 0;
    const sourceEnd = hasLoopWindow ? Math.min(sample.loopEnd, sample.data.length) : Math.min(sample.data.length, 4096);
    const source = [...sample.data.slice(sourceStart, sourceEnd)];
    const signed = signedPcm(source);
    const mean = signed.length ? signed.reduce((sum, v) => sum + v, 0) / signed.length : 0;
    const effectivePeriod = player.audioEng._romSynthEffectivePeriod({
      looped: sample.looped,
      rawLoopEnd: sample.rawLoopEnd,
    }, loopLen);
    const synthMode = mode || player.audioEng._synthModeFor({ instrumentIndex: i });
    const rendered = source.length
      ? player.audioEng._renderLoopForSynthMode(synthMode, Uint8Array.from(source), Math.max(1, effectivePeriod))
      : Uint8Array.from([]);
    const renderedSigned = signedPcm(rendered);
    return {
      instrument: i,
      tableIndex: resolved.tableIndex,
      resolvedNote: resolved.note,
      summary: instSummary(waveEntry, resolved.tableIndex >= 0 ? resolved.tableIndex : i),
      parentSummary: resolved.parent ? instSummary(entry, i) : null,
      type: waveEntry.type,
      sampleHz: sample.sampleHz,
      sourceStart,
      sourceEnd,
      rawLoopEnd: sample.rawLoopEnd,
      loopLen,
      effectivePeriod,
      synthMode,
      bytes: source,
      signed,
      signedMean: mean,
      normalizedMean: mean / 128,
      dcCenteredSigned: signed.map(v => +(v - mean).toFixed(3)),
      renderedBytes: [...rendered],
      renderedSigned,
    };
  },
  synthWave: i => window.gs1Debug.waveform(i),
  waveformUrl: (i, mode = null, rendered = true, note = 60) => {
    const wave = window.gs1Debug.waveform(i, mode, note);
    if (!wave) return null;
    const values = rendered ? wave.renderedSigned : wave.signed;
    const child = wave.tableIndex >= 0 ? `:${wave.tableIndex}` : '';
    return waveformSvgDataUrl(values, { label: `inst ${i}${child} ${wave.synthMode} ${rendered ? 'rendered' : 'raw'}` });
  },
  bytes: (off, len = 32) => {
    if (!player.rom) return [];
    return [...player.rom.bytes(off, len)].map(b => hex(b));
  },
  setDebug: open => player.setDebug(!!open),
  clearLog: () => player.clearDebugLog(),
};

// ROM loading
async function inflate(u8compressed, format = 'deflate') {
  const ds = new DecompressionStream(format);
  const w = ds.writable.getWriter();
  const r = ds.readable.getReader();
  w.write(u8compressed); w.close();
  const chunks = [];
  for (;;) { const { done, value } = await r.read(); if (done) break; chunks.push(value); }
  const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let p = 0; for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

function gsfIsValid(buf) {
  const u8 = new Uint8Array(buf, 0, 4);
  return u8[0] === 0x50 && u8[1] === 0x53 && u8[2] === 0x46 && u8[3] === 0x22;
}

function cleanAscii(bytes) {
  return new TextDecoder('ascii')
    .decode(bytes)
    .replace(/\0/g, ' ')
    .trim();
}

function readGbaHeader(buf) {
  if (!buf || buf.byteLength < 0xb2) return null;
  const u8 = new Uint8Array(buf);
  const title = cleanAscii(u8.subarray(0xa0, 0xac));
  const gameCode = cleanAscii(u8.subarray(0xac, 0xb0));
  const makerCode = cleanAscii(u8.subarray(0xb0, 0xb2));
  if (!title && !gameCode && !makerCode) return null;
  return { title, gameCode, makerCode };
}

function parseGsfTags(buf) {
  if (!gsfIsValid(buf)) return {};
  const view = new DataView(buf);
  const reservedLen = view.getUint32(4, true);
  const compressedLen = view.getUint32(8, true);
  const tagOff = 16 + reservedLen + compressedLen;
  if (tagOff + 5 > buf.byteLength) return {};
  const u8 = new Uint8Array(buf);
  const marker = new TextDecoder('ascii').decode(u8.subarray(tagOff, tagOff + 5));
  if (marker !== '[TAG]') return {};
  const tagText = new TextDecoder().decode(u8.subarray(tagOff + 5));
  const tags = {};
  for (const line of tagText.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (key && value) tags[key] = value;
  }
  return tags;
}

function gsfTagSummary(tags) {
  if (!tags || !Object.keys(tags).length) return '';
  const parts = [];
  if (tags.game) parts.push(`game ${tags.game}`);
  if (tags.title) parts.push(`title ${tags.title}`);
  if (tags.artist) parts.push(`artist ${tags.artist}`);
  if (tags.copyright) parts.push(tags.copyright);
  return parts.join(' | ');
}

async function gsfDecompress(buf) {
  const view = new DataView(buf);
  const reservedLen   = view.getUint32(4, true);
  const compressedLen = view.getUint32(8, true);
  const compressed    = new Uint8Array(buf, 16 + reservedLen, compressedLen);
  return inflate(compressed, 'deflate');
}

async function parseGsfBuffer(buf) {
  if (!gsfIsValid(buf)) return null;
  const dec = await gsfDecompress(buf);
  const dv  = new DataView(dec.buffer);
  const loadAddr = dv.getUint32(4, true);
  const dataSize = dv.getUint32(8, true);
  const romOffset = loadAddr - 0x08000000;
  if (romOffset < 0 || romOffset > 32 * 1024 * 1024) throw new Error(`GSF load address out of range: 0x${loadAddr.toString(16)}`);
  const rom = new ArrayBuffer(romOffset + dataSize);
  new Uint8Array(rom).set(dec.subarray(12, 12 + dataSize), romOffset);
  return rom;
}

async function parseGsfProgramInfo(buf) {
  if (!gsfIsValid(buf)) return null;
  const dec = await gsfDecompress(buf);
  const dv = new DataView(dec.buffer);
  return {
    loadAddr: dv.getUint32(4, true),
    dataSize: dv.getUint32(8, true),
  };
}

async function parseMiniGsfPatch(buf) {
  if (!gsfIsValid(buf)) return null;
  const dec = await gsfDecompress(buf);
  const dv  = new DataView(dec.buffer);
  const loadAddr = dv.getUint32(4, true);
  const size     = dv.getUint32(8, true);
  return { loadAddr, data: dec.slice(12, 12 + size) };
}

async function parseZip(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  // Locate End of Central Directory record
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65558); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const cdCount  = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);

  const entries = [];
  let pos = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (dv.getUint32(pos, true) !== 0x02014b50) break;
    const method     = dv.getUint16(pos + 10, true);
    const csize      = dv.getUint32(pos + 20, true);
    const usize      = dv.getUint32(pos + 24, true);
    const fnLen      = dv.getUint16(pos + 28, true);
    const extraLen   = dv.getUint16(pos + 30, true);
    const commentLen = dv.getUint16(pos + 32, true);
    const localOff   = dv.getUint32(pos + 42, true);
    const name       = new TextDecoder().decode(u8.subarray(pos + 46, pos + 46 + fnLen));
    pos += 46 + fnLen + extraLen + commentLen;
    if (!name.endsWith('/')) entries.push({ name, method, csize, usize, localOff });
  }

  const files = {};
  for (const e of entries) {
    const lhFnLen    = dv.getUint16(e.localOff + 26, true);
    const lhExtraLen = dv.getUint16(e.localOff + 28, true);
    const dataOff    = e.localOff + 30 + lhFnLen + lhExtraLen;
    let data;
    if (e.method === 0) {
      data = u8.slice(dataOff, dataOff + e.usize);
    } else if (e.method === 8) {
      data = await inflate(u8.subarray(dataOff, dataOff + e.csize), 'deflate-raw');
    } else continue;
    const base = e.name.split('/').pop();
    files[base] = data.buffer;
  }
  return files;
}

async function loadGsfArchive(buf, source = {}) {
  const files = window.GsfTools?.archiveFiles
    ? await window.GsfTools.archiveFiles(buf)
    : await parseZip(buf);
  if (!files) return false;

  const libKey = Object.keys(files).find(k => /\.gsflib$/i.test(k));
  if (!libKey) throw new Error('No .gsflib found in archive');
  setStatus('Decompressing gsflib…');
  const libTags = parseGsfTags(files[libKey]);
  const baseRom = await parseGsfBuffer(files[libKey]);
  if (!baseRom) throw new Error('Could not parse gsflib');

  const miniKeys = Object.keys(files).filter(k => /\.minigsf$/i.test(k)).sort();
  const archiveKind = window.GsfTools?.isSevenZip?.(buf) ? 'GSF 7z' : 'GSF ZIP';
  await player.loadROM(baseRom, {
    kind: archiveKind,
    name: source.name || `Dropped ${archiveKind}`,
    gsfLibrary: libKey,
    gsfTags: libTags,
    minigsfCount: miniKeys.length,
  });

  setStatus(`Mapping ${miniKeys.length} minigsf song names…`);

  // Collect all patch values upfront
  const patches = [];
  for (const key of miniKeys) patches.push(await parseMiniGsfPatch(files[key]));
  const patchVals = patches.map(p => (p && p.data.length >= 2) ? p.data[0] | (p.data[1] << 8) : -1);

  function assignName(song, key, patch = null) {
    song.name = key.replace(/\.minigsf$/i, '');
    if (patch) song.gsfPatch = { key, loadAddr: patch.loadAddr, size: patch.data.length };
  }
  function scoreTableForPatches(table) {
    const songs = table?.songs || [];
    const idxSet = new Set(songs.map(s => s.idx));
    const valid = patchVals.filter(v => v >= 0);
    const baseCounts = new Map();
    for (const value of valid) {
      for (const song of songs) {
        const base = value - song.idx;
        baseCounts.set(base, (baseCounts.get(base) || 0) + 1);
      }
    }
    let bestBase = 0;
    let bestScore = valid.filter(v => idxSet.has(v)).length;
    for (const [base, score] of baseCounts) {
      if (score > bestScore || (score === bestScore && Math.abs(base) < Math.abs(bestBase))) {
        bestBase = base;
        bestScore = score;
      }
    }
    return { table, base: bestBase, score: bestScore };
  }

  const bestPatchTable = player.songTables
    .map(scoreTableForPatches)
    .sort((a, b) => b.score - a.score || b.table.songs.length - a.table.songs.length || b.table.avgTc - a.table.avgTc)[0];
  if (bestPatchTable && bestPatchTable.score > 0 && bestPatchTable.table.addr !== player.songTableAddr) {
    player.stop();
    player._applySongTable(bestPatchTable.table);
  }

  // Strategy 1: use the best patch base across detected tables. This handles sets
  // like Pokémon Sapphire, where minigsf values 350-467 map to table idx 0-117.
  let matched = 0;
  const patchBase = bestPatchTable?.base || 0;
  miniKeys.forEach((key, i) => {
    if (patchVals[i] < 0) return;
    const song = player.songs.find(s => s.idx === patchVals[i] - patchBase);
    if (song) { assignName(song, key, patches[i]); matched++; }
  });

  // Strategy 2: direct idx match — minigsf patch value == song.idx.
  if (matched < miniKeys.length * 0.5) {
    matched = 0;
    player.songs.forEach(s => { s.name = undefined; });
    miniKeys.forEach((key, i) => {
      if (patchVals[i] < 0) return;
      const song = player.songs.find(s => s.idx === patchVals[i]);
      if (song) { assignName(song, key, patches[i]); matched++; }
    });
  }

  // Strategy 3: positional — minigsf order == song table order (sparse stripped gsflibs)
  if (matched === 0 && miniKeys.length > 0 && miniKeys.length <= player.songs.length * 2) {
    const sorted = [...player.songs].sort((a, b) => a.idx - b.idx);
    miniKeys.forEach((key, i) => { if (i < sorted.length) assignName(sorted[i], key, patches[i]); });
  }

  if (player.loadedInfo) {
    player.loadedInfo.gsfPatchBase = patchBase;
    player.loadedInfo.gsfNameMatches = matched;
  }
  return player.songs.length;
}

function updateInfoText() {
  const info = player.loadedInfo || {};
  const header = info.header || {};
  const sourceParts = [];
  if (info.kind || info.name) sourceParts.push(`Loaded: ${[info.kind, info.name].filter(Boolean).join(' ')}`);
  if (header.title || header.gameCode || header.makerCode) {
    sourceParts.push(`ROM header: ${header.title || 'untitled'} | code ${header.gameCode || '----'} | maker ${header.makerCode || '--'}`);
  } else if (info.gsfTags && Object.keys(info.gsfTags).length) {
    sourceParts.push(`GSF tags: ${gsfTagSummary(info.gsfTags) || 'present'}`);
  }
  if (info.gsfLibrary) sourceParts.push(`GSF library: ${info.gsfLibrary}${info.minigsfCount != null ? ` | minigsf files: ${info.minigsfCount}` : ''}`);
  if (info.gsfPatchBase != null) sourceParts.push(`GSF mapping: patch base ${info.gsfPatchBase} | named ${info.gsfNameMatches || 0}/${info.minigsfCount || 0}`);
  if (info.loadAddr != null && info.dataSize != null) sourceParts.push(`GSF load: ${hex(info.loadAddr, 8)} | ${info.dataSize} bytes`);
  if (info.profile) sourceParts.push(`Engine profile: ${info.profile.label}`);
  if (info.soundModeManualRate) {
    sourceParts.push(`Sound mode: manual override ${info.soundModeManualRate} Hz${info.soundMode?.rate ? ` (detected ${info.soundMode.rate} Hz at ROM ${hex(info.soundMode.pos, 6)})` : ''}`);
  } else if (info.soundMode?.rate) {
    sourceParts.push(`Sound mode: ${info.soundMode.rate} Hz (freq ${info.soundMode.freq}, max ${info.soundMode.maxChannels}, dac ${info.soundMode.dacConfig}) at ROM ${hex(info.soundMode.pos, 6)} via ${info.soundMode.source}`);
  } else {
    sourceParts.push(`Sound mode: not detected, using selected mix rate`);
  }
  const selectedEngine = document.getElementById('engineSelect')?.value || 'mp2k-hle';
  const engine = `MP2k HLE engine | Backend: ${player.audioEng?.backendLabel || 'Web Audio graph'} | Song table: ROM ${hex(player.songTableAddr, 6)} (${player.songs.length} songs) | Mix rate: ${GBA_MIX_RATE} Hz | Tick: ${AGB_EXACT_FPS.toFixed(4)} Hz x tempo`;
  const gsfEngine = standardGsfEngine ? standardGsfEngine.summary() : 'GSF LLE: gsf_emulator.js not loaded';
  const compare = `Compare: selected ${selectedEngine === 'gsf-lle' ? 'GSF LLE' : 'MP2K HLE'} | HLE playable: ${player.songs.length ? 'yes' : 'no'} | LLE playable: ${standardGsfEngine?.canPlay() ? 'yes' : 'no'}`;
  document.getElementById('info').textContent = [...sourceParts, engine, gsfEngine, compare].join('\n');
}

async function initWithBuffer(buf, source = {}) {
  try {
    const isZip = window.GsfTools?.isZip?.(buf) || false;
    const isSevenZip = window.GsfTools?.isSevenZip?.(buf) || false;
    const isArchive = isZip || isSevenZip;
    const isGsf = window.GsfTools?.isValid?.(buf) || false;
    if (standardGsfEngine) {
      if (isArchive || isGsf) {
        await standardGsfEngine.loadBuffer(buf, source);
      } else {
        standardGsfEngine.reset();
      }
    }
    let count;
    if (isArchive) {
      setStatus(isSevenZip ? 'Reading 7z…' : 'Reading ZIP…');
      count = await loadGsfArchive(buf, source);
    } else {
      setStatus('Parsing ROM…');
      const gsfTags = parseGsfTags(buf);
      const gsfProgram = await parseGsfProgramInfo(buf);
      const gsfRom = await parseGsfBuffer(buf);
      if (gsfRom) { buf = gsfRom; setStatus('GSF decompressed, detecting engine…'); }
      count = await player.loadROM(buf, gsfRom
        ? { kind: 'GSF', name: source.name || 'Dropped GSF', gsfTags, ...(gsfProgram || {}) }
        : { kind: 'ROM', name: source.name || 'Dropped ROM' });
    }

    // Populate table selector if multiple tables found
    const tableRow = document.getElementById('tableRow');
    const tableSel = document.getElementById('tableSelect');
    tableSel.innerHTML = '';
    if (player.songTables.length > 1) {
      player.songTables.forEach((t, i) => {
        const avgTc = (t.avgTc).toFixed(1);
        const label = t.avgTc >= 3
          ? `ROM ${hex(t.addr, 6)} — ${t.songs.length} songs, avg ${avgTc} tracks (music)`
          : `ROM ${hex(t.addr, 6)} — ${t.songs.length} entries, avg ${avgTc} tracks (sfx?)`;
        const opt = new Option(label, i);
        opt.selected = t.addr === player.songTableAddr;
        tableSel.appendChild(opt);
      });
      tableRow.style.display = '';
    } else {
      tableRow.style.display = 'none';
    }

    populateVoicePoolSelect();
    populateSongList(player.songs);
    player._debugEvent({ type:'load', trackIdx:-1, tick:0, message:`loaded ${count} songs, ${player.voiceGroup.length} instruments` });
    setStatus(`${count} songs loaded — select one and press ▶`);
    document.getElementById('dropmsg').style.display = 'none';
    updateInfoText();
  } catch (err) {
    setStatus('Error: ' + err.message);
    console.error(err);
  }
}

function populateVoicePoolSelect() {
  const sel = document.getElementById('voicePoolSelect');
  const addrs = player.allVoiceGroupAddrs();
  sel.innerHTML = addrs.map(a =>
    `<option value="${a}"${a === player.voiceGroupOff ? ' selected' : ''}>Voice pool ROM ${hex(a, 6)}</option>`
  ).join('');
  sel.style.display = addrs.length > 1 ? '' : 'none';
}

document.getElementById('voicePoolSelect').addEventListener('change', e => {
  const addr = Number(e.target.value);
  player.setVoiceGroup(addr);
  player.audioEng.loadSamples(player.rom, player.voiceGroup);
  updateSynthPanel();
  if (player.seq) {
    player.seq.voiceGroup = player.voiceGroup;
  }
});

document.getElementById('tableSelect').addEventListener('change', e => {
  const t = player.songTables[Number(e.target.value)];
  if (!t) return;
  player.stop();
  player._applySongTable(t);
  populateVoicePoolSelect();
  populateSongList(player.songs);
  updateInfoText();
  setStatus(`${player.songs.length} songs loaded — select one and press ▶`);
});

// Try auto-loading a local baserom when it exists beside the app.
fetch('baserom.gba')
  .then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`)))
  .then(buf => initWithBuffer(buf, { name: 'baserom.gba' }))
  .catch(() => {
    setStatus('Drop a GBA ROM, GSF dump, minigsf, gsflib, ZIP, or 7z to begin');
  });

// Drag-and-drop
document.body.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
document.body.addEventListener('drop', e => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => initWithBuffer(ev.target.result, { name: file.name });
  reader.readAsArrayBuffer(file);
});

// File picker fallback
const filePicker = document.getElementById('filePicker');
filePicker.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    initWithBuffer(ev.target.result, { name: file.name });
    filePicker.value = '';
  };
  reader.readAsArrayBuffer(file);
});

document.getElementById('dropmsg').addEventListener('click', () => {
  filePicker.click();
});

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (e.key === ' ') { e.preventDefault(); document.getElementById('btnPlay').click(); }
  if (e.key === 's') document.getElementById('btnStop').click();
  if (e.key === 'ArrowLeft') document.getElementById('btnPrev').click();
  if (e.key === 'ArrowRight') document.getElementById('btnNext').click();
});
