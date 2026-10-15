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

## Figma vs Wecra — same method (2026-10-15, after Batch B, `e1a98929`)

Figma in the owner's Chrome (signed in, "Open here instead" so the web editor ran, not the desktop app), Wecra from `out/`. One in-page script for both: the frame recorder above plus the wheel input dispatched as `WheelEvent`s on the largest canvas from inside the page (16 ms apart; zoom = `ctrlKey` wheel, the pinch form), so neither side pays a driver round trip. Page **Desktop**, Shift+1 first. Both at devicePixelRatio 2. The machine was loaded (load average 15–17: Illustrator, Creative Cloud, a WebKit GPU process) for both runs alike. Figma's file had two other people in it; only the view was moved.

| | Figma (web, Chrome) | Wecra (Electron) |
|---|---|---|
| Canvas | 973 × 772 CSS px (panels beside it) | 1440 × 862 CSS px (panels over it) — 1.65× the pixels |
| Pan, 2 runs | 115.4 / 116.6 fps · p95 9.3 / 9.1 ms · max 25 / 17 ms · **0** frames > 33 ms | 111.9 / 113.4 fps · p95 9.2 / 9.2 ms · max 58 / 58 ms · **5 / 3** frames > 33 ms |
| Zoom (pinch), 2 runs | 119.7 / 119.7 fps · p95 9.1 / 8.9 ms · max 17.6 / 16.7 ms · 0 > 33 ms | 120 / 120 fps · p95 9.2 / 9.0 ms · max 9.3 ms · 0 > 33 ms |
| Idle | 120 fps | 120 fps |
| Open | not comparable (the first load went through the desktop-app hand-off and a loaded main thread; the editor was usable ~100 s after "Open here instead", most of it network) | 7.8 s openFile → first frame (6.8 s on the page clock), under the same load (5.1 s on the quieter night run) |
| Memory | JS heap 388 MB (`performance.memory`; wasm and GPU not included) | 1.45–1.81 GB whole process tree; engine GPU 288 MB |

Reading: zoom is level (Wecra's worst zoom frame is better than Figma's). Pan is close on average but Wecra has 3–5 long frames (~58 ms) per 180-step pan where Figma has none — Batch D's first target (likely tiles entering view; trace it with `engine-bench --only fastPan --profile`). Worth checking too: the engine reported 319,892 nodes on this open against 230,123 the night before on the same file — find out whether Batch B's load-time work (override-key repair, variant backfill) or a counting change explains it.
