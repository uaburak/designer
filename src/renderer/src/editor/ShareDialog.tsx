/**
 * Share › developer preview (docs/data.md §13; the right panel's Share button, File ▸ Share preview…): what the
 * preview shows (all pages or this one, Inspect, exporting assets), then
 *
 * - **Publish preview** / **Copy link** once published, **Update preview** and **Stop sharing** — a link on the
 *   owner's Firebase project (Hosting serves the viewer, Storage the preview), off until it is configured and sync
 *   is on: the dialog says so;
 * - **Export as HTML…** — one self-contained file (the viewer, the engine, the file and its images) saved where the
 *   Save dialog says, sent like any attachment, opened in any browser with WebGL 2.
 *
 * Either way the store (the only writer) packages the editor's derived snapshot.
 */
import { useEffect, useState } from "react";
import { Banner, Button, Checkbox, Dialog, Select, Spinner, TextInput, showToast } from "@/ds";
import { useCurrentPage } from "@/engine/hooks";
import type { PreviewRecord } from "../../../shared/store/types";
import { useEditor } from "./controller";
import { useUI } from "./hooks";
import { shareAccess, type SharePreviewOptions } from "./previews";
import styles from "./ShareDialog.module.css";

export function ShareDialog() {
  const open = useUI((s) => s.shareOpen);
  return open ? <Share /> : null;
}

const EXPIRY = [
  { value: "never", label: "Never" },
  { value: "7", label: "In 7 days" },
  { value: "30", label: "In 30 days" },
];

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Share() {
  const ed = useEditor();
  const page = useCurrentPage(ed.store);
  const pages = ed.engine.pages();
  const fileName = useUI((s) => s.fileName);
  const [access] = useState(() => shareAccess(ed));
  const [status, setStatus] = useState<{ publish: boolean; reason: string | null } | null>(null);
  const [record, setRecord] = useState<PreviewRecord | null>(null);
  const [which, setWhich] = useState<"all" | "page">("all");
  const [inspect, setInspect] = useState(true);
  const [allowExport, setAllowExport] = useState(true);
  const [expiry, setExpiry] = useState("never");
  const [busy, setBusy] = useState<null | "publish" | "export" | "stop">(null);
  const close = () => {
    ed.ui.set({ shareOpen: false });
    ed.focusCanvas();
  };

  useEffect(() => {
    let live = true;
    void Promise.all([access.status(), access.current()]).then(
      ([s, r]) => {
        if (!live) return;
        setStatus(s);
        setRecord(r);
        if (r) {
          setInspect(r.options.inspect);
          setAllowExport(r.options.export);
          setExpiry(r.options.expiresInDays === null ? "never" : String(r.options.expiresInDays));
          setWhich(r.options.pageIds === "all" ? "all" : "page");
        }
      },
      () => live && setStatus({ publish: false, reason: "The store couldn't be reached" }),
    );
    return () => {
      live = false;
    };
  }, [access]);

  const options = (): SharePreviewOptions => ({
    pageIds: which === "all" ? "all" : [page],
    inspect,
    export: allowExport,
    expiresInDays: expiry === "7" ? 7 : expiry === "30" ? 30 : null,
  });

  const copyLink = (url: string) => {
    void navigator.clipboard?.writeText(url).then(
      () => showToast({ message: "Link copied" }),
      () => showToast({ message: "Couldn't copy the link" }),
    );
  };

  const publish = async () => {
    setBusy("publish");
    try {
      const r = await access.publish(options());
      setRecord(r);
      copyLink(r.url);
    } catch (e) {
      showToast({ message: `Couldn't publish the preview: ${message(e)}` });
    } finally {
      setBusy(null);
    }
  };

  const stop = async () => {
    if (!record) return;
    setBusy("stop");
    try {
      await access.stop(record.previewId);
      setRecord(null);
      showToast({ message: "Stopped sharing the preview" });
    } catch (e) {
      showToast({ message: `Couldn't stop sharing: ${message(e)}` });
    } finally {
      setBusy(null);
    }
  };

  const exportHtml = async () => {
    if (!access.exportHtml) return;
    setBusy("export");
    try {
      const r = await access.exportHtml(options());
      if (!("cancelled" in r)) showToast({ message: `Preview exported (${(r.bytes / 1_000_000).toFixed(1)} MB)` });
    } catch (e) {
      showToast({ message: `Couldn't export the preview: ${message(e)}` });
    } finally {
      setBusy(null);
    }
  };

  const currentName = pages.find((p) => p.guid === page)?.name ?? "This page";
  const canPublish = !!status?.publish;
  const footer = (
    <>
      {access.exportHtml && (
        <Button variant="secondary" size="large" loading={busy === "export"} disabled={!!busy} onClick={() => void exportHtml()} data-share="export">
          Export as HTML…
        </Button>
      )}
      {record ? (
        <>
          <Button variant="destructive-secondary" size="large" loading={busy === "stop"} disabled={!!busy || !canPublish} onClick={() => void stop()}>
            Stop sharing
          </Button>
          <Button variant="primary" size="large" loading={busy === "publish"} disabled={!!busy || !canPublish} onClick={() => void publish()}>
            Update preview
          </Button>
        </>
      ) : (
        <Button variant="primary" size="large" loading={busy === "publish"} disabled={!!busy || !canPublish} onClick={() => void publish()} data-share="publish">
          Publish preview
        </Button>
      )}
    </>
  );

  return (
    <Dialog title={`Share “${fileName}”`} size="medium" open onClose={close} footer={footer}>
      <div className={styles.body} data-share-dialog="">
        <p className={styles.note}>Developers see the file as it looks now, with Inspect for each layer&apos;s properties and code. They can&apos;t edit it or see your other files.</p>
        <div className={styles.field}>
          <span className={styles.label}>Pages</span>
          <Select
            label="Pages"
            value={which}
            options={[
              { value: "all", label: pages.length === 1 ? "All pages" : `All pages (${pages.length})` },
              { value: "page", label: `Only “${currentName}”` },
            ]}
            onChange={(v) => setWhich(v as "all" | "page")}
          />
        </div>
        <Checkbox label="Inspect" checked={inspect} onChange={setInspect} />
        <Checkbox label="Allow exporting assets" checked={allowExport} onChange={setAllowExport} />
        <div className={styles.field}>
          <span className={styles.label}>Link expires</span>
          <Select label="Link expires" value={expiry} options={EXPIRY} onChange={setExpiry} disabled={!canPublish} />
        </div>
        {!status ? (
          <Spinner size={16} />
        ) : record ? (
          <div className={styles.field}>
            <span className={styles.label}>Link</span>
            <div className={styles.row}>
              <TextInput label="Preview link" value={record.url} onChange={() => {}} />
              <Button variant="secondary" onClick={() => copyLink(record.url)}>
                Copy link
              </Button>
            </div>
          </div>
        ) : !canPublish ? (
          <Banner tone="default">{`${status.reason ?? "Publishing links isn't available"}. Export the preview as an HTML file to send it instead.`}</Banner>
        ) : null}
        {busy && busy !== "stop" && <p className={styles.note}>Preparing the preview… every page is laid out with its fonts first.</p>}
      </div>
    </Dialog>
  );
}
