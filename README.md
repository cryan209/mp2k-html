# GBA MP2k Music Player

Standalone HTML MP2k music player for inspecting and playing music from compatible GBA ROMs and GSF dumps. It auto-detects MP2k song tables in full ROMs and can also load `.gsf`, `.gsflib`, `.minigsf`, ZIP, and 7z archives containing GSF dumps.

## Run

From this directory:

```sh
npm start
```

Then open:

```text
http://localhost:8000/
```

You can drag and drop a `.gba`, `.bin`, `.gsf`, `.gsflib`, `.minigsf`, `.zip`, or `.7z` file onto the page.

No install step is required; the npm script only wraps Python's built-in static file server.

## GSF Decoder

`gsf.js` includes a minimum viable GSF decoder. It parses the PSF/GSF container header, decompresses the executable payload, decodes the GBA entry/load/data header, maps loads to GBA memory regions, and extracts ZIP/7z archive contents.

`gsf_emulator.js` owns the LLE emulator boundary. It materializes ROM-backed payloads, applies minigsf patches from ZIP/7z/gsflib sets into a memory image, and includes the first ARM7TDMI CPU/memory diagnostic scaffold for IO hook, hot patch, timer, DMA, and sound register work.

Playback through the standard GSF LLE path is not emulated yet. The decoder state is exposed for inspection with:

```js
window.gs1Debug.gsfReport()
window.gs1Debug.gsfDiagnostics()
```

## Files

- `index.html` - the player UI.
- `mp2k.js` - the MP2K HLE player and Web Audio/software mixer paths.
- `gsf.js` - the standard GSF decoder and archive utilities.
- `gsf_emulator.js` - the GSF LLE emulator boundary and diagnostics scaffold.
- `package.json` - convenience scripts for serving the project locally.
