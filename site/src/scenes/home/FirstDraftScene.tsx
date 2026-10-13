// First Draft (docs/ai.md §1, the Actions panel's AI view): describe a screen — the prompt, the suggestions, Library
// (the app's kits; Auto picks app or website, design or wireframe from the words, as autoKit does) and "Make it" —
// and the draft's layers arrive one by one on the canvas under the AI shimmer, the Layers list filling in. Then
// "Make changes": Color (Light / Dark and the presets), Border radius and Spacing, restyling the
// draft live. The draft here is drawn by the page from templates (no model is called on the site).
import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Button, IconButton } from "@/ds/components/Button";
import { LayerRow } from "@/ds/components/LayerRow";
import { Badge } from "@/ds/components/Misc";
import { SegmentedControl } from "@/ds/components/SegmentedControl";
import { Select } from "@/ds/components/Select";
import { Slider } from "@/ds/components/Slider";
import { Spinner } from "@/ds/components/Spinner";
import { TextArea, TextInput } from "@/ds/components/TextInput";
import ai from "@/editor/ai/AiPanel.module.css";
import { COLOR_PRESETS, kitFor, LIBRARY_CHOICES, type Kit, type LibraryChoice } from "@shared/ai/kits";
import { boxIn, FrameLabel, Panel, SceneBody, SceneCanvas, SceneWindow, Selection, type Box } from "../kit/kit";
import { DemoCursor, useDemo, type SceneRun } from "../runtime/useDemo";
import { appBlocks, templateFor, webBlocks, type Block, type Template } from "./draftTemplates";
import { clamp, useSize } from "./shared";
import styles from "./firstdraft.module.css";

const SUGGESTIONS = ["A habit tracker for a fitness app", "A sign up screen for a meditation app", "A travel app home screen", "A music player"];

interface Look {
  mode: "light" | "dark";
  primary: string;
  radius: number;
  spacing: number;
}

interface Draft {
  prompt: string;
  kit: Kit;
  template: Template;
  blocks: Block[];
}

type Phase = "form" | "running" | "done";

const PALETTES = {
  light: { bg: "#ffffff", surface: "#f4f4f5", text: "#18181b", muted: "#71717a", border: "#e4e4e7" },
  dark: { bg: "#111113", surface: "#1d1d21", text: "#fafafa", muted: "#a1a1aa", border: "#2c2c31" },
};

function lookStyle(look: Look, kit: Kit): CSSProperties {
  const p = PALETTES[look.mode];
  const wire = kit.style === "wireframe";
  return {
    ["--d-bg" as string]: p.bg,
    ["--d-surface" as string]: wire ? (look.mode === "dark" ? "#26262a" : "#f0f0f0") : p.surface,
    ["--d-text" as string]: p.text,
    ["--d-muted" as string]: p.muted,
    ["--d-border" as string]: p.border,
    ["--d-primary" as string]: wire ? (look.mode === "dark" ? "#d4d4d8" : "#3f3f46") : look.primary,
    ["--d-on-primary" as string]: wire && look.mode === "dark" ? "#111113" : "#ffffff",
    ["--d-r" as string]: `${look.radius}px`,
    ["--d-s" as string]: `${look.spacing}px`,
  };
}

