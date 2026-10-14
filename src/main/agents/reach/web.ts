import { BrowserWindow, session, type NativeImage, type Session, type WebContents } from "electron";
import { lookup } from "node:dns/promises";
import { REACH_LIMITS, untrustedResult, wrapUntrusted } from "../../../shared/agents/reach";
import { checkWebUrl, displayUrl, isPublicAddress } from "../../../shared/agents/reachNet";
import type { ToolResult } from "../../../shared/agents/tools";
import type { WNode } from "../../../shared/agents/web/convert";
import WALKER from "../../../shared/agents/web/walker.js?raw";
import type { ReachRunner, RunContext } from "./hub";
import { designFromCapture, withoutImages } from "./webSpec";

/**
 * Web (docs/agents-reach.md §5): each call opens its own hidden, offscreen window in one in-memory session of its own
 * (no cookies, storage or cache of the owner's; cleared after every call), sandboxed, context-isolated, no Node, no
 * preload, no permissions, no downloads, no popups. Every request the page makes is checked by reachNet.ts's rules and
 * its host's DNS answers (private addresses refused unless the owner allowed that host), counted and sized. Our scripts
 * run in an isolated world the page can't reach.
 */

const PARTITION = "reach-web"; // no "persist:": in memory only
const WORLD = 1717;
const LOAD_MS = 20_000;

interface CallState {
  allowed: readonly string[];
  dns: Map<string, Promise<boolean>>;
  requests: number;
  bytes: number;
  /** Why the main frame was refused (ends the call) */
  refused: string | null;
  /** A limit reached */
  over: string | null;
}

const calls = new Map<number, CallState>();
let ses: Session | null = null;

const publicHost = (st: CallState, host: string): Promise<boolean> => {
  let p = st.dns.get(host);
  if (!p) {
    // Chromium's own resolver for the page's session (the answer the page then connects with, from the same cache),
    // Node's as a fallback; no answer in 8 s is a refusal.
    const addresses = webSession()
      .resolveHost(host)
      .then((r) => r.endpoints.map((e) => e.address))
      .catch(() => lookup(host, { all: true, verbatim: true }).then((list) => list.map((a) => a.address)));
    p = within(addresses, 8000, [] as string[]).then(
      (list) => list.length > 0 && list.every((a) => isPublicAddress(a)),
      () => false
    );
    st.dns.set(host, p);
  }
  return p;
};

async function allowedRequest(st: CallState, url: string, mainFrame: boolean): Promise<boolean> {
  if (++st.requests > REACH_LIMITS.web.requests) {
    st.over ??= `the page made more than ${REACH_LIMITS.web.requests} requests`;
    return false;
  }
  const c = checkWebUrl(url, st.allowed, { subresource: !mainFrame });
  if (!c.ok) {
    if (mainFrame) st.refused = c.reason;
    return false;
  }
  if (!c.host || c.allowedLocal || c.literal) return true;
  const ok = await publicHost(st, c.host);
  if (!ok && mainFrame) st.refused = `${c.hostPort} resolves to a local or private address (allow it in Agent settings › Access › Web if it is yours)`;
  return ok;
}

