import { useEffect, useRef, useSyncExternalStore } from "react";
import { cx } from "../util/cx";
import { Portal } from "../overlay/Portal";
import { Icon } from "../icons/Icon";
import { timing } from "../tokens";
import { STRINGS } from "../strings";
import { t, useT } from "@/i18n";
import { Button, IconButton } from "./Button";
import styles from "./Toast.module.css";

export type ToastKind = "default" | "error" | "success";
export type ToastOptions = {
  message: string;
  kind?: ToastKind;
  action?: { label: string; onAction: () => void };
  /** ms on screen (Figma's `timeoutOverride`); 0 or Infinity: until dismissed. Without it, `toastDuration`'s rule */
  duration?: number;
  /** ms before it joins the queue (Figma's `delay`) */
  delay?: number;
  /** "exact": its time isn't halved while others wait (Figma's `timeoutType`; "suggested" by default) */
  timeoutType?: "suggested" | "exact";
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
export function Toast({ message, kind = "default", action, count, onClose, static: isStatic }: ToastOptions & { count?: number; onClose?: () => void; static?: boolean }) {
  useT();
  return (
    <div role={kind === "error" ? "alert" : "status"} data-ds="Toast" data-theme="dark" data-theme-forced="" className={cx(styles.toast, kind === "error" && styles.error, isStatic && styles.static)}>
      {kind === "success" && <span className={styles.lead}><Icon name="24.check" /></span>}
      <span className={styles.message}>{message}</span>
      {count !== undefined && count > 1 && <span className={styles.count} data-toast-count={count}>{count}</span>}
      {action && (
        <Button variant="ghost" onClick={action.onAction}>
          {action.label}
        </Button>
      )}
      {onClose && <IconButton icon="24.close.small" label={t(STRINGS.dismiss)} tooltip={false} onClick={onClose} />}
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
 * (an error, or one that stays until dismissed), as Figma's.
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
  const lasting = !Number.isFinite(toastDuration(toast));
  return (
    <Portal theme="dark">
      <div className={styles.host} aria-live="polite" onPointerEnter={() => window.clearTimeout(timer.current)} onPointerLeave={() => schedule(timer, toast, queued)}>
        <Toast
          key={toast.id}
          message={toast.message}
          kind={toast.kind}
          count={toast.count}
          action={toast.action && { label: toast.action.label, onAction: () => { toast.action?.onAction(); dismissToast(toast.id); } }}
          onClose={lasting ? () => dismissToast(toast.id) : undefined}
        />
      </div>
    </Portal>
  );
}
