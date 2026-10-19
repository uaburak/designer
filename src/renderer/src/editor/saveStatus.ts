/**
 * The save status (docs/research/atlas/22-undo-file.md §3.4–3.5): Figma has no Save — every change is kept as it is
 * made — so the editor only speaks up when changes wait too long. Two halves: changes the store hasn't taken yet (the
 * journal's acknowledgement; Figma's IndexedDB autosave) and, for a shared file, frames the room hasn't acknowledged
 * (Figma's multiplayer changes). Polled every 500 ms:
 *
 *   - the "offline" icon when the file's link has been down for more than 10 s;
 *   - the "unsaved" icon when changes have waited more than 10 s since they began or the last acknowledgement, or
 *     30 s since they began;
 *   - 60 s after changes start waiting, a toast that stays until they're saved ("Changes saved" then, when online).
 *
 * ⌘S (Wrap in new section) with nothing to wrap shows Figma's save reminder: offline, unsaved, or — once in 14 days —
 * that there is nothing to save.
 */
import { showToast } from "@/ds";
import { t } from "@/i18n";
import { getStoreClient } from "@/store";
import type { FileShareState } from "@shared/multiplayer/types";
import type { EditorController } from "./controller";

export const SAVE_STATUS = {
  pollMs: 500,
  /** Disconnected this long before the icon shows (Figma: 10 000 ms; 6 000 in a variant whose gate isn't read) */
  disconnectedMs: 10_000,
  /** Waiting changes show after this long without an acknowledgement… */
  waitingMs: 10_000,
  /** …or this long after they began */
  waitingMaxMs: 30_000,
  /** The "unsaved changes" toast this long after changes started waiting */
  toastMs: 60_000,
  /** The "you don't need to save" reminder at most once in this long (Figma's 12096e5) */
  reminderEveryMs: 14 * 24 * 60 * 60 * 1000,
} as const;

/** Figma's localStorage key for the reminder's last showing */
export const REMINDER_KEY = "autosaveVisualBellLastTime";
/** One of these, two spaces, then the reminder (Figma's prefixes) */
export const REMINDER_PREFIXES = ["✓", "✔", "💾", "👍", "✌️", "👋", "😎", "⚡️"] as const;

export interface Waiting {
  /** Since when changes have waited (null: none) */
  since: number | null;
  /** The last acknowledgement */
  last: number;
}

export interface SaveInputs {
  now: number;
  shared: boolean;
  connection: FileShareState["connection"];
  /** Since when the link has been down (null: live, or not shared) */
  downSince: number | null;
  /** Edited while the link was down (those changes wait for the room) */
  editedWhileDown: boolean;
  local: Waiting;
  server: Waiting | null;
}

export type SaveIcon = "offline" | "unsaved" | null;
export type SaveReason = "disconnected" | "local" | "server" | null;

const waitingTooLong = (w: Waiting | null, now: number) =>
  !!w && w.since !== null && (now - Math.max(w.since, w.last) > SAVE_STATUS.waitingMs || now - w.since > SAVE_STATUS.waitingMaxMs);

/** The icon and why (the tooltip): Figma's rules, the disconnection first */
export function saveIcon(i: SaveInputs): { icon: SaveIcon; reason: SaveReason } {
  const down = i.shared && i.connection !== "live";
  if (down && i.downSince !== null && i.now - i.downSince > SAVE_STATUS.disconnectedMs) return { icon: "offline", reason: "disconnected" };
  if (waitingTooLong(i.local, i.now)) return { icon: down ? "offline" : "unsaved", reason: "local" };
  if (!down && waitingTooLong(i.server, i.now)) return { icon: "unsaved", reason: "server" };
  return { icon: null, reason: null };
}

/** Figma's hasUnsavedChanges: changes the store or the room hasn't taken yet */
export function hasUnsaved(i: Pick<SaveInputs, "shared" | "connection" | "editedWhileDown" | "local" | "server">): boolean {
  if (i.local.since !== null) return true;
  if (!i.shared) return false;
  if (i.connection !== "live") return i.editedWhileDown;
  return i.server?.since != null;
}

/** The reminder's text for ⌘S with nothing to wrap, or null when it was shown within 14 days (Figma's rule) */
export function reminderText(state: { offline: boolean; unsaved: boolean }, lastShown: number | null, now: number, pick = Math.random): string | null {
  if (state.offline) return t("You're offline. Your changes are saved on this computer and sent when you're back online.");
  if (state.unsaved) return t("Your latest changes are still being saved.");
  if (lastShown !== null && now - lastShown < SAVE_STATUS.reminderEveryMs) return null;
  const prefix = REMINDER_PREFIXES[Math.min(REMINDER_PREFIXES.length - 1, Math.floor(pick() * REMINDER_PREFIXES.length))];
  return `${prefix}  ${t("You don't need to save. Your changes are saved as you go.")}`;
}

