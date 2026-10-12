/**
 * One org library's Durable Object (docs/data.md §16.2, §16.13): `LibraryBox` (libraryBox.ts) on SQLite storage.
 * Named by the library's key (its file's room key) through the Worker's binding `LIBRARIES`, which has checked the
 * caller for every route.
 */
import { DurableObject } from "cloudflare:workers";
import type { SqlLike } from "../previews";
import { LibraryBox } from "./libraryBox";

export class LibraryObject extends DurableObject {
  private box: LibraryBox;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.box = new LibraryBox({
      sql: ctx.storage.sql as unknown as SqlLike,
      transaction: (fn) => ctx.storage.transactionSync(fn),
      deleteAll: () => ctx.storage.deleteAll(),
      // R2 (docs/cloud.md §1): the buckets, and the object's name (the library key / the org id) for its prefix
      env: env as never,
      name: () => ctx.id.name ?? null,
    });
  }

  fetch(req: Request): Promise<Response> {
    return this.box.fetch(req);
  }
}
