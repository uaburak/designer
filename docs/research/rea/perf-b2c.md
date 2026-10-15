# B2C Project — performance, Wecra vs Figma (2026-10-15)

The owner's "B2C Project" (Wecra copy `RktQdAS12XKvwCnRRdJoDv`, imported from `.fig`; Figma `3shNOwBVQJUEcMSa8auOjr`), measured after Round 17 Batch A was merged (`74dbda87`), on the owner's 16 GB Mac.

## Method

One scenario for both apps (`bench.mjs`, kept in the session scratchpad; it is a ~150-line Playwright script): open the file, switch to the page **Desktop**, Shift+1 (zoom to fit), then trusted wheel input through CDP — 180 pan steps (40 px, 16 ms apart: down, right, back diagonally), 160 ⌘-wheel zoom steps (in, out, in), 1.5 s idle — while a `requestAnimationFrame` recorder in the page logs frame intervals. Memory is the RSS of the app's whole process tree. Wecra ran from `out/` (`npm run build`) on an APFS clone of the owner's workspace (only `Workspace/`, its `.lock` removed in the clone), so the everyday app and its data were untouched.

## Wecra — measured

| | |
|---|---|
| Document | 230,123 nodes (engine stats), 9 pages |
| Open (openFile → first canvas frame) | 5.1 s (attached 0.47 s, store source open 0.67 s, editor ready 4.43 s, first frame 4.77 s on the page clock) |
| Pan, 758 frames | 119.2 fps, p50 8.3 ms, p95 9.2 ms, max 24.5 ms, 0 frames > 33 ms |
| ⌘-wheel zoom, 704 frames | 120.0 fps, p50 8.3 ms, p95 9.0 ms, max 9.3 ms, 0 frames > 33 ms |
| Idle | 120 fps |
| Memory (process tree) | 2.09 GB after open → 1.58 GB after the scenario; engine GPU 274 MB |

The rAF cadence shows the main thread never blocked a frame at 120 Hz; it does not by itself prove each frame redrew the full scene (the engine composites cached tiles while the camera moves, as Figma does).

## Figma — not measured yet

Figma desktop ignores `--remote-debugging-port` (relaunched with it: the flag is on the process, no port opens), the in-app browser has no Figma session (signing in is the owner's), and the Claude in Chrome extension was not connected. To finish: connect the Chrome extension (signed in to Figma in Chrome), then the same recorder runs in the figma.com tab with real wheel input — or the owner turns on Figma's own performance HUD and reads the numbers by hand on the same page and moves.
