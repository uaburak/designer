// @vitest-environment happy-dom
/**
 * Admin › Resources › Libraries against round 3a's real handler (src/store/libraries/fake/real.ts: server/src/api.ts on
 * node:sqlite) through the store's `orgLibrariesRepository`: what the views send is what §16.10's routes take — the
 * org approval, an org default on a team library publishing it to the org (scope and the file's link), a workspace's
 * default mode; a workspace admin sees the org's approval and can't undo it.
 */
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { $$, click, mount, type Mounted } from "@/ds/__tests__/dom";
import type { OrgLibrariesRepository } from "@shared/libraries/orgTypes";
import type { AdminRepository } from "@shared/org/repositories";
import type { OrgWorkspace } from "@shared/org/types";
import { AdminApp, type AdminAppProps } from "..";

/** The parts of the real server and the store's repository used here, loaded by computed paths so the web typecheck
 *  (tsconfig.web.json) doesn't take in the Worker's or the store's Node code; vitest runs them in Node. */
interface Stmt {
  bind(...args: unknown[]): { run(): Promise<unknown>; first<T>(): Promise<T | null> };
}
interface RealLibraryServer {
  addUser(email: string): Promise<{ user: { id: string }; token: string }>;
  addOrg(orgId: string, members: string[]): Promise<void>;
  addTeam(teamId: string, members: string[]): Promise<void>;
  addFile(key: string, f: { orgId: string; teamId?: string | null; name?: string; editors?: string[] }): Promise<void>;
  library(key: string): Promise<{ scope: string } | null>;
  orgLinkAccess(key: string): Promise<string | null>;
  d1: { prepare(sql: string): Stmt };
  fetch: typeof fetch;
}
interface LibraryServer {
  signedIn: boolean;
  userId: string | null;
  request(method: string, path: string, body?: unknown): Promise<Response>;
}
const REAL = "../../../../store/libraries/fake/real";
const REPO = "../../../../store/libraries/orgLibraries";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  document.body.innerHTML = "";
});
/** The handler answers through a few awaits (sqlite, the objects): let a write and the reloads it causes finish */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
  });
const rows = () => $$('[data-admin-table="Libraries"] [data-row]');
const toggle = (label: string) => $$('[role="switch"]').find((s) => s.getAttribute("aria-label") === label) as HTMLButtonElement;
const dialog = () => $$('[role="dialog"]').at(-1)!;
const button = (label: string, root: ParentNode = document) => $$("button", root).find((b) => b.textContent?.trim() === label)!;
async function choose(label: string, option: string) {
  click($$('[role="combobox"]').find((c) => c.getAttribute("aria-label") === label)!);
  await settle();
  click($$('[role="option"]').find((o) => o.textContent?.trim() === option)!);
  await settle();
}

