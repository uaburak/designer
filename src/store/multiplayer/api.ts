/** The `multiplayer` repository (docs/multiplayer.md §5) over a store's service — LocalStore and the browser's dev store. */
import type { MultiplayerRepository } from "../../shared/multiplayer/types";
import { StoreError } from "../../shared/store/protocol";
import type { MultiplayerService } from "./service";

export function multiplayerApi(m: MultiplayerService): MultiplayerRepository {
  return {
    setSession: (session) => m.setSession(session && typeof session.server === "string" && typeof session.token === "string" ? { server: session.server, token: session.token } : null),
    status: () => m.status(),
    fileState: (fileKey) => m.fileState(fileKey),
    share: (fileKey, input) => {
      if (!(input?.snapshot instanceof Uint8Array) || !Number.isInteger(input.headSeq)) throw new StoreError("invalid", "share needs the file's snapshot and head seq");
      return m.share(fileKey, input);
    },
    listRemote: () => m.listRemote(),
    openShared: (key) => m.openShared(String(key)),
    members: (fileKey) => m.members(fileKey),
    fileInfo: (fileKey) => m.fileInfo(fileKey),
    setViewersCanCopy: (fileKey, on) => m.setViewersCanCopy(fileKey, on === true),
    requestEdit: (fileKey) => m.requestEdit(fileKey),
    requests: (fileKey) => m.requests(fileKey),
    answerRequest: (fileKey, userId, approve) => m.answerRequest(fileKey, String(userId), approve === true),
    setLinkAccess: (fileKey, access) => m.setLinkAccess(fileKey, access === "viewer" || access === "editor" ? access : "none"),
    invite: (fileKey, email, role) => m.invite(fileKey, String(email), role === "viewer" ? "viewer" : "editor"),
    removeMember: (fileKey, email) => m.removeMember(fileKey, String(email)),
    presence: (fileKey, data) => m.presence(fileKey, data),
    watch: (listener) => {
      const a = m.onFileState((fileKey, state) => listener({ fileKey, state }));
      const b = m.onReplaced((from, to) => void m.fileState(from).then((state) => listener({ fileKey: from, state, replacedBy: to })));
      const c = m.onNotice((fileKey, notice) => void m.fileState(fileKey).then((state) => listener({ fileKey, state, notice })));
      return () => {
        a();
        b();
        c();
      };
    },
  };
}
