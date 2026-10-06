import { useEffect, useRef, useSyncExternalStore } from "react";
import { cx } from "../util/cx";
import { Portal } from "../overlay/Portal";
import { Icon } from "../icons/Icon";
import { timing } from "../tokens";
import { STRINGS } from "../strings";
import { Button, IconButton } from "./Button";
import styles from "./Toast.module.css";

export type ToastKind = "default" | "error" | "success";
export type ToastOptions = { message: string; kind?: ToastKind; action?: { label: string; onAction: () => void }; duration?: number };
type ToastState = ToastOptions & { id: number };

/** One toast at a time (a new one replaces it), per document. */
let current: ToastState | null = null;
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Show a toast (contract §4.22); returns its id. */
export function showToast(options: ToastOptions): number {
  current = { ...options, id: nextId++ };
  emit();
  return current.id;
}

export function dismissToast(id?: number): void {
  if (!current || (id !== undefined && current.id !== id)) return;
  current = null;
  emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** A toast's look (contract §4.22): 40px, radius 9, dark (red for errors), an action and ×. */
export function Toast({ message, kind = "default", action, onClose, static: isStatic }: ToastOptions & { onClose?: () => void; static?: boolean }) {
  return (
    <div role={kind === "error" ? "alert" : "status"} data-ds="Toast" data-theme="dark" data-theme-forced="" className={cx(styles.toast, kind === "error" && styles.error, isStatic && styles.static)}>
      {kind === "success" && <span className={styles.lead}><Icon name="24.check" /></span>}
      <span className={styles.message}>{message}</span>
      {action && (
        <Button variant="ghost" onClick={action.onAction}>
          {action.label}
        </Button>
      )}
      {onClose && <IconButton icon="24.close.small" label={STRINGS.dismiss} tooltip={false} onClick={onClose} />}
    </div>
  );
}

/** Mounted once per document: draws the current toast bottom-centre (68 from the bottom), dismissing it on time (paused while hovered). */
function schedule(timer: { current: number | undefined }, t: ToastState) {
  window.clearTimeout(timer.current);
  const ms = t.duration ?? (t.action ? timing.toastAction : timing.toast);
  if (ms > 0) timer.current = window.setTimeout(() => dismissToast(t.id), ms);
}

export function ToastHost() {
  const toast = useSyncExternalStore(subscribe, () => current, () => null);
  const timer = useRef<number | undefined>(undefined);
  const start = (t: ToastState) => schedule(timer, t);
  useEffect(() => {
    const t = timer;
    if (toast) schedule(t, toast);
    return () => window.clearTimeout(t.current);
  }, [toast]);
  if (!toast) return null;
  return (
    <Portal theme="dark">
      <div className={styles.host} aria-live="polite" onPointerEnter={() => window.clearTimeout(timer.current)} onPointerLeave={() => start(toast)}>
        <Toast
          key={toast.id}
          message={toast.message}
          kind={toast.kind}
          action={toast.action && { label: toast.action.label, onAction: () => { toast.action?.onAction(); dismissToast(toast.id); } }}
          onClose={() => dismissToast(toast.id)}
        />
      </div>
    </Portal>
  );
}
