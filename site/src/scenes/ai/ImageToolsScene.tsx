// Image tools (docs/ai.md §2.6, §4): an image layer with its secondary toolbar — the app's own Toolbar,
// ToolTextButtons, More menu, prompt card and canvas overlays (ImageTools.module.css: the sweep, the lasso, Expand's
// frame and handles) — over a picture drawn in SVG (imageArt.tsx). The tools act on the drawing: Remove background
// hides the backdrop over a checkerboard, Boost resolution shows a before / after, Select area takes a lasso for Erase,
// Isolate and Blur, Expand grows the crop with its handles, Vectorize posterizes it live (Full color / Grayscale /
// Black and white), and Make an image / Edit with prompt redraw it from the prompt's words. Each run is one undo step,
// and the panel says where each tool runs: on this computer (ONNX models), in the engine, or through the image route.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { Button, IconButton } from "@/ds/components/Button";
import { ContextMenu } from "@/ds/components/Menu";
import { PanelSection } from "@/ds/components/PanelSection";
import { SegmentedControl } from "@/ds/components/SegmentedControl";
import { Select } from "@/ds/components/Select";
import { Spinner } from "@/ds/components/Spinner";
import { TextArea } from "@/ds/components/TextInput";
import { Toolbar, ToolbarDivider, ToolTextButton } from "@/ds/components/Toolbar";
import { Icon, type IconName } from "@/ds/icons/Icon";
import toolCss from "@/editor/imageTools/ImageTools.module.css";
import { creditsFor } from "@shared/ai/types";
import type { AiAction } from "@shared/ai/types";
import { Panel, SceneBody, SceneCanvas, SceneWindow, Selection, type Box } from "../kit/kit";
import { DemoCursor, useDemo, type SceneRun } from "../runtime/useDemo";
import { FIRST_ART, OBJECT_AT, ProductArt, editFor, makeFor, type ArtState, type Part } from "./imageArt";
import { RunPill, WhereTag, useJobs, useUndoKey } from "./shared";
import styles from "./image.module.css";

type Crop = { x: number; y: number; w: number; h: number };
type Pad = { l: number; t: number; r: number; b: number };
type VecMode = "FULL_COLOR" | "GRAYSCALE" | "BLACK_AND_WHITE";
interface Vec {
  mode: VecMode;
  colors: number;
  grays: number;
  threshold: number;
}
interface Pic {
  art: ArtState;
  crop: Crop;
  vector: Vec | null;
  boosted: boolean;
  blurs: { x: number; y: number }[][];
  isolated: Box | null;
}
type Mode = null | "edit" | "make" | "select-area" | "expand" | "vectorize";

const FIRST_CROP: Crop = { x: 200, y: 150, w: 560, h: 700 };
const FIRST_PIC: Pic = { art: FIRST_ART, crop: FIRST_CROP, vector: null, boosted: false, blurs: [], isolated: null };
const NO_PAD: Pad = { l: 0, t: 0, r: 0, b: 0 };
const FIRST_VEC: Vec = { mode: "FULL_COLOR", colors: 8, grays: 4, threshold: 50 };
const VEC_MODES: { id: VecMode; label: string; key: "colors" | "grays" | "threshold"; name: string; min: number; max: number }[] = [
  { id: "FULL_COLOR", label: "Full color", key: "colors", name: "Number of colors", min: 2, max: 32 },
  { id: "GRAYSCALE", label: "Grayscale", key: "grays", name: "Number of grays", min: 2, max: 16 },
  { id: "BLACK_AND_WHITE", label: "Black and white", key: "threshold", name: "Threshold", min: 0, max: 100 },
];
const ASPECTS = [
  { value: "freeform", label: "Freeform", ratio: null },
  { value: "1:1", label: "1:1", ratio: 1 },
  { value: "4:3", label: "4:3", ratio: 4 / 3 },
  { value: "3:4", label: "3:4", ratio: 3 / 4 },
  { value: "16:9", label: "16:9", ratio: 16 / 9 },
  { value: "9:16", label: "9:16", ratio: 9 / 16 },
];
/** The picture's pixels: the crop at 512 px wide, ×4 once boosted */
const pixels = (c: Crop, boosted: boolean) => {
  const w = Math.round((512 * c.w) / FIRST_CROP.w) * (boosted ? 4 : 1);
  return `${w} × ${Math.round((w * c.h) / c.w)}`;
};
const MP = (c: Crop) => (((512 * c.w) / FIRST_CROP.w) * ((512 * c.h) / FIRST_CROP.w)) / 1e6;

