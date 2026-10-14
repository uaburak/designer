// AI actions (docs/ai.md §3): the bottom toolbar's Actions opens the palette over it (editor/panels/ActionsPanel.tsx,
// its own CSS module: the search, All / Assets / Plugins & widgets, the AI rows of editor/ai/actionRows.ts with their
// "AI" badge). "Rename layers" is clicked; the palette shows the run in its place (the app's AiPanel view: the
// action's name, "Renaming layers…", Stop), the selected screen's default layer names turn into names that mean
// something, one after another, in Layers, and the palette closes when it's done.
import { useRef, useState } from "react";
import { Button, IconButton } from "@/ds/components/Button";
import { EditorToolbar } from "@/ds/components/EditorToolbar";
import { Badge } from "@/ds/components/Misc";
import { Spinner } from "@/ds/components/Spinner";
import { Tabs } from "@/ds/components/Tabs";
import { Icon } from "@/ds/icons/Icon";
import { AI_ROWS } from "@/editor/ai/actionRows";
import aiPanel from "@/editor/ai/AiPanel.module.css";
import palette from "@/editor/panels/ActionsPanel.module.css";
import { Collage, CURSOR, Cursor, FrameName, Piece, Selection, usePointer } from "../collage/kit";
import { FileHeader, Layers, noop, type Row } from "../collage/ui";
import { BEZIER } from "../runtime/easing";
import type { Run } from "../runtime/motion";
import { pointOf } from "../together/pick";
import styles from "./ai.module.css";

const NAMES: [string, string, Row["icon"], number][] = [
  ["Frame 12", "Sign up", "16.frame", 0],
  ["Frame 8", "Header", "16.autolayout.horizontal", 1],
  ["Ellipse 3", "Logo", "16.ellipse", 2],
  ["Text", "Title", "16.text", 2],
  ["Frame 9", "Form", "16.autolayout.vertical", 1],
  ["Rectangle 4", "Email field", "16.rectangle", 2],
  ["Rectangle 5", "Password field", "16.rectangle", 2],
  ["Frame 10", "Create account", "16.autolayout.horizontal", 2],
];

const ROWS = AI_ROWS.filter((r) => r.section === "Design tools");
const FRAME = { x: 600, y: 64, w: 208, h: 364 };

export default function ActionsCollage() {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [renamed, setRenamed] = useState(0);
  const me = usePointer([760, 520]);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const script = async (run: Run) => {
    await run.wait(1100);
    const actions = pointOf(toolbarRef.current?.querySelector('button[aria-label^="Actions"]'), [0.5, 0.5]);
    if (actions) await me.click(run, actions, { beat: 260 });
    setOpen(true);
    await run.wait(650);
    const row = pointOf(listRef.current?.querySelector("[data-row='ai.rename-layers']"), [0.3, 0.55]);
    if (row) await me.to(run, row, { ms: 700, ease: BEZIER.standard });
    setActive("ai.rename-layers");
    await me.click(run, undefined, { beat: 320 });
    setRunning(true);
    await run.wait(700);
    for (let i = 1; i <= NAMES.length; i++) {
      setRenamed(i);
      await run.wait(220);
    }
    await run.wait(500);
    setOpen(false);
    setRunning(false);
  };

  const rows: Row[] = NAMES.map(([from, to, icon, depth], i) => ({ id: from, name: i < renamed ? to : from, icon, depth, expanded: depth < 2 && icon !== "16.ellipse" ? true : undefined, strong: depth === 0, selected: i === 0 }));

  return (
    <Collage size={[860, 560]} focus={[0.48, 0.5]} safe={800} script={script}>
      <Piece surface x={32} y={32} w={240} d={0} from="left">
        <FileHeader name="Bloom — App" />
        <div className={styles.renaming}>
          <Layers rows={rows} />
        </div>
      </Piece>

      {/* The selected screen on the canvas */}
      <FrameName x={FRAME.x} y={FRAME.y} selected>
        {renamed ? "Sign up" : "Frame 12"}
      </FrameName>
      <div className={styles.build} data-on="" data-auto="" data-colored="" style={{ left: FRAME.x, top: FRAME.y, width: FRAME.w, height: FRAME.h }}>
        <span className={styles.buildTitle}>
          <span>Bloom</span>
          <span data-brand="">Bloom</span>
        </span>
        <span className={styles.buildHead}>Create your account</span>
        <span className={styles.buildField}>Email</span>
        <span className={styles.buildField}>Password</span>
        <span className={styles.buildButton}>
          <i />
          <span>Create account</span>
        </span>
      </div>
      <Selection box={FRAME} />

      {/* Actions, 8 over the toolbar, its left edge at the toolbar's */}
      <Piece surface x={300} y={212} w={420} h={240} show={open} from="scale" origin="0 100%" z={20} className={styles.palette}>
        {running ? (
          <div className={aiPanel.view}>
            <div className={aiPanel.header}>
              <IconButton icon="24.arrow.left" label="Back" tone="secondary" disabled tooltip={false} />
              <span className={aiPanel.title}>Rename layers</span>
              <Badge>AI</Badge>
            </div>
            <div className={aiPanel.body}>
              <div className={aiPanel.running}>
                <Spinner size={24} />
                <span>Renaming layers…</span>
                <Button variant="secondary">Stop</Button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className={palette.search}>
              <span className={palette.searchIcon}>
                <Icon name="24.search.small" />
              </span>
              <input className={`${palette.input} ${styles.paletteInput}`} placeholder="Search actions" readOnly tabIndex={-1} />
            </div>
            <Tabs label="Action kinds" className={palette.tabs} value="all" tabs={[{ value: "all", label: "All" }, { value: "assets", label: "Assets" }, { value: "plugins", label: "Plugins & widgets" }]} onChange={noop} />
            <div ref={listRef} className={palette.list}>
              <div className={palette.header}>Design tools</div>
              {ROWS.map((r) => (
                <div key={r.id} className={palette.row} data-row={r.id} data-active={active === r.id || undefined}>
                  <span className={palette.glyph}>
                    <Icon name={r.icon} />
                  </span>
                  <span className={palette.label}>{r.label}</span>
                  <span className={aiPanel.badge}>AI</span>
                </div>
              ))}
            </div>
          </>
        )}
      </Piece>

      <Piece x={300} y={464} w={528} h={64} d={160} z={10}>
        <div ref={toolbarRef} className={styles.toolbarSlot}>
          <EditorToolbar floating tool="move" mode="design" actionsActive={open} onMode={noop} onTool={noop} />
        </div>
      </Piece>
      <Cursor {...me.state} color={CURSOR.ink} d={300} z={30} />
    </Collage>
  );
}
