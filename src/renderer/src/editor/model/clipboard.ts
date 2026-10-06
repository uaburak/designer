/**
 * The clipboard's formats (docs/desktop.md §13, docs/engine.md §10.7), as pure
 * functions: one copy writes our own type `application/x-designerv2-kiwi`
 * (the Message, base64), a `text/html` envelope carrying the same base64
 * (what survives apps that drop custom types — Figma's own approach), and
 * `text/plain` (the layer names, for text editors). Paste reads the first
 * that decodes: our type, then the envelope in the HTML, then an envelope
 * that arrived as plain text.
 *
 * Interim: the payload is the engine's interim JSON Message; the envelope's
 * markers are ours, `(designerv2)…(/designerv2)`, not Figma's `(figma)`, so
 * real Figma never tries to read it. When the kiwi codec lands the payload
 * becomes the fig-kiwi archive of desktop.md §13 and the markers Figma's.
 */
import type { Guid, Message } from "@/engine/codec";

export const CLIPBOARD_TYPE = "application/x-designerv2-kiwi";
const OPEN = "(designerv2)";
const CLOSE = "(/designerv2)";
const ENVELOPE = /\(designerv2\)([A-Za-z0-9+/=]+)\(\/designerv2\)/;

export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function base64ToUtf8(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The names of the copied layers that aren't inside another copied layer, one per line. */
export function plainTextOf(message: Message): string {
  const ids = new Set<Guid>(message.nodeChanges.map((n) => n.guid));
  return message.nodeChanges
    .filter((n) => !n.parentIndex || !ids.has(n.parentIndex.guid))
    .map((n) => n.name ?? "")
    .filter(Boolean)
    .join("\n");
}

/** Every format one copy writes, by MIME type. */
export function encodeClipboard(message: Message, plain = plainTextOf(message)): Record<string, string> {
  const b64 = utf8ToBase64(JSON.stringify(message));
  const meta = utf8ToBase64(JSON.stringify({ app: "designerv2", dataType: "scene" }));
  return {
    [CLIPBOARD_TYPE]: b64,
    "text/html":
      `<meta charset="utf-8"><div><span data-metadata="<!--(designerv2meta)${meta}(/designerv2meta)-->"></span>` +
      `<span data-buffer="<!--${OPEN}${b64}${CLOSE}-->"></span></div>` +
      `<span style="white-space:pre-wrap;">${escapeHtml(plain)}</span>`,
    "text/plain": plain,
  };
}

/** A base64 payload as a Message, or null when it isn't one. */
function decodePayload(b64: string): Message | null {
  try {
    const value = JSON.parse(base64ToUtf8(b64.trim())) as Partial<Message>;
    if (value && value.type === "NODE_CHANGES" && Array.isArray(value.nodeChanges)) return value as Message;
  } catch {
    /* not ours */
  }
  return null;
}

/** The envelope's payload in some text (HTML or plain), or null. */
export function envelopeOf(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = ENVELOPE.exec(text);
  return m ? m[1] : null;
}

/** What was copied, from whichever format decodes first; null when the clipboard holds no layers of ours. */
export function decodeClipboard(read: (type: string) => string | null | undefined): Message | null {
  const own = read(CLIPBOARD_TYPE);
  if (own) {
    const m = decodePayload(own);
    if (m) return m;
  }
  for (const type of ["text/html", "text/plain"]) {
    const payload = envelopeOf(read(type));
    if (payload) {
      const m = decodePayload(payload);
      if (m) return m;
    }
  }
  return null;
}
