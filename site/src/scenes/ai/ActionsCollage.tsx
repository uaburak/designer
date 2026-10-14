// AI actions (docs/ai.md §3): ⌘K opens Actions with the app's own rows (editor/ai/actionRows.ts: their labels,
// sections and icons); "Rename layers" is chosen, and the layers' default names turn into names that mean something,
// one after another, as one undo step.
import { useState } from "react";
import { SearchField } from "@/ds/components/SearchField";
import { Spinner } from "@/ds/components/Spinner";
import { Icon } from "@/ds/icons/Icon";
import { AI_ROWS } from "@/editor/ai/actionRows";
import { around, Collage, CURSOR, Cursor, FrameName, Piece, Selection, usePointer } from "../collage/kit";
import { BEZIER } from "../runtime/easing";
import { FileHeader, Layers, noop, type Row } from "../collage/ui";
import type { Run } from "../runtime/motion";
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

const SECTIONS = ["Design tools", "Riffing and writing"] as const;

const RENAME: [number, number] = [516, 175];

export default function ActionsCollage() {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [renamed, setRenamed] = useState(0);
  const me = usePointer([700, 520]);

  const script = async (run: Run) => {
    await run.wait(900);
    setOpen(true);
    await run.wait(500);
    await me.to(run, [RENAME[0] + 30, RENAME[1] + 30], { ms: 800 });
    setHover("ai.replace-content");
    await run.wait(200);
    await me.to(run, RENAME, { ms: 520, ease: BEZIER.standard });
    setHover("ai.rename-layers");
    await me.click(run, undefined, { beat: 260 });
    setRunning(true);
    await run.wait(600);
    setOpen(false);
    for (let i = 1; i <= NAMES.length; i++) {
      await run.wait(i === 1 ? 300 : 170 + (i % 3) * 30);
      setRenamed(i);
    }
    setRunning(false);
    await me.to(run, [640, 470], { ms: 900, ease: BEZIER.standard });
    await me.idle(run, around([640, 470], 16));
  };

  const rows: Row[] = NAMES.map(([from, to, icon, depth], i) => ({ id: from, name: i < renamed ? to : from, icon, depth, expanded: depth < 2 && icon !== "16.ellipse" ? true : undefined, strong: depth === 0, selected: i === 0 }));
  const actions = AI_ROWS.filter((r) => (SECTIONS as readonly string[]).includes(r.section));

  return (
    <Collage size={[860, 560]} focus={[0.47, 0.5]} safe={680} script={script}>
      <Piece surface x={72} y={48} w={240} d={0} from="left">
        <FileHeader name="Bloom — App" />
        <div className={styles.renaming}>
          <Layers rows={rows} />
        </div>
      </Piece>

      {/* The file's screen on the canvas, under the Actions menu */}
      <FrameName x={500} y={72} selected>
        {renamed ? "Sign up" : "Frame 12"}
      </FrameName>
      <div className={styles.build} data-on="" data-auto="" style={{ left: 500, top: 72, height: 420 }}>
        <span className={styles.buildTitle} style={{ color: "#2F7D4F" }}>
          Bloom
        </span>
        <span className={styles.buildHead}>Create your account</span>
        <span className={styles.buildField}>Email</span>
        <span className={styles.buildField}>Password</span>
        <span className={styles.buildButton} style={{ background: "#2F7D4F" }}>
          Create account
        </span>
      </div>
      <Selection box={{ x: 500, y: 72, w: 240, h: 420 }} />

      <Piece surface x={372} y={88} w={320} show={open} from="scale" origin="50% 0" z={20} className={styles.actions}>
        <div className={styles.actionsSearch}>
          <SearchField value="" onChange={noop} placeholder="Search actions" />
        </div>
        {SECTIONS.map((section) => (
          <div key={section} className={styles.actionsGroup}>
            <span className={styles.actionsHeading}>{section}</span>
            {actions
              .filter((r) => r.section === section)
              .map((r) => (
                <span key={r.id} className={styles.actionRow} data-hover={hover === r.id || undefined} data-pressable="">
                  <Icon name={r.icon} />
                  {r.label}
                  {r.id === "ai.rename-layers" && running && <Spinner size={16} />}
                </span>
              ))}
          </div>
        ))}
      </Piece>
      <Piece x={72} y={490} w={240} show={running || renamed > 0} from="up">
        <span className={styles.status}>
          <span className={styles.swap}>
            <span data-out={renamed >= NAMES.length || undefined}>
              <Spinner size={16} />
            </span>
            <span data-out={renamed < NAMES.length || undefined}>
              <Icon name="16.check" />
            </span>
          </span>
          <span className={styles.swap}>
            <span data-out={renamed >= NAMES.length || undefined}>Renaming layers…</span>
            <span data-out={renamed < NAMES.length || undefined}>Renamed {NAMES.length} layers</span>
          </span>
        </span>
      </Piece>
      <Cursor {...me.state} color={CURSOR.ink} d={300} z={30} />
    </Collage>
  );
}