function webSession(): Session {
  if (ses) return ses;
  const s = session.fromPartition(PARTITION, { cache: false });
  s.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  s.setPermissionCheckHandler(() => false);
  s.setDevicePermissionHandler(() => false);
  s.on("will-download", (e, item) => {
    e.preventDefault();
    item.cancel();
  });
  // A plain Chrome to the sites (no app name in the user agent).
  s.setUserAgent(s.getUserAgent().replace(/\s(?:Electron|Wecra|designer-v2)\/\S+/gi, ""));
  s.webRequest.onBeforeRequest((details, cb) => {
    const st = details.webContentsId !== undefined ? calls.get(details.webContentsId) : undefined;
    // Anything not made by a live call's page (a service worker, a straggler after the call) is refused.
    if (!st) return cb({ cancel: true });
    allowedRequest(st, details.url, details.resourceType === "mainFrame").then(
      (ok) => cb({ cancel: !ok }),
      () => cb({ cancel: true })
    );
  });
  s.webRequest.onHeadersReceived((details, cb) => {
    const st = details.webContentsId !== undefined ? calls.get(details.webContentsId) : undefined;
    if (!st) return cb({ cancel: true });
    const len = Number(Object.entries(details.responseHeaders ?? {}).find(([k]) => k.toLowerCase() === "content-length")?.[1]?.[0] ?? 0);
    st.bytes += Number.isFinite(len) ? len : 0;
    if (st.bytes > REACH_LIMITS.web.bytes) {
      st.over ??= `the page is larger than ${Math.round(REACH_LIMITS.web.bytes / 1024 / 1024)} MB`;
      return cb({ cancel: true });
    }
    cb({});
  });
  ses = s;
  return s;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const within = <T>(p: Promise<T>, ms: number, fallback: T) => Promise.race([p, sleep(ms).then(() => fallback)]);

interface Page {
  wc: WebContents;
  win: BrowserWindow;
  st: CallState;
  close(): void;
}

/** Opens `url` in a fresh hidden window; throws why it can't. */
async function openPage(url: string, ctx: RunContext, width: number, height: number, scheme: "light" | "dark" = "light"): Promise<Page> {
  const allowed = ctx.settings.web.allowedHosts;
  const first = checkWebUrl(url, allowed);
  if (!first.ok) throw new Error(first.reason);
  const st: CallState = { allowed, dns: new Map(), requests: 0, bytes: 0, refused: null, over: null };
  if (!first.allowedLocal && !first.literal && !(await publicHost(st, first.host))) throw new Error(`${first.hostPort} resolves to a local or private address (or doesn't resolve)`);
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    enableLargerThanScreen: true,
    webPreferences: { session: webSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true, offscreen: true, spellcheck: false, devTools: false, backgroundThrottling: false, webviewTag: false, safeDialogs: true },
  });
  const wc = win.webContents;
  calls.set(wc.id, st);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    calls.delete(wc.id);
    if (!win.isDestroyed()) win.destroy();
    // Nothing of a page outlives its call (the session is shared by calls one after another).
    if (!calls.size) void webSession().clearStorageData().catch(() => undefined);
  };
  ctx.signal.addEventListener("abort", close);
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-attach-webview", (e) => e.preventDefault());
  wc.setAudioMuted(true);
  wc.setFrameRate(15);
  try {
    // The page in light mode unless asked (the owner's Mac may be dark): emulated for this page only.
    try {
      wc.debugger.attach("1.3");
      await within(wc.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] }), 1000, null);
    } catch {
      /* the page's own default */
    }
    const loaded = new Promise<string | null>((resolve) => {
      wc.once("did-finish-load", () => resolve(null));
      wc.on("did-fail-load", (_e, code, desc, _u, isMain) => isMain && code !== -3 && resolve(desc || `error ${code}`));
    });
    wc.loadURL(url).catch(() => undefined);
    const failed = await within(loaded, LOAD_MS, null);
    if (st.refused) throw new Error(st.refused);
    if (failed && !wc.getURL().startsWith("http")) throw new Error(`the page didn't load (${failed})`);
    const now = checkWebUrl(wc.getURL(), allowed);
    if (!now.ok) throw new Error(now.reason);
    // Fonts and late layout, briefly.
    await within(wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: "document.fonts ? document.fonts.ready.then(() => 1) : 1" }]), 3000, 0);
    await sleep(500);
    if (ctx.signal.aborted) throw new Error("stopped");
    return { wc, win, st, close };
  } catch (err) {
    close();
    throw err;
  }
}

const run = <T>(wc: WebContents, code: string) => wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]) as Promise<T>;

/** The page's height (the whole document), capped. */
const pageHeight = async (wc: WebContents) => Math.min(REACH_LIMITS.web.maxHeight, Math.max(1, Number(await run<number>(wc, "Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)")) || 1));

async function resizeTo(p: Page, width: number, height: number) {
  p.win.setContentSize(Math.round(width), Math.round(height));
  await sleep(400);
}

