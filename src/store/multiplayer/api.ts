/** The `multiplayer` repository (docs/multiplayer.md §5) over a store's service — LocalStore and the browser's dev store. */
import type { LinkAccess, LinkSettingsPatch, MultiplayerRepository, OpenIntent, RestJobAnswer } from "../../shared/multiplayer/types";
import { StoreError } from "../../shared/store/protocol";
import type { MultiplayerService } from "./service";

/** `owner`: the port the repository is bound to (its renderers end when it closes: `releaseRenderersOf`) */
export function multiplayerApi(m: MultiplayerService, owner?: object): MultiplayerRepository {
  return {
    setSession: (session) => m.setSession(session && typeof session.server === "string" && typeof session.token === "string" ? { server: session.server, token: session.token } : null),
    status: () => m.status(),
    fileState: (fileKey) => m.fileState(fileKey),
    share: (fileKey, input) => {
      if (!(input?.snapshot instanceof Uint8Array) || !Number.isInteger(input.headSeq)) throw new StoreError("invalid", "share needs the file's snapshot and head seq");
      return m.share(fileKey, input);
    },
    listRemote: () => m.listRemote(),
    openShared: (key, password, intent) => m.openShared(String(key), typeof password === "string" ? password : undefined, cleanIntent(intent)),
    takeOpenIntent: (fileKey) => m.takeOpenIntent(fileKey),
    unlockFile: (fileKey, password) => m.unlockFile(fileKey, String(password)),
    setLinkPassword: (fileKey, password) => m.setLinkPassword(fileKey, typeof password === "string" && password ? password : null),
    transferOwnership: (fileKey, email) => m.transferOwnership(fileKey, String(email)),
    signal: (fileKey, to, data) => m.signal(fileKey, Number(to), data),
    members: (fileKey) => m.members(fileKey),
    fileInfo: (fileKey) => m.fileInfo(fileKey),
    setViewersCanCopy: (fileKey, on) => m.setViewersCanCopy(fileKey, on === true),
    requestEdit: (fileKey) => m.requestEdit(fileKey),
    requests: (fileKey) => m.requests(fileKey),
    answerRequest: (fileKey, userId, approve) => m.answerRequest(fileKey, String(userId), approve === true),
    setLinkAccess: (fileKey, access) => m.setLinkAccess(fileKey, access === "viewer" || access === "editor" ? access : "none"),
    updateLink: (fileKey, patch) => m.updateLink(fileKey, cleanLinkPatch(patch)),
    invite: (fileKey, email, role) => m.invite(fileKey, String(email), role === "viewer" ? "viewer" : "editor"),
    removeMember: (fileKey, email) => m.removeMember(fileKey, String(email)),
    presence: (fileKey, data) => m.presence(fileKey, data),
    watch: (listener) => {
      const a = m.onFileState((fileKey, state) => listener({ fileKey, state }));
      const b = m.onReplaced((from, to) => void m.fileState(from).then((state) => listener({ fileKey: from, state, replacedBy: to })));
      const c = m.onNotice((fileKey, notice) => void m.fileState(fileKey).then((state) => listener({ fileKey, state, notice })));
      const d = m.onSignal((fileKey, from, data) => void m.fileState(fileKey).then((state) => listener({ fileKey, state, signal: { from, data } })));
      const e = m.onPolicy((fileKey, policy) => void m.fileState(fileKey).then((state) => listener({ fileKey, state, policy })));
      const f = m.onRestJob((fileKey, restJob) => void m.fileState(fileKey).then((state) => listener({ fileKey, state, restJob })));
      const g = m.onRestWanted((fileKey) => void m.fileState(fileKey).then((state) => listener({ fileKey, state, restWanted: true })));
      return () => {
        a();
        b();
        c();
        d();
        e();
        f();
        g();
      };
    },
    restRender: (fileKey, on, opts, token) => m.restRender(fileKey, on === true, { helper: (opts as { helper?: unknown } | undefined)?.helper === true }, typeof token === "string" && token ? token : undefined, owner),
    restAnswer: (fileKey, id, answer) => m.restAnswer(fileKey, String(id), cleanAnswer(answer)),
    watchSession: (listener) => m.onSessionEnded(listener),
    uploads: async () => m.uploads.list(),
    retryUpload: async (id) => m.uploads.retry(String(id)),
    cancelUpload: async (id) => m.uploads.cancel(String(id)),
    watchUploads: (listener) => m.onUploads(listener),
  };
}

/** A render job's answer: parts of bytes with names and types, or an error text */
function cleanAnswer(a: unknown): RestJobAnswer {
  if (!a || typeof a !== "object") throw new StoreError("invalid", "restAnswer needs the parts or an error");
  const v = a as { parts?: unknown; err?: unknown };
  if (typeof v.err === "string") return { err: v.err };
  if (!Array.isArray(v.parts)) throw new StoreError("invalid", "restAnswer needs the parts or an error");
  return {
    parts: v.parts.map((p: { name?: unknown; bytes?: unknown; contentType?: unknown }) => {
      if (!p || typeof p.name !== "string" || !p.name || !(p.bytes instanceof Uint8Array) || typeof p.contentType !== "string") throw new StoreError("invalid", "a part is {name, bytes, contentType}");
      return { name: p.name, bytes: p.bytes, contentType: p.contentType };
    }),
  };
}

const linkAccess = (v: unknown): LinkAccess => (v === "viewer" || v === "editor" ? v : "none");

/** Only `LinkSettingsPatch`'s keys, each of its type (the server checks the values against the org's policy) */
function cleanLinkPatch(p: unknown): LinkSettingsPatch {
  if (!p || typeof p !== "object") throw new StoreError("invalid", "updateLink needs the settings to change");
  const v = p as Record<string, unknown>;
  const out: LinkSettingsPatch = {};
  if (v.linkAccess !== undefined) out.linkAccess = linkAccess(v.linkAccess);
  if (v.orgLinkAccess !== undefined) out.orgLinkAccess = linkAccess(v.orgLinkAccess);
  if (v.linkPassword !== undefined) out.linkPassword = typeof v.linkPassword === "string" && v.linkPassword ? v.linkPassword : null;
  if (v.linkExpiresAt !== undefined) out.linkExpiresAt = typeof v.linkExpiresAt === "number" && Number.isFinite(v.linkExpiresAt) ? v.linkExpiresAt : null;
  if (v.viewersCanCopy !== undefined) out.viewersCanCopy = v.viewersCanCopy === true;
  if (v.protoLinkAccess !== undefined) out.protoLinkAccess = v.protoLinkAccess === "viewer" ? "viewer" : "none";
  if (v.protoOrgLinkAccess !== undefined) out.protoOrgLinkAccess = v.protoOrgLinkAccess === "viewer" ? "viewer" : "none";
  return out;
}

const cleanIntent = (i: unknown): OpenIntent | undefined => {
  if (!i || typeof i !== "object") return undefined;
  const { nodeId, mode, commentId, devMode } = i as OpenIntent;
  return {
    ...(devMode === "ready" ? { devMode } : {}),
    ...(typeof nodeId === "string" && /^[0-9]+:[0-9]+$/.test(nodeId) ? { nodeId } : {}),
    ...(mode === "dev" || mode === "proto" ? { mode } : {}),
    ...(typeof commentId === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(commentId) ? { commentId } : {}),
  };
};
