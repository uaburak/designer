// @vitest-environment happy-dom
/**
 * The Library analytics modal (docs/data.md §17, docs/research/figma/R22-library-analytics.md) on the browser's
 * MemoryStore against the real server's handler (src/store/libraries/fake/real.ts) after the daily roll-up:
 * Overview (Teams using the library, the totals, Activity this week, the asset lists), Analytics (Type, Duration,
 * the insertions graph and Compare with, Top teams, the sortable table, Download CSV only above five teams), a
 * component set's usage view (Total, Used by, Used in, its variants from the CSV, the files), the Modes tab — and the
 * pure parts (weeks, sorting, CSV).
 */
import { createHash } from "node:crypto";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeMessage, newDocumentMessage } from "@shared/schema/codec";
import { $, $$, click, mount, type Mounted } from "@/ds/__tests__/dom";
import { MemoryStore } from "@/store/memory/memoryStore";
import { LibraryAnalyticsModal } from "../analytics";
import { canDownloadCsv, topTeamsOf, COLUMNS, graphWeeks, parseCsv, sortRows, variantsFromCsv, weekOf } from "../analytics/model";

const SERVER = "https://lib.test";
const ORG = "Org0000000000001";
const FOLDER = "Fold000000000001";
const hex = (s: string) => createHash("sha1").update(s).digest("hex");

interface D1 {
  prepare(sql: string): { bind(...a: unknown[]): { run(): Promise<unknown> } };
}
interface RealLibraryServer {
  clock: number;
  d1: D1;
  addUser(email: string, name?: string): Promise<{ user: { id: string; email: string }; token: string }>;
  addOrg(orgId: string, members: string[]): Promise<void>;
  addTeam(teamId: string, members: string[]): Promise<void>;
  addFile(key: string, f: { orgId: string; teamId?: string | null; projectId?: string | null; name?: string; editors?: string[] }): Promise<void>;
  fetch: typeof fetch;
}
const REAL = "../../../../store/libraries/fake/real";
const ROLLUP = "../../../../../server/src/analytics/rollup";

let m: Mounted | null = null;
const stores: MemoryStore[] = [];
afterEach(() => {
  m?.unmount();
  m = null;
  document.body.innerHTML = "";
  for (const s of stores.splice(0)) s.dispose();
  vi.unstubAllGlobals();
});

const settle = (ms = 40) => act(async () => new Promise((r) => setTimeout(r, ms)));
const settleLong = async () => {
  for (let i = 0; i < 6; i++) await settle();
};
const tab = (label: string) => $$('[role="tab"]').find((t) => t.querySelector("span > span")?.textContent === label)!;
async function choose(comboLabel: string, option: string) {
  const combo = $$('[role="combobox"]').find((el) => el.getAttribute("aria-label") === comboLabel)!;
  expect(combo, comboLabel).toBeTruthy();
  click(combo);
  await settle(10);
  click($$('[role="option"]').find((o) => o.textContent?.trim() === option)!);
  await settleLong();
}
const cells = (row: Element) => [...row.querySelectorAll("td")].map((td) => td.textContent);

const KEYS = { button: hex("button"), toggle: hex("toggle"), on: hex("toggle/on"), off: hex("toggle/off"), red: hex("red"), theme: hex("theme"), brand: hex("brand") };
const MODES = { light: { sessionID: 1048577, localID: 20 }, dark: { sessionID: 1048577, localID: 21 } };

const node = (fields: Record<string, unknown>) => encodeMessage({ type: "NODE_CHANGES", sessionID: 0, ackID: 0, nodeChanges: [{ guid: { sessionID: 1048577, localID: 1 }, phase: "CREATED", ...fields }], blobs: [] } as never);
const asset = (key: string, kind: string, name: string, extra: Record<string, unknown> = {}, payload = node({ type: kind === "STYLE" ? "RECTANGLE" : "SYMBOL", name })) => ({ key, kind: kind as "COMPONENT", name, description: name === "Button" ? "The primary action" : "", guid: "1048577:1", versionHash: hex(`${key}@1`), dependencyOnly: false, dependencies: [], payload, ...extra });

