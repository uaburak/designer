import { beforeEach, describe, expect, it } from "vitest";
import { restWorld, type RestWorld } from "../testing/restWorld";
import { AI_CALLS_PER_HOUR } from "./usage";

let w: RestWorld;
const DAY = 86_400_000;
const day = (offset: number) => new Date(w.now.t + offset * DAY).toISOString().slice(0, 10);

beforeEach(async () => {
  w = await restWorld();
});

const post = (who: keyof RestWorld["people"], rows: unknown) => w.call("POST", "/me/ai-usage", w.people[who].token, { rows });

describe("POST /me/ai-usage (docs/ai.md §2.9)", () => {
  it("upserts each day's absolute total (idempotent), drops what isn't the caller's to report, and fills /v1/ai_usage/daily", async () => {
    const r = await post("bob", [
      { orgId: w.orgId, day: day(0), editorType: "design", credits: 12.5 },
      { orgId: w.orgId, day: day(-1), editorType: "design", credits: 3 },
      { orgId: w.orgId, day: day(-36), editorType: "design", credits: 1 }, // too old
      { orgId: w.orgId, day: day(2), editorType: "design", credits: 1 }, // the future
      { orgId: w.orgId, day: day(0), editorType: "notepad", credits: 1 },
      { orgId: w.orgId, day: day(0), editorType: "design", credits: -1 },
      { orgId: "orgNotMine000001", day: day(0), editorType: "design", credits: 1 },
      "nonsense",
    ]);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ accepted: 2, dropped: 6 });
    // The same totals again change nothing; a bigger total replaces (never adds)
    await post("bob", [{ orgId: w.orgId, day: day(0), editorType: "design", credits: 12.5 }]);
    await post("bob", [{ orgId: w.orgId, day: day(0), editorType: "design", credits: 20 }]);
    const rows = await w.rows(`SELECT user_id, day, editor_type, seat_credits, plan_credits, workspace_id FROM ai_usage_daily ORDER BY day`);
    expect(rows).toEqual([
      { user_id: w.people.bob.id, day: day(-1), editor_type: "design", seat_credits: 3, plan_credits: 0, workspace_id: "wsProduct0000001" },
      { user_id: w.people.bob.id, day: day(0), editor_type: "design", seat_credits: 20, plan_credits: 0, workspace_id: "wsProduct0000001" },
    ]);
    // A guest reports too; someone outside the org doesn't
    expect((await post("gus", [{ orgId: w.orgId, day: day(0), editorType: "design", credits: 2 }])).body).toEqual({ accepted: 1, dropped: 0 });
    expect((await post("olga", [{ orgId: w.orgId, day: day(0), editorType: "design", credits: 2 }])).body).toEqual({ accepted: 0, dropped: 1 });
    // The REST API reads them (plan tokens)
    const plan = await w.planToken(["org:ai_metering_usage_read"]);
    const usage = (await w.rest("GET", `/v1/ai_usage/daily?start_date=${day(-5)}&end_date=${day(0)}`, plan)).body;
    expect(usage.rows.map((x: { user_email: string; day: string; seat_credits_sum: number }) => [x.user_email, x.day, x.seat_credits_sum]).sort()).toEqual([
      ["bob@x.co", day(-1), 3],
      ["bob@x.co", day(0), 20],
      ["gus@x.co", day(0), 2],
    ]);
  });

  it("refuses bad bodies, personal access tokens and too many calls", async () => {
    expect((await w.call("POST", "/me/ai-usage", w.people.bob.token, { rows: "x" })).status).toBe(400);
    expect((await w.call("POST", "/me/ai-usage", w.people.bob.token, { rows: Array.from({ length: 201 }, () => ({})) })).status).toBe(413);
    expect((await w.call("GET", "/me/ai-usage", w.people.bob.token)).status).toBe(405);
    expect((await w.call("POST", "/me/ai-usage", undefined, { rows: [] })).status).toBe(401);
    const pat = await w.pat("bob", ["current_user:read"]);
    expect((await w.call("POST", "/me/ai-usage", pat, { rows: [] })).status).not.toBe(200);
    for (let i = 0; i < AI_CALLS_PER_HOUR; i++) expect((await post("tara", [])).status).toBe(200);
    expect((await post("tara", [])).status).toBe(429);
    w.now.t += 3_600_000;
    expect((await post("tara", [])).status).toBe(200);
  });
});

describe("Admin › Settings › AI (docs/ai.md §2.12)", () => {
  it("patches aiEnabled and aiCreditLimit, checks them, and logs the change", async () => {
    const path = `/orgs/${w.orgId}/admin/settings`;
    const s = await w.call("PATCH", path, w.people.alice.token, { aiEnabled: false, aiCreditLimit: 1000 });
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ aiEnabled: false, aiCreditLimit: 1000 });
    expect((await w.call("PATCH", path, w.people.alice.token, { aiCreditLimit: -1 })).status).toBe(400);
    expect((await w.call("PATCH", path, w.people.alice.token, { aiCreditLimit: 1.5 })).status).toBe(400);
    expect((await w.call("PATCH", path, w.people.alice.token, { aiEnabled: "yes" })).status).toBe(400);
    expect((await w.call("PATCH", path, w.people.alice.token, { aiCreditLimit: null })).body.aiCreditLimit).toBeNull();
    expect((await w.call("PATCH", path, w.people.bob.token, { aiEnabled: true })).status).toBe(403);
    // Everyone in the org reads them (OrgInfo.settings)
    expect((await w.call("GET", `/orgs/${w.orgId}`, w.people.bob.token)).body.org.settings).toMatchObject({ aiEnabled: false, aiCreditLimit: null });
    const logs = await w.rows(`SELECT action, details FROM activity_log WHERE action = 'org_ai_setting_change' ORDER BY id`);
    expect(logs).toHaveLength(2);
    expect(JSON.parse(logs[1].details as string)).toMatchObject({ setting: "aiCreditLimit", from: 1000, to: null });
  });
});
