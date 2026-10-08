/**
 * File › Export… (⇧⌘E; help.figma.com 360040028114 "Export from Figma
 * Design"): every layer of the current page with export settings, each with
 * its thumbnail (click it to find the layer on the canvas), its name (hover:
 * the file names it makes), its settings and size, and a checkbox — all
 * checked; "Export" exports the checked ones (one file through the Save
 * dialog, several into a folder).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Checkbox, Dialog } from "@/ds";
import type { ExportListEntry, Guid } from "@/engine/codec";
import { useEditor } from "./controller";
import { canExport, exportItems } from "./exporting";
import { useDocumentVersion, useUI } from "./hooks";
import { describeSetting, exportFileName } from "./model/exports";
import styles from "./ExportDialog.module.css";

export function ExportDialog() {
  const open = useUI((s) => s.exportDialog);
  return open ? <ExportDialogBody /> : null;
}

function ExportDialogBody() {
  const ed = useEditor();
  const version = useDocumentVersion(~3);
  const page = ed.store.page;
  // Read again after every committed change (a layer renamed, a setting added from the panel).
  const entries = useMemo<ExportListEntry[]>(() => (version >= 0 && canExport(ed) ? ed.engine.exportList(page) : []), [ed, page, version]);
  const [unchecked, setUnchecked] = useState<ReadonlySet<Guid>>(new Set());
  const [busy, setBusy] = useState(false);
  const checked = entries.filter((e) => !unchecked.has(e.guid));
  const close = () => {
    ed.ui.set({ exportDialog: false });
    ed.focusCanvas();
  };
  const run = async () => {
    setBusy(true);
    try {
      await exportItems(
        ed,
        checked.map((e) => ({ ref: e.guid, name: e.name, settings: e.exportSettings }))
      );
      close();
    } finally {
      setBusy(false);
    }
  };
  const files = checked.reduce((n, e) => n + e.exportSettings.length, 0);
  return (
    <Dialog
      title="Export"
      size="medium"
      open
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!files} onClick={() => void run()} data-export-dialog-run="">
            Export
          </Button>
        </>
      }
    >
      {entries.length === 0 ? (
        <div className={styles.empty} data-export-dialog-empty="">
          <p>There's nothing to export on this page.</p>
          <p className={styles.hint}>Add export settings to layers in the Design panel to export them from here.</p>
        </div>
      ) : (
        <ul className={styles.list} data-export-dialog-list="">
          {entries.map((e) => (
            <ExportRow
              key={e.guid}
              entry={e}
              checked={!unchecked.has(e.guid)}
              onCheck={(on) =>
                setUnchecked((s) => {
                  const next = new Set(s);
                  if (on) next.delete(e.guid);
                  else next.add(e.guid);
                  return next;
                })
              }
              onLocate={() => {
                ed.engine.setSelection([e.guid]);
                ed.engine.command("ZOOM_TO_SELECTION");
              }}
            />
          ))}
        </ul>
      )}
    </Dialog>
  );
}

const THUMB = 32;

function ExportRow({ entry, checked, onCheck, onLocate }: { entry: ExportListEntry; checked: boolean; onCheck: (on: boolean) => void; onLocate: () => void }) {
  const ed = useEditor();
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const px = ed.engine.renderNodeThumbnailPixels({ node: entry.guid, maxSize: THUMB * Math.max(1, Math.round(window.devicePixelRatio || 1)) });
    if (!px) return;
    c.width = px.width;
    c.height = px.height;
    c.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(px.pixels), px.width, px.height), 0, 0);
  }, [ed, entry.guid]);
  const info = useMemo(() => ed.engine.exportInfo([entry.guid], entry.exportSettings[0] ?? {}), [ed, entry]);
  const size = info?.targets[0];
  const names = entry.exportSettings.map((s) => exportFileName(entry.name, s)).join("\n");
  return (
    <li className={styles.row} data-export-dialog-row={entry.guid}>
      <Checkbox label={`Export ${entry.name}`} hideLabel checked={checked} onChange={onCheck} />
      <button type="button" className={styles.thumb} title="Find on canvas" onClick={onLocate}>
        <canvas ref={canvas} />
      </button>
      <div className={styles.text} title={names}>
        <span className={styles.name}>{entry.name}</span>
        <span className={styles.detail}>
          {entry.exportSettings.map(describeSetting).join(", ")}
          {size ? ` · ${Math.round(size.width)} × ${Math.round(size.height)}` : ""}
        </span>
      </div>
    </li>
  );
}