async function world(teams: number) {
  const srv = new ((await import(/* @vite-ignore */ REAL)) as { RealLibraryServer: new () => RealLibraryServer }).RealLibraryServer();
  const alice = await srv.addUser("alice@x.test");
  await srv.addOrg(ORG, [alice.user.id]);
  const teamIds = Array.from({ length: teams }, (_, i) => `Team00000000000${i + 1}`.slice(-16));
  for (const t of teamIds) await srv.addTeam(t, [alice.user.id]);
  await srv.addFile("libf_A", { orgId: ORG, teamId: teamIds[0], projectId: FOLDER, name: "Design System", editors: [alice.user.id] });
  await srv.addFile("libf_C", { orgId: ORG, teamId: teamIds[0], projectId: FOLDER, name: "Icons", editors: [alice.user.id] });
  for (const [i, t] of teamIds.entries()) await srv.addFile(`appf_${i}`, { orgId: ORG, teamId: t, projectId: `Fold00000000000${i + 2}`.slice(-16), name: `App ${i + 1}`, editors: [alice.user.id] });
  vi.stubGlobal("fetch", srv.fetch);
  const store = await MemoryStore.open({ teamName: "Alice's team" });
  stores.push(store);
  const api = store.api();
  await api.multiplayer.setSession({ server: SERVER, token: alice.token });
  const space = (key: string) => ({ orgId: ORG, key, teamId: teamIds[0], projectId: FOLDER });
  await store.addFile({ name: "Design System", folderId: null, snapshot: encodeMessage(newDocumentMessage()), space: space("libf_A") });
  await store.addFile({ name: "Icons", folderId: null, snapshot: encodeMessage(newDocumentMessage()), space: space("libf_C") });
  const theme = node({ type: "VARIABLE_SET", name: "Theme", variableSetModes: [{ id: MODES.light, name: "Light", sortPosition: "a" }, { id: MODES.dark, name: "Dark", sortPosition: "b" }] });
  await api.libraries.publish({
    libraryFileKey: "libf_A",
    description: "",
    moves: [],
    assets: [
      asset(KEYS.button, "COMPONENT", "Button"),
      asset(KEYS.toggle, "COMPONENT_SET", "Toggle"),
      asset(KEYS.on, "COMPONENT", "State=On", { componentSetKey: KEYS.toggle }),
      asset(KEYS.off, "COMPONENT", "State=Off", { componentSetKey: KEYS.toggle }),
      asset(KEYS.red, "STYLE", "Red", { styleType: "FILL" }),
      asset(KEYS.theme, "VARIABLE_COLLECTION", "Theme", {}, theme),
      asset(KEYS.brand, "VARIABLE", "Brand", { resolvedType: "COLOR", collectionKey: KEYS.theme }),
    ] as never,
  });
  await api.libraries.publish({ libraryFileKey: "libf_C", description: "", moves: [], assets: [asset(hex("heart"), "COMPONENT", "Heart")] as never });
  const sql = (q: string, ...a: unknown[]) => srv.d1.prepare(q).bind(...a).run();
  // Insertions over two weeks in every team's app (Button more in the first team), a detach; Icons for comparing
  for (const [i, t] of teamIds.entries()) {
    await sql(`INSERT INTO library_actions_daily VALUES ('2026-10-06', 'libf_A', ?1, 'component', ?2, ?3, NULL, 'insert', ?4)`, KEYS.button, `appf_${i}`, t, i === 0 ? 10 : 2);
    await sql(`INSERT INTO library_actions_daily VALUES ('2026-10-09', 'libf_A', ?1, 'component', ?2, ?3, NULL, 'insert', 1)`, KEYS.on, `appf_${i}`, t);
    await sql(`INSERT INTO library_usage VALUES (?1, 'libf_A', ?2, 'component', 3)`, `appf_${i}`, KEYS.button);
    await sql(`INSERT INTO library_usage VALUES (?1, 'libf_A', ?2, 'component', 1)`, `appf_${i}`, KEYS.on);
  }
  await sql(`INSERT INTO library_actions_daily VALUES ('2026-10-09', 'libf_A', ?1, 'component', 'appf_0', ?2, NULL, 'detach', 1)`, KEYS.button, teamIds[0]);
  await sql(`INSERT INTO library_actions_daily VALUES ('2026-10-07', 'libf_C', ?1, 'component', 'appf_0', ?2, NULL, 'insert', 4)`, hex("heart"), teamIds[0]);
  await sql(`INSERT INTO library_usage VALUES ('appf_0', 'libf_A', ?1, 'mode', 5)`, `${KEYS.theme}/1048577:21`);
  const { rollup } = (await import(/* @vite-ignore */ ROLLUP)) as { rollup: (d1: D1, now: number) => Promise<unknown> };
  await rollup(srv.d1, srv.clock);
  return { api, srv };
}

async function open(teams: number) {
  const { api } = await world(teams);
  let closed = 0;
  m = mount(LibraryAnalyticsModal, { store: { analytics: api.analytics, orgLibraries: api.orgLibraries }, libraryKey: "libf_A", name: "Design System", orgId: ORG, onClose: () => closed++, today: "2026-10-11" });
  await settleLong();
  return { api, closed: () => closed };
}

