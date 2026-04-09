# CLAUDE.md - OpenShelf

## What is OpenShelf?

OpenShelf is a **Progressive Web App (PWA) EPUB reader with AI-powered text-to-speech**. It runs entirely in the browser with no backend server -- all book parsing, storage, and TTS inference happen on-device. Privacy-first, offline-capable, and zero-build.

## Tech Stack

- **Vanilla JavaScript** (ES6 modules, no framework)
- **HTML5 / CSS3** with CSS custom properties for theming
- **IndexedDB** for local persistence (books + settings)
- **Service Worker** for offline caching
- **Web Worker** for TTS inference (Kokoro 82M ONNX model via kokoro-js)
- **JSZip** for EPUB parsing
- External deps loaded via CDN (`esm.sh`), no npm/package.json

## File Structure

```
index.html          Main HTML shell (library + reader screens)
app.js              App state, UI rendering, event handling (main module)
db.js               IndexedDB persistence layer (books + settings stores)
epub-parser.js      EPUB file parsing, text extraction, sentence splitting
tts-engine.js       TTS orchestration, AudioContext, playback queue
tts-worker.js       Web Worker: Kokoro ONNX model inference
sw.js               Service Worker: offline caching (stale-while-revalidate)
base.css            Design tokens, CSS custom properties, reset
style.css           Component styles, responsive layout, themes
manifest.json       PWA manifest (name, icons, theme)
assets/             App icons (SVG + PNG, 192px/512px/maskable)
```

## Architecture

### No build system

Files are served directly to the browser as ES6 modules. No bundler, transpiler, or package manager. External libraries are imported from `esm.sh` CDN.

### Module responsibilities

| Module | Role |
|---|---|
| `app.js` | Centralised app state, screen rendering (library/reader), event binding, TTS UI integration |
| `db.js` | IndexedDB wrapper with silent fallback to in-memory storage |
| `epub-parser.js` | Parses EPUB zip -> metadata, chapters, TOC, cover; exports `parseEpub()`, `extractTextFromHtml()`, `splitIntoSentences()` |
| `tts-engine.js` | AudioContext lifecycle, iOS audio workarounds, sentence batching (~400 chars), 3-chunk lookahead queue, speed/voice control; singleton `ttsEngine` |
| `tts-worker.js` | Runs in Web Worker; loads Kokoro model from HuggingFace, generates PCM audio |
| `sw.js` | Pre-caches app shell (`openshelf-v13`), stale-while-revalidate for same-origin + CDN (`openshelf-cdn-v1`) |

### Data flow

1. **Import**: File picker -> `parseEpub()` -> save to IndexedDB -> render library
2. **Read**: Click book -> `goToChapter()` -> render chapter HTML, restore scroll position
3. **TTS**: Start -> extract text -> split sentences -> batch -> worker generates PCM -> AudioContext plays -> sentence highlighting callbacks -> auto-advance chapters

### Key data models

**Book** (stored in IndexedDB `books` store):
- `id`, `title`, `author`, `cover` (base64 data URL)
- `chapters` array: `{id, href, title, html}`
- `toc`: `{title, href, fragment}`
- `currentChapter`, `progress` (0-100), `lastRead` (timestamp)
- `scrollPositions` and `ttsSentencePositions` (per-chapter maps)

**Settings** (stored in IndexedDB `settings` store):
- `fontSize` (14-24), `lineHeight` (1.5-2.0), `fontFamily` (`serif`|`sans-serif`)
- `theme` (`light`|`dark`|`system`)
- `ttsVoice` (`af_heart`), `ttsSpeed` (0.75-2.0), `modelDtype` (`q8`|`fp16`|`fp32`)

## Coding Conventions

### Naming
- Functions/variables: `camelCase`
- Private/internal functions: `_underscorePrefix`
- Constants: `UPPER_SNAKE_CASE`
- CSS classes: `kebab-case`
- Data attributes: `data-kebab-case`

### Patterns
- **Render functions** produce HTML strings, then DOM is queried for event binding
- **No component framework** -- DOM manipulation is imperative
- **Singleton exports** for engines: `export const ttsEngine = new TTSEngine()`
- **Silent failure** in persistence layer -- DB errors don't propagate to UI
- **Debounced saves** for settings (300ms)
- **Passive scroll listeners** for performance
- **Toast notifications** for user-facing errors (`showToast()`)

### iOS Safari considerations
- AudioContext created on user gesture, routed through `MediaStreamDestination` -> hidden `<audio>` element for background/lock screen playback
- Silent buffer played on first interaction to warm up audio hardware
- Media Session API for lock screen controls

## Development

### Running locally
Serve the directory with any static HTTP server:
```sh
npx serve .
# or
python3 -m http.server 8000
```
No install step required. Open in a modern browser.

### Testing
No automated test framework is configured. Testing is manual via browser.

### Deployment
Deploy as static files to any HTTP(S) host. No environment variables or server-side config needed.

### Service Worker versioning
The cache name in `sw.js` is `openshelf-v13`. **Bump the version number** when changing cached assets so users get the update.

## External Dependencies (CDN)

| Dependency | Version | URL | Purpose |
|---|---|---|---|
| JSZip | 3.10.1 | `esm.sh/jszip@3.10.1` | EPUB zip extraction |
| kokoro-js | 1.2.1 | `esm.sh/kokoro-js@1.2.1` | TTS model wrapper |
| ONNX Runtime | (transitive) | via kokoro-js | ML inference (WASM) |
| Kokoro 82M model | v1.0 | HuggingFace `onnx-community/Kokoro-82M-v1.0-ONNX` | TTS weights (q8/fp16/fp32) |
| Google Fonts | - | `fonts.googleapis.com` | Inter, Lora, Source Serif 4 |

## Common Tasks

### Adding a new setting
1. Add default value in `db.js` `loadSettings()` return
2. Add UI control in `index.html` settings panel
3. Wire up change handler in `app.js` (bind in `initSettingsPanel()`)
4. Call `persistSettings()` after mutation

### Modifying the EPUB parser
- All parsing logic is in `epub-parser.js`
- `parseEpub(arrayBuffer)` is the entry point
- Chapter merging logic: chapters sharing a base filename are merged into one

### Changing TTS behavior
- Playback orchestration: `tts-engine.js`
- Model inference: `tts-worker.js` (runs in Web Worker)
- Worker communicates via `postMessage` with typed messages: `init`, `generate`, `set_voice`
- Sentence batching target is ~400 characters; lookahead queue is 3 chunks

### Updating cached assets
- Edit the `ASSETS` array in `sw.js`
- **Bump `CACHE_NAME` version** (e.g., `openshelf-v13` -> `openshelf-v14`)
