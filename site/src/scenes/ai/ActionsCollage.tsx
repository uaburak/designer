// AI actions (docs/ai.md §3): ⌘K opens Actions with the app's own rows (editor/ai/actionRows.ts: their labels,
// sections and icons); "Rename layers" is chosen, and the layers' default names turn into names that mean something,
// one after another, as one undo step.
import { useState } from "react";
import { SearchField } from "@/ds/components/SearchField";
import { Spinner } from "@/ds/components/Spinner";
import { Icon } from "@/ds/icons/Icon";
import { AI_ROWS } from "@/editor/ai/actionRows";
import { Collage, CURSOR, Cursor, FrameName, Piece, Selection } from "../collage/kit";
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

export default function ActionsCollage() {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [renamed, setRenamed] = useState(0);
  const [me, setMe] = useState<[number, number, boolean?]>([700, 520]);

  const script = async (run: Run) => {
    await run.wait(900);
    setOpen(true);
    await run.wait(700);
    setMe([520, 186]);
    setHover("ai.rename-layers");
    await run.wait(1000);
    setMe([520, 186, true]);
    await run.wait(160);
    setMe([520, 186]);
    setRunning(true);
    await run.wait(700);
    setOpen(false);
    for (let i = 1; i <= NAMES.length; i++) {
      await run.wait(220);
      setRenamed(i);
    }
    setRunning(false);
    setMe([640, 470]);
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

      <Piece surface x={372} y={88} w={320} show={open} from="scale" z={20} className={styles.actions}>
        <div className={styles.actionsSearch}>
          <SearchField value="" onChange={noop} placeholder="Search actions" />
        </div>
        {SECTIONS.map((section) => (
          <div key={section} className={styles.actionsGroup}>
            <span className={styles.actionsHeading}>{section}</span>
            {actions
              .filter((r) => r.section === section)
              .map((r) => (
                <span key={r.id} className={styles.actionRow} data-hover={hover === r.id || undefined}>
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
          {renamed < NAMES.length ? <Spinner size={16} /> : <Icon name="16.check" />}
          {renamed < NAMES.length ? "Renaming layers…" : `Renamed ${NAMES.length} layers`}
        </span>
      </Piece>
      <Cursor x={me[0]} y={me[1]} press={me[2]} color={CURSOR.ink} d={500} z={30} />
    </Collage>
  );
}