interface ToolDef {
  id: string;
  label: string;
  icon: IconName;
  where: "local" | "engine" | "route";
  model: string;
  credits: string;
}
const TOOLS: ToolDef[] = [
  { id: "make", label: "Make an image", icon: "24.image", where: "route", model: "Antigravity, Gemini API or OpenAI", credits: "2–16" },
  { id: "edit", label: "Edit with prompt", icon: "24.pencil", where: "route", model: "Your image route", credits: "2–16" },
  { id: "expand", label: "Expand", icon: "24.expand", where: "route", model: "Your image route", credits: "5–10" },
  { id: "remove", label: "Remove background", icon: "24.erase", where: "local", model: "ISNet · 88 MB", credits: "1–5" },
  { id: "boost", label: "Boost resolution", icon: "24.scale", where: "local", model: "Swin2SR ×4 · 55 MB", credits: "5–10" },
  { id: "erase", label: "Erase", icon: "24.lasso", where: "local", model: "LaMa · 93 MB", credits: "5–10" },
  { id: "isolate", label: "Isolate", icon: "24.lasso", where: "local", model: "ISNet", credits: "5–10" },
  { id: "vectorize", label: "Vectorize", icon: "24.pen", where: "engine", model: "Wecra’s tracer", credits: "2–5" },
];

function useSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const m = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    m();
    const ro = new ResizeObserver(m);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

const inside = (p: { x: number; y: number }, poly: { x: number; y: number }[]) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
};