async function world() {
  const Real = ((await import(/* @vite-ignore */ REAL)) as { RealLibraryServer: new () => RealLibraryServer }).RealLibraryServer;
  // The server's sqlite reads its migrations from `new URL("../../migrations/", import.meta.url)`, which the DOM
  // environment's transform turns into an http://localhost URL: for the constructor, map those back to the files.
  const NODE_URL = "node:url";
  const NodeURL = ((await import(/* @vite-ignore */ NODE_URL)) as { URL: typeof URL }).URL;
  const root = import.meta.url.slice(0, import.meta.url.indexOf("/src/renderer/src/admin/"));
  const domUrl = globalThis.URL;
  globalThis.URL = class extends NodeURL {
    constructor(url: string | URL, base?: string | URL) {
      super(url, base);
      // (the transform also drops a folder's trailing slash)
      if (this.protocol === "http:" && this.host === "localhost:3000") return new NodeURL(root + this.pathname + (/\.\w+$/.test(this.pathname) ? "" : "/"));
    }
  } as typeof URL;
  let fake: RealLibraryServer;
  try {
    fake = new Real();
  } finally {
    globalThis.URL = domUrl;
  }
  const repoOf = ((await import(/* @vite-ignore */ REPO)) as { orgLibrariesRepository: (s: LibraryServer) => OrgLibrariesRepository }).orgLibrariesRepository;
  const alice = await fake.addUser("alice@x.test");
  const bob = await fake.addUser("bob@x.test");
  const carol = await fake.addUser("carol@x.test");
  await fake.addOrg("o1", [alice.user.id, bob.user.id, carol.user.id]);
  const run = (sql: string, ...args: unknown[]) => fake.d1.prepare(sql).bind(...args).run();
  await run(`INSERT INTO workspaces (id, org_id, name, created_at, updated_at) VALUES ('ws1', 'o1', 'Design', 0, 0)`);
  await run(`INSERT INTO workspace_admins (workspace_id, user_id) VALUES ('ws1', ?1)`, bob.user.id);
  await fake.addTeam("t1", [alice.user.id]);
  await run(`UPDATE teams SET workspace_id = 'ws1', name = 'Design System' WHERE id = 't1'`);
  await fake.addTeam("t2", [carol.user.id]);
  await fake.addFile("libf_A", { orgId: "o1", teamId: "t1", name: "Core", editors: [alice.user.id] });
  await fake.addFile("libf_B", { orgId: "o1", teamId: "t2", name: "Carol's kit", editors: [carol.user.id] });
  for (const key of ["libf_A", "libf_B"]) {
    await run(`INSERT INTO libraries (key, org_id, name, scope, latest_version, counts, first_published_at, last_published_at) VALUES (?1, 'o1', ?1, 'team', 1, '{"components":3,"styles":1,"variables":2}', 0, 0)`, key);
  }
  await run(`INSERT INTO library_assets (library_key, key, kind, name, modes, version_hash) VALUES ('libf_A', 'col1', 'VARIABLE_COLLECTION', 'Colors', '[{"id":"m1","name":"Light"},{"id":"m2","name":"Dark"}]', 'h1')`);
  const repo = (who: { user: { id: string }; token: string }) =>
    repoOf({
      signedIn: true,
      userId: who.user.id,
      request: (method, path, body) => fake.fetch(new URL(path, "https://lib.test").toString(), { method, headers: { authorization: `Bearer ${who.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
    });
  const workspaces: OrgWorkspace[] = [{ id: "ws1", name: "Design", hidden: false, admins: [], defaultTeamIds: [], memberCount: 0, teamCount: 1, createdAt: 0 }];
  const admin = { workspaces: async () => workspaces } as unknown as AdminRepository;
  const setting = (scopeType: string, scopeId: string) => fake.d1.prepare(`SELECT approved, default_design, default_modes FROM library_settings WHERE library_key = 'libf_A' AND scope_type = ?1 AND scope_id = ?2`).bind(scopeType, scopeId).first<{ approved: number; default_design: number | null; default_modes: string }>();
  return { fake, alice, bob, repo, admin, setting };
}

describe("Admin › Resources › Libraries on the real server", () => {
  it("an org admin approves, enables a team library by default (published to the org), sets a workspace's default mode", async () => {
    const { fake, alice, repo, admin, setting } = await world();
    const props: AdminAppProps = { orgId: "o1", store: { admin, orgLibraries: repo(alice) }, initial: { section: "resources" } };
    m = mount(AdminApp, props);
    await settle();
    expect(rows().map((r) => r.getAttribute("data-row")).sort()).toEqual(["libf_A", "libf_B"]);
    click(rows().find((r) => r.textContent?.includes("Core"))!);
    await settle();
    click(toggle("Set as approved library"));
    await settle();
    expect((await setting("org", "o1"))!.approved).toBe(1);
    click(toggle("Design files"));
    await settle();
    expect(dialog().textContent).toContain("Publish to the organization?");
    click(button("Enable by default", dialog()));
    await settle();
    expect((await setting("org", "o1"))!.default_design).toBe(1);
    expect((await fake.library("libf_A"))!.scope).toBe("org");
    expect(await fake.orgLinkAccess("libf_A")).toBe("viewer");
    await choose("Where", "Design");
    await choose("Default mode for Colors", "Dark");
    expect(JSON.parse((await setting("workspace", "ws1"))!.default_modes)).toEqual([{ collectionKey: "col1", modeId: "m2" }]);
    click(button("Done"));
    await settle();
    // approved first, with the check mark
    expect(rows()[0].getAttribute("data-row")).toBe("libf_A");
    expect(rows()[0].querySelector("[data-approved]")).not.toBeNull();
  });

  it("a workspace admin sees the workspace's and org-shared libraries; an org approval can't be undone there", async () => {
    const { bob, alice, repo, admin } = await world();
    await repo(alice).updateSettings("o1", "libf_A", { scope: { type: "org", id: "o1" }, approved: true });
    m = mount(AdminApp, { orgId: "o1", store: { admin, orgLibraries: repo(bob) }, workspace: { id: "ws1", name: "Design" } });
    await settle();
    expect(rows().map((r) => r.getAttribute("data-row"))).toEqual(["libf_A"]);
    click(rows()[0]);
    await settle();
    expect(toggle("Set as approved library").disabled).toBe(true);
    expect(toggle("Set as approved library").getAttribute("aria-checked")).toBe("true");
    await choose("Design files", "On");
    expect((await repo(bob).get("o1", "libf_A")).defaultIn.workspaceIds).toEqual(["ws1"]);
  });
});
