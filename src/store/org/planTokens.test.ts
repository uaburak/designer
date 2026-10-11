/**
 * Round 5h — `AdminRepository`'s plan access tokens (docs/multiplayer.md §16.3) through LocalStore against round 5a's
 * real handler (server/src/api.ts on node:sqlite, the org of server/src/testing/orgWorld.ts): an org admin generates
 * one (the secret once, plan scopes only), lists and revokes it; a member is refused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handle } from "../../../server/src/api";
import { world, type World } from "../../../server/src/testing/orgWorld";
import { StoreError } from "../../shared/store/protocol";
import { openTestStore, type TestStore } from "../testing/harness";

const ORIGIN = "https://designer.example.workers.dev";

class NoSocket {
  binaryType = "arraybuffer";
  readyState = 0;
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  send() {}
  close() {}
}

let w: World;
const opened: TestStore[] = [];

async function open(person: keyof World["people"]): Promise<TestStore> {
  const fetch: typeof globalThis.fetch = async (input, init) => handle(new Request(String(input), init), w.deps);
  const s = await openTestStore({ fetch });
  await s.api.multiplayer.setSession({ server: ORIGIN, token: w.people[person].token });
  opened.push(s);
  return s;
}

beforeEach(async () => {
  vi.stubGlobal("WebSocket", NoSocket);
  w = await world();
});
afterEach(async () => {
  for (const s of opened.splice(0)) {
    await s.close().catch(() => undefined);
    s.dispose();
  }
  vi.unstubAllGlobals();
});

describe("plan access tokens", () => {
  it("an org admin generates, lists and revokes; plan scopes only; a member is refused", async () => {
    const alice = await open("alice");
    const made = await alice.api.admin.createPlanToken(w.orgId, { description: "Activity export", expiresInDays: 365, scopes: ["org:activity_log_read", "webhooks:read"] });
    expect(made.token).toMatch(/^dsgn_plan_/);
    expect(made.info).toMatchObject({ description: "Activity export", kind: "plan", orgId: w.orgId, scopes: ["org:activity_log_read", "webhooks:read"] });
    expect((await alice.api.admin.planTokens(w.orgId)).map((t) => t.id)).toEqual([made.info.id]);
    await expect(alice.api.admin.createPlanToken(w.orgId, { description: "x", expiresInDays: 30, scopes: ["file_content:read"] })).rejects.toBeInstanceOf(StoreError);
    const activity = await alice.api.admin.activity(w.orgId, { events: ["plan_access_token_create", "plan_access_token_delete"] });
    expect(activity.activity_logs.map((r) => r.action.type)).toEqual(["plan_access_token_create"]);
    await alice.api.admin.revokePlanToken(w.orgId, made.info.id);
    expect(await alice.api.admin.planTokens(w.orgId)).toEqual([]);

    const bob = await open("bob");
    await expect(bob.api.admin.planTokens(w.orgId)).rejects.toBeInstanceOf(StoreError);
  });
});