export default function ImageToolsScene() {
  const rootRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const size = useSize(areaRef);
  const [pic, setPic] = useState<Pic>(FIRST_PIC);
  const picRef = useRef(pic);
  picRef.current = pic;
  const pastRef = useRef<{ pic: Pic; label: string }[]>([]);
  const [mode, setMode] = useState<Mode>(null);
  const [busy, setBusy] = useState<{ label: string; progress: number } | null>(null);
  const [lasso, setLasso] = useState<{ x: number; y: number }[] | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [pad, setPad] = useState<Pad>(NO_PAD);
  const [aspect, setAspect] = useState("freeform");
  const [vec, setVec] = useState<Vec>(FIRST_VEC);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [compare, setCompare] = useState<number | null>(null);
  const [pill, setPill] = useState<string | null>(null);
  const [reveal, setReveal] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [route, setRoute] = useState("antigravity");
  const jobs = useJobs();

  // ---- the layer's place: the crop (and Expand's growth) fitted over the toolbar ----
  const W = pic.crop.w + pad.l + pad.r;
  const H = pic.crop.h + pad.t + pad.b;
  const s = size.w ? Math.min(0.62, (size.w - 48) / W, (size.h - 56) / H) : 0.5;
  const ox = (size.w - W * s) / 2;
  const oy = (size.h - H * s) / 2;
  const layer: Box = { x: ox + pad.l * s, y: oy + pad.t * s, w: pic.crop.w * s, h: pic.crop.h * s };
  const toWorld = (px: number, py: number) => ({ x: pic.crop.x + (px - layer.x) / s, y: pic.crop.y + (py - layer.y) / s });
  const toPx = (p: { x: number; y: number }) => ({ x: layer.x + (p.x - pic.crop.x) * s, y: layer.y + (p.y - pic.crop.y) * s });

  // ---- history ----
  const commit = useCallback((label: string, next: Pic) => {
    pastRef.current = [...pastRef.current.slice(-19), { pic: picRef.current, label }];
    picRef.current = next;
    setPic(next);
    setReveal((r) => r + 1);
  }, []);
  const undo = useCallback(() => {
    const last = pastRef.current.pop();
    jobs.cancel();
    setBusy(null);
    if (!last) return;
    picRef.current = last.pic;
    setPic(last.pic);
    setCompare(null);
    setPill(`Undo ${last.label}`);
  }, [jobs]);
  useUndoKey(rootRef, undo);

  const close = () => {
    setMode(null);
    setLasso(null);
    setPad(NO_PAD);
    setAspect("freeform");
  };

  /** A run: the sweep over the layer with its progress, then the result as one step */
  const runTool = (label: string, action: AiAction | null, title: string, next: (p: Pic) => Pic, ms = 1800, extra: Parameters<typeof creditsFor>[1] = {}) => {
    setPill(null);
    setMenuAt(null);
    setCompare(null);
    void jobs.start(async (wait) => {
      const steps = 12;
      for (let i = 0; i <= steps; i++) {
        setBusy({ label, progress: i / steps });
        await wait(ms / steps);
      }
      setBusy(null);
      const n = next(picRef.current);
      commit(title, n);
      close();
      const c = action ? creditsFor(action, { megapixels: MP(n.crop), ...extra }) : 0;
      setPill(action ? `${title} · ${c} ${c === 1 ? "credit" : "credits"}` : title);
      if (action === "boost-resolution") setCompare(0.5);
    });
  };

  const removeBackground = () => runTool("Removing background…", "remove-background", "Remove background", (p) => ({ ...p, art: { ...p.art, hidden: [...new Set<Part>([...p.art.hidden, "background", "cup"])] } }), 1600);
  const boost = () => runTool("Boosting resolution…", "boost-resolution", "Boost resolution", (p) => ({ ...p, boosted: true }), 2400);
  const hits = (poly: { x: number; y: number }[]) => (Object.keys(OBJECT_AT) as (keyof typeof OBJECT_AT)[]).filter((k) => inside(OBJECT_AT[k], poly));
  const erase = () => {
    if (!lasso) return;
    const hit = hits(lasso);
    runTool("Erasing…", "erase-object", "Erase", (p) => ({ ...p, art: { ...p.art, hidden: [...new Set<Part>([...p.art.hidden, ...hit])] } }), 2000);
  };
  const isolate = () => {
    if (!lasso) return;
    const hit = hits(lasso)[0];
    const xs = lasso.map((p) => p.x);
    const ys = lasso.map((p) => p.y);
    const box = hit ? OBJECT_AT[hit].box : { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    runTool("Isolating…", "isolate-object", "Isolate", (p) => ({ ...p, isolated: { x: box.x, y: box.y, w: box.w, h: box.h } }), 1200);
  };
  const blur = () => {
    if (!lasso) return;
    const area = lasso;
    runTool("Blurring…", null, "Blur", (p) => ({ ...p, blurs: [...p.blurs, area] }), 900);
  };
  const expand = () => {
    const c = pic.crop;
    const crop = { x: c.x - pad.l, y: c.y - pad.t, w: c.w + pad.l + pad.r, h: c.h + pad.t + pad.b };
    runTool("Expanding…", "expand-image", "Expand", (p) => ({ ...p, crop }), 2600);
  };
  const applyVector = () => {
    commit("Vectorize", { ...picRef.current, vector: vec });
    const c = creditsFor("vectorize", { colors: vec.mode === "FULL_COLOR" ? vec.colors : vec.mode === "GRAYSCALE" ? vec.grays : 2 });
    setPill(`Vectorize · ${c} credits`);
    setMode(null);
  };
  const send = (kind: "make" | "edit", text = prompt) => {
    if (!text.trim()) return;
    const model = route === "gemini-images" ? "gemini-3-pro-image-preview" : "";
    if (kind === "edit") runTool("Editing image…", "edit-image", "Edit image", (p) => ({ ...p, art: editFor(text, p.art), blurs: [] }), 2600, { model });
    else runTool("Making an image…", "make-image", "Make an image", (p) => ({ ...p, art: makeFor(text), vector: null, blurs: [], isolated: null, boosted: false }), 3000, { model });
    setPrompt("");
  };

  const openTool = (id: string) => {
    if (busy) return;
    setMenuAt(null);
    setPill(null);
    setCompare(null);
    if (id === "remove") return removeBackground();
    if (id === "boost") return boost();
    if (id === "erase" || id === "isolate") {
      setLasso(null);
      return setMode("select-area");
    }
    if (id === "vectorize") {
      setVec(pic.vector ?? FIRST_VEC);
      return setMode("vectorize");
    }
    setPad(NO_PAD);
    setMode(mode === id ? null : (id as Mode));
  };

  // ---- the lasso ----
  const lassoDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = areaRef.current!.getBoundingClientRect();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrawing(true);
    setLasso([toWorld(e.clientX - box.left, e.clientY - box.top)]);
  };
  const lassoMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drawing) return;
    const box = areaRef.current!.getBoundingClientRect();
    const p = toWorld(e.clientX - box.left, e.clientY - box.top);
    setLasso((l) => (l ? [...l, p] : [p]));
  };

  // ---- Expand's handles: each drags its sides along the layer's axes (dragging sets Freeform) ----
  const handleDown = (sides: { l?: 1; t?: 1; r?: 1; b?: 1 }) => (e: ReactPointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, pad };
    setAspect("freeform");
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / s;
      const dy = (ev.clientY - start.y) / s;
      const c = pic.crop;
      const clampL = (v: number) => Math.max(0, Math.min(c.x - 0, v));
      const clampT = (v: number) => Math.max(0, Math.min(c.y, v));
      const clampR = (v: number) => Math.max(0, Math.min(1000 - c.x - c.w, v));
      const clampB = (v: number) => Math.max(0, Math.min(1000 - c.y - c.h, v));
      setPad({
        l: sides.l ? clampL(start.pad.l - dx) : start.pad.l,
        t: sides.t ? clampT(start.pad.t - dy) : start.pad.t,
        r: sides.r ? clampR(start.pad.r + dx) : start.pad.r,
        b: sides.b ? clampB(start.pad.b + dy) : start.pad.b,
      });
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  const pickAspect = (v: string) => {
    setAspect(v);
    const ratio = ASPECTS.find((a) => a.value === v)?.ratio;
    const c = pic.crop;
    if (!ratio) return setPad(NO_PAD);
    // Grow the short side, centred, as far as the world allows
    if (c.w / c.h < ratio) {
      const grow = Math.min(c.h * ratio - c.w, c.x * 2, (1000 - c.x - c.w) * 2);
      setPad({ l: grow / 2, r: grow / 2, t: 0, b: 0 });
    } else {
      const grow = Math.min(c.w / ratio - c.h, c.y * 2, (1000 - c.y - c.h) * 2);
      setPad({ l: 0, r: 0, t: grow / 2, b: grow / 2 });
    }
  };

  // ---- the Boost compare handle ----
  const compareDown = (e: ReactPointerEvent) => {
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const box = areaRef.current!.getBoundingClientRect();
    const move = (ev: PointerEvent) => setCompare(Math.max(0, Math.min(1, (ev.clientX - box.left - layer.x) / layer.w)));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  useEffect(() => {
    if (!pill) return;
    const t = setTimeout(() => setPill(null), 4200);
    return () => clearTimeout(t);
  }, [pill]);

  const reset = () => {
    jobs.cancel();
    pastRef.current = [];
    picRef.current = FIRST_PIC;
    setPic(FIRST_PIC);
    close();
    setBusy(null);
    setMenuAt(null);
    setCompare(null);
    setPill(null);
    setPrompt("");
  };
  const api = { openTool, removeBackground, setLasso, setMode, erase, setVec, applyVector, undo, setPrompt, send, pickAspect, expand };
  const apiRef = useRef(api);
  apiRef.current = api;
  const { cursor } = useDemo(rootRef, (r) => demo(r, apiRef), { onStart: reset });

  // ---- Vectorize: the drawing traced into flat shapes (live while its controls are open) ----
  const v = mode === "vectorize" ? vec : pic.vector;
  const trace = v ? { mode: v.mode, n: v.mode === "FULL_COLOR" ? v.colors : v.mode === "GRAYSCALE" ? v.grays : v.threshold } : null;

  const one = !busy;
  const lassoPx = lasso?.map(toPx);
  const isoPx = pic.isolated && { ...toPx(pic.isolated), w: pic.isolated.w * s, h: pic.isolated.h * s };
  const checker = pic.art.hidden.includes("background");

  let bar;
  if (busy) {
    bar = (
      <>
        <span className={toolCss.busyLabel} data-image-busy="">
          <Spinner size={16} />
          {busy.label}
        </span>
        <ToolbarDivider />
        <ToolTextButton label="Cancel" onSelect={() => (jobs.cancel(), setBusy(null))} />
      </>
    );
  } else if (mode === "select-area") {
    bar = (
      <>
        <span className={toolCss.busyLabel}>{lasso && !drawing && lasso.length > 2 ? "Area selected" : "Draw around an area"}</span>
        <ToolbarDivider />
        <ToolTextButton label="Erase" disabled={!lasso || drawing} onSelect={erase} />
        <ToolTextButton label="Isolate" disabled={!lasso || drawing} onSelect={isolate} />
        <ToolTextButton label="Blur" disabled={!lasso || drawing} onSelect={blur} />
        <ToolbarDivider />
        <IconButton icon="24.close.small" label="Close" onClick={close} />
      </>
    );
  } else if (mode === "expand") {
    const grown = pad.l + pad.r + pad.t + pad.b > 0;
    bar = (
      <>
        <Select label="Aspect ratio" variant="ghost" width="hug" value={aspect} options={ASPECTS.map((a) => ({ value: a.value, label: a.label }))} onChange={pickAspect} data-aspect="" />
        <ToolbarDivider />
        <IconButton icon="24.check" label="Expand" disabled={!grown} onClick={expand} data-expand-ok="" />
        <IconButton icon="24.close.small" label="Cancel" onClick={close} />
      </>
    );
  } else if (mode === "vectorize") {
    const m = VEC_MODES.find((x) => x.id === vec.mode)!;
    bar = (
      <>
        <SegmentedControl label="Mode" tone="toolbar" value={vec.mode} options={VEC_MODES.map((x) => ({ value: x.id, label: x.label }))} onChange={(x) => setVec({ ...vec, mode: x as VecMode })} data-vec-mode="" />
        <ToolbarDivider />
        <label className={`${toolCss.setting} ${styles.setting}`}>
          <span className={styles.settingName}>{m.name}</span>
          <input type="range" min={m.min} max={m.max} step={1} value={vec[m.key]} aria-label={m.name} onChange={(e) => setVec({ ...vec, [m.key]: Number(e.currentTarget.value) })} />
          <span className={toolCss.value}>{vec[m.key]}</span>
        </label>
        <ToolbarDivider />
        <IconButton icon="24.check" label="Apply" onClick={applyVector} data-vec-apply="" />
        <IconButton icon="24.close.small" label="Cancel" onClick={() => setMode(null)} />
      </>
    );
  } else {
    bar = (
      <>
        <ToolTextButton label="Edit with prompt" active={mode === "edit"} onSelect={() => openTool("edit")} />
        <ToolTextButton label="Remove background" onSelect={() => openTool("remove")} />
        <ToolTextButton label="Select area" onSelect={() => openTool("erase")} />
        <ToolbarDivider />
        <div ref={moreRef} style={{ display: "contents" }}>
          <ToolTextButton
            label="More"
            chevron
            aria-haspopup="menu"
            aria-expanded={!!menuAt}
            onSelect={(e) => {
              if (menuAt) return setMenuAt(null);
              const r = e.currentTarget.getBoundingClientRect();
              setMenuAt({ x: r.left - 11, y: r.top - 16 });
            }}
          />
        </div>
      </>
    );
  }

  return (
    <SceneWindow ref={rootRef} title="Studio Lune — Product shots" tabIndex={-1}>
      <SceneBody>
        <SceneCanvas className={styles.canvas}>
          <div ref={areaRef} className={styles.area} onPointerDown={() => mode === null && setMenuAt(null)}>
            {/* Expand: the new area, empty until confirmed */}
            {mode === "expand" && <div className={styles.expandArea} style={{ left: ox, top: oy, width: W * s, height: H * s }} />}
            <div className={styles.layer} data-checker={checker || undefined} style={{ left: layer.x, top: layer.y, width: layer.w, height: layer.h }} data-image-layer="">
              <div key={reveal} className={reveal ? styles.reveal : styles.still}>
                <ProductArt art={pic.art} view={pic.crop} trace={trace} blurs={pic.blurs} />
              </div>
              {compare !== null && (
                <div className={styles.before} style={{ clipPath: `inset(0 ${(1 - compare) * 100}% 0 0)` } as CSSProperties}>
                  <ProductArt art={pic.art} view={pic.crop} trace={trace} blurs={pic.blurs} />
                </div>
              )}
            </div>
            {compare !== null && (
              <div className={styles.compare} style={{ left: layer.x + layer.w * compare, top: layer.y, height: layer.h }} onPointerDown={compareDown} role="slider" aria-label="Before and after" aria-valuenow={Math.round(compare * 100)}>
                <span className={styles.compareKnob}>
                  <Icon name="16.drag" />
                </span>
                <span className={styles.compareTag} data-side="before">
                  Before
                </span>
                <span className={styles.compareTag} data-side="after">
                  After
                </span>
              </div>
            )}
            {isoPx && <Selection box={isoPx} instant label="Isolated" />}
            {!isoPx && mode !== "expand" && <Selection box={layer} instant label={`${Math.round(pic.crop.w * 0.5714)} × ${Math.round(pic.crop.h * 0.5714)}`} />}
            {busy && (
              <div className={`${toolCss.sweep} ${styles.sweep}`} style={{ left: layer.x, top: layer.y, width: layer.w, height: layer.h }}>
                <div className={toolCss.progress} style={{ width: `${busy.progress * 100}%` }} />
              </div>
            )}
            {mode === "select-area" && (
              <div className={styles.lassoLayer} style={{ left: layer.x, top: layer.y, width: layer.w, height: layer.h }} onPointerDown={lassoDown} onPointerMove={lassoMove} onPointerUp={() => setDrawing(false)} data-lasso="">
                <svg>{lassoPx && lassoPx.length > 1 && <path className={toolCss.lassoPath} d={`M${lassoPx.map((p) => `${p.x - layer.x} ${p.y - layer.y}`).join(" L")}${drawing ? "" : " Z"}`} />}</svg>
              </div>
            )}
            {mode === "expand" && (
              <div className={styles.expandFrame} style={{ left: ox, top: oy, width: W * s, height: H * s }}>
                {(
                  [
                    [0, 0, { l: 1, t: 1 }],
                    [0.5, 0, { t: 1 }],
                    [1, 0, { r: 1, t: 1 }],
                    [1, 0.5, { r: 1 }],
                    [1, 1, { r: 1, b: 1 }],
                    [0.5, 1, { b: 1 }],
                    [0, 1, { l: 1, b: 1 }],
                    [0, 0.5, { l: 1 }],
                  ] as const
                ).map(([x, y, sides], i) => (
                  <span key={i} className={`${toolCss.handle} ${styles.handle}`} style={{ left: `${x * 100}%`, top: `${y * 100}%` }} onPointerDown={handleDown(sides)} data-handle={i} />
                ))}
              </div>
            )}
            {(mode === "edit" || mode === "make") && !busy && (
              <div className={`${toolCss.card} ${styles.card}`} role="dialog" aria-label={mode === "make" ? "Make an image" : "Edit with prompt"} data-image-prompt={mode}>
                <div className={toolCss.cardHead}>
                  {mode === "make" ? "Make an image" : "Edit with prompt"}
                  <IconButton icon="24.close.small" label="Close" onClick={close} />
                </div>
                <TextArea label="Prompt" value={prompt} placeholder={mode === "make" ? "Describe the image you want" : "Describe your edit"} minRows={2} maxRows={4} onChange={setPrompt} onExit={(r) => r === "enter" && send(mode)} data-prompt="" />
                <div className={toolCss.cardFoot}>
                  <IconButton icon="24.plus" label="Add a reference image" />
                  <span className={toolCss.spacer} />
                  <Select
                    label="Model"
                    variant="ghost"
                    width="hug"
                    value={route}
                    options={[
                      { value: "antigravity", label: "Antigravity (Google AI)" },
                      { value: "gemini-images", label: "Gemini API" },
                    ]}
                    onChange={setRoute}
                  />
                  <Button variant="primary" disabled={!prompt.trim()} shortcut="⌘↵" onClick={() => send(mode)} data-send="">
                    Send
                  </Button>
                </div>
              </div>
            )}
            {pill && !busy && (
              <RunPill done={pill} onUndo={pill.startsWith("Undo") ? undefined : undo} />
            )}
          </div>
          <Toolbar floating secondary label="Image tools" className={styles.toolbar} data-image-toolbar={mode ?? ""}>
            {bar}
          </Toolbar>
          {menuAt && (
            <ContextMenu
              at={menuAt}
              above
              flush
              label="More image tools"
              width={189}
              entries={[
                { id: "expand", label: "Expand" },
                { id: "boost", label: "Boost resolution" },
                { id: "vectorize", label: "Vectorize" },
              ]}
              ignore={moreRef}
              onSelect={(id) => openTool(id)}
              onClose={() => setMenuAt(null)}
            />
          )}
          <DemoCursor cursor={cursor} />
        </SceneCanvas>
        <Panel title="Image tools">
          <div className={styles.tools}>
            {TOOLS.map((t) => (
              <button key={t.id} type="button" className={styles.tool} disabled={!one} onClick={() => openTool(t.id)} data-tool={t.id} data-active={mode === t.id || (t.id === "erase" && mode === "select-area") || undefined}>
                <span className={styles.toolIcon}>
                  <Icon name={t.icon} />
                </span>
                <span className={styles.toolText}>
                  <span className={styles.toolName}>{t.label}</span>
                  <span className={styles.toolModel}>{t.model}</span>
                </span>
                <WhereTag where={t.where} />
              </button>
            ))}
          </div>
          <PanelSection title="Picture">
            <dl className={styles.facts}>
              <div>
                <dt>Size</dt>
                <dd data-pixels="">{pixels(pic.crop, pic.boosted)}</dd>
              </div>
              <div>
                <dt>Credits</dt>
                <dd>Make and edit 2–16 by model</dd>
              </div>
            </dl>
            <p className={styles.note}>Local models download once, the first time a tool needs them, after you confirm their size.</p>
          </PanelSection>
        </Panel>
      </SceneBody>
    </SceneWindow>
  );
}

