import { describe, expect, it, vi } from "vitest";
import { prefetch, RequestD1, requestTime, rootD1 } from "./requestD1";
import { sqliteD1 } from "./testing/sqliteD1";

const world = async () => {
  const base = sqliteD1();
  await base.prepare(`INSERT INTO users (id, email, name, google_sub, created_at, last_seen_at) VALUES ('u1', 'a@x.co', 'A', 'g1', 1, 1)`).run();
  const batch = vi.spyOn(base, "batch" as never);
  const prepare = vi.spyOn(base, "prepare");
  return { base, d1: new RequestD1(base, 1234), batch, prepare };
};
const USER = { sql: `SELECT id, name FROM users WHERE id = ?1`, args: ["u1"] };

describe("RequestD1", () => {
  it("prefetched reads come from one batch, identical reads take its rows", async () => {
    const { d1, batch, prepare } = await world();
    await d1.prefetch([USER, { sql: `SELECT COUNT(*) AS n FROM users`, args: [] }]);
    expect(batch).toHaveBeenCalledTimes(1);
    prepare.mockClear();
    expect(await d1.prepare(USER.sql).bind("u1").first()).toEqual({ id: "u1", name: "A" });
    expect(await d1.prepare(USER.sql).bind("u1").all()).toEqual({ results: [{ id: "u1", name: "A" }] });
    expect((await d1.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>())?.n).toBe(1);
    expect(prepare).not.toHaveBeenCalled();
    expect(d1.hits).toBe(3);
    // Other arguments, other SQL: to D1
    expect(await d1.prepare(USER.sql).bind("nobody").first()).toBeNull();
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("a write drops what was prefetched: reads after it see it", async () => {
    const { d1 } = await world();
    await d1.prefetch([USER]);
    await d1.prepare(`UPDATE users SET name = 'B' WHERE id = ?1`).bind("u1").run();
    expect(await d1.prepare(USER.sql).bind("u1").first()).toEqual({ id: "u1", name: "B" });
    await d1.prefetch([USER]);
    // A write read through first() (UPDATE … RETURNING) drops it too
    await d1.prepare(`UPDATE users SET name = 'C' WHERE id = ?1 RETURNING id`).bind("u1").first();
    expect(await d1.prepare(USER.sql).bind("u1").first()).toEqual({ id: "u1", name: "C" });
    expect(d1.hits).toBe(0);
  });

  it("hands out copies, passes batches through, and keeps the request's time", async () => {
    const { base, d1 } = await world();
    await d1.prefetch([USER]);
    const a = await d1.prepare(USER.sql).bind("u1").first<{ name: string }>();
    a!.name = "changed";
    expect(await d1.prepare(USER.sql).bind("u1").first()).toEqual({ id: "u1", name: "A" });
    const out = (await d1.batch([d1.prepare(USER.sql).bind("u1"), d1.prepare(`UPDATE users SET name = 'D' WHERE id = ?1`).bind("u1")])) as { results: unknown[] }[];
    expect(out[0].results).toEqual([{ id: "u1", name: "A" }]);
    expect(await d1.prepare(USER.sql).bind("u1").first()).toEqual({ id: "u1", name: "D" });
    expect(rootD1(d1)).toBe(base);
    expect(rootD1(base)).toBe(base);
    expect(requestTime(d1, () => 99)).toBe(1234);
    expect(requestTime(base, () => 99)).toBe(99);
  });

  it("does nothing without a batch, or for a plain D1", async () => {
    const base = sqliteD1();
    const narrow = { prepare: base.prepare.bind(base) };
    const d1 = new RequestD1(narrow);
    await d1.prefetch([USER]);
    await prefetch(base, [USER, null, false, ""]);
    expect(await d1.prepare(USER.sql).bind("u1").first()).toBeNull();
    expect(d1.hits).toBe(0);
  });
});
