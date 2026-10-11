/**
 * Dev Mode on the server (docs/editor.md D-1, D-3, D-4, D-6; round 5c): dev resources (limits, duplicates, seats),
 * Code Connect (UI and CLI mappings, links, the library's users), the status report and its notifications (who,
 * folding, the per-file switch), prototype-only access. On node:sqlite through the real handler (testing/orgWorld.ts).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { devStatusText, notificationAction } from "../../../src/shared/notifications";
import { DEV_RESOURCE_LIMIT } from "../../../src/shared/devmode/types";
import { assetKey, DRAFT, LIB, P1, publish, WEB, world, type Any, type World } from "../testing/orgWorld";
import { devModeRestRoute } from "./rest";
import { parseNodeLink } from "./codeConnect";

const ORIGIN = "https://designer.example.workers.dev";
let w: World;

beforeEach(async () => {
  w = await world();
});

const res = (key: string) => `/files/${key}/dev-resources`;
const activity = async (action: string) => (await w.rows(`SELECT details FROM activity_log WHERE action = ?1 ORDER BY id`, action)).map((r: Any) => JSON.parse(r.details));

/** A REST call to devModeRestRoute as 5a's restRoute makes it (after its scope, tier and rate checks) */
async function rest(method: string, path: string, who: { id: string }, body?: unknown): Promise<{ status: number; body: Any } | null> {
  const user = (await w.deps.db.user(who.id))!;
  const url = new URL(ORIGIN + path);
  const req = new Request(url, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body === undefined ? undefined : JSON.stringify(body) });
  const r = await devModeRestRoute(req, url, w.deps, { user, sid: null, scopes: null }, url.pathname.split("/").filter(Boolean).map(decodeURIComponent));
  if (!r) return null;
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

