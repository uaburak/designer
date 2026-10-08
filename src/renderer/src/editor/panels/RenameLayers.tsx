/**
 * "Rename layers" (⌘R with several layers selected; help "Rename layers"): Match (optional), Rename to — with
 * Current name ($&) and Number ($nn up, $NN down) put in at the caret —, Start from, a preview of the first new
 * names, and Rename: every name changed as one undo step.
 */
import { useMemo, useRef, useState } from "react";
import { Button, Dialog, NumericInput, TextInput } from "@/ds";
import { useEditor } from "../controller";
import { writeOn } from "../components";
import { useUI } from "../hooks";
import { inPanelOrder } from "../model/layerTree";
import { renameAll } from "../model/rename";
import styles from "./RenameLayers.module.css";

const PREVIEW = 4;

export function RenameLayersDialog() {
  const refs = useUI((s) => s.renameLayers ?? null);
  if (!refs?.length) return null;
  return <RenameLayers refs={refs} />;
}

function RenameLayers({ refs }: { refs: string[] }) {
  const ed = useEditor();
  const tree = ed.getTree();
  const ordered = useMemo(() => inPanelOrder(tree, refs), [tree, refs]);
  const names = useMemo(() => ordered.map((id) => tree.nodes.get(id)?.name ?? ed.engine.readNode(id, { fields: ["name"] })?.name ?? ""), [ordered, tree, ed]);
  const [match, setMatch] = useState("");
  const [renameTo, setRenameTo] = useState("$&");
  const [start, setStart] = useState(1);
  const field = useRef<HTMLDivElement>(null);
  const next = renameAll(names, { match, renameTo, start });

  const close = () => {
    ed.ui.set({ renameLayers: null });
    ed.focusCanvas();
  };
  const insert = (token: string) => {
    const input = field.current?.querySelector("input");
    const at = input?.selectionStart ?? renameTo.length;
    const end = input?.selectionEnd ?? at;
    setRenameTo(renameTo.slice(0, at) + token + renameTo.slice(end));
    queueMicrotask(() => {
      input?.focus();
      input?.setSelectionRange(at + token.length, at + token.length);
    });
  };
  const apply = () => {
    ed.batch("Rename", () => {
      ordered.forEach((id, i) => {
        if (next[i] === names[i]) return;
        if (tree.nodes.get(id)?.derived) writeOn(ed, id, { name: next[i] });
        else ed.engine.setProps([id], { name: next[i] });
      });
    });
    close();
  };

  return (
    <Dialog
      title={`Rename ${refs.length} layers`}
      size="small"
      open
      onClose={close}
      footer={
        <Button variant="primary" onClick={apply} data-rename-apply="">
          Rename
        </Button>
      }
    >
      <div className={styles.body} data-rename-layers="">
        <label className={styles.label}>Match</label>
        <TextInput label="Match" placeholder="Leave empty to rename the whole name" value={match} selectAllOnFocus={false} onChange={setMatch} onCommit={setMatch} data-rename-match="" />
        <label className={styles.label}>Rename to</label>
        <div ref={field}>
          <TextInput label="Rename to" value={renameTo} autoFocus onChange={setRenameTo} onCommit={setRenameTo} onExit={(r) => r === "enter" && apply()} data-rename-to="" />
        </div>
        <div className={styles.tokens}>
          <Button variant="secondary" onClick={() => insert("$&")}>
            Current name
          </Button>
          <Button variant="secondary" onClick={() => insert("$nn")}>
            Number ↑
          </Button>
          <Button variant="secondary" onClick={() => insert("$NN")}>
            Number ↓
          </Button>
        </div>
        <label className={styles.label}>Start from</label>
        <div className={styles.start}>
          <NumericInput label="Start from" value={start} min={0} step={1} onChange={(v) => setStart(Math.max(0, Math.round(Number(v) || 0)))} />
        </div>
        <div className={styles.preview} aria-label="Preview">
          {names.slice(0, PREVIEW).map((n, i) => (
            <div key={ordered[i]} className={styles.previewRow} data-rename-preview={next[i]}>
              <span className={styles.old}>{n}</span>
              <span className={styles.arrow}>→</span>
              <span className={styles.new}>{next[i]}</span>
            </div>
          ))}
          {names.length > PREVIEW && <div className={styles.more}>and {names.length - PREVIEW} more</div>}
        </div>
      </div>
    </Dialog>
  );
}
