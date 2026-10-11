import { beforeEach, describe, expect, it } from "vitest";
import { assetKey, BRAND, DRAFT, LIB, P2, publish, T2, T3, WEB, world, type Any, type TestAsset, type World } from "../testing/orgWorld";
import { CALLS_PER_HOUR } from "./ingest";
import { lastWholeWeek, rollup, weekOf } from "./rollup";

let w: World;
const DAY = 86_400_000;

const SET: TestAsset = { key: assetKey("Button"), kind: "COMPONENT_SET", name: "Button", seed: "set" };
const PRIMARY: TestAsset = { key: assetKey("Button/Primary"), kind: "COMPONENT", name: "Type=Primary", seed: "p", componentSetKey: SET.key };
const GHOST: TestAsset = { key: assetKey("Button/Ghost"), kind: "COMPONENT", name: "Type=Ghost", seed: "g", componentSetKey: SET.key };
const ICON: TestAsset = { key: assetKey("Icon"), kind: "COMPONENT", name: "Icon", seed: "i" };
const H1: TestAsset = { key: assetKey("H1"), kind: "STYLE", name: "Heading 1", seed: "h1" };
const COLORS: TestAsset = { key: assetKey("Colors"), kind: "VARIABLE_COLLECTION", name: "Colors", seed: "c" };
const BRANDV: TestAsset = { key: assetKey("Brand"), kind: "VARIABLE", name: "Brand", seed: "b", collectionKey: COLORS.key };

beforeEach(async () => {
  w = await world();
  await publish(w, LIB, w.people.alice.token, [SET, PRIMARY, GHOST, ICON, H1, COLORS, BRANDV], { scope: "org", collections: [{ collectionKey: COLORS.key, name: "Colors", modes: [{ id: "1:0", name: "Light" }, { id: "1:1", name: "Dark" }] }] });
  // The Brand board (T3) becomes a design file Carol can edit, so two teams report
  await w.run(`UPDATE files SET editor_type = 'design' WHERE key = ?1`, BRAND);
  await w.run(`INSERT INTO team_members (team_id, email, user_id, role, created_at) VALUES (?1, 'carol@x.co', ?2, 'editor', 0)`, T3, w.people.carol.id);
});

const day = (offset: number) => new Date(w.now.t + offset * DAY).toISOString().slice(0, 10);
const ev = (file: string, asset: string, type: string, action: string, count: number, d = day(0)) => ({ day: d, file, library: LIB, asset, type, action, count });
const post = (who: keyof World["people"], events: unknown[]) => w.call("POST", "/analytics/library-events", w.people[who].token, { events });

