/**
 * Shared fonts in main (docs/desktop.md §14.3): the organization and team fonts the multiplayer server serves to the
 * signed-in person — the font index's fourth source next to the installed fonts, the uploaded ones and Google Fonts.
 *
 * - **The list**: `GET /me/fonts` (every face the person may use across their orgs and teams; the server leaves org
 *   fonts out for guests), cached in `userData/cache/shared-fonts-v1.json` for offline use (per account and server).
 *   Refreshed at launch when signed in, on the store's `fonts` event (an Inbox notice after an upload, a replace or a
 *   removal), on sign-in / sign-out and at most every 6 hours on window focus. A changed `version` → `fonts:changed`.
 * - **The files**: a face's id in the index is `s:<id>`; `fonts:read` of one downloads `GET /fonts/:sha1` into
 *   `userData/fonts/shared/<sha1>.<ttf|otf>` on first use (checked against its SHA-1) and reads it from there after.
 *   A file no longer listed for the person is deleted on the next successful refresh (someone who left the org stops
 *   having its fonts); signed out, the list is empty and the files stay until a signed-in refresh decides.
 * - **Uploading** (Admin › Resources › Fonts; a team's View team's fonts): views can't name paths, so main picks the
 *   files (its Open dialog), parses them (`parseFile`), asks the server for conflicts, keeps the paths behind tokens
 *   (10 minutes) and uploads them once the view confirmed the licence and chose Skip / Replace per family.
 *
 * Views see faces, never paths or the session token.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type {
  FontConflict,
  FontConflictChoice,
  FontUploadAnswer,
  FontUploadCandidate,
  FontUploadResult,
  SharedFontFace,
  SharedFontFaceInput,
  SharedFontList,
  SharedFontScope,
} from "../shared/fonts/sharedTypes";
import type { FontFaceInfo } from "../shared/ipc";

// ---- Seams (the app's account and fetch; tests put a fake server here) ------------------------

/** A signed-in session: the server's base URL, the token, the account's id (the cache is per account). */
export interface SharedFontsSession {
  server: string;
  token: string;
  userId: string;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type ParseFile = (path: string, source: FontFaceInfo["source"]) => Promise<FontFaceInfo[]>;

let root = "";
let fetcher: Fetch = (url, init) => fetch(url, init);
let currentSession: () => SharedFontsSession | null = () => null;
let parse: ParseFile | null = null;

/** userData: the list's cache in `<root>/cache`, the files in `<root>/fonts/shared`. */
export function setSharedFontsRoot(dir: string): void {
  root = dir;
  listLoad = null;
}
export function setSharedFontsFetch(f: Fetch): void {
  fetcher = f;
}
/** Where the session comes from (main: the account; tests: a fake). */
export function setSharedFontsSession(s: () => SharedFontsSession | null): void {
  currentSession = s;
}
/** The font reader (fonts.ts parseFile), injected so fonts.ts can import this module without a cycle at load. */
export function setSharedFontsParser(p: ParseFile): void {
  parse = p;
}

const LIST_VERSION = 1;
const TIMEOUT_MS = 30_000;
/** As §14.2's personal upload: a font past 50 MB is surely not one */
export const MAX_SHARED_FONT_BYTES = 50 * 1024 * 1024;
/** Picked files' tokens expire after 10 minutes */
const TOKEN_MS = 10 * 60 * 1000;
/** On window focus, a refresh at most this often */
export const FOCUS_REFRESH_MS = 6 * 3600 * 1000;

const listPath = () => join(root, "cache", `shared-fonts-v${LIST_VERSION}.json`);
const filesDir = () => join(root, "fonts", "shared");
const filePath = (f: Pick<SharedFontFace, "sha1" | "format">) => join(filesDir(), `${f.sha1}.${f.format}`);

async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

class SharedFontsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

/** A request to the server with the session; null when signed out. */
async function request(method: string, path: string, init: { body?: RequestInit["body"]; headers?: Record<string, string>; json?: unknown } = {}): Promise<Response | null> {
  const s = currentSession();
  if (!s) return null;
  const headers: Record<string, string> = { authorization: `Bearer ${s.token}`, ...init.headers };
  let body = init.body;
  if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  return fetcher(`${s.server.replace(/\/+$/, "")}${path}`, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/** The answer's JSON, or an error carrying the server's message ("You're offline" when the request didn't go). */
async function json<T>(method: string, path: string, init: Parameters<typeof request>[2] = {}): Promise<T> {
  let res: Response | null;
  try {
    res = await request(method, path, init);
  } catch {
    throw new SharedFontsError("You're offline", 0, null);
  }
  if (!res) throw new SharedFontsError("Log in first", 401, null);
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const msg = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : `The server answered ${res.status}`;
    throw new SharedFontsError(msg, res.status, body);
  }
  return body as T;
}

// ---- The list --------------------------------------------------------------------------------

interface CachedList extends SharedFontList {
  v: number;
  server: string;
  userId: string;
}

let list: SharedFontList = { version: "", faces: [] };
let listLoad: Promise<void> | null = null;
const byId = new Map<string, SharedFontFace>();

function setList(next: SharedFontList): void {
  list = { version: next.version, faces: [...next.faces] };
  byId.clear();
  for (const f of list.faces) byId.set(f.id, f);
}

/** The cached list, read once (only the same account on the same server: another person signing in sees none). */
function loadCached(): Promise<void> {
  listLoad ??= (async () => {
    const s = currentSession();
    setList({ version: "", faces: [] });
    if (!s || !root) return;
    try {
      const c = JSON.parse(await readFile(listPath(), "utf8")) as CachedList;
      if (c.v === LIST_VERSION && c.server === s.server && c.userId === s.userId && Array.isArray(c.faces)) setList(c);
    } catch {
      // no cache yet
    }
  })();
  return listLoad;
}

/** The faces last handed out (the index's): a refresh tells the views only when what they'd see differs. */
let given = "";

/** The shared faces the signed-in person may use (the cached list until a refresh answers; none signed out). */
export async function sharedFonts(): Promise<SharedFontFace[]> {
  await loadCached();
  const faces = currentSession() ? list.faces : [];
  given = idsOf(faces);
  return faces;
}

/** The list's version (changes whenever the faces do). */
export const sharedFontsVersion = () => list.version;

const valid = (f: unknown): f is SharedFontFace => {
  const x = f as SharedFontFace;
  return !!x && typeof x.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(x.id) && typeof x.family === "string" && typeof x.style === "string" && typeof x.sha1 === "string" && /^[0-9a-f]{40}$/.test(x.sha1) && (x.format === "ttf" || x.format === "otf") && typeof x.orgId === "string";
};

/** What the pickers see changes when the faces do (a replace gives new ids; the version follows the ids). */
const idsOf = (faces: readonly SharedFontFace[]) => faces.map((f) => `${f.id}\t${f.family}\t${f.style}`).join("\n");

let refreshing: Promise<boolean> | null = null;
let lastRefresh = 0;

/**
 * Reads `GET /me/fonts`: true when the list changed. Signed out: the list empties (files kept). Offline or a server
 * error: the cached list stays. After a successful read, cached files no longer listed are deleted.
 */
export function refreshSharedFonts(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      await loadCached();
      const s = currentSession();
      if (!s) {
        const changed = list.faces.length > 0;
        setList({ version: "", faces: [] });
        return changed;
      }
      let answer: SharedFontList;
      try {
        answer = await json<SharedFontList>("GET", "/me/fonts");
      } catch (e) {
        // 401: the session is gone — like signed out (the account drops it on its own request).
        if (e instanceof SharedFontsError && e.status === 401) {
          const changed = list.faces.length > 0;
          setList({ version: "", faces: [] });
          return changed;
        }
        return false;
      }
      lastRefresh = Date.now();
      const faces = Array.isArray(answer?.faces) ? answer.faces.filter(valid) : [];
      const version = typeof answer?.version === "string" ? answer.version : "";
      const changed = idsOf(faces) !== idsOf(list.faces);
      setList({ version, faces });
      if (root) {
        const cached: CachedList = { v: LIST_VERSION, server: s.server, userId: s.userId, version, faces };
        await writeAtomic(listPath(), JSON.stringify(cached)).catch(() => {});
        await evict(faces);
      }
      return changed;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Deletes the cached files no listed face uses (licences: fonts the person may no longer use don't stay). */
async function evict(faces: readonly SharedFontFace[]): Promise<void> {
  const keep = new Set(faces.map((f) => `${f.sha1}.${f.format}`));
  let names: string[] = [];
  try {
    names = await readdir(filesDir());
  } catch {
    return;
  }
  for (const n of names) if (!keep.has(n)) await rm(join(filesDir(), n), { force: true }).catch(() => {});
}

// ---- Files -----------------------------------------------------------------------------------

const downloads = new Map<string, Promise<string>>();

const sha1 = (b: Uint8Array) => createHash("sha1").update(b).digest("hex");
const magic = (b: Uint8Array) => (b.length >= 4 ? ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0 : 0);
/** TTF (`0x00010000`, `true`) or OTF (`OTTO`); a collection or anything else: null */
export function sfntFormat(b: Uint8Array): "ttf" | "otf" | null {
  const m = magic(b);
  return m === 0x4f54544f ? "otf" : m === 0x00010000 || m === 0x74727565 ? "ttf" : null;
}

/** The cached file of a shared face (its id without `s:`), downloaded first if needed (concurrent asks share one). */
export async function sharedFontPath(id: string): Promise<string> {
  await loadCached();
  const face = byId.get(id);
  if (!face || !currentSession()) throw new Error(`shared fonts: no face ${id}`);
  const path = filePath(face);
  try {
    await stat(path);
    return path;
  } catch {
    // not cached yet
  }
  let p = downloads.get(face.sha1);
  if (!p) {
    p = (async () => {
      let res: Response | null;
      try {
        res = await request("GET", `/fonts/${face.sha1}`);
      } catch {
        throw new Error(`shared fonts: offline, ${face.family} ${face.style} isn't cached`);
      }
      if (!res?.ok) throw new Error(`shared fonts: ${face.family} ${face.style}: ${res ? res.status : "signed out"}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (sha1(bytes) !== face.sha1 || !sfntFormat(bytes)) throw new Error(`shared fonts: ${face.family} ${face.style}: not the listed file`);
      await writeAtomic(path, bytes);
      return path;
    })();
    downloads.set(face.sha1, p);
    void p.finally(() => downloads.delete(face.sha1)).catch(() => {});
  }
  return p;
}

/** A shared face's bytes (`fonts:read` of `s:<id>`): TTF / OTF are single files, nothing is sliced. */
export async function readSharedFont(id: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(await sharedFontPath(id)));
}

// ---- Uploading (admins) ----------------------------------------------------------------------

interface Picked {
  path: string;
  candidate: FontUploadCandidate;
  scope: string;
  expires: number;
}
const picked = new Map<string, Picked>();

const scopeKey = (s: SharedFontScope) => (s.type === "org" ? `org:${s.orgId}` : `team:${s.orgId}:${s.teamId}`);
const idOk = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);

/** A scope from a view, checked (ids are URL path segments). */
export function checkScope(v: unknown): SharedFontScope {
  const s = v as SharedFontScope;
  if (s?.type === "org" && idOk(s.orgId)) return { type: "org", orgId: s.orgId };
  if (s?.type === "team" && idOk(s.orgId) && idOk(s.teamId)) return { type: "team", orgId: s.orgId, teamId: s.teamId };
  throw new Error("shared fonts: not a scope");
}

const fontsPath = (s: SharedFontScope, query: Record<string, string> = {}) => {
  const q = new URLSearchParams({ ...(s.type === "team" ? { team: s.teamId } : {}), ...query }).toString();
  return `/orgs/${encodeURIComponent(s.orgId)}/fonts${q ? `?${q}` : ""}`;
};

const toInput = (f: FontFaceInfo): SharedFontFaceInput => ({
  family: f.family,
  style: f.style,
  postscriptName: f.postscriptName,
  weight: Math.max(1, Math.min(1000, Math.round(f.weight) || 400)),
  italic: f.italic,
  stretch: Math.max(1, Math.min(9, Math.round(f.stretch) || 5)),
  variable: !!f.variable,
});

/** One file checked and parsed into a candidate (or why it's refused, in the words the view shows). */
export async function readCandidate(path: string): Promise<FontUploadCandidate | { fileName: string; reason: string }> {
  const fileName = basename(path);
  const ext = extname(path).toLowerCase();
  if (ext !== ".ttf" && ext !== ".otf") return { fileName, reason: "Only .TTF and .OTF files can be uploaded" };
  let bytes: Uint8Array;
  try {
    const s = await stat(path);
    if (s.size > MAX_SHARED_FONT_BYTES) return { fileName, reason: "The file is larger than 50 MB" };
    bytes = new Uint8Array(await readFile(path));
  } catch {
    return { fileName, reason: "The file can't be read" };
  }
  const format = sfntFormat(bytes);
  if (!format) return { fileName, reason: magic(bytes) === 0x74746366 ? "Font collections (.TTC) can't be uploaded" : "Not a font file" };
  let faces: FontFaceInfo[] = [];
  try {
    faces = parse ? await parse(path, "user") : [];
  } catch {
    faces = [];
  }
  if (!faces.length) return { fileName, reason: "No font in it" };
  return { token: randomUUID(), fileName, format, size: bytes.length, sha1: sha1(bytes), faces: faces.map(toInput) };
}

function sweepTokens(now = Date.now()): void {
  for (const [t, p] of picked) if (p.expires <= now) picked.delete(t);
}

/**
 * `fonts:shared-pick`'s work after the Open dialog: each path parsed (refused files listed), then the families asked
 * about (`POST …/fonts/check`). The candidates keep tokens; the paths stay here.
 */
export async function prepareUpload(scope: SharedFontScope, paths: string[]): Promise<{ candidates: FontUploadCandidate[]; conflicts: FontConflict[]; failed: { fileName: string; reason: string }[] }> {
  sweepTokens();
  const candidates: FontUploadCandidate[] = [];
  const failed: { fileName: string; reason: string }[] = [];
  for (const path of paths) {
    const c = await readCandidate(path);
    if ("token" in c) {
      candidates.push(c);
      picked.set(c.token, { path, candidate: c, scope: scopeKey(scope), expires: Date.now() + TOKEN_MS });
    } else failed.push(c);
  }
  const families = [...new Set(candidates.flatMap((c) => c.faces.map((f) => f.family)))];
  let conflicts: FontConflict[] = [];
  if (families.length) {
    const answer = await json<{ conflicts: FontConflict[] }>("POST", `/orgs/${encodeURIComponent(scope.orgId)}/fonts/check`, { json: { ...(scope.type === "team" ? { teamId: scope.teamId } : {}), families } });
    conflicts = Array.isArray(answer?.conflicts) ? answer.conflicts : [];
  }
  return { candidates, conflicts, failed };
}

/** A header value as the server reads it: plain ASCII as is, anything else percent-encoded. */
const headerValue = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : encodeURIComponent(s));

/**
 * `fonts:shared-upload`: each picked file `PUT …/fonts` with its faces and the licence header. A file of a family in
 * conflict follows its choice — Skip leaves it out, Replace sends `onConflict=replace`. Refreshes the list after.
 */
export async function uploadPicked(scope: SharedFontScope, tokens: string[], choices: Record<string, FontConflictChoice>): Promise<FontUploadResult> {
  sweepTokens();
  const result: FontUploadResult = { uploaded: [], skipped: [], replaced: [], failed: [] };
  for (const token of tokens) {
    const p = picked.get(token);
    if (!p || p.scope !== scopeKey(scope)) {
      result.failed.push({ fileName: p?.candidate.fileName ?? "", reason: "The file was picked too long ago. Pick it again." });
      continue;
    }
    picked.delete(token);
    const c = p.candidate;
    const families = [...new Set(c.faces.map((f) => f.family))];
    const chosen = families.map((f) => choices[f]).filter((x): x is FontConflictChoice => x === "skip" || x === "replace");
    if (chosen.length && chosen.every((x) => x === "skip")) {
      result.skipped.push(...families);
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(p.path));
    } catch {
      result.failed.push({ fileName: c.fileName, reason: "The file can't be read" });
      continue;
    }
    if (sha1(bytes) !== c.sha1) {
      result.failed.push({ fileName: c.fileName, reason: "The file changed since it was picked. Pick it again." });
      continue;
    }
    const onConflict = chosen.includes("replace") ? "replace" : chosen.length ? "skip" : null;
    try {
      const answer = await json<FontUploadAnswer>("PUT", fontsPath(scope, onConflict ? { onConflict } : {}), {
        body: bytes,
        headers: {
          "content-type": c.format === "otf" ? "font/otf" : "font/ttf",
          "x-font-faces": Buffer.from(JSON.stringify(c.faces)).toString("base64"),
          "x-font-file-name": headerValue(c.fileName),
          "x-font-licence": "confirmed",
        },
      });
      result.uploaded.push(...(answer.uploaded ?? []));
      result.replaced.push(...(answer.replaced ?? []));
      if (onConflict === "skip") for (const f of families) if (choices[f] === "skip") result.skipped.push(f);
    } catch (e) {
      const reason = e instanceof SharedFontsError && e.status === 409 ? "A font with this name was uploaded meanwhile. Upload it again to choose." : e instanceof Error ? e.message : String(e);
      result.failed.push({ fileName: c.fileName, reason });
    }
  }
  if (result.uploaded.length || result.replaced.length) await refreshAndTell();
  return result;
}

/** `fonts:shared-list`: the scope's fonts (Admin › Resources › Fonts; View team's fonts). */
export async function listScopeFonts(scope: SharedFontScope): Promise<{ faces: SharedFontFace[] }> {
  const answer = await json<{ faces: SharedFontFace[] }>("GET", fontsPath(scope));
  return { faces: Array.isArray(answer?.faces) ? answer.faces : [] };
}

/** `fonts:shared-remove`: faces by id, or a whole family; the scope's fonts after. */
export async function removeScopeFonts(scope: SharedFontScope, sel: { ids?: string[]; family?: string }): Promise<{ faces: SharedFontFace[] }> {
  let faces: SharedFontFace[] | null = null;
  if (sel.family) faces = (await json<{ faces: SharedFontFace[] }>("DELETE", fontsPath(scope, { family: sel.family }))).faces;
  for (const id of sel.ids ?? []) {
    if (!idOk(id)) continue;
    faces = (await json<{ faces: SharedFontFace[] }>("DELETE", `/orgs/${encodeURIComponent(scope.orgId)}/fonts/${encodeURIComponent(id)}`)).faces;
  }
  await refreshAndTell();
  return faces ? { faces } : listScopeFonts(scope);
}

/** Drops the picked tokens (tests). */
export function forgetPicked(): void {
  picked.clear();
}

// ---- Refreshing ------------------------------------------------------------------------------

let changedListener: (() => void) | null = null;

/** Called when the list changed (fonts.ts bumps the index's version; views hear `fonts:changed`). */
export function onSharedFontsChanged(listener: () => void): void {
  changedListener = listener;
}

async function refreshAndTell(): Promise<void> {
  await refreshSharedFonts().catch(() => false);
  const before = given;
  if (idsOf(await sharedFonts()) !== before) changedListener?.();
}

/** A refresh on window focus, at most every 6 hours. */
export function refreshOnFocus(now = Date.now()): void {
  if (currentSession() && now - lastRefresh >= FOCUS_REFRESH_MS) void refreshAndTell();
}

/** The triggers: the store's `fonts` events, the account's sign-in / sign-out, window focus. Returns a stop. */
export function startSharedFonts(hooks: { onStoreFonts(cb: () => void): () => void; onSession(cb: () => void): () => void; onFocus(cb: () => void): () => void }): () => void {
  void refreshAndTell();
  const offs = [
    hooks.onStoreFonts(() => void refreshAndTell()),
    hooks.onSession(() => {
      // Another account (or none): the cached list is read again for it.
      listLoad = null;
      void refreshAndTell();
    }),
    hooks.onFocus(() => refreshOnFocus()),
  ];
  return () => offs.forEach((off) => off());
}

/** Forgets everything in memory (tests). */
export function resetSharedFonts(): void {
  setList({ version: "", faces: [] });
  listLoad = null;
  refreshing = null;
  lastRefresh = 0;
  given = "";
  picked.clear();
  downloads.clear();
}