describe("dev resources (D-3)", () => {
  it("editors with a Full or Dev seat add, edit and delete; viewers read; ≤ 10 per node; a URL once per node", async () => {
    const { bob, gus, dan } = w.people;
    const add = await w.call("POST", res(LIB), bob.token, { nodeId: "1:2", name: "", url: "https://github.com/acme/ui/blob/main/Button.tsx" });
    expect(add.status).toBe(201);
    expect(add.body.devResource).toMatchObject({ fileKey: LIB, nodeId: "1:2", name: "github.com/acme/ui/blob/main/Button.tsx", createdBy: bob.id });
    const dup = await w.call("POST", res(LIB), bob.token, { nodeId: "1:2", name: "again", url: "https://github.com/acme/ui/blob/main/Button.tsx" });
    expect([dup.status, dup.body.error]).toEqual([409, "This link has already been added."]);
    // The same URL on another node is fine
    expect((await w.call("POST", res(LIB), bob.token, { nodeId: "1:3", name: "x", url: "https://github.com/acme/ui/blob/main/Button.tsx" })).status).toBe(201);
    for (let i = 1; i < DEV_RESOURCE_LIMIT; i++) expect((await w.call("POST", res(LIB), bob.token, { nodeId: "1:2", name: `L${i}`, url: `https://storybook.acme.dev/${i}` })).status).toBe(201);
    const over = await w.call("POST", res(LIB), bob.token, { nodeId: "1:2", name: "11", url: "https://jira.acme.dev/11" });
    expect([over.status, over.body.error]).toEqual([400, "You can add up to 10 links to a layer."]);
    expect((await w.call("POST", res(LIB), bob.token, { nodeId: "1:2", name: "bad", url: "javascript:alert(1)" })).status).toBe(400);

    // gus (a guest who can view) reads, filtered by node; can't add
    const list = await w.call("GET", `${res(LIB)}?nodeIds=1:3`, gus.token);
    expect(list.body.devResources).toHaveLength(1);
    expect((await w.call("GET", res(LIB), gus.token)).body.devResources).toHaveLength(11);
    expect((await w.call("POST", res(LIB), gus.token, { nodeId: "1:4", name: "x", url: "https://x.dev" })).status).toBe(403);

    // A Dev seat editor writes; a Collab seat editor is refused with seat_required
    await w.run(`UPDATE org_members SET seat = 'dev' WHERE user_id = ?1`, dan.id);
    await w.run(`INSERT INTO members (file_key, email, user_id, role, created_at) VALUES (?1, 'dan@x.co', ?2, 'editor', 1)`, LIB, dan.id);
    expect((await w.call("POST", res(LIB), dan.token, { nodeId: "1:4", name: "x", url: "https://x.dev" })).status).toBe(201);
    await w.run(`UPDATE org_members SET seat = 'collab' WHERE user_id = ?1`, dan.id);
    const collab = await w.call("POST", res(LIB), dan.token, { nodeId: "1:4", name: "y", url: "https://y.dev" });
    expect([collab.status, collab.body.code]).toEqual([403, "seat_required"]);

    // Edit and delete; logged for the org
    const id = add.body.devResource.id;
    const patched = await w.call("PATCH", `${res(LIB)}/${id}`, bob.token, { name: "Button source" });
    expect(patched.body.devResource).toMatchObject({ id, name: "Button source" });
    expect((await w.call("PATCH", `${res(LIB)}/${id}`, bob.token, { url: "https://storybook.acme.dev/1" })).status).toBe(409);
    expect((await w.call("DELETE", `${res(LIB)}/${id}`, bob.token)).status).toBe(204);
    expect((await w.call("DELETE", `${res(LIB)}/${id}`, bob.token)).status).toBe(404);
    expect((await activity("dev_resource_create")).length).toBe(12);
    expect(await activity("dev_resource_delete")).toEqual([expect.objectContaining({ node_id: "1:2", name: "Button source" })]);
    // Someone who can't open the file: 404
    expect((await w.call("GET", res(LIB), w.people.carol.token)).status).toBe(404);
  });

  it("REST /v1: per-item errors in the batch routes, Figma's shapes", async () => {
    const { bob, carol } = w.people;
    const created = await rest("POST", "/v1/dev_resources", bob, {
      dev_resources: [
        { name: "Storybook", url: "https://storybook.acme.dev/button", file_key: LIB, node_id: "1:2" },
        { name: "Again", url: "https://storybook.acme.dev/button", file_key: LIB, node_id: "1:2" },
        { name: "Web", url: "https://acme.dev", file_key: WEB, node_id: "1:2" },
        { name: "Nope", url: "https://acme.dev", file_key: "nofile_000", node_id: "1:2" },
      ],
    });
    expect(created!.status).toBe(200);
    expect(created!.body.links_created).toEqual([{ id: expect.any(String), name: "Storybook", url: "https://storybook.acme.dev/button", file_key: LIB, node_id: "1:2" }]);
    expect(created!.body.errors.map((e: Any) => [e.file_key, e.error])).toEqual([
      [LIB, "This link has already been added."],
      [WEB, "File not found"],
      ["nofile_000", "File not found"],
    ]);
    const id = created!.body.links_created[0].id;
    expect((await rest("GET", `/v1/files/${LIB}/dev_resources?node_ids=1:2,9:9`, bob))!.body.dev_resources).toHaveLength(1);
    const upd = await rest("PUT", "/v1/dev_resources", bob, { dev_resources: [{ id, name: "SB" }, { id: "nope", name: "x" }] });
    expect(upd!.body).toEqual({ links_updated: [id], errors: [{ id: "nope", error: "Dev resource not found" }] });
    expect((await rest("PUT", "/v1/dev_resources", carol, { dev_resources: [{ id, name: "x" }] }))!.body.errors).toHaveLength(1);
    const del = await rest("DELETE", `/v1/files/${LIB}/dev_resources/${id}`, bob);
    expect([del!.status, del!.body]).toEqual([200, null]);
    expect((await rest("DELETE", `/v1/files/${LIB}/dev_resources/${id}`, bob))!.status).toBe(404);
    expect((await rest("GET", `/v1/files/${WEB}/dev_resources`, bob))!.body).toEqual({ status: 404, err: "File not found" });
    expect(await rest("GET", "/v1/me", bob)).toBeNull();
  });
});