describe("Library analytics (docs/data.md §17)", () => {
  it("Overview: teams using the library, totals, Activity this week, components / styles / collections", async () => {
    await open(2);
    const dialog = $('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Library analytics");
    expect($("[data-library-name]")?.textContent).toBe("Design System");
    const stat = (id: string) => $(`[data-stat='${id}']`)!.textContent;
    expect(stat("teams")).toBe("Teams using the library2");
    expect(stat("components")).toBe("Total components4"); // Button, Toggle and its two variants (§9's counts)
    expect(stat("styles")).toBe("Total styles1");
    expect(stat("variables")).toBe("Total variables1");
    expect(stat("week")).toContain("insertions");
    expect($$("section[aria-label='Components'] [data-asset]").map((e) => e.getAttribute("data-asset"))).toEqual(["Button", "Toggle"]);
    expect($("section[aria-label='Styles'] [data-asset='Red']")).toBeTruthy();
    expect($("section[aria-label='Variable collections'] [data-collection='Theme']")?.textContent).toContain("1 variable");
    expect(dialog.textContent).toContain("Updated daily");
  });

  it("Analytics: graph, Compare with, Top teams, the sortable table; Download CSV as soon as a team is listed (atlas 12 §8.3)", async () => {
    await open(2);
    click(tab("Analytics"));
    await settleLong();
    expect($("[data-insertions-graph]")).toBeTruthy();
    expect($$("[data-legend]").map((e) => e.getAttribute("data-legend"))).toEqual(["current"]); // data through Saturday Oct 10: the week is complete
    expect($$("path[data-line]").length).toBeGreaterThan(0);
    expect($("[data-download-csv]")).toBeTruthy();
    // Top teams: insertions and share
    const teams = $$("section[aria-label='Top teams'] [data-team]");
    expect(teams).toHaveLength(2);
    expect(teams[0].textContent).toContain("11 insertions");
    // Table: Name, Variants, Instances, Inserts, Detaches; sets and components outside sets
    const table = $("[data-stats-table='component']")!;
    expect($$("th", table).map((th) => th.textContent)).toEqual(["Name", "Variants", "Instances", "Inserts ↓", "Detaches"]);
    expect($$("tbody tr", table).map((r) => r.getAttribute("data-row"))).toEqual(["Button", "Toggle"]);
    expect(cells($("tr[data-row='Button']", table)!)).toEqual(["Button", "0", "6", "12", "1"]);
    // Sort by Name: ascending, then descending
    click($$("th button", table).find((b) => b.textContent === "Name")!);
    await settle();
    expect($$("tbody tr", table).map((r) => r.getAttribute("data-row"))).toEqual(["Button", "Toggle"]);
    click($$("th button", table).find((b) => b.textContent?.startsWith("Name"))!);
    await settle();
    expect($$("tbody tr", table).map((r) => r.getAttribute("data-row"))).toEqual(["Toggle", "Button"]);
    // Compare with another library of the org: its line and legend
    await choose("Compare with", "Icons");
    expect($("[data-legend='compare']")?.textContent).toBe("Icons");
    expect($$("path[data-line='compare']").length).toBeGreaterThan(0);
    // Duration and Type
    await choose("Duration", "Last year");
    await choose("Type", "Styles");
    expect($$("[data-stats-table='style'] th").map((th) => th.textContent)).toEqual(["Name", "Instances", "Inserts ↓", "Detaches"]);
  });

  it("Variables: the Modes tab lists mode, collection and instances", async () => {
    await open(2);
    click(tab("Analytics"));
    await settleLong();
    await choose("Type", "Variables");
    expect($$("[data-stats-table='variable'] th").map((th) => th.textContent)).toEqual(["Name", "Collection", "Instances", "Inserts ↓", "Detaches"]);
    click(tab("Modes"));
    await settleLong();
    const row = $("[data-modes-table] tr[data-mode='Dark']")!;
    expect(cells(row)).toEqual(["Dark", "Theme", "5"]);
  });

  it("a component set's usage view: Total, Used by, Used in, its variants (one opens), the files", async () => {
    await open(2);
    click($("section[aria-label='Components'] [data-asset='Toggle']")!);
    await settleLong();
    const view = $("[data-usage-view='Toggle']")!;
    expect($("[data-stat='total']", view)?.textContent).toBe("Total2 instances");
    expect($("[data-stat='used-by']", view)?.textContent).toBe("Used by2 teams");
    expect($("[data-stat='used-in']", view)?.textContent).toBe("Used in2 files");
    expect($$("[data-variants-table] tr[data-variant]", view).map((r) => r.getAttribute("data-variant")).sort()).toEqual(["State=Off", "State=On"]);
    expect($$("[data-files-table] tbody tr", view)).toHaveLength(2);
    click($("[data-variant='State=On']", view)!);
    await settleLong();
    expect($("[data-usage-view='State=On']")).toBeTruthy();
    click($('[aria-label="Back"]')!);
    await settleLong();
    expect($("[data-usage-view='Toggle']")).toBeTruthy();
    click($('[aria-label="Back"]')!);
    await settleLong();
    expect($("[data-analytics-overview]")).toBeTruthy();
    // Button's description
    click($("section[aria-label='Components'] [data-asset='Button']")!);
    await settleLong();
    expect($("[data-usage-view='Button']")?.textContent).toContain("The primary action");
  });

  it("Download CSV appears above five teams and saves Figma's columns", async () => {
    const { api } = await open(6);
    click(tab("Analytics"));
    await settleLong();
    const saved: string[] = [];
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: (b: Blob) => (void b.text().then((t) => saved.push(t)), "blob:x"), revokeObjectURL: () => {} }));
    click($("[data-download-csv]")!);
    await settleLong();
    expect(saved[0]?.split("\n")[0]).toContain("component_key,component_name,component_set_key,component_set_name");
    expect(await api.analytics.csv("libf_A", { type: "component", range: 30 })).toContain("State=On");
  });
});

