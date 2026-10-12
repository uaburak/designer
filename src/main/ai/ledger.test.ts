import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ORG_SETTINGS, type OrgSettings, type OrgSummary } from "../../shared/org/types";

const state: { orgs: (OrgSummary & { settings: OrgSettings })[]; asked: number[]; fail: boolean } = { orgs: [], asked: [], fail: false };
vi.mock("../storeHost", () => ({
  storeClient: () => ({
    orgs: {
      list: async () => state.orgs.map(({ settings: _s, ...o }) => o),
      get: async (id: string) => ({ ...state.orgs.find((o) => o.id === id)! }),
    },
    ai: {
      balance: async (allowance: number) => {
        if (state.fail) throw new Error("store down");
        state.asked.push(allowance);
        return { month: "2026-10", used: 100, allowance, remaining: Math.max(0, allowance - 100), resetsAt: 0, byAction: {} };
      },
    },
  }),
}));

const { forgetOrgPolicy, ledgerBalance, policyOf } = await import("./ledger");
const org = (id: string, role: OrgSummary["role"], s: Partial<OrgSettings>) => ({ id, name: id, role, seat: "full" as const, workspaceId: null, settings: { ...DEFAULT_ORG_SETTINGS, ...s } });

beforeEach(() => {
  state.orgs = [];
  state.asked = [];
  state.fail = false;
  forgetOrgPolicy();
});

describe("ledgerBalance (docs/ai.md §2.12)", () => {
  it("is Settings › AI's allowance, lowered by the smallest org limit; 0 when an org turned AI off; guests' orgs don't count", async () => {
    expect((await ledgerBalance(4250))?.remaining).toBe(4150);
    forgetOrgPolicy();
    state.orgs = [org("a", "member", { aiCreditLimit: 1000 }), org("b", "admin", { aiCreditLimit: 500 }), org("c", "guest", { aiCreditLimit: 10, aiEnabled: false })];
    expect(await ledgerBalance(4250)).toMatchObject({ allowance: 500, remaining: 400 });
    expect((await ledgerBalance(200))?.allowance).toBe(200);
    forgetOrgPolicy();
    state.orgs.push(org("d", "member", { aiEnabled: false }));
    expect(await ledgerBalance(4250)).toMatchObject({ allowance: 0, remaining: 0 });
    state.fail = true;
    expect(await ledgerBalance(4250)).toBeNull();
  });

  it("policyOf", () => {
    expect(policyOf([])).toEqual({ disabled: false, limit: null });
    expect(policyOf([{ role: "member", settings: { aiEnabled: true, aiCreditLimit: 0 } }])).toEqual({ disabled: false, limit: 0 });
  });
});