describe("Code Connect (D-1)", () => {
  it("parses our links and Figma's", () => {
    expect(parseNodeLink(`${ORIGIN}/f/${LIB}?node-id=1-2`)).toEqual({ fileKey: LIB, nodeId: "1:2" });
    expect(parseNodeLink(`https://www.figma.com/design/${LIB}/Design-System?node-id=12%3A34&t=x`)).toEqual({ fileKey: LIB, nodeId: "12:34" });
    expect(parseNodeLink(`https://www.figma.com/file/${LIB}/x?node-id=5:6`)).toEqual({ fileKey: LIB, nodeId: "5:6" });
    expect(parseNodeLink(`${ORIGIN}/f/${LIB}`)).toBeNull();
    expect(parseNodeLink("not a link")).toBeNull();
  });

  it("CLI publish and unpublish through /v1, UI mappings through the private routes, CLI ones read-only there", async () => {
    const { bob, gus, carol } = w.people;
    const pub = await rest("POST", "/v1/code_connect", bob, {
      docs: [
        { url: `${ORIGIN}/f/${LIB}?node-id=1-2`, label: "React", language: "tsx", source: "src/Button.tsx", component: "Button", template: "export default { example: figma.code`<Button />` }", imports: ['import { Button } from "./Button"'] },
        { url: `https://www.figma.com/design/${LIB}/DS?node-id=1-3`, label: "SwiftUI", template: null },
        { url: `${ORIGIN}/f/${WEB}?node-id=1-2`, label: "React", template: "x" },
        { url: `${ORIGIN}/f/${LIB}`, label: "React", template: "x" },
      ],
    });
    expect(pub!.body.published).toEqual([
      { nodeId: "1:2", fileKey: LIB, label: "React", url: `${ORIGIN}/f/${LIB}?node-id=1-2` },
      { nodeId: "1:3", fileKey: LIB, label: "SwiftUI", url: `${ORIGIN}/f/${LIB}?node-id=1-3` },
    ]);
    expect(pub!.body.errors.map((e: Any) => e.error)).toEqual(["File not found", "url is not a link to a node (…?node-id=1-2)"]);
    expect(await activity("code_connect_publish")).toEqual([expect.objectContaining({ count: 2, origin: "cli" })]);

    // gus (a viewer) reads them; the CLI doc shape too
    const got = await w.call("GET", `/files/${LIB}/code-connect`, gus.token);
    expect(got.body.mappings.map((m: Any) => [m.nodeId, m.label, m.language, m.origin])).toEqual([
      ["1:2", "React", "tsx", "cli"],
      ["1:3", "SwiftUI", "swift", "cli"],
    ]);
    expect(got.body.mappings[0]).toMatchObject({ source: "src/Button.tsx", component: "Button", imports: ['import { Button } from "./Button"'], nestable: true, updatedBy: bob.id });
    expect((await rest("GET", `/v1/files/${LIB}/code_connect?label=React`, gus))!.body.docs).toEqual([expect.objectContaining({ url: `${ORIGIN}/f/${LIB}?node-id=1-2`, label: "React", origin: "cli" })]);
    expect((await w.call("GET", `/files/${LIB}/code-connect`, carol.token)).status).toBe(404);

    // UI mappings: a new one, then a CLI one refused
    const ui = await w.call("PUT", `/files/${LIB}/code-connect`, bob.token, { nodeId: "1:4", label: "React", source: "src/Card.tsx", component: "Card", instructions: "Use the Card" });
    expect(ui.body.mapping).toMatchObject({ nodeId: "1:4", label: "React", language: "tsx", origin: "ui", template: null, instructions: "Use the Card" });
    expect((await w.call("PUT", `/files/${LIB}/code-connect`, bob.token, { nodeId: "1:2", label: "React", source: "x" })).status).toBe(409);
    expect((await w.call("PUT", `/files/${LIB}/code-connect`, gus.token, { nodeId: "1:5", label: "React" })).status).toBe(403);
    expect((await w.call("DELETE", `/files/${LIB}/code-connect/1:2?label=React`, bob.token)).status).toBe(409);
    expect((await w.call("DELETE", `/files/${LIB}/code-connect/1:4?label=React`, bob.token)).status).toBe(204);

    // Unpublish: by nodes, then everything of a label the caller published
    expect((await rest("DELETE", "/v1/code_connect", bob, { label: "React", nodes: [{ fileKey: LIB, nodeId: "1:2" }] }))!.body.removed).toEqual([{ fileKey: LIB, nodeId: "1:2", label: "React" }]);
    expect((await rest("DELETE", "/v1/code_connect", gus, { label: "SwiftUI" }))!.body.removed).toEqual([]);
    expect((await rest("DELETE", "/v1/code_connect", bob, { label: "SwiftUI" }))!.body.removed).toEqual([{ fileKey: LIB, nodeId: "1:3", label: "SwiftUI" }]);
    expect((await w.call("GET", `/files/${LIB}/code-connect`, bob.token)).body.mappings).toEqual([]);
  });

  it("a published org library's users read its mappings without opening the file", async () => {
    const { bob, carol } = w.people;
    await rest("POST", "/v1/code_connect", bob, { docs: [{ url: `${ORIGIN}/f/${LIB}?node-id=1-2`, label: "React", template: "t" }] });
    expect((await w.call("GET", `/files/${LIB}/code-connect`, carol.token)).status).toBe(404);
    const pub = await publish(w, LIB, w.people.alice.token, [{ key: assetKey("Button"), kind: "COMPONENT", name: "Button", seed: "b1" }], { scope: "org" });
    expect(pub.status).toBe(201);
    // Publishing to the org opens the file by its org link; closed again, the library's scope still lets carol use it
    await w.run(`UPDATE files SET org_link_access = 'none' WHERE key = ?1`, LIB);
    expect((await w.call("GET", `/files/${LIB}`, carol.token)).status).toBe(404);
    expect((await w.call("GET", `/files/${LIB}/code-connect`, carol.token)).body.mappings).toHaveLength(1);
    // …but not its dev resources (view access to the library file, docs/editor.md D-3)
    expect((await w.call("GET", res(LIB), carol.token)).status).toBe(404);
  });
});