describe("Library analytics' pure parts", () => {
  it("weeks: Sundays, zero-filled to the current week, the data's last week incomplete, early weeks unavailable for styles", () => {
    expect(weekOf("2026-10-10")).toBe("2026-10-04");
    const w = graphWeeks("component", [{ week: "2026-09-27", insertions: 3, detachments: 0 }, { week: "2026-10-04", insertions: 5, detachments: 1 }], null, "2026-10-08", "2026-10-15");
    expect(w.map((x) => [x.week, x.insertions, x.incomplete])).toEqual([
      ["2026-09-27", 3, false],
      ["2026-10-04", 5, true],
      ["2026-10-11", null, false],
    ]);
    expect(graphWeeks("component", [{ week: "2026-10-04", insertions: 5, detachments: 0 }], null, "2026-10-10", "2026-10-10")[0].incomplete).toBe(false);
    expect(graphWeeks("style", [{ week: "2024-09-29", insertions: 0, detachments: 0 }], null, "2024-10-05", "2024-10-05")[0].unavailable).toBe(true);
    expect(graphWeeks("component", [{ week: "2024-09-29", insertions: 0, detachments: 0 }], null, "2024-10-05", "2024-10-05")[0].unavailable).toBe(false);
  });

  it("CSV whenever a team is listed; sorting by a column, ties by name; the CSV parsed into variants", () => {
    expect([0, 1, 6].map(canDownloadCsv)).toEqual([false, true, true]);
    expect(topTeamsOf([0, 3, 9, 1, 4, 2, 7, 5].map((insertions, i) => ({ teamId: String(i), insertions }))).map((r) => r.insertions)).toEqual([9, 7, 5, 4, 3, 2]);
    const rows = [
      { key: "a", name: "B", type: "component" as const, description: "", instances: 1, insertions: 2, detachments: 0, teamsUsing: 0, filesUsing: 0 },
      { key: "b", name: "A", type: "component" as const, description: "", instances: 1, insertions: 2, detachments: 0, teamsUsing: 0, filesUsing: 0 },
      { key: "c", name: "C", type: "component" as const, description: "", instances: 9, insertions: 1, detachments: 0, teamsUsing: 0, filesUsing: 0 },
    ];
    const inserts = COLUMNS.component.find((c) => c.id === "inserts")!;
    expect(sortRows(rows, inserts, "desc").map((r) => r.name)).toEqual(["A", "B", "C"]);
    expect(sortRows(rows, inserts, "asc").map((r) => r.name)).toEqual(["C", "A", "B"]);
    const csv = 'component_key,component_name,component_set_key,component_set_name,instances,insertions,detachments,teams_using,files_using\nk1,"Size=Small, On",s,Toggle,3,2,1,1,2\nk2,Other,,,1,1,0,1,1\n';
    expect(parseCsv(csv)[0].component_name).toBe("Size=Small, On");
    expect(variantsFromCsv(csv, "s").map((v) => [v.name, v.instances, v.insertions])).toEqual([["Size=Small, On", 3, 2]]);
  });
});