/** A screenshot as the agent gets it: ≤ `maxWidth` wide, PNG (JPEG when the PNG is large). */
function forAgent(img: NativeImage, maxWidth: number): ToolResult["content"][number] {
  const s = img.getSize();
  const scaled = s.width > maxWidth ? img.resize({ width: maxWidth, quality: "good" }) : img;
  const png = scaled.toPNG();
  if (png.length < 2.5 * 1024 * 1024) return { type: "image", data: png.toString("base64"), mimeType: "image/png" };
  return { type: "image", data: scaled.toJPEG(75).toString("base64"), mimeType: "image/jpeg" };
}

const OUTLINE = (limitText: number, limitLinks: number) => `(() => {
  const text = (document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n");
  const headings = [...document.querySelectorAll("h1,h2,h3")].slice(0, 80).map((h) => h.tagName.toLowerCase() + ": " + h.innerText.trim().replace(/\\s+/g, " ").slice(0, 200)).filter((h) => !/: $/.test(h));
  const links = [...document.querySelectorAll("a[href]")].map((a) => ({ text: (a.innerText || a.getAttribute("aria-label") || "").trim().replace(/\\s+/g, " ").slice(0, 120), href: a.href })).filter((l) => /^https?:/.test(l.href)).slice(0, ${limitLinks});
  const meta = document.querySelector('meta[name="description"]');
  return JSON.stringify({ url: location.href, title: document.title.slice(0, 300), description: meta ? String(meta.content).slice(0, 500) : "", headings, text: text.slice(0, ${limitText}), cut: text.length > ${limitText}, links });
})()`;

interface Outline {
  url: string;
  title: string;
  description: string;
  headings: string[];
  text: string;
  cut: boolean;
  links: { text: string; href: string }[];
}

const num = (v: unknown, min: number, max: number, dflt: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : dflt);

async function openWebPage(args: Record<string, unknown>, ctx: RunContext): Promise<ToolResult> {
  const url = String(args.url ?? "");
  const width = num(args.width, 320, 2560, 1280);
  const p = await openPage(url, ctx, width, 800, args.colorScheme === "dark" ? "dark" : "light");
  try {
    const o = JSON.parse(await run<string>(p.wc, OUTLINE(REACH_LIMITS.web.outlineText, REACH_LIMITS.web.links))) as Outline;
    if (args.fullPage === true) await resizeTo(p, width, await pageHeight(p.wc));
    const shot = forAgent(await p.wc.capturePage(), 1280);
    const text = [
      `URL: ${o.url}`,
      `Title: ${o.title}`,
      o.description && `Description: ${o.description}`,
      o.headings.length && `Headings:\n${o.headings.join("\n")}`,
      `Text:\n${o.text}${o.cut ? "\n[… more text on the page]" : ""}`,
      o.links.length && `Links:\n${o.links.map((l) => `- ${l.text || "(no text)"} → ${l.href}`).join("\n")}`,
      p.st.over && `Note: stopped loading early: ${p.st.over}.`,
    ]
      .filter(Boolean)
      .join("\n\n");
    return untrustedResult(`web:${displayUrl(o.url)}`, text, [shot]);
  } finally {
    p.close();
  }
}