describe("ready for dev (D-4)", () => {
  const status = (key: string, token: string, body: unknown) => w.call("POST", `/files/${key}/dev-status`, token, body);
  const devRows = async (userId: string) => (await w.rows(`SELECT kind, text, count, read_at FROM notifications WHERE user_id = ?1 AND kind LIKE 'dev_%' ORDER BY created_at`, userId)) as Any[];

  it("viewers in Dev Mode are told, folded within the hour, not the actor; seats, the switch and access count", async () => {
    const { alice, bob, gus, wade, dan } = w.people;
    // alice, wade and gus viewed the file in Dev Mode; gus is a guest with a View seat: not recorded (no Dev Mode)
    for (const p of [alice, wade, gus, bob]) expect((await w.call("POST", `/files/${LIB}/dev-status/viewed`, p.token)).status).toBe(204);
    expect((await w.rows(`SELECT user_id FROM dev_mode_viewers WHERE file_key = ?1 ORDER BY user_id`, LIB)).map((r: Any) => r.user_id).sort()).toEqual([alice.id, bob.id, wade.id].sort());
    // wade turns it off for this file
    expect((await w.call("PUT", `/files/${LIB}/dev-status/notify`, wade.token, { notify: false })).body).toEqual({ notify: false });
    expect((await w.call("GET", `/files/${LIB}/dev-status/notify`, wade.token)).body).toEqual({ notify: false, viewed: true });

    expect((await status(LIB, bob.token, { nodeId: "1:2", nodeName: "Checkout", status: "READY_FOR_DEV", kind: "ready" })).status).toBe(204);
    w.now.t += 10 * 60_000;
    await status(LIB, bob.token, { nodeId: "1:3", nodeName: "Cart", status: "READY_FOR_DEV", kind: "ready" });
    await status(LIB, bob.token, { nodeId: "1:3", nodeName: "Cart", status: "COMPLETED", kind: "completed" });
    await status(LIB, bob.token, { nodeId: "1:3", nodeName: "Cart", status: "COMPLETED", kind: "changed_done", changeMessage: "New totals" });
    await status(LIB, bob.token, { nodeId: "1:3", nodeName: "Cart", status: "NONE", kind: "removed" });
    const a = await devRows(alice.id);
    expect(a.map((r) => [r.kind, r.count])).toEqual([
      ["dev_ready", 2],
      ["dev_completed", 1],
      ["dev_changed", 1],
    ]);
    expect(devStatusText(a[2].text)).toEqual({ design: "Cart", reason: "New totals" });
    expect(notificationAction({ kind: "dev_ready", count: 2, state: null, role: null, text: "Cart" })).toBe("2 designs marked ready for dev");
    expect(notificationAction({ kind: "dev_changed", count: 1, state: null, role: null, text: a[2].text })).toBe("Updated Cart after a change: New totals");
    expect(await devRows(bob.id)).toEqual([]); // the actor
    expect(await devRows(wade.id)).toEqual([]); // "Nothing"
    // An hour on, a new row
    w.now.t += 61 * 60_000;
    await status(LIB, bob.token, { nodeId: "1:4", nodeName: "Pay", status: "READY_FOR_DEV", kind: "ready" });
    expect((await devRows(alice.id)).filter((r) => r.kind === "dev_ready").map((r) => r.count)).toEqual([2, 1]);
    // The live push carries it, with the Dev Mode preference
    expect(w.inbox.filter((x) => x.userId === alice.id && x.msg.item?.kind === "dev_ready").at(-1)?.msg.desktop).toBe(true);
    await w.call("PUT", `/notifications/prefs`, alice.token, { devMode: "none" });
    await status(LIB, bob.token, { nodeId: "1:5", nodeName: "Pay 2", status: "READY_FOR_DEV", kind: "ready" });
    expect(w.inbox.filter((x) => x.userId === alice.id && x.msg.item?.kind === "dev_ready").at(-1)?.msg.desktop).toBe(false);

    // Writers only, with the seat; bad reports refused
    expect((await status(LIB, gus.token, { nodeId: "1:2", nodeName: "x", status: "READY_FOR_DEV", kind: "ready" })).status).toBe(403);
    expect((await status(LIB, bob.token, { nodeId: "1:2", nodeName: "x", status: "NONE", kind: "ready" })).status).toBe(400);
    // Someone who lost access isn't told
    await w.run(`INSERT INTO dev_mode_viewers (file_key, user_id, viewed_at) VALUES (?1, ?2, 1)`, LIB, dan.id);
    await status(LIB, bob.token, { nodeId: "1:6", nodeName: "Z", status: "READY_FOR_DEV", kind: "ready" });
    expect(await devRows(dan.id)).toEqual([]);
  });

  it("outside orgs only ready for dev is told; everyone may view in Dev Mode", async () => {
    const owner = (await w.call("POST", "/auth/dev", undefined, { email: "solo@y.co" })).body;
    const friend = (await w.call("POST", "/auth/dev", undefined, { email: "friend@y.co" })).body;
    await w.call("POST", "/files", owner.token, { key: "solo_file1", name: "Solo" });
    await w.call("PUT", `/files/solo_file1/members`, owner.token, { email: "friend@y.co", role: "viewer" });
    await w.call("POST", `/files/solo_file1/dev-status/viewed`, friend.token);
    await status("solo_file1", owner.token, { nodeId: "1:2", nodeName: "A", status: "READY_FOR_DEV", kind: "ready" });
    await status("solo_file1", owner.token, { nodeId: "1:2", nodeName: "A", status: "COMPLETED", kind: "completed" });
    expect((await devRows(friend.user.id)).map((r) => r.kind)).toEqual(["dev_ready"]);
  });
});

