/**
 * The `designer` Worker (docs/multiplayer.md): the API in api.ts over D1, one FileRoom Durable Object per file, one
 * Inbox per person for live notifications (§12), one LibraryObject per org library and one FontObject per org
 * (docs/data.md §16, docs/desktop.md §14.3). `scheduled()` tells its two crons apart by `event.cron`: "17 3 * * *" is
 * the daily roll-up of library analytics and the retention sweeps (docs/data.md §17.5; REST rate counters, §16.4;
 * deleted organizations past their grace period, docs/multiplayer.md §14.17);
 * every five minutes, webhook retries (docs/multiplayer.md §16.9). Rooms and library objects of orgs whose data region is
 * the EU live in Cloudflare's `eu` jurisdiction (docs/multiplayer.md §15.10: `roomsOn`, `libraryFetch`).
 */
import { handle, type Deps, type Env as ApiEnv, type Inboxes, type Rooms } from "./api";
import { Db } from "./db";
import { rollup } from "./analytics/rollup";
import type { ObjectNamespace } from "./libraries/db";
import { roomsOn } from "./policy/region";
import type { ObjectStore } from "./storage/objects";

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
  /** R2 (docs/cloud.md §1): wecra-files and wecra-files-eu (jurisdiction eu) */
  FILES?: ObjectStore;
  FILES_EU?: ObjectStore;
}

/** The API's dependencies over the bindings (requests and the daily cron) */
function depsOf(env: Env, waitUntil?: (p: Promise<unknown>) => void): Deps {
  // Each file's room in its jurisdiction (files.jurisdiction, docs/multiplayer.md §15.10), with x-policy (§15.9).
  const db = new Db(env.DB);
  const rooms: Rooms = roomsOn(env.ROOMS as unknown as ObjectNamespace, db.d1, env);
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
  return { db, env, rooms, inboxes, fetch: (...a) => fetch(...a), now: () => Date.now(), ...(waitUntil ? { waitUntil } : {}) };
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handle(req, depsOf(env, (p) => ctx.waitUntil(p)));
  },

  /** "17 3 * * *": the library analytics roll-up for yesterday (UTC) and the retention sweeps; "*\/5 * * * *": webhook
   *  deliveries that are due (and the 7-day log), after the spend guard's usage check */
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === "*/5 * * * *") {
      // The spend guard (docs/multiplayer.md §17.1): month-to-date usage from Cloudflare's analytics; never fails the cron
      await (await import("./guard/check")).checkSpend(depsOf(env)).catch((e: unknown) => console.error("spend guard: check failed", e));
      const { sweepWebhooks } = await import("./webhooks/deliver");
      await sweepWebhooks({ db: new Db(env.DB), now: () => Date.now(), fetch: (...a) => fetch(...a) });
      return;
    }
    await rollup(env.DB, controller.scheduledTime);
    await (await import("./rest/rate")).sweepRate(env.DB, controller.scheduledTime);
    // Guests whose access ended (docs/governance.md §2.13): removed, logged org_user_delete {reason: "guest_expired"}
    await (await import("./governance/guests")).sweepExpiredGuests(depsOf(env));
    // Discovery events and developer logs older than 30 days (docs/governance.md §2.11, §2.12)
    await (await import("./discovery/record")).sweepGovernanceLogs(env.DB, controller.scheduledTime);
    // Quota counters of past days, expired previews' rows and stored bytes (docs/multiplayer.md §17)
    await (await import("./quota/quota")).sweepQuotas({ ...depsOf(env), now: () => controller.scheduledTime });
    // Organizations deleted more than 14 days ago, deleted for good (docs/multiplayer.md §14.17)
    await (await import("./org/deletion")).purgeDeletedOrgs({ ...depsOf(env), now: () => controller.scheduledTime });
    // R2 (docs/cloud.md §1): references of deleted files dropped, objects unreferenced for 7 days deleted
    const r2 = await (await import("./storage/refs")).sweepR2({ ...depsOf(env), now: () => controller.scheduledTime });
    if (r2.dropped || r2.deleted) console.log("r2 sweep", r2);
  },
} satisfies ExportedHandler<Env>;