describe("ingestion (§17.5)", () => {
  it("keeps what editable org files report, sums repeats, drops the rest", async () => {
    const r = await post("carol", [
      ev(WEB, PRIMARY.key, "component", "insert", 3),
      ev(WEB, PRIMARY.key, "component", "insert", 2),
      ev(WEB, H1.key, "style", "detach", 1, day(-7)),
      ev(WEB, ICON.key, "component", "insert", 1, day(-8)), // too old
      ev(WEB, ICON.key, "component", "insert", 1, day(1)), // the future
      ev(WEB, ICON.key, "component", "insert", 0), // count
      ev(WEB, ICON.key, "component", "insert", 10_001),
      ev(DRAFT, ICON.key, "component", "insert", 1), // a draft (and not Carol's)
      ev(LIB, ICON.key, "component", "insert", 1), // not editable by Carol
      { ...ev(WEB, ICON.key, "component", "insert", 1), library: "lib_other99" }, // not an org library
      { ...ev(WEB, ICON.key, "component", "paste", 1) },
    ]);
    expect(r.body).toEqual({ accepted: 3, dropped: 8 });
    const rows = await w.rows(`SELECT day, asset_key, file_key, team_id, workspace_id, action, count FROM library_actions_daily ORDER BY asset_key`);
    expect(rows).toHaveLength(2);
    expect(rows.find((x) => x.asset_key === PRIMARY.key)).toMatchObject({ file_key: WEB, team_id: T2, action: "insert", count: 5 });
    // A second batch adds up (count = count + excluded.count)
    await post("carol", [ev(WEB, PRIMARY.key, "component", "insert", 4)]);
    expect((await w.rows(`SELECT count FROM library_actions_daily WHERE asset_key = ?1`, PRIMARY.key))[0].count).toBe(9);
    // Bob's own draft doesn't report either (drafts skipped, §17.2), nor a branch
    expect((await post("bob", [ev(DRAFT, ICON.key, "component", "insert", 1)])).body).toEqual({ accepted: 0, dropped: 1 });
    await w.run(`INSERT INTO files (key, owner_id, name, created_at, updated_at, org_id, team_id, project_id) VALUES ('branch_web1', ?1, 'B', 0, 0, ?2, ?3, ?4)`, w.people.carol.id, w.orgId, T2, P2);
    await w.run(`INSERT INTO branches (key, main_key, name, created_by, created_at, base_seq, main_seen_seq, session_base) VALUES ('branch_web1', ?1, 'B', ?2, 0, 0, 0, 0)`, WEB, w.people.carol.id);
    expect((await post("carol", [ev("branch_web1", ICON.key, "component", "insert", 1)])).body.accepted).toBe(0);
  });

  it("is rate-limited per person and stores no person", async () => {
    for (let i = 0; i < CALLS_PER_HOUR; i++) expect((await post("tara", [])).status).toBe(200);
    const r = await post("tara", []);
    expect(r.status).toBe(429);
    expect(r.body.code).toBe("rate_limited");
    w.now.t += 3_600_000;
    expect((await post("tara", [])).status).toBe(200);
    const cols = (await w.rows(`SELECT name FROM pragma_table_info('library_actions_daily')`)).map((c) => c.name);
    expect(cols.some((c) => /user|actor|ip/.test(c))).toBe(false);
  });

  it("replaces a file's instance snapshot unless its hash is unchanged", async () => {
    const snap = { hash: "h1", assets: [{ library: LIB, asset: PRIMARY.key, type: "component", instances: 4 }, { library: LIB, asset: PRIMARY.key, type: "component", instances: 1 }], modes: [{ library: LIB, collection: COLORS.key, mode: "1:1", instances: 2 }] };
    expect((await w.call("PUT", `/files/${WEB}/library-usage`, w.people.carol.token, snap)).status).toBe(204);
    expect(await w.rows(`SELECT asset_key, asset_type, instances FROM library_usage ORDER BY asset_type`)).toEqual([
      { asset_key: PRIMARY.key, asset_type: "component", instances: 5 },
      { asset_key: `${COLORS.key}/1:1`, asset_type: "mode", instances: 2 },
    ]);
    await w.run(`UPDATE library_usage SET instances = 99`);
    expect((await w.call("PUT", `/files/${WEB}/library-usage`, w.people.carol.token, snap)).status).toBe(204);
    expect((await w.rows(`SELECT instances FROM library_usage`))[0].instances).toBe(99); // unchanged hash: nothing done
    expect((await w.call("PUT", `/files/${WEB}/library-usage`, w.people.carol.token, { ...snap, hash: "h2", modes: [] })).status).toBe(204);
    expect(await w.rows(`SELECT instances FROM library_usage`)).toEqual([{ instances: 5 }]);
    expect((await w.call("PUT", `/files/${DRAFT}/library-usage`, w.people.bob.token, snap)).status).toBe(403);
    expect((await w.call("PUT", `/files/${WEB}/library-usage`, w.people.dan.token, snap)).status).toBe(404);
  });
});

