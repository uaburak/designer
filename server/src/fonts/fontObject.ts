/**
 * One organization's shared fonts (docs/desktop.md §14.3): `FontBox` (fontBox.ts) on SQLite storage, named by the
 * org id through the Worker's binding `FONTS`. Org and team fonts of that org share it; their rows are in D1.
 */
import { DurableObject } from "cloudflare:workers";
import type { SqlLike } from "../previews";
import { FontBox } from "./fontBox";

export class FontObject extends DurableObject {
  private box: FontBox;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.box = new FontBox({
      sql: ctx.storage.sql as unknown as SqlLike,
      transaction: (fn) => ctx.storage.transactionSync(fn),
      deleteAll: () => ctx.storage.deleteAll(),
    });
  }

  fetch(req: Request): Promise<Response> {
    return this.box.fetch(req);
  }
}
