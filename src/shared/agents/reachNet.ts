/**
 * Which web addresses agents may open (docs/agents-reach.md §5.2): http(s) pages on public hosts; local, private,
 * link-local, metadata and other special addresses refused unless the owner allowed that host in Agent settings ›
 * Access › Web. Pure — main's web runner checks the URL with `checkWebUrl`, then every address the host resolves to with
 * `isPublicAddress`, and every request the page makes again.
 */

export type UrlCheck =
  | { ok: true; url: URL; host: string; hostPort: string; allowedLocal: boolean; literal: boolean }
  | { ok: false; reason: string };

/** "localhost:5173", "http://192.168.1.20:3000/x", "dev.test" → "localhost:5173", "192.168.1.20:3000", "dev.test"; null if it isn't a host. */
export function normalizeAllowedHost(input: string): string | null {
  const raw = String(input ?? "").trim();
  if (!raw || raw.length > 260) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password || !u.hostname) return null;
  return u.port ? `${u.hostname.toLowerCase()}:${u.port}` : u.hostname.toLowerCase();
}

/** An allowed host entry matches `host` (any port) or `host:port` (that port only). */
export function hostAllowed(host: string, port: string, allowed: readonly string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((a) => {
    const e = a.toLowerCase();
    return e === h || (port !== "" && e === `${h}:${port}`) || (port === "" && (e === `${h}:80` || e === `${h}:443`));
  });
}

const LOCAL_NAMES = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

/** IPv4 dotted quad → 4 bytes, or null. (WHATWG URL already turned 0x7f.1, 2130706433 … into dotted form.) */
export function ipv4Bytes(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((x) => x <= 255) ? b : null;
}

function privateV4(b: number[]): boolean {
  const [a, c] = b;
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 ||
    (a === 100 && c >= 64 && c <= 127) || // CGNAT
    a === 127 ||
    (a === 169 && c === 254) || // link-local, cloud metadata
    (a === 172 && c >= 16 && c <= 31) ||
    (a === 192 && c === 0 && b[2] === 0) ||
    (a === 192 && c === 0 && b[2] === 2) || // TEST-NET-1
    (a === 192 && c === 168) ||
    (a === 198 && (c === 18 || c === 19)) ||
    (a === 198 && c === 51 && b[2] === 100) ||
    (a === 203 && c === 0 && b[2] === 113) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

/** IPv6 text (no brackets, an optional %zone) → 16 bytes, or null. */
export function ipv6Bytes(input: string): number[] | null {
  let s = input.replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  if (!s.includes(":")) return null;
  let tail: number[] = [];
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) {
    const b = ipv4Bytes(v4[1]);
    if (!b) return null;
    tail = b;
    s = s.slice(0, -v4[1].length) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part ? part.split(":") : []);
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const bytes = groups.flatMap((g) => {
    const n = parseInt(g, 16);
    return [n >> 8, n & 255];
  });
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

function privateV6(b: number[]): boolean {
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 16)) return true; // ::
  if (zero(0, 15) && b[15] === 1) return true; // ::1
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true; // fec0::/10 site-local (deprecated)
  if (b[0] === 0xff) return true; // multicast
  // IPv4 inside: mapped ::ffff:a.b.c.d, compatible ::a.b.c.d, NAT64 64:ff9b::/96, 6to4 2002::/16
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return privateV4(b.slice(12));
  if (zero(0, 12)) return privateV4(b.slice(12));
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return privateV4(b.slice(12));
  if (b[0] === 0x20 && b[1] === 0x02) return privateV4(b.slice(2, 6));
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // documentation
  return false;
}

/** Whether an IP address (v4 or v6 text) is a public one agents may reach. Anything unreadable is not. */
export function isPublicAddress(ip: string): boolean {
  const v4 = ipv4Bytes(ip);
  if (v4) return !privateV4(v4);
  const v6 = ipv6Bytes(ip);
  if (v6) return !privateV6(v6);
  return false;
}

/**
 * A URL an agent (or a page it opened) wants: refused when its scheme isn't http(s) (`subresource` also allows a page's
 * own data: and blob: URLs), it carries a user name or password, or its host is local / private and not allowed.
 * A host name passes here; main checks what it resolves to with `isPublicAddress` (unless it is allowed).
 */
export function checkWebUrl(raw: string, allowedHosts: readonly string[], opts: { subresource?: boolean } = {}): UrlCheck {
  let url: URL;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    return { ok: false, reason: "not a valid URL (give a full address like https://example.com)" };
  }
  if (opts.subresource && (url.protocol === "data:" || url.protocol === "blob:")) return { ok: true, url, host: "", hostPort: "", allowedLocal: false, literal: false };
  if (opts.subresource && url.href === "about:blank") return { ok: true, url, host: "", hostPort: "", allowedLocal: false, literal: false };
  const ws = opts.subresource && (url.protocol === "ws:" || url.protocol === "wss:");
  if (url.protocol !== "http:" && url.protocol !== "https:" && !ws) return { ok: false, reason: `${url.protocol} addresses can't be opened (only http and https)` };
  if (url.username || url.password) return { ok: false, reason: "addresses with a user name or password can't be opened" };
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return { ok: false, reason: "the address has no host" };
  const hostPort = url.port ? `${host}:${url.port}` : host;
  const allowedLocal = hostAllowed(host, url.port, allowedHosts);
  const literal = !!ipv4Bytes(host) || !!ipv6Bytes(host);
  if (allowedLocal) return { ok: true, url, host, hostPort, allowedLocal, literal };
  if (literal && !isPublicAddress(host)) return { ok: false, reason: `${hostPort} is a local or private address (allow it in Agent settings › Access › Web if it is yours)` };
  if (!literal && (LOCAL_NAMES.test(host) || !host.includes("."))) return { ok: false, reason: `${hostPort} is a local name (allow it in Agent settings › Access › Web if it is yours)` };
  return { ok: true, url, host, hostPort, allowedLocal, literal };
}

/** A URL as the log and the consent card show it: no query, no fragment, no user info, ≤ 300 characters. */
export function displayUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.protocol === "data:" || u.protocol === "blob:") return `${u.protocol}…`;
    return `${u.protocol}//${u.host}${u.pathname}`.slice(0, 300);
  } catch {
    return String(raw ?? "").replace(/[?#].*$/, "").slice(0, 300);
  }
}
