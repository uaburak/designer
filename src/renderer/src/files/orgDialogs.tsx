/**
 * Home's modals for organizations (docs/multiplayer.md §14; wording in docs/research/figma/R20-home-org.md): Create
 * organization (with Import shared files, §14.8), a name (Create team, Create user group), Ask to upgrade, Transfer
 * ownership, Change icon (§14.16), and the destinations of "Move to…" across spaces and within an org.
 */
import { useMemo, useRef, useState } from "react";
import { Button, Checkbox, Dialog, Icon, RadioGroup, SearchField, Select, TextInput } from "@/ds";
import { ICON_ACCEPT, ICON_MAX_BYTES, ICON_SIZE, bytesToDataUrl, iconMime } from "@shared/org/icons";
import type * as O from "@shared/org/types";
import { searchKey } from "./model";
import { SEAT_HINT, SEAT_LABEL } from "./org";
import { FolderGlyph, TeamIcon } from "./parts";
import styles from "./Files.module.css";

function Footer({ confirm, ok, onConfirm, onClose, destructive }: { confirm: string; ok: boolean; onConfirm: () => void; onClose: () => void; destructive?: boolean }) {
  return (
    <>
      <Button variant="secondary" size="large" onClick={onClose}>
        Cancel
      </Button>
      <Button variant={destructive ? "destructive" : "primary"} size="large" disabled={!ok} onClick={() => ok && onConfirm()}>
        {confirm}
      </Button>
    </>
  );
}

