/**
 * One developer preview's Durable Object (docs/multiplayer.md §9): `PreviewBox` (previews.ts) on SQLite storage,
 * with an alarm at the preview's expiry. Reached only through the Worker's binding `PREVIEWS`, which has already
 * checked the caller owns the preview for every write.
 */
import { DurableObject } from "cloudflare:workers";
import { PreviewBox, type SqlLike } from "./previews";

export class PreviewObject extends DurableObject {
  private box: PreviewBox;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.box = new PreviewBox({
      sql: ctx.storage.sql as unknown as SqlLike,
      transaction: (fn) => ctx.storage.transactionSync(fn),
      now: () => Date.now(),
      setAlarm: async (at) => {
        if (at === null) await ctx.storage.deleteAlarm();
        else await ctx.storage.setAlarm(at);
      },
      deleteAll: async () => {
        await ctx.storage.deleteAlarm();
        await ctx.storage.deleteAll();
      },
    });
  }

  fetch(req: Request): Promise<Response> {
    return this.box.fetch(req);
  }

  alarm(): Promise<void> {
    return this.box.alarm();
  }
}
