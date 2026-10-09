/**
 * Model APIs' errors as people read them. Google's arrive as JSON inside JSON, often inside a CLI's own message
 * ("[API Error: {…{\"error\": {\"code\": 429, …}}}]", "MCP tool 'generate_image' reported tool error … {\"error\": …}"):
 * the innermost message, and for Google's API what it means. Shared by main's parsers and the chat's tool rows.
 */

/** Undo up to a few levels of JSON string escaping, so nested messages can be read with one pattern. */
function unescapeNested(raw: string): string {
  let s = raw;
  for (let i = 0; i < 6; i++) {
    const next = s.replace(/\\\\/g, "\\").replace(/\\n/g, " ").replace(/\\"/g, '"');
    if (next === s) break;
    s = next;
  }
  return s;
}

/** The innermost `"message"` (and the nearest `"code"`) in a raw error, or null when there is no JSON in it. */
export function innerApiError(raw: string): { message: string; code?: string } | null {
  const s = unescapeNested(raw);
  const msgs = [...s.matchAll(/"message"\s*:\s*"([^"]+)"/g)].map((m) => m[1].replace(/\s+/g, " ").trim()).filter((m) => m && !m.startsWith("{"));
  const message = msgs[msgs.length - 1];
  if (!message) return null;
  return { message, code: /"code"\s*:\s*(\d{3})/.exec(s)?.[1] };
}

/** A tool's or an API's error, readable: the inner message when it is wrapped in JSON, else the text as it came. */
export function readableError(raw: string): string {
  return innerApiError(raw)?.message ?? raw.trim();
}

/** A Gemini API error (through Antigravity) in plain English. */
export function friendlyApiError(raw: string): string {
  const inner = innerApiError(raw);
  if (!inner) return raw;
  const { message, code } = inner;
  if (code === "402" || /prepayment credits/i.test(message)) return `Google refused the request: out of prepaid credits (${message})`;
  if (code === "429" || /RESOURCE_EXHAUSTED|exceeded your current quota/i.test(message)) {
    if (/limit:\s*0\b/.test(message)) {
      const model = /model:\s*([\w.-]+)/.exec(message)?.[1];
      const what = model && /image/i.test(model) ? "the image model" : model ? `${model}` : "this model";
      return `Google: no quota for ${what} on this account (limit 0)`;
    }
    return `Google’s rate limit: ${message}`;
  }
  return `Gemini API: ${message}`;
}
