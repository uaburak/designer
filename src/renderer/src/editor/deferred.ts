/**
 * A listener called once in a microtask after one or more calls (the version it reads is bumped at once). Engine
 * events are dispatched after any engine call, reads included — a panel reading a node while it renders can deliver
 * a queued event (a lazily derived page's changes) — and React refuses a store update while another component
 * renders ("Cannot update a component while rendering a different component"). Deferring the notification keeps
 * the read fresh and the update out of the render.
 */
export function deferredListener(listener: () => void): () => void {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      listener();
    });
  };
}
