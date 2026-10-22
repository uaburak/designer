import { useEffect, useRef, useSyncExternalStore } from "react";
import { cx } from "../util/cx";
import { Portal } from "../overlay/Portal";
import { Icon, type IconName } from "../icons/Icon";
import { timing } from "../tokens";
import { STRINGS } from "../strings";
import { t, useT } from "@/i18n";
import { Button, IconButton } from "./Button";
import { Spinner } from "./Spinner";
import styles from "./Toast.module.css";

export type ToastKind = "default" | "error" | "success";
export type ToastOptions = {
  message: string;
  kind?: ToastKind;
  action?: { label: string; onAction: () => void };
  /** The action doesn't take the toast down: its owner does (a plugin's notify button returning false keeps it) */
  keepOnAction?: boolean;
  /** ms on screen (Figma's `timeoutOverride`); 0 or Infinity: until dismissed. Without it, `toastDuration`'s rule */
  duration?: number;
  /** ms before it joins the queue (Figma's `delay`) */
  delay?: number;
  /** "exact": its time isn't halved while others wait (Figma's `timeoutType`; "suggested" by default) */
  timeoutType?: "suggested" | "exact";
  /** Figma's bell icon before the message (Return to instance's: the instance glyph) */
  icon?: IconName;
  /** Called when the user dismisses it with × (Figma's `onDismiss`, which shows the ×); not when it times out or is taken down */
  onDismiss?: () => void;
  /** Figma's progress bell (a plugin running, a library publishing): a spinner before the message */
  spinner?: boolean;
  /** Work done, 0…1: a thin bar along the toast's foot (a progress toast stays until its owner takes it down — no ×) */
  progress?: number;
};
type ToastState = ToastOptions & { id: number; count: number };

/**
 * Figma's visual bells (docs/research/atlas/02-editor-chrome.md §7), per document: one on screen, the rest waiting
 * first in, first out; the same message again while it is queued counts up on it (a badge) instead of queueing twice.
 */
let queue: ToastState[] = [];
/** Toasts waiting out their `delay` before they join the queue */
const delayed = new Map<number, number>();
let nextId = 1;
let snapshot: { toast: ToastState | null; queued: number } = { toast: null, queued: 0 };
const listeners = new Set<() => void>();
const emit = () => {
  snapshot = { toast: queue[0] ?? null, queued: queue.length };
  listeners.forEach((l) => l());
};

/**
 * How long a toast stays (Figma's rule): an error until dismissed; with a button 10 s; a message over 25 characters
 * 6 s; else 3 s — `duration` overrides it. With `queued` toasts in the queue (itself included) a "suggested" time
 * is halved for each one waiting behind it.
 */
export function toastDuration(toast: ToastOptions, queued = 1): number {
  let ms = toast.duration ?? (toast.kind === "error" ? Infinity : toast.action ? timing.toastAction : toast.message.length > 25 ? timing.toastLong : timing.toast);
  if (ms <= 0) ms = Infinity;
  if (toast.timeoutType !== "exact" && queued > 1) ms *= 0.5 ** (queued - 1);
  return ms;
}

/** Show a toast (contract §4.22): it waits its turn behind the one showing; returns its id. */
export function showToast(options: ToastOptions): number {
  const kind = options.kind ?? "default";
  const same = queue.find((q) => q.message === options.message && (q.kind ?? "default") === kind);
  if (same) {
    // Figma's repeat badge: the waiting (or showing) toast counts up, and starts its time again when it is showing.
    queue = queue.map((q) => (q === same ? { ...q, count: q.count + 1 } : q));
    emit();
    return same.id;
  }
  const id = nextId++;
  const add = () => {
    delayed.delete(id);
    queue = [...queue, { ...options, id, count: 1 }];
    emit();
  };
  if (options.delay && options.delay > 0) delayed.set(id, window.setTimeout(add, options.delay));
  else add();
  return id;
}

/**
 * Changes a toast in place — its message, its progress — without queueing it again or restarting its time (a
 * progress toast: "Publishing HeroUI… 153/8295"). False when it is gone.
 */