describe("prototype-only access (D-6)", () => {
  it("invited from Share prototype: the presentation's routes only; listed nowhere; removed → gone", async () => {
    const { bob, carol } = w.people;
    expect((await w.call("GET", `/files/${LIB}`, carol.token)).status).toBe(404);
    expect((await w.call("PUT", `/files/${LIB}/prototype-members`, bob.token, { email: "carol@x.co" })).status).toBe(201);
    expect((await w.call("PUT", `/files/${LIB}/prototype-members`, carol.token, { email: "dan@x.co" })).status).toBe(403);
    expect((await w.call("GET", `/files/${LIB}/prototype-members`, bob.token)).body.members).toEqual([{ email: "carol@x.co", userId: carol.id, name: "carol" }]);
    const info = await w.call("GET", `/files/${LIB}`, carol.token);
    expect(info.body.access).toMatchObject({ role: "viewer", prototypeOnly: true, canDevMode: false, canEdit: false, canShare: false });
    expect(w.inbox.some((x) => x.userId === carol.id && x.msg.item?.kind === "invite")).toBe(true);
    // The document and comments yes; members, Dev Mode, requests no
    expect((await w.call("GET", `/files/${LIB}/snapshot`, carol.token)).status).toBe(200);
    await w.call("GET", `/files/${LIB}/ws?m=proto`, carol.token, undefined, { upgrade: "websocket" });
    expect(w.rooms.filter((r) => r.path === "/room/ws").length).toBe(1);
    expect((await w.call("GET", `/files/${LIB}/members`, carol.token)).status).toBe(403);
    expect((await w.call("POST", `/files/${LIB}/requests`, carol.token)).status).toBe(403);
    expect((await w.call("GET", `${res(LIB)}`, carol.token)).status).toBe(403);
    expect((await w.call("POST", `/files/${LIB}/dev-status/viewed`, carol.token)).status).toBe(403);
    // Not in Home's listings
    const listed = await w.call("GET", `/projects/${P1}/files`, carol.token);
    expect(JSON.stringify(listed.body)).not.toContain(LIB);
    expect((await w.call("DELETE", `/files/${LIB}/prototype-members/carol@x.co`, bob.token)).status).toBe(204);
    expect(w.rooms.some((r) => r.path === "/room/revoke" && r.body?.userId === carol.id)).toBe(true);
    expect((await w.call("GET", `/files/${LIB}`, carol.token)).status).toBe(404);
  });

  it("the org's prototype link: members by the link, not guests; logged; outside orgs refused", async () => {
    const { alice, carol, gus } = w.people;
    expect((await w.call("PATCH", `/files/${LIB}`, alice.token, { protoOrgLinkAccess: "viewer" })).status).toBe(200);
    expect((await w.call("GET", `/files/${LIB}`, carol.token)).body.access).toMatchObject({ prototypeOnly: true, via: ["audience"] });
    expect((await w.call("GET", `/files/${LIB}`, alice.token)).body.protoOrgLinkAccess).toBe("viewer");
    expect(await activity("fig_file_proto_link_access_change")).toEqual([{ link: "org", from: "none", to: "viewer" }]);
    // gus is a viewer of the file: a full viewer still
    expect((await w.call("GET", `/files/${LIB}`, gus.token)).body.access.prototypeOnly).toBe(false);
    expect((await w.call("PATCH", `/files/${LIB}`, alice.token, { protoOrgLinkAccess: "editor" })).status).toBe(400);
    expect((await w.call("PATCH", `/files/${LIB}`, carol.token, { protoOrgLinkAccess: "none" })).status).toBe(403);
    expect((await w.call("PATCH", `/files/${LIB}`, alice.token, { protoOrgLinkAccess: "none" })).status).toBe(200);
    expect(w.rooms.some((r) => r.key === LIB && r.path === "/room/reauth")).toBe(true);
    expect((await w.call("GET", `/files/${LIB}`, carol.token)).status).toBe(404);
    // Anyone with the prototype link
    await w.call("PATCH", `/files/${DRAFT}`, w.people.bob.token, { protoLinkAccess: "viewer" });
    const outsider = (await w.call("POST", "/auth/dev", undefined, { email: "out@y.co" })).body;
    expect((await w.call("GET", `/files/${DRAFT}`, outsider.token)).body.access).toMatchObject({ prototypeOnly: true, via: ["link"] });
    expect((await w.call("GET", `/files/${DRAFT}/snapshot`, outsider.token)).status).toBe(200);
  });
});