describe("the daily roll-up and the views (§17.5, §17.6)", () => {
  async function seed() {
    // Web (T2, closed to the org) and the Brand board (T3, open to the org) use the library
    await w.run(`UPDATE teams SET org_access = 'viewer' WHERE id = ?1`, T3);
    await post("carol", [ev(WEB, PRIMARY.key, "component", "insert", 5, day(-1)), ev(WEB, GHOST.key, "component", "insert", 2, day(-3)), ev(WEB, PRIMARY.key, "component", "detach", 1, day(-2)), ev(BRAND, ICON.key, "component", "insert", 4, day(-1)), ev(BRAND, H1.key, "style", "insert", 7, day(-1)), ev(BRAND, BRANDV.key, "variable", "insert", 2, day(-2))]);
    // Older weeks, written straight (the route only takes the last seven days)
    await w.run(`INSERT INTO library_actions_daily (day, library_key, asset_key, asset_type, file_key, team_id, action, count) VALUES (?1, ?2, ?3, 'component', ?4, ?5, 'insert', 10)`, day(-20), LIB, ICON.key, WEB, T2);
    await w.run(`INSERT INTO library_actions_daily (day, library_key, asset_key, asset_type, file_key, team_id, action, count) VALUES (?1, ?2, ?3, 'component', ?4, ?5, 'insert', 1)`, day(-400), LIB, ICON.key, WEB, T2);
    await w.call("PUT", `/files/${WEB}/library-usage`, w.people.carol.token, { hash: "a", assets: [{ library: LIB, asset: PRIMARY.key, type: "component", instances: 3 }, { library: LIB, asset: GHOST.key, type: "component", instances: 1 }], modes: [{ library: LIB, collection: COLORS.key, mode: "1:1", instances: 6 }] });
    await w.call("PUT", `/files/${BRAND}/library-usage`, w.people.carol.token, { hash: "b", assets: [{ library: LIB, asset: PRIMARY.key, type: "component", instances: 2 }, { library: LIB, asset: H1.key, type: "style", instances: 8 }], modes: [{ library: LIB, collection: COLORS.key, mode: "1:0", instances: 1 }] });
    await w.run(`INSERT INTO activity_log (org_id, at, action, entity_type, entity_id) VALUES (?1, ?2, 'fig_file_view', 'file', 'x')`, w.orgId, w.now.t - 400 * DAY);
    return rollup(w.d1, w.now.t);
  }

  it("rolls up instances, files, teams and actions; sweeps old rows", async () => {
    const { day: D } = await seed();
    expect(D).toBe(day(-1));
    const stats = await w.rows(`SELECT asset_key, instances, files_using, teams_using, inserts_30d, detaches_30d FROM library_asset_stats`);
    const of = (k: string) => stats.find((s) => s.asset_key === k);
    expect(of(PRIMARY.key)).toMatchObject({ instances: 5, files_using: 2, teams_using: 2, inserts_30d: 5, detaches_30d: 1 });
    expect(of(SET.key)).toMatchObject({ instances: 6, files_using: 2, teams_using: 2, inserts_30d: 7, detaches_30d: 1 }); // its variants
    expect(of(ICON.key)).toMatchObject({ instances: 0, inserts_30d: 14 });
    expect(of(H1.key)).toMatchObject({ instances: 8, files_using: 1 });
    const lib = (await w.rows(`SELECT * FROM library_stats`))[0];
    const [ws, we] = lastWholeWeek(D);
    const inWeek = (d: string) => d >= ws && d <= we;
    expect(lib).toMatchObject({ library_key: LIB, teams_using: 2, through_day: D, inserts_this_week: 5 + 2 + 4 + 7 + 2, detaches_this_week: 1 });
    expect(lib.inserts_last_week).toBe([[day(-1), 16], [day(-2), 2], [day(-3), 2], [day(-20), 10]].filter(([d]) => inWeek(d as string)).reduce((n, [, c]) => n + (c as number), 0));
    // Retention: actions older than 53 weeks, the activity log older than a year
    expect((await w.rows(`SELECT COUNT(*) AS n FROM library_actions_daily WHERE day = ?1`, day(-400)))[0].n).toBe(0);
    expect((await w.rows(`SELECT COUNT(*) AS n FROM activity_log WHERE entity_id = 'x'`))[0].n).toBe(0);
  });

  it("serves the views, with files and teams the caller can't see named as not visible", async () => {
    const { day: D } = await seed();
    const bob = w.people.bob.token; // in T1 only: T2 is closed to him, T3 is open to the org
    const overview = (await w.call("GET", `/libraries/${LIB}/analytics/overview`, bob)).body;
    expect(overview).toMatchObject({ libraryKey: LIB, teamsUsing: 2, counts: { components: 4, styles: 1, variables: 1 }, throughDay: D });
    expect(overview.rows.map((r: Any) => [r.name, r.type, r.instances])).toEqual([
      ["Brand", "variable", 0],
      ["Button", "component", 6],
      ["Heading 1", "style", 8],
      ["Icon", "component", 0],
    ]);
    expect(overview.rows.find((r: Any) => r.name === "Button").variants).toBe(2);
    expect(overview.rows.find((r: Any) => r.name === "Brand")).toMatchObject({ collectionName: "Colors", insertions: 2 });

    const actions = (await w.call("GET", `/libraries/${LIB}/analytics/actions?type=component&range=30`, bob)).body;
    expect(actions.series.at(-1).week).toBe(weekOf(D));
    expect(actions.series.every((s: Any, i: number, all: Any[]) => i === 0 || Date.parse(s.week) - Date.parse(all[i - 1].week) === 7 * DAY)).toBe(true);
    expect(actions.series.reduce((n: number, s: Any) => n + s.insertions, 0)).toBe(5 + 2 + 4 + 10);
    expect(actions.topTeams).toEqual([
      { teamId: null, teamName: "Team not visible", workspaceName: null, insertions: 17, detachments: 1, share: 17 / 21 },
      { teamId: T3, teamName: "Brand", workspaceName: null, insertions: 4, detachments: 0, share: 4 / 21 },
    ]);
    expect(actions.rows.find((r: Any) => r.name === "Icon").insertions).toBe(14);

    const usage = (await w.call("GET", `/libraries/${LIB}/analytics/usage/${SET.key}`, bob)).body;
    expect(usage.row.instances).toBe(6);
    expect(usage.files).toEqual([
      { fileKey: null, fileName: "File not visible", teamName: null, workspaceName: null, instances: 4, lastModified: null },
      { fileKey: BRAND, fileName: "Brand board", teamName: "Brand", workspaceName: null, instances: 2, lastModified: expect.any(Number) },
    ]);
    // Carol is in T2: she sees her own team's file
    expect((await w.call("GET", `/libraries/${LIB}/analytics/usage/${SET.key}`, w.people.carol.token)).body.files[0]).toMatchObject({ fileKey: WEB, fileName: "Website", teamName: "Web" });

    const modes = (await w.call("GET", `/libraries/${LIB}/analytics/modes`, bob)).body.modes;
    expect(modes).toEqual([
      { collectionKey: COLORS.key, collectionName: "Colors", modeId: "1:1", modeName: "Dark", instances: 6 },
      { collectionKey: COLORS.key, collectionName: "Colors", modeId: "1:0", modeName: "Light", instances: 1 },
    ]);

    const text = (await w.call("GET", `/libraries/${LIB}/analytics/csv?type=component&range=90`, bob)).body as string;
    const lines = text.trim().split("\n");
    expect(lines[0]).toBe("component_key,component_name,component_set_key,component_set_name,instances,insertions,detachments,teams_using,files_using");
    expect(lines.find((l) => l.startsWith(PRIMARY.key))).toBe(`${PRIMARY.key},Type=Primary,${SET.key},Button,5,5,1,2,2`);
    expect((await w.call("GET", `/libraries/${LIB}/analytics/csv?type=style&range=30`, bob)).body.split("\n")[0]).toBe("style_key,style_name,style_type,instances,insertions,detachments,teams_using,files_using");

    // Guests can't; people who can't view the file get 404; bad parameters 400
    expect((await w.call("GET", `/libraries/${LIB}/analytics/overview`, w.people.gus.token)).status).toBe(403);
    await w.call("PATCH", `/libraries/${LIB}`, w.people.alice.token, { scope: "team" });
    expect((await w.call("GET", `/libraries/${LIB}/analytics/overview`, w.people.dan.token)).status).toBe(404);
    expect((await w.call("GET", `/libraries/${LIB}/analytics/actions?range=7`, bob)).status).toBe(400);

    const org = (await w.call("GET", `/orgs/${w.orgId}/libraries/analytics`, w.people.alice.token)).body;
    expect(org).toMatchObject({ totals: { teams: 3, teamsWithLibraries: 1, libraries: 1, components: 4, styles: 1, variables: 1 }, libraries: [{ key: LIB, name: "Design System", teamName: "Design", components: 4 }], throughDay: D });
    expect((await w.call("GET", `/orgs/${w.orgId}/libraries/analytics?text=zzz`, w.people.alice.token)).body.libraries).toEqual([]);
    expect((await w.call("GET", `/orgs/${w.orgId}/libraries/analytics`, w.people.gus.token)).status).toBe(403);
  });
});