export function updateToast(id: number, patch: Partial<Omit<ToastOptions, "delay">>): boolean {
  const at = queue.findIndex((q) => q.id === id);
  if (at < 0) return false;
  queue = queue.map((q, i) => (i === at ? { ...q, ...patch } : q));
  emit();
  return true;
}

/** The toast showing now (null: none) — what ToastHost draws. */
export const currentToast = (): Readonly<ToastOptions & { id: number }> | null => snapshot.toast;

/** Dismiss a toast — waiting, delayed or showing (no id: the one showing). */
export function dismissToast(id?: number): void {
  if (id !== undefined && delayed.has(id)) {
    window.clearTimeout(delayed.get(id));
    delayed.delete(id);
    return;
  }
  const gone = id === undefined ? queue[0] : queue.find((q) => q.id === id);
  if (!gone) return;
  queue = queue.filter((q) => q !== gone);
  emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** A toast's look (contract §4.22): 40px, radius 9, dark (red for errors), a repeat count, an action and ×. */
export function Toast({ message, kind = "default", action, count, icon, spinner, progress, onClose, static: isStatic }: ToastOptions & { count?: number; onClose?: () => void; static?: boolean }) {
  useT();
  return (
    <div role={kind === "error" ? "alert" : "status"} data-ds="Toast" data-theme="dark" data-theme-forced="" className={cx(styles.toast, kind === "error" && styles.error, isStatic && styles.static)}>
      {kind === "success" && <span className={styles.lead}><Icon name="24.check" /></span>}
      {icon && <span className={cx(styles.lead, styles.icon)}><Icon name={icon} size={24} /></span>}
      {/* Figma's progress bell (a plugin running): a spinner before the message */}
      {spinner && <span className={cx(styles.lead, styles.icon)}><Spinner size={24} tone="onbrand" /></span>}
      {message && <span className={styles.message}>{message}</span>}
      {count !== undefined && count > 1 && <span className={styles.count} data-toast-count={count}>{count}</span>}
      {action && (
        <Button variant="ghost" onClick={action.onAction}>
          {action.label}
        </Button>
      )}
      {onClose && <IconButton icon="24.close.small" label={t(STRINGS.dismiss)} tooltip={false} onClick={onClose} />}
      {progress !== undefined && (
        <span className={styles.progress} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(1, Math.max(0, progress)) * 100)}>
          <span className={styles.progressFill} style={{ width: `${Math.min(1, Math.max(0, progress)) * 100}%` }} />
        </span>
      )}
    </div>
  );
}

/** Dismisses `toast` when its time is up (none for one that stays until dismissed). */
function schedule(timer: { current: number | undefined }, toast: ToastState, queued: number) {
  window.clearTimeout(timer.current);
  const ms = toastDuration(toast, queued);
  if (Number.isFinite(ms)) timer.current = window.setTimeout(() => dismissToast(toast.id), ms);
}

/**
 * Mounted once per document: draws the queue's first toast bottom-centre (68 from the bottom), dismissing it on time
 * — counted again when one more queues behind it or it repeats; paused while hovered. Its × shows when it has no time
 * (an error, or one that stays until dismissed) or it has an `onDismiss`, as Figma's.
 */
export function ToastHost() {
  const { toast, queued } = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const t = timer;
    if (toast) schedule(t, toast, queued);
    return () => window.clearTimeout(t.current);
  }, [toast, queued]);
  if (!toast) return null;
  // A progress toast has no ×: its owner takes it down when the work is done.
  const lasting = !Number.isFinite(toastDuration(toast)) && toast.progress === undefined;
  return (
    <Portal theme="dark">
      <div className={styles.host} aria-live="polite" onPointerEnter={() => window.clearTimeout(timer.current)} onPointerLeave={() => schedule(timer, toast, queued)}>
        <Toast
          key={toast.id}
          message={toast.message}
          kind={toast.kind}
          count={toast.count}
          icon={toast.icon}
          spinner={toast.spinner}
          progress={toast.progress}
          action={toast.action && { label: toast.action.label, onAction: () => { toast.action?.onAction(); if (!toast.keepOnAction) dismissToast(toast.id); } }}
          onClose={
            lasting || toast.onDismiss
              ? () => {
                  dismissToast(toast.id);
                  toast.onDismiss?.();
                }
              : undefined
          }
        />
      </div>
    </Portal>
  );
}
