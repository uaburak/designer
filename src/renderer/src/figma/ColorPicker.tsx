import { useEffect, useMemo, useRef, useState } from "react";
import type { DesignVariable, VariableValue } from "@/types/design";
import { cn } from "@/lib/utils";
import { fi } from "@/components/admin/figmaIcons";
import { boundValue, splitName, type ThemeMode } from "@/components/project/designVariables";
import { ChevronMenu, IconButton, NumericInput, Select, Tab, TextInput, selectAllOnClick } from "./ui";
import { PAINT_LABEL, type GradientStop, type Paint } from "./model";

/**
 * Figma's colour picker (UI3): Custom — the colour's square (saturation
 * across, brightness down), the hue and the alpha sliders, the eyedropper,
 * the hex and the opacity, the colours already on this page; Libraries —
 * the site's colour variables as Figma lists them: a search, the library
 * menu, swatches (or rows) by collection and group. Floats beside the
 * design panel.
 */

type Hsv = { h: number; s: number; v: number };

function hexToHsv(hex: string): Hsv {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0;
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

function hsvToHex({ h, s, v }: Hsv): string {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

export function ColorPicker({ color, opacity, anchor, variables, byId, mode, pageColors, onChange, onVariable, onClose, paint, onPaint, onUpload, onCreateVariable, initialTab, selectedId }: {
  color: string;
  opacity: number;
  /** Which tab opens first (Custom unless said) */
  initialTab?: "custom" | "libraries";
  /** The variable the colour is bound to, if any — marked in Libraries */
  selectedId?: string;
  /** The fill being edited, when it may become a gradient or an image */
  paint?: Paint;
  onPaint?: (paint: Paint) => void;
  /** An image chosen from the disk: its URL once uploaded */
  onUpload?: (file: File) => Promise<string>;
  /** "+": the colour kept as a new colour variable */
  onCreateVariable?: (hex: string) => void;
  /** Where it opens: beside the panel, at this top */
  anchor: { top: number; right: number };
  variables: DesignVariable[];
  byId: Map<string, DesignVariable>;
  mode: ThemeMode;
  /** The colours used on this page (Figma's "Document colors") */
  pageColors: string[];
  onChange: (hex: string, opacity: number) => void;
  onVariable?: (value: VariableValue) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"custom" | "libraries">(initialTab ?? "custom");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [library, setLibrary] = useState<string | null>(null);
  const kind: NonNullable<Paint["type"]> = paint?.type ?? "solid";
  const [stop, setStop] = useState(0);
  const [uploading, setUploading] = useState(false);
  const stops = paint?.gradient?.stops ?? [];
  const current = kind === "gradient" && stops[stop] ? stops[stop].color : color;
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(current));
  const [hexDraft, setHexDraft] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  // The colour changed elsewhere (a variable, the hex): the square follows — not while it is being dragged here.
  const own = useRef(current);
  useEffect(() => {
    if (current.toLowerCase() !== own.current.toLowerCase()) {
      own.current = current;
      setHsv(hexToHsv(current));
    }
  }, [current]);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element;
      if (!ref.current?.contains(t) && !t.closest("[data-picker-anchor]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("pointerdown", onDown); window.removeEventListener("keydown", onKey, true); };
  }, [onClose]);

  const setStops = (next: GradientStop[]) => onPaint?.({ ...paint!, type: "gradient", gradient: { angle: paint?.gradient?.angle ?? 90, stops: next } });
  const set = (next: Hsv) => {
    setHsv(next);
    const hex = hsvToHex(next);
    own.current = hex;
    if (kind === "gradient" && stops[stop]) return setStops(stops.map((st, i) => (i === stop ? { ...st, color: hex } : st)));
    onChange(hex, opacity);
  };
  const setKind = (next: NonNullable<Paint["type"]>) => {
    if (!paint || !onPaint || next === kind) return;
    if (next === "solid") return onPaint({ ...paint, type: undefined, gradient: undefined, image: undefined });
    if (next === "gradient") return onPaint({ ...paint, type: "gradient", gradient: paint.gradient ?? { angle: 90, stops: [{ color, position: 0 }, { color: "#ffffff", position: 100 }] } });
    onPaint({ ...paint, type: "image", image: paint.image ?? { url: "", fit: "fill" } });
  };
  const chooseImage = () => {
    if (!onUpload) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setUploading(true);
      try {
        const url = await onUpload(file);
        onPaint?.({ ...paint!, type: "image", image: { ...paint?.image, url, fit: paint?.image?.fit ?? "fill" } });
      } finally {
        setUploading(false);
      }
    };
    input.click();
  };
  const drag = (e: React.PointerEvent, update: (x: number, y: number) => void) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const at = (ev: { clientX: number; clientY: number }) => update(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)));
    at(e);
    const move = (ev: PointerEvent) => at(ev);
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const hueColor = hsvToHex({ h: hsv.h, s: 1, v: 1 });
  const eyedropper = typeof window !== "undefined" && "EyeDropper" in window;
  const pick = async () => {
    try {
      const Dropper = (window as unknown as { EyeDropper: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
      const { sRGBHex } = await new Dropper().open();
      set(hexToHsv(sRGBHex));
    } catch { /* cancelled */ }
  };
  const colorVars = useMemo(() => variables.filter((v) => v.kind === "color"), [variables]);
  const DEFAULT_COLLECTION = "Collection 1";
  const collections = useMemo(() => [...new Set(colorVars.map((v) => v.collection ?? DEFAULT_COLLECTION))], [colorVars]);
  // The variables shown: the chosen library's, matching the search — by collection, then by group ("Arka plan/1" → "Arka plan").
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: [string, [string, DesignVariable[]][]][] = [];
    for (const v of colorVars) {
      const coll = v.collection ?? DEFAULT_COLLECTION;
      if ((library && coll !== library) || (q && !v.name.toLowerCase().includes(q))) continue;
      const [group] = splitName(v.name);
      let c = out.find((x) => x[0] === coll);
      if (!c) out.push((c = [coll, []]));
      let g = c[1].find((x) => x[0] === group);
      if (!g) c[1].push((g = [group, []]));
      g[1].push(v);
    }
    return out;
  }, [colorVars, library, query]);
  const pickVariable = (id: string) => { onVariable?.({ alias: id }); onClose(); };
  const valueOf = (v: DesignVariable) => String(boundValue(v.light, mode, byId) ?? "#000000");
  const top = Math.max(8, Math.min(anchor.top, window.innerHeight - 520));
  const left = Math.max(8, anchor.right - 240 - 8);

  return (
    <div ref={ref} role="dialog" aria-label="Color" className="fixed z-50 flex w-[240px] flex-col rounded-[13px] bg-[var(--f-bg)] shadow-[0_0_0.5px_rgba(0,0,0,0.3),0_10px_16px_rgba(0,0,0,0.2)] text-[11px] leading-4 text-[var(--f-text)]" style={{ top, left }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between h-10 px-2 border-b border-[var(--f-border)]">
        <div className="flex items-center gap-1">
          <Tab label="Custom" active={tab === "custom"} onClick={() => setTab("custom")} />
          <Tab label="Libraries" active={tab === "libraries"} onClick={() => setTab("libraries")} />
        </div>
        <div className="flex items-center gap-1">
          {onCreateVariable && <IconButton label="Create color variable" icon={fi("plus.small")} onClick={() => { onCreateVariable(hsvToHex(hsv)); onClose(); }} />}
          <IconButton label="Close" icon={fi("close.small")} onClick={onClose} />
        </div>
      </div>
      {tab === "custom" ? (
        <div className="flex flex-col gap-2 p-2">
          <div className="flex items-center gap-1 px-1">
            <IconButton label="Solid" icon={fi("24.fill.solid.small")} active={kind === "solid"} onClick={() => setKind("solid")} />
            {kind !== "solid" && <span className="ml-1 text-[var(--f-text-secondary)]">{PAINT_LABEL[kind]}</span>}
            <IconButton label="Gradient" icon={fi("24.gradient.linear.small")} active={kind === "gradient"} disabled={!onPaint} onClick={() => setKind("gradient")} />
            <IconButton label="Image" icon={fi("24.fill.image.small")} active={kind === "image"} disabled={!onPaint} onClick={() => setKind("image")} />
          </div>
          {kind === "gradient" && paint?.gradient && (
            <div className="flex flex-col gap-2">
              <div className="relative h-4 rounded-[3px]" style={{ background: `linear-gradient(to right, ${[...stops].sort((a, b) => a.position - b.position).map((st) => `${st.color} ${st.position}%`).join(", ")})` }} onDoubleClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); const at = Math.round(((e.clientX - r.left) / r.width) * 100); setStops([...stops, { color: hsvToHex(hsv), position: at }]); setStop(stops.length); }}>
                {stops.map((st, i) => (
                  <button key={i} type="button" aria-label={`Stop ${i + 1}`} onPointerDown={(e) => { e.stopPropagation(); setStop(i); drag(e as unknown as React.PointerEvent, () => {}); const bar = e.currentTarget.parentElement!.getBoundingClientRect(); const move = (ev: PointerEvent) => setStops(stops.map((x, j) => (j === i ? { ...x, position: Math.round(Math.min(100, Math.max(0, ((ev.clientX - bar.left) / bar.width) * 100))) } : x))); const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); }; window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); }} className={cn("absolute top-1/2 w-3 h-3 -ml-1.5 -mt-1.5 rounded-full border-2 shadow-[0_0_0_1px_rgba(0,0,0,0.3)] cursor-pointer", i === stop ? "border-[var(--f-border-selected)]" : "border-white")} style={{ left: `${st.position}%`, background: st.color }} />
                ))}
              </div>
              <div className="flex items-center gap-2">
                <NumericInput label="Angle" prefix={<span className="flex w-6 justify-center text-[var(--f-text-secondary)]">{fi("24.rotation", 16)}</span>} value={paint.gradient.angle} min={0} max={360} unit="°" onChange={(angle) => onPaint?.({ ...paint, gradient: { ...paint.gradient!, angle } })} />
                <NumericInput label="Stop position" prefix={<span className="flex w-6 justify-center text-[var(--f-text-secondary)]">%</span>} value={stops[stop]?.position ?? 0} min={0} max={100} onChange={(position) => setStops(stops.map((x, j) => (j === stop ? { ...x, position } : x)))} />
                <IconButton label="Remove stop" icon={fi("minus.small")} disabled={stops.length <= 2} onClick={() => { setStops(stops.filter((_, j) => j !== stop)); setStop(0); }} />
              </div>
            </div>
          )}
          {kind === "image" ? (
            <div className="flex flex-col gap-2">
              <div className="w-full h-[120px] rounded-[5px] bg-[var(--f-bg-secondary)] bg-center bg-no-repeat" style={{ backgroundImage: paint?.image?.url ? `url("${paint.image.url}")` : undefined, backgroundSize: paint?.image?.fit === "fit" ? "contain" : paint?.image?.fit === "tile" ? "auto" : "cover", backgroundRepeat: paint?.image?.fit === "tile" ? "repeat" : "no-repeat" }} />
              <div className="flex items-center gap-2">
                <Select label="Scale mode" value={paint?.image?.fit ?? "fill"} options={[{ value: "fill", label: "Fill" }, { value: "fit", label: "Fit" }, { value: "tile", label: "Tile" }]} onChange={(fit) => onPaint?.({ ...paint!, image: { ...paint?.image, url: paint?.image?.url ?? "", fit: fit as "fill" | "fit" | "tile" } })} />
                <button type="button" onClick={chooseImage} disabled={!onUpload || uploading} className="flex h-6 shrink-0 items-center px-2 rounded-[5px] bg-[var(--f-bg-secondary)] text-[var(--f-text)] hover:bg-[var(--f-bg-hover)] cursor-pointer disabled:opacity-50">{uploading ? "Uploading…" : "Choose image"}</button>
              </div>
              <TextInput label="Image URL" value={paint?.image?.url ?? ""} placeholder="https://…" onCommit={(url) => onPaint?.({ ...paint!, image: { ...paint?.image, url: url.trim(), fit: paint?.image?.fit ?? "fill" } })} />
              {/* What it shows, in words: for screen readers and search engines (and when it can't load). */}
              <TextInput label="Alt text" value={paint?.image?.alt ?? ""} placeholder="Alt text — what it shows" onCommit={(alt) => onPaint?.({ ...paint!, image: { url: paint?.image?.url ?? "", fit: paint?.image?.fit ?? "fill", ...paint?.image, alt: alt.trim() || undefined } })} />
              <TextInput label="Alt text (English)" value={paint?.image?.altEn ?? ""} placeholder="Alt text in English" onCommit={(altEn) => onPaint?.({ ...paint!, image: { url: paint?.image?.url ?? "", fit: paint?.image?.fit ?? "fill", ...paint?.image, altEn: altEn.trim() || undefined } })} />
            </div>
          ) : (
          <div className="relative w-full h-[184px] rounded-[5px] overflow-hidden cursor-crosshair" style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueColor})` }} onPointerDown={(e) => drag(e, (x, y) => set({ ...hsv, s: x, v: 1 - y }))}>
            <span className="pointer-events-none absolute w-3 h-3 -ml-1.5 -mt-1.5 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.3)]" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hsvToHex(hsv) }} />
          </div>
          )}
          {kind !== "image" && (
          <div className="flex items-center gap-2">
            <IconButton label="Eyedropper" icon={fi("24.eyedropper.small")} onClick={pick} disabled={!eyedropper} />
            <div className="flex flex-1 flex-col gap-2">
              <div className="relative h-3 rounded-full cursor-pointer" style={{ background: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)" }} onPointerDown={(e) => drag(e, (x) => set({ ...hsv, h: x * 360 }))}>
                <span className="pointer-events-none absolute top-1/2 w-3 h-3 -ml-1.5 -mt-1.5 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.3)]" style={{ left: `${(hsv.h / 360) * 100}%`, background: hueColor }} />
              </div>
              <div className="relative h-3 rounded-full cursor-pointer" style={{ background: `linear-gradient(to right, transparent, ${hsvToHex(hsv)}), repeating-conic-gradient(#ccc 0 25%, #fff 0 50%) 0 0 / 8px 8px` }} onPointerDown={(e) => drag(e, (x) => onChange(hsvToHex(hsv), Math.round(x * 100)))}>
                <span className="pointer-events-none absolute top-1/2 w-3 h-3 -ml-1.5 -mt-1.5 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.3)] bg-[var(--f-bg)]" style={{ left: `${opacity}%` }} />
              </div>
            </div>
          </div>
          )}
          {kind !== "image" && (
          <div className="flex items-center gap-2">
            <span className="flex shrink-0 items-center gap-1 h-6 px-2 rounded-[5px] bg-[var(--f-bg-secondary)] text-[var(--f-text)]">Hex {fi("16.chevron.down")}</span>
            <div className="flex flex-1 min-w-0 items-center h-6 rounded-[5px] bg-[var(--f-bg-secondary)]">
              <input
                aria-label="Hex"
                value={hexDraft ?? hsvToHex(hsv).replace("#", "").toUpperCase()}
                {...selectAllOnClick}
                onChange={(e) => setHexDraft(e.target.value)}
                onBlur={(e) => {
                  // Only what was typed, and a colour other than this one: leaving the field untouched keeps a bound colour bound.
                  const d = e.currentTarget.value.replace("#", "");
                  if (hexDraft !== null && /^[0-9a-f]{6}$/i.test(d) && `#${d.toLowerCase()}` !== hsvToHex(hsv).toLowerCase()) set(hexToHsv(`#${d}`));
                  setHexDraft(null);
                }}
                onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); if (e.key === "Escape") { setHexDraft(null); requestAnimationFrame(() => (e.target as HTMLInputElement).blur()); } }}
                className="min-w-0 flex-1 h-full pl-2 bg-transparent outline-none uppercase text-[var(--f-text)]"
              />
              <span className="flex w-[53px] shrink-0 h-full items-center border-l border-[var(--f-bg)]">
                <NumericInput label="Opacity" prefix={<span className="w-[7px]" />} value={opacity} min={0} max={100} unit="%" onChange={(o) => onChange(hsvToHex(hsv), o)} className="bg-transparent border-0 hover:border-0 rounded-none" />
              </span>
            </div>
          </div>
          )}
          <div className="mt-1 pt-2 border-t border-[var(--f-border)]">
            <div className="flex items-center justify-between h-6 px-1 text-[var(--f-text)]">
              <span>Document colors</span>
              <span className="text-[var(--f-icon-secondary)]">{fi("16.chevron.down")}</span>
            </div>
            <div className="grid grid-cols-8 gap-1 px-1 pt-1 pb-1">
              {pageColors.map((c) => (
                <button key={c} type="button" title={c} aria-label={c} onClick={() => set(hexToHsv(c))} className="w-5 h-5 rounded-[3px] border border-[var(--f-border-translucent)] cursor-pointer" style={{ background: c }} />
              ))}
              {pageColors.length === 0 && <span className="col-span-8 py-1 text-[var(--f-text-secondary)]">No colors yet.</span>}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col">
          <div className="flex items-center gap-1 h-10 px-2 border-b border-[var(--f-border)]">
            <span className="flex w-6 h-6 shrink-0 items-center justify-center text-[var(--f-icon-secondary)]">{fi("24.search.small")}</span>
            <input aria-label="Search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} className="min-w-0 flex-1 h-6 bg-transparent outline-none text-[var(--f-text)] placeholder:text-[var(--f-text-secondary)]" />
          </div>
          <div className="flex items-center justify-between h-10 pl-2 pr-2 border-b border-[var(--f-border)]">
            <ChevronMenu label="Library" items={[{ label: "All libraries", checked: !library, onSelect: () => setLibrary(null) }, ...collections.map((c) => ({ label: c, checked: library === c, onSelect: () => setLibrary(c) }))]}>
              <span className="text-[11px] text-[var(--f-text)]">{library ?? "All libraries"}</span>
            </ChevronMenu>
            <IconButton label={view === "grid" ? "List view" : "Grid view"} icon={fi(view === "grid" ? "list-view" : "24.grid")} onClick={() => setView(view === "grid" ? "list" : "grid")} />
          </div>
          <div className="flex flex-col max-h-[400px] overflow-y-auto px-3 pb-2">
            {grouped.length === 0 && <p className="py-3 text-[var(--f-text-secondary)]">{colorVars.length ? "No results" : "No color variables."}</p>}
            {grouped.map(([coll, groups]) => (
              <div key={coll} className="flex flex-col">
                <p className="flex items-center h-8 text-[11px] font-[550] text-[var(--f-text)]">{coll}</p>
                {groups.map(([group, list]) => (
                  <div key={group || "_"} className="flex flex-col pb-1">
                    {group && <p className="flex items-center h-6 text-[11px] text-[var(--f-text-secondary)]">{group}</p>}
                    {view === "grid" ? (
                      <div className="flex flex-wrap gap-2 py-1">
                        {list.map((v) => (
                          <button key={v.id} type="button" title={v.name} aria-label={v.name} disabled={!onVariable} onClick={() => pickVariable(v.id)} className={cn("w-7 h-7 rounded-[4px] border border-[var(--f-border-translucent)] cursor-pointer", selectedId === v.id && "outline outline-2 outline-offset-1 outline-[var(--f-border-selected)]")} style={{ background: valueOf(v) }} />
                        ))}
                      </div>
                    ) : (
                      list.map((v) => (
                        <button key={v.id} type="button" disabled={!onVariable} onClick={() => pickVariable(v.id)} className={cn("flex items-center gap-2 h-8 -mx-1 px-1 rounded-[5px] text-left hover:bg-[var(--f-bg-hover)] cursor-pointer", selectedId === v.id && "bg-[var(--f-bg-secondary)]")}>
                          <span className="w-4 h-4 shrink-0 rounded-[3px] border border-[var(--f-border-translucent)]" style={{ background: valueOf(v) }} />
                          <span className="min-w-0 flex-1 truncate text-[var(--f-text)]">{splitName(v.name)[1] || v.name}</span>
                        </button>
                      ))
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Every colour of its own used in these nodes (fills and strokes), each once. */
export function colorsIn(nodes: readonly import("./model").SceneNode[]): string[] {
  const out = new Set<string>();
  const visit = (list: readonly import("./model").SceneNode[]) => {
    for (const n of list) {
      for (const p of [...(n.fills ?? []), ...(n.type !== "text" ? n.strokes ?? [] : [])]) if (!("alias" in p.color) && typeof p.color.value === "string") out.add(p.color.value.toLowerCase());
      if ("children" in n) visit(n.children);
    }
  };
  visit(nodes);
  return [...out];
}

export { hexToHsv, hsvToHex, splitName };