/** "Create organization": its name, and whether the files shared so far move into it (§14.8). */
export function CreateOrgDialog({ onCreate, onClose }: { onCreate: (input: { name: string; importSharedFiles: boolean }) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [importShared, setImportShared] = useState(false);
  const ok = name.trim().length > 0;
  const create = () => ok && onCreate({ name: name.trim(), importSharedFiles: importShared });
  return (
    <Dialog open title="Create organization" onClose={onClose} footer={<Footer confirm="Create organization" ok={ok} onConfirm={create} onClose={onClose} />}>
      <div className={styles.dialogField}>
        <TextInput label="Organization name" placeholder="Organization name" size="large" value={name} onChange={setName} autoFocus onExit={(r) => (r === "enter" ? create() : r === "escape" && onClose())} />
        <Checkbox label="Import shared files" checked={importShared} onChange={setImportShared} />
        <p className={styles.dialogHint}>Files you’ve shared move into a team of the new organization, and the people you shared them with join it as members.</p>
      </div>
    </Dialog>
  );
}

/** One name: Create team, Create user group, Rename team. */
export function NameDialog({ title, label, confirm, initial = "", onDone, onClose, description }: { title: string; label: string; confirm: string; initial?: string; description?: boolean; onDone: (name: string, description: string) => void; onClose: () => void }) {
  const [name, setName] = useState(initial);
  const [about, setAbout] = useState("");
  const ok = name.trim().length > 0 && name.trim() !== initial;
  const done = () => ok && onDone(name.trim(), about.trim());
  return (
    <Dialog open title={title} onClose={onClose} footer={<Footer confirm={confirm} ok={ok} onConfirm={done} onClose={onClose} />}>
      <div className={styles.dialogField}>
        <TextInput label={label} placeholder={label} size="large" value={name} onChange={setName} autoFocus onExit={(r) => (r === "enter" ? done() : r === "escape" && onClose())} />
        {description && <TextInput label="Description" placeholder="Description (optional)" size="large" value={about} onChange={setAbout} />}
      </div>
    </Dialog>
  );
}

/** "Ask to upgrade" (help.figma.com: a seat request with an optional note; admins answer it in Admin). */
export function AskToUpgradeDialog({ orgName, current, onSend, onClose }: { orgName: string; current: O.Seat; onSend: (seat: Exclude<O.Seat, "view">, note: string) => void; onClose: () => void }) {
  const [seat, setSeat] = useState<Exclude<O.Seat, "view">>("full");
  const [note, setNote] = useState("");
  return (
    <Dialog open title="Ask to upgrade" onClose={onClose} footer={<Footer confirm="Send request" ok={seat !== current} onConfirm={() => onSend(seat, note.trim())} onClose={onClose} />}>
      <div className={styles.dialogField}>
        <p className={styles.dialogText}>
          You have a {SEAT_LABEL[current]} seat in {orgName}. Ask an admin for a seat that can edit.
        </p>
        <RadioGroup
          label="Seat"
          value={seat}
          options={(["full", "dev", "collab"] as const).map((s) => ({ value: s, label: `${SEAT_LABEL[s]} — ${SEAT_HINT[s]}`, disabled: s === current }))}
          onChange={(v) => setSeat(v as Exclude<O.Seat, "view">)}
        />
        <TextInput label="Note" placeholder="Add a note (optional)" size="large" value={note} onChange={setNote} />
      </div>
    </Dialog>
  );
}

/** Transfer ownership of a team: only to someone on it (help.figma.com 360039481134); the old owner stays as an admin. */
export function TransferDialog({ team, members, onTransfer, onClose }: { team: string; members: O.TeamMember[]; onTransfer: (userId: string) => void; onClose: () => void }) {
  const people = members.filter((m) => m.person && !m.owner && !m.pending);
  const [who, setWho] = useState(people[0]?.person?.id ?? "");
  return (
    <Dialog open title="Transfer ownership" onClose={onClose} footer={<Footer confirm="Transfer ownership" ok={!!who} onConfirm={() => onTransfer(who)} onClose={onClose} destructive />}>
      <div className={styles.dialogField}>
        <p className={styles.dialogText}>Make someone else the owner of {team}. You’ll stay on the team as a team admin. You can’t undo this.</p>
        {people.length ? <Select label="New owner" value={who} options={people.map((m) => ({ value: m.person!.id, label: m.person!.name ?? m.person!.email }))} onChange={setWho} /> : <p className={styles.dialogText}>Invite someone to the team first.</p>}
      </div>
    </Dialog>
  );
}

/** A place a file or folder can go. `id` is what onMove gets; headers (a team a file can't sit in directly) aren't picked. */
export interface Destination {
  id: string;
  label: string;
  depth: number;
  kind: "drafts" | "team" | "folder" | "local-folder" | "header";
  disabled?: boolean;
  color?: Parameters<typeof FolderGlyph>[0]["color"];
  /** An org team or folder's team */
  teamId?: string;
}
export interface DestinationSection {
  title: string;
  rows: Destination[];
}

/** "Move to…": every space's places, searchable (Figma's move dialog: search, pick, Move). */
export function DestinationDialog({ title, sections, onMove, onClose }: { title: string; sections: DestinationSection[]; onMove: (dest: Destination) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Destination | null>(null);
  const shown = useMemo(() => {
    const needle = searchKey(query.trim());
    if (!needle) return sections;
    return sections.map((s) => ({ ...s, rows: s.rows.filter((r) => r.kind !== "header" && searchKey(r.label).includes(needle)).map((r) => ({ ...r, depth: 1 })) })).filter((s) => s.rows.length);
  }, [sections, query]);
  const can = !!picked && !picked.disabled && picked.kind !== "header";
  return (
    <Dialog open size="medium" title={title} onClose={onClose} footer={<Footer confirm="Move" ok={can} onConfirm={() => picked && onMove(picked)} onClose={onClose} />}>
      <SearchField value={query} onChange={setQuery} placeholder="Search folders" size="large" autoFocus onExit={(r) => r === "escape" && onClose()} />
      <div role="listbox" aria-label="Destinations" className={styles.moveList}>
        {shown.map((s) => (
          <div key={s.title} role="group" aria-label={s.title}>
            {sections.length > 1 && <div className={styles.moveSection}>{s.title}</div>}
            {s.rows.map((r) => (
              <button
                key={`${s.title}:${r.id}`}
                type="button"
                role="option"
                aria-selected={picked?.id === r.id}
                aria-disabled={r.disabled || r.kind === "header" || undefined}
                className={styles.moveRow}
                style={{ paddingLeft: `calc(var(--ds-space-2) + ${r.depth - 1} * var(--ds-space-4))` }}
                onClick={() => r.kind !== "header" && setPicked(r)}
                onDoubleClick={() => !r.disabled && r.kind !== "header" && onMove(r)}
              >
                {r.kind === "drafts" ? <Icon name="24.file" /> : r.kind === "team" || r.kind === "header" ? <TeamIcon name={r.label} /> : <FolderGlyph color={r.color ?? "none"} />}
                <span className={styles.moveName}>{r.label}</span>
              </button>
            ))}
          </div>
        ))}
        {!shown.length && <span className={styles.moveRow}>No results</span>}
      </div>
    </Dialog>
  );
}

/** A picked image as a 256 × 256 PNG: the middle square, scaled (transparency kept, as Figma's icons allow). */
export async function cropIcon(file: Blob): Promise<Uint8Array> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    if (!side) throw new Error("empty image");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = ICON_SIZE;
    canvas.getContext("2d")!.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, ICON_SIZE, ICON_SIZE);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("no PNG");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * "Change icon" (help.figma.com 14949911189399: the team's ⌄ menu → Change icon → upload an image; the same for the
 * organization icon in Admin › Settings, docs/multiplayer.md §14.16): Upload image… picks a file, which is cropped to a
 * square and shown as it will be (the page's square, the sidebar's circle); Save uploads it. Remove icon (ours) goes
 * back to the initial.
 */
export function IconDialog({ title = "Change icon", name, iconUrl, src, onSave, onRemove, onClose, crop = cropIcon }: { title?: string; name: string; iconUrl?: string | null; src?: string | null; onSave: (image: Uint8Array) => Promise<unknown> | void; onRemove?: () => Promise<unknown> | void; onClose: () => void; crop?: (file: Blob) => Promise<Uint8Array> }) {
  const input = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<{ bytes: Uint8Array; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const has = !!(iconUrl || src);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      // A picture the page can't redraw (no decoder for it here) goes as it is when the server would take it; the
      // icons show it cropped (object-fit: cover)
      const bytes = await crop(file).catch(async () => new Uint8Array(await file.arrayBuffer()));
      if (bytes.length > ICON_MAX_BYTES) throw new Error("too large");
      const mime = iconMime(bytes);
      if (!mime) throw new Error("not an image");
      setPicked({ bytes, url: bytesToDataUrl(bytes, mime) });
    } catch {
      setError("Couldn’t read that image. Use a PNG, JPEG, WebP or GIF file.");
    }
  };
  const run = async (fn: () => Promise<unknown> | void) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const shownSrc = picked ? picked.url : src;
  const shownUrl = picked ? null : iconUrl;
  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      footer={
        <>
          {onRemove && has && !picked && (
            <Button variant="secondary" size="large" disabled={busy} onClick={() => void run(onRemove)}>
              Remove icon
            </Button>
          )}
          <Footer confirm="Save" ok={!!picked && !busy} onConfirm={() => picked && void run(() => onSave(picked.bytes))} onClose={onClose} />
        </>
      }
    >
      <div className={styles.dialogField} data-icon-dialog="">
        <div className={styles.iconPreview} data-icon-preview={picked ? "picked" : has ? "current" : "initial"}>
          <TeamIcon name={name} src={shownSrc} iconUrl={shownUrl} size={64} />
          <TeamIcon name={name} src={shownSrc} iconUrl={shownUrl} size={16} />
        </div>
        <div className={styles.iconActions}>
          <Button variant="secondary" onClick={() => input.current?.click()} disabled={busy}>
            Upload image…
          </Button>
        </div>
        <input
          ref={input}
          type="file"
          accept={ICON_ACCEPT}
          hidden
          data-icon-input=""
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            void pick(f);
          }}
        />
        <p className={styles.dialogHint}>A PNG, JPEG, WebP or GIF image, cropped to a square. One at least 500 × 500 pixels looks sharpest.</p>
        {error && (
          <p className={styles.iconError} role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