type Listener = () => void;

/**
 * One editor's save status: its source's waiting changes, the file's link (shared files), polled every 500 ms while
 * something reads it (the toolbar's icon), and what the toast and the reminder need.
 */
export class SaveStatusTracker {
  inputs: SaveInputs;
  private listeners = new Set<Listener>();
  private offs: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private key = "";

  constructor(private readonly ed: EditorController) {
    this.inputs = { now: Date.now(), shared: false, connection: "offline", downSince: null, editedWhileDown: false, local: { since: null, last: 0 }, server: null };
  }

  private get fileKey(): string | null {
    const k = (this.ed.source as unknown as { fileKey?: unknown }).fileKey;
    return typeof k === "string" ? k : null;
  }

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(l);
      if (!this.listeners.size) this.stop();
    };
  };

  private start(): void {
    const fileKey = this.fileKey;
    if (fileKey) {
      const mp = getStoreClient().multiplayer;
      void mp.fileState(fileKey).then((s) => this.link(s), () => {});
      this.offs.push(mp.watch((e) => e.fileKey === fileKey && this.link(e.state)));
    }
    this.offs.push(
      this.ed.engine.on("DOCUMENT_CHANGED", (e) => {
        if (this.inputs.downSince !== null && e.kind !== "SYSTEM") this.inputs = { ...this.inputs, editedWhileDown: true };
      }),
    );
    this.timer = setInterval(() => this.poll(), SAVE_STATUS.pollMs);
    this.poll();
  }

  private stop(): void {
    for (const off of this.offs.splice(0)) off();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private link(s: FileShareState): void {
    const down = s.shared && s.connection !== "live";
    const was = this.inputs.downSince;
    this.inputs = {
      ...this.inputs,
      shared: s.shared,
      connection: s.connection,
      downSince: down ? (was ?? Date.now()) : null,
      // Back online: what was edited meanwhile goes to the room (the server half follows it).
      editedWhileDown: down ? this.inputs.editedWhileDown : false,
      server: s.unacked ? { since: s.unacked.since, last: s.unacked.lastAckAt } : null,
    };
    this.poll();
  }

  private poll(): void {
    const local = this.ed.source.saveState?.() ?? { pendingSince: null, lastSavedAt: 0 };
    this.inputs = { ...this.inputs, now: Date.now(), local: { since: local.pendingSince, last: local.lastSavedAt } };
    const { icon, reason } = saveIcon(this.inputs);
    const key = `${icon}|${reason}|${hasUnsaved(this.inputs)}|${this.inputs.connection}`;
    if (key === this.key) return;
    this.key = key;
    for (const l of this.listeners) l();
  }

  get state(): { icon: SaveIcon; reason: SaveReason; unsaved: boolean; online: boolean } {
    const { icon, reason } = saveIcon(this.inputs);
    return { icon, reason, unsaved: hasUnsaved(this.inputs), online: !this.inputs.shared || this.inputs.connection === "live" };
  }
}

const trackers = new WeakMap<EditorController, SaveStatusTracker>();

export function saveStatusOf(ed: EditorController): SaveStatusTracker {
  let s = trackers.get(ed);
  if (!s) trackers.set(ed, (s = new SaveStatusTracker(ed)));
  return s;
}

/** ⌘S with nothing to wrap (Figma's showAutosaveVisualBell; editors only: the command asks). */
export function saveReminder(ed: EditorController): void {
  const tracker = saveStatusOf(ed);
  const off = tracker.subscribe(() => {});
  const { icon, unsaved } = tracker.state;
  off();
  let last: number | null = null;
  try {
    const raw = localStorage.getItem(REMINDER_KEY);
    last = raw ? Number(raw) : null;
  } catch {
    // a per-viewer convenience only
  }
  const now = Date.now();
  const text = reminderText({ offline: icon === "offline", unsaved }, Number.isFinite(last) ? last : null, now);
  if (!text) return;
  if (icon !== "offline" && !unsaved) {
    try {
      localStorage.setItem(REMINDER_KEY, String(now));
    } catch {
      // as above
    }
  }
  showToast({ message: text });
}