export default function FirstDraftScene() {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [prompt, setPrompt] = useState("");
  const [library, setLibrary] = useState<LibraryChoice>("auto");
  const [phase, setPhase] = useState<Phase>("form");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [shown, setShown] = useState(0);
  const [look, setLook] = useState<Look>({ mode: "light", primary: "#14804A", radius: 12, spacing: 12 });
  const [change, setChange] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [selBox, setSelBox] = useState<Box | null>(null);
  const run = useRef(0);

  const make = useCallback(
    (text: string, lib: LibraryChoice = library) => {
      const p = text.trim();
      if (!p) return;
      const kit = kitFor(lib, p);
      const template = templateFor(p);
      const blocks = kit.platform === "web" ? webBlocks(template) : appBlocks(template);
      const id = ++run.current;
      setDraft({ prompt: p, kit, template, blocks });
      setLook((l) => ({ ...l, primary: template.accent }));
      setShown(0);
      setSelected(null);
      setPhase("running");
      // The layers arrive one by one, as the draft is built
      blocks.forEach((_, i) => window.setTimeout(() => run.current === id && setShown(i + 1), 650 + i * 280));
      window.setTimeout(() => run.current === id && setPhase("done"), 650 + blocks.length * 280 + 300);
    },
    [library],
  );

  // The selection follows the layer it's on
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const el = selected ? frameRef.current?.querySelector(`[data-block="${selected}"]`) : selected === "frame" ? frameRef.current : null;
    setSelBox(selected === "frame" ? boxIn(frameRef.current, canvas) : el ? boxIn(el, canvas) : null);
  }, [selected, look, shown, draft]);

  const { cursor } = useDemo(rootRef, (r) => demo(r, { setPrompt, make, setLook, setSelected }), {
    onStart: () => {
      run.current++;
      setPrompt("");
      setLibrary("auto");
      setPhase("form");
      setDraft(null);
      setShown(0);
      setSelected(null);
      setLook({ mode: "light", primary: "#14804A", radius: 12, spacing: 12 });
    },
  });

  const size = useSize(canvasRef);
  const web = draft?.kit.platform === "web";
  const fw = web ? 520 : 300;
  const fh = web ? 360 : 600;
  const fs = clamp(Math.min((size.w - 48) / fw, (size.h - 72) / fh), 0.3, 1);
  const running = phase === "running";
  const blocks = draft?.blocks ?? [];

  return (
    <SceneWindow ref={rootRef} title="Untitled — First Draft" className={styles.root}>
      <SceneBody>
        <Panel side="left" title="Layers">
          <div className={styles.layers} role="tree" aria-label="Layers">
            {draft ? (
              <>
                <LayerRow id="frame" depth={0} name={draft.template.name} icon="16.frame" expanded selected={selected === "frame"} />
                {[...blocks.slice(0, shown)].reverse().map((b) => (
                  <LayerRow key={b.id} id={b.id} depth={1} name={b.name} icon={b.icon} kind={b.icon === "16.instance" ? "instance" : "default"} selected={selected === b.id} selectedAncestor={selected === "frame"} className={styles.rowIn} />
                ))}
              </>
            ) : (
              <div className={styles.noLayers}>The draft's layers show here.</div>
            )}
          </div>
        </Panel>
        <SceneCanvas ref={canvasRef} className={styles.canvas}>
          {draft ? (
            <div className={styles.center}>
              <div className={styles.frameWrap} style={{ width: fw * fs, height: fh * fs }}>
                {running && <div className={styles.glow} aria-hidden="true" />}
                <FrameLabel x={0} y={0} selected={selected === "frame"}>
                  {draft.template.name}
                </FrameLabel>
                <div
                  ref={frameRef}
                  className={styles.frame}
                  data-web={web || undefined}
                  data-wire={draft.kit.style === "wireframe" || undefined}
                  data-running={running || undefined}
                  style={{ ...lookStyle(look, draft.kit), width: fw, height: fh, transform: `scale(${fs})` }}
                >
                  {blocks.map((b, i) => (
                    <div key={`${draft.prompt}-${b.id}`} className={styles.block} data-block={b.id} data-in={i < shown || undefined}>
                      {b.render()}
                    </div>
                  ))}
                </div>
                {running && <div className={styles.shimmer} aria-hidden="true" />}
              </div>
            </div>
          ) : (
            <div className={styles.empty}>
              <span className={styles.emptyFrame} />
              <span>Describe a screen and press Make it.</span>
            </div>
          )}
          <Selection box={selBox} label={selBox ? `${Math.round(selBox.w / fs)} × ${Math.round(selBox.h / fs)}` : undefined} instant />
          <DemoCursor cursor={cursor} />
        </SceneCanvas>
        <Panel>
          <div className={`${ai.view} ${styles.aiView}`} data-ai-view="first-draft">
            <div className={ai.header}>
              <IconButton icon="24.arrow.left" label="Back" tone="secondary" disabled={running} />
              <span className={ai.title}>First Draft</span>
              <Badge>AI</Badge>
            </div>
            <div className={ai.body}>
              {running ? (
                <div className={ai.running} role="status">
                  <Spinner size={24} label="Making a first draft…" />
                  <span>Making a first draft…</span>
                  <Button variant="secondary">
                    Stop
                  </Button>
                </div>
              ) : phase === "done" && draft ? (
                <MakeChanges look={look} setLook={setLook} change={change} setChange={setChange} onDone={() => {}} />
              ) : (
                <div className={ai.form}>
                  <TextArea
                    label="Describe what you want to make"
                    placeholder="Describe what you want to make"
                    value={prompt}
                    onChange={setPrompt}
                    minRows={3}
                    maxRows={5}
                    data-demo="prompt"
                  />
                  <div className={ai.chips}>
                    {SUGGESTIONS.map((sg) => (
                      <button key={sg} type="button" className={`${ai.chip} ${styles.suggestion}`}>
                        {sg}
                      </button>
                    ))}
                  </div>
                  <div className={`${ai.actions} ${styles.actions}`}>
                    <Select label="Library" prefix="24.library" value={library} options={LIBRARY_CHOICES.map((c) => ({ value: c.id, label: c.label }))} onChange={(v) => setLibrary(v as LibraryChoice)} width={150} />
                    <Button variant="primary" disabled={!prompt.trim()} data-demo="make">
                      Make it
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </Panel>
      </SceneBody>
    </SceneWindow>
  );
}

function MakeChanges({ look, setLook, change, setChange, onDone }: { look: Look; setLook: (f: (l: Look) => Look) => void; change: string; setChange: (s: string) => void; onDone: () => void }) {
  const set = (patch: Partial<Look>) => setLook((l) => ({ ...l, ...patch }));
  return (
    <div className={ai.form}>
      <div className={ai.label}>Make changes</div>
      <div className={`${ai.row} ${styles.changeRow}`}>
        <TextInput className={ai.grow} label="Describe a change" placeholder="Describe a change" value={change} onChange={setChange} />
        <Button variant="secondary" disabled={!change.trim()}>
          Make changes
        </Button>
      </div>
      <div className={styles.control}>
        <span className={ai.field}>Color</span>
        <SegmentedControl
          label="Color"
          value={look.mode}
          options={[
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
          onChange={(v) => set({ mode: v as Look["mode"] })}
          data-demo="mode"
        />
      </div>
      <div className={styles.control}>
        <span />
        <span className={ai.presets}>
          {COLOR_PRESETS.map((c) => (
            <button key={c.color} type="button" aria-label={c.name} aria-pressed={look.primary === c.color} className={`${ai.preset} ${look.primary === c.color ? ai.presetOn : ""}`} style={{ background: c.color }} onClick={() => set({ primary: c.color })} />
          ))}
        </span>
      </div>
      <div className={styles.control}>
        <span className={ai.field}>Border radius</span>
        <Slider label="Border radius" value={look.radius} min={0} max={32} onChange={(radius) => set({ radius })} data-demo="radius" />
        <span className={styles.value}>{look.radius}</span>
      </div>
      <div className={styles.control}>
        <span className={ai.field}>Spacing</span>
        <Slider label="Spacing" value={look.spacing} min={4} max={24} onChange={(spacing) => set({ spacing })} data-demo="spacing" />
        <span className={styles.value}>{look.spacing}</span>
      </div>
      <div className={ai.actions}>
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

async function demo(
  run: SceneRun,
  s: { setPrompt: (p: string) => void; make: (p: string, lib?: LibraryChoice) => void; setLook: (f: (l: Look) => Look) => void; setSelected: (id: string | null) => void },
) {
  await run.wait(600);
  await run.click(run.$('[data-demo="prompt"]'));
  const text = "A habit tracker for a fitness app";
  for (let i = 1; i <= text.length; i++) {
    s.setPrompt(text.slice(0, i));
    await run.wait(38 + (text[i - 1] === " " ? 40 : 0));
  }
  await run.wait(400);
  await run.click(run.$('[data-demo="make"]'));
  s.make(text, "auto");
  run.hide();
  await run.wait(650 + 7 * 280 + 700);
  // Real layers: select one on the canvas, the Layers list follows
  await run.click(run.$('[data-block="hero"]'));
  s.setSelected("hero");
  await run.wait(1000);
  s.setSelected(null);
  // Dark, rounder, airier
  await run.click(run.$('[data-demo="mode"] [role="radio"]:nth-child(2), [data-demo="mode"] button:nth-child(2)'));
  s.setLook((l) => ({ ...l, mode: "dark" }));
  await run.wait(900);
  const slider = run.$('[data-demo="radius"]');
  await run.move(slider, { dx: -20 });
  run.press(true);
  for (let r = 12; r <= 24; r += 1) {
    s.setLook((l) => ({ ...l, radius: r }));
    await run.move(run.at(slider, -20 + (r - 12) * 3), { ms: 40 });
  }
  run.press(false);
  await run.wait(700);
  await run.click(run.$('[aria-label="Indigo"]'));
  s.setLook((l) => ({ ...l, primary: "#4F46E5" }));
  await run.wait(1600);
  run.hide();
  await run.wait(1200);
}
