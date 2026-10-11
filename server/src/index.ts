/**
 * The `designer` Worker (docs/multiplayer.md): the API in api.ts over D1, one FileRoom Durable Object per file, one
 * Inbox per person for live notifications (§12), one LibraryObject per org library and one FontObject per org
 * (docs/data.md §16, docs/desktop.md §14.3). `scheduled()` is the daily roll-up of library analytics and the
 * retention sweeps (docs/data.md §17.5; wrangler.jsonc's cron).
 */
import { handle, type Env as ApiEnv, type Inboxes, type Rooms } from "./api";
import { Db } from "./db";
import { rollup } from "./analytics/rollup";

export { FileRoom } from "./fileRoom";
export { PreviewObject } from "./previewObject";
export { Inbox } from "./inbox";
export { LibraryObject } from "./libraries/libraryObject";
export { FontObject } from "./fonts/fontObject";

interface Env extends ApiEnv {
  DB: D1Database;
  ROOMS: DurableObjectNamespace;
  INBOXES: DurableObjectNamespace;
  LIBRARIES: DurableObjectNamespace;
  FONTS: DurableObjectNamespace;
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
    return handle(req, { db: new Db(env.DB), env, rooms, inboxes, fetch: (...a) => fetch(...a), now: () => Date.now(), waitUntil: (p) => ctx.waitUntil(p) });
  },

  /** "17 3 * * *": the library analytics roll-up for yesterday (UTC) and the retention sweeps */
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await rollup(env.DB, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