const TREE = (selector: string) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return "null";
  const tree = window.__uikit.capture(el, false);
  const bg = getComputedStyle(document.documentElement).backgroundColor;
  return JSON.stringify({ tree, bg, title: document.title.slice(0, 120) });
})()`;

async function captureWebDesign(args: Record<string, unknown>, ctx: RunContext, runInView: WebDeps["runInView"]): Promise<ToolResult> {
  const url = String(args.url ?? "");
  const width = num(args.width, 320, 2560, 1440);
  const height = num(args.height, 320, 4000, 900);
  const selector = typeof args.selector === "string" && args.selector.trim() ? args.selector.trim().slice(0, 500) : "html";
  const parentId = typeof args.parentId === "string" && args.parentId.trim() ? args.parentId.trim() : null;
  const p = await openPage(url, ctx, width, height, args.colorScheme === "dark" ? "dark" : "light");
  try {
    await run(p.wc, WALKER);
    // The whole page laid out at once (up to the limit), so every box has its page position and is in the screenshot.
    const full = await pageHeight(p.wc);
    if (full > height) await resizeTo(p, width, full);
    const got = await run<string>(p.wc, TREE(selector));
    const parsed = JSON.parse(got) as { tree: WNode | null; bg: string; title: string } | null;
    if (!parsed) return { content: [{ type: "text", text: `Nothing on the page matches the selector ${selector}.` }], isError: true };
    if (!parsed.tree) return { content: [{ type: "text", text: "Nothing visible to capture there." }], isError: true };
    const tree = parsed.tree;
    // The page's own background behind the root when it has none.
    if (tree.c && !tree.c.bg) tree.c.bg = /^rgba?\(/.test(parsed.bg) && !/,\s*0\)$/.test(parsed.bg) ? rgbHex(parsed.bg) : "#ffffff";
    const img = await p.wc.capturePage();
    const size = img.getSize();
    const crop = (b: { x: number; y: number; w: number; h: number }) => {
      const x = Math.max(0, Math.floor(b.x));
      const y = Math.max(0, Math.floor(b.y));
      const w = Math.min(size.width - x, Math.ceil(b.w));
      const h = Math.min(size.height - y, Math.ceil(b.h));
      if (w < 1 || h < 1) return null;
      const part = img.crop({ x, y, width: w, height: h });
      const png = part.toPNG();
      return (png.length < 2 * 1024 * 1024 ? png : part.toJPEG(85)).toString("base64");
    };
    const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : `${parsed.title || new URL(p.wc.getURL()).host}${selector !== "html" ? ` — ${selector}` : ""}`;
    const design = designFromCapture(tree, { name, crop: parentId ? crop : undefined, images: !!parentId });
    if (design.layers > REACH_LIMITS.web.layers) return { content: [{ type: "text", text: `That is ${design.layers} layers (the limit is ${REACH_LIMITS.web.layers}). Capture a part of the page with \`selector\` (the outline's headings help find the sections).` }], isError: true };
    const shot = forAgent(img, 1600);
    const source = `web:${displayUrl(p.wc.getURL())}`;
    const about = `Captured ${displayUrl(p.wc.getURL())}${selector !== "html" ? ` (${selector})` : ""} at ${width} px: ${design.layers} layers, ${design.pictures} pictures${design.skipped ? ` (${design.skipped} more left as plain rectangles)` : ""}; fonts: ${design.fonts.join(", ") || "Inter"}.${p.st.over ? ` Stopped loading early: ${p.st.over}.` : ""}`;
    if (parentId) {
      const made = await runInView(ctx, { name: "create_nodes", args: { parentId, nodes: [design.spec] } });
      const text = made.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
      return { content: [{ type: "text", text: about }, shot, { type: "text", text: wrapUntrusted(source, text) }], ...(made.isError ? { isError: true } : {}), ...(made.touched ? { touched: made.touched } : {}) };
    }
    const json = JSON.stringify(withoutImages(design.spec));
    if (json.length > REACH_LIMITS.text)
      return { content: [{ type: "text", text: `${about}\nThe specs are too long to send (${json.length} characters): call again with \`parentId\` to create the layers directly, or capture a part with \`selector\`.` }, shot] };
    return { content: [{ type: "text", text: `${about}\nThe create_nodes spec (pictures left out — call again with parentId to get them):` }, shot, { type: "text", text: wrapUntrusted(source, json) }] };
  } finally {
    p.close();
  }
}

const rgbHex = (c: string) => {
  const [r, g, b] = (/\(([^)]+)\)/.exec(c)?.[1] ?? "255,255,255").split(/[\s,/]+/).map(Number);
  return `#${[r, g, b].map((v) => Math.round(v || 0).toString(16).padStart(2, "0")).join("")}`;
};

export interface WebDeps {
  /** A canvas tool on the turn's file, in the turn (one undo step with its other writes) */
  runInView(ctx: RunContext, call: { name: string; args: Record<string, unknown> }): Promise<ToolResult>;
}

export function webRunner(deps: WebDeps): ReachRunner {
  return (tool, args, ctx) => (tool === "open_web_page" ? openWebPage(args, ctx) : tool === "capture_web_design" ? captureWebDesign(args, ctx, deps.runInView) : Promise.resolve({ content: [{ type: "text", text: `Unknown tool: ${tool}` }], isError: true }));
}
