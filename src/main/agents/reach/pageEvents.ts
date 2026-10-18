/**
 * What a web call's page tells through its debugger (docs/agents-reach.md §4.5, §5.1), decided here and acted on by
 * web.ts: a JavaScript dialog (alert, confirm, prompt, beforeunload) is dismissed at once — nobody is there to answer
 * it, and the page would wait on it until the call's time ran out — and the bytes the page receives are counted as
 * they arrive, so an answer without a Content-Length (chunked) counts toward the page's limit too.
 */

/** Run in every frame before the page's own scripts: the dialogs answered as a dismissed one would be, print a no-op. */
export const NO_DIALOGS = `(() => {
  const quiet = (name, value) => { try { Object.defineProperty(window, name, { value, configurable: true, writable: true }); } catch {} };
  quiet("alert", () => undefined);
  quiet("confirm", () => false);
  quiet("prompt", () => null);
  quiet("print", () => undefined);
})()`;

export type PageEventAction = { dismiss: true } | { over: string } | null;

/** A debugger event of the page: dismiss a dialog, the page over its size (`st.bytes` counted), or nothing to do. */
export function pageEvent(st: { bytes: number }, method: string, params: Record<string, unknown>, limit: number): PageEventAction {
  if (method === "Page.javascriptDialogOpening") return { dismiss: true };
  if (method !== "Network.dataReceived") return null;
  // What came over the wire; the decoded length when the encoded one isn't reported.
  const encoded = Number(params.encodedDataLength);
  const decoded = Number(params.dataLength);
  st.bytes += encoded > 0 ? encoded : decoded > 0 ? decoded : 0;
  return st.bytes > limit ? { over: `the page is larger than ${Math.round(limit / 1024 / 1024)} MB` } : null;
}
