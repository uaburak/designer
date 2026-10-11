/**
 * The `designer` Worker (docs/multiplayer.md): the API in api.ts over D1, one FileRoom Durable Object per file, and
 * one Inbox per person for live notifications (§12).
 */
import { handle, type Env as ApiEnv, type Inboxes, type Rooms } from "./api";
import { Db } from "./db";

export { FileRoom } from "./fileRoom";
export { PreviewObject } from "./previewObject";
export { Inbox } from "./inbox";

interface Env extends ApiEnv {
  DB: D1Database;
  ROOMS: DurableObjectNamespace;
  INBOXES: DurableObjectNamespace;
}

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    const rooms: Rooms = {
      fetch(fileKey, path, init, original) {
        const stub = env.ROOMS.get(env.ROOMS.idFromName(fileKey));
        const headers = new Headers(original?.headers);
        headers.delete("authorization");
        if (init.identity) {
          headers.set("x-user-id", init.identity.userId);
          headers.set("x-user-name", init.identity.name ?? "");
          headers.set("x-role", init.identity.role);
        }
        return stub.fetch(new Request(`https://room${path}`, { method: init.method, headers, body: init.body }));
      },
    };
    const inbox = (userId: string) => env.INBOXES.get(env.INBOXES.idFromName(userId));
    const inboxes: Inboxes = {
      async notify(userId, message) {
        await inbox(userId).fetch(new Request("https://inbox/inbox/notify", { method: "POST", body: JSON.stringify(message) }));
      },
      connect(userId, original) {
        const headers = new Headers(original.headers);
        headers.delete("authorization");
        return inbox(userId).fetch(new Request("https://inbox/inbox/ws", { method: "GET", headers }));
      },
    };
    return handle(req, { db: new Db(env.DB), env, rooms, inboxes, fetch: (...a) => fetch(...a), now: () => Date.now() });
  },
} satisfies ExportedHandler<Env>;