// ---- the guided demo ---------------------------------------------------------------------------------------------

type Api = {
  openTool: (id: string) => void;
  setLasso: (l: { x: number; y: number }[] | null) => void;
  setMode: (m: Mode) => void;
  erase: () => void;
  setVec: (v: Vec) => void;
  applyVector: () => void;
  undo: () => void;
  setPrompt: (p: string) => void;
  send: (k: "make" | "edit", text?: string) => void;
};

async function demo(run: SceneRun, api: { current: Api }) {
  await run.wait(900);
  // Remove the background (on this computer)
  await run.click(run.$('[data-image-toolbar] [aria-label="Remove background"]'));
  api.current.openTool("remove");
  await run.wait(3600);
  await run.click(run.$("[data-undo]"));
  api.current.undo();
  await run.wait(900);
  // Lasso the cup and erase it
  await run.click(run.$('[data-image-toolbar] [aria-label="Select area"]'));
  api.current.openTool("erase");
  await run.wait(500);
  const layer = run.$("[data-image-layer]");
  if (layer) {
    const r = layer.getBoundingClientRect();
    const root = run.root.getBoundingClientRect();
    // The cup sits at world (300, 730) in the crop (200…760, 150…850)
    const cx = r.left - root.left + ((300 - 200) / 560) * r.width;
    const cy = r.top - root.top + ((730 - 150) / 700) * r.height;
    const rx = (110 / 560) * r.width;
    const ry = (80 / 700) * r.height;
    const pts: { x: number; y: number }[] = [];
    await run.move({ x: cx + rx, y: cy });
    run.press(true);
    for (let i = 0; i <= 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const p = { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry * 1.05 };
      await run.move(p, { ms: 30 });
      pts.push({ x: 200 + ((p.x - (r.left - root.left)) / r.width) * 560, y: 150 + ((p.y - (r.top - root.top)) / r.height) * 700 });
      api.current.setLasso([...pts]);
    }
    run.press(false);
  }
  await run.wait(500);
  await run.click(run.$('[data-image-toolbar] [aria-label="Erase"]'));
  api.current.erase();
  await run.wait(3400);
  // Vectorize, four colours
  await run.click(run.$('[data-tool="vectorize"]'));
  api.current.openTool("vectorize");
  await run.wait(900);
  for (const colors of [6, 4]) {
    api.current.setVec({ mode: "FULL_COLOR", colors, grays: 4, threshold: 50 });
    await run.wait(700);
  }
  await run.click(run.$("[data-vec-apply]"));
  api.current.applyVector();
  await run.wait(1800);
  // Edit with prompt: evening light
  await run.click(run.$('[data-image-toolbar] [aria-label="Edit with prompt"]'));
  api.current.openTool("edit");
  await run.wait(400);
  const text = "Evening light, a warm lamp glow";
  for (let i = 1; i <= text.length; i += 2) {
    api.current.setPrompt(text.slice(0, i));
    await run.wait(40);
  }
  api.current.setPrompt(text);
  await run.click(run.$("[data-send]"));
  api.current.send("edit", text);
  await run.wait(4200);
  run.hide();
  await run.wait(1500);
}
