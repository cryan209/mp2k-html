# GBA MP2k Music Player

Standalone HTML MP2k music player for inspecting and playing music from compatible GBA ROMs and GSF dumps. It auto-detects MP2k song tables in full ROMs and can also load `.gsf`, `.gsflib`, `.minigsf`, and ZIP archives containing GSF dumps.

## Run

From this directory:

```sh
npm start
```

Then open:

```text
http://localhost:8000/music-player/
```

The dev server is rooted at the parent repository so `index.html` can auto-load `../baserom.gba` for the local Golden Sun workspace. You can also drag and drop a `.gba`, `.bin`, `.gsf`, `.gsflib`, `.minigsf`, or `.zip` file onto the page.

No install step is required; the npm script only wraps Python's built-in static file server.

## Files

- `index.html` - the player UI.
- `mp2k.js` - the MP2K HLE player and Web Audio/software mixer paths.
- `gsf.js` - the standard GSF container/LLE engine boundary for payload comparison.
- `package.json` - convenience scripts for serving the project locally.
