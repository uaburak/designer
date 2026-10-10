/**
 * The `designer` Worker (docs/multiplayer.md): the API in api.ts over D1, and one FileRoom Durable Object per file.
 */
import { handle, type Env as ApiEnv, type Rooms } from "./api";
import { Db } from "./db";

export { FileRoom } from "./fileRoom";
export { PreviewObject } from "./previewObject";

interface Env extends ApiEnv {
  DB: D1Database;
  ROOMS: DurableObjectNamespace;
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
    return handle(req, { db: new Db(env.DB), env, rooms, fetch: (...a) => fetch(...a), now: () => Date.now() });
  },
} satisfies ExportedHandler<Env>;
