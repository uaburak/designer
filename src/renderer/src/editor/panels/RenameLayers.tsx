/**
 * "Rename N layers" (⌘R with several layers selected; live: docs/research/figma/live/behaviour/layers.md #5 and
 * behaviour/img/bulk-rename-dialog-and-smart-selection.jpg): the Preview column (the names as they will be, top row
 * first), Match (optional), Rename to — Current name ($&) and Number ($nn up, $NN down) put in at the caret —,
 * Start ascending from, Learn more, Cancel / Rename: every name changed as one undo step. An empty Rename to with no
 * match changes nothing.
 */
import { useMemo, useRef, useState } from "react";
import { Button, Dialog, NumericInput, TextInput } from "@/ds";
import { useEditor } from "../controller";
import { writeOn } from "../components";
import { useUI } from "../hooks";
import { inPanelOrder } from "../model/layerTree";
import { renameAll } from "../model/rename";
import styles from "./RenameLayers.module.css";

/** "Learn more" (help.figma.com "Rename layers") */
const LEARN_MORE = "https://help.figma.com/hc/en-us/search?query=rename%20layers";

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
  const [renameTo, setRenameTo] = useState("");
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
      size="medium"
      open
      onClose={close}
      footer={
        <div className={styles.footer}>
          <a className={styles.learn} href={LEARN_MORE} target="_blank" rel="noreferrer">
            Learn more
          </a>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" onClick={apply} data-rename-apply="">
            Rename
          </Button>
        </div>
      }
    >
      <div className={styles.body} data-rename-layers="">
        <div className={styles.preview} aria-label="Preview">
          <div className={styles.previewTitle}>Preview</div>
          <div className={styles.previewList}>
            {names.map((n, i) => (
              <div key={ordered[i]} className={styles.previewRow} title={next[i] !== n ? `${n} → ${next[i]}` : n} data-rename-preview={next[i]}>
                {next[i]}
              </div>
            ))}
          </div>
        </div>
        <div className={styles.fields}>
          <TextInput label="Match (optional)" placeholder="Match (optional)" value={match} selectAllOnFocus={false} onChange={setMatch} onCommit={setMatch} data-rename-match="" />
          <div ref={field}>
            <TextInput label="Rename to" placeholder="Rename to" value={renameTo} autoFocus onChange={setRenameTo} onCommit={setRenameTo} onExit={(r) => r === "enter" && apply()} data-rename-to="" />
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
          <label className={styles.start}>
            <span>Start ascending from</span>
            <span className={styles.startField}>
              <NumericInput label="Start ascending from" value={start} min={0} step={1} onChange={(v) => setStart(Math.max(0, Math.round(Number(v) || 0)))} />
            </span>
          </label>
        </div>
      </div>
    </Dialog>
  );
}
