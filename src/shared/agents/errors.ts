/**
 * Model APIs' errors as people read them. Google's arrive as JSON inside JSON, often inside a CLI's own message
 * ("[API Error: {…{\"error\": {\"code\": 429, …}}}]", "MCP tool 'generate_image' reported tool error … {\"error\": …}"):
 * the innermost message, and for the Gemini API what to do. Shared by main's parsers and the chat's tool rows.
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

/** A Gemini API error (through Gemini CLI or Nano Banana) in plain English, with what to do about the key's project. */
export function friendlyApiError(raw: string): string {
  const inner = innerApiError(raw);
  if (!inner) return raw;
  const { message, code } = inner;
  if (code === "402" || /prepayment credits/i.test(message)) return `Google refused the request: the Gemini API key's AI Studio project has run out of prepaid credits (${message}) Add credits at ai.studio/projects, or make a key in a project without billing (Google’s free tier) and add it in Agent settings.`;
  if (code === "429" || /RESOURCE_EXHAUSTED|exceeded your current quota/i.test(message)) {
    if (/limit:\s*0\b/.test(message)) {
      const model = /model:\s*([\w.-]+)/.exec(message)?.[1];
      const what = model && /image/i.test(model) ? "the image model" : model ? `${model}` : "this model";
      return `Google: free tier has no quota for ${what} (limit 0) — turn on billing for the key's AI Studio project`;
    }
    return `Google’s rate limit for this Gemini API key: ${message}`;
  }
  if (code === "400" && /API key not valid/i.test(message)) return "Google says the Gemini API key isn’t valid — check it in Agent settings.";
  return `Gemini API: ${message}`;
}
