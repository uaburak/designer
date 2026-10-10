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
    invite: (fileKey, email, role) => m.invite(fileKey, String(email), role === "viewer" ? "viewer" : "editor"),
    removeMember: (fileKey, email) => m.removeMember(fileKey, String(email)),
    presence: (fileKey, data) => m.presence(fileKey, data),
    watch: (listener) => m.onFileState((fileKey, state) => listener({ fileKey, state })),
  };
}
