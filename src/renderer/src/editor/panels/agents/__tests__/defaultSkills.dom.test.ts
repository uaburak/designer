// @vitest-environment happy-dom
/**
 * Agent settings › Skills with Wecra's default skills (docs/ai.md §8.6): the defaults are listed with a "Default"
 * badge; saving a default's page makes the owner's copy (badge "Default · edited"), whose page offers Reset to default
 * instead of Delete; turning a default off is remembered in the store — the store's real AiService on a memory host
 * behind a mocked `@/store`.
 */
import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SKILLS } from "@shared/agents/defaultSkills";
import { $, $$, click, mount, type Mounted } from "@/ds/__tests__/dom";
import { AiService, type AiStoreHost } from "../../../../../../store/ai/service";
import type { AgentSetupHost } from "../../../agents/setup";

const files = new Map<string, string>();
let n = 0;
const host: AiStoreHost = {
  read: async (name) => files.get(name) ?? null,
  write: async (name, text) => void files.set(name, text),
  remove: async (name) => void files.delete(name),
  list: async (dir) => [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
  server: { signedIn: false, userId: null, request: async () => new Response(null, { status: 503 }) },
  getMeta: () => null,
  newId: () => `s${++n}`,
  now: () => 1000,
  timers: { setTimeout: () => 0, clearTimeout: () => {} },
  log: () => {},
} as AiStoreHost;
const ai = new AiService(host);
vi.mock("@/store", () => ({ getStoreClient: () => ({ ai: ai.repository() }) }));

const { SkillsGroup, aiSettingsPage } = await import("../aiSettings");

const opened: (string | null)[] = [];
const service = { api: null, openSetting: (item: string | null) => void opened.push(item) } as unknown as AgentSetupHost;
const Page = ({ id }: { id: string }) => aiSettingsPage("skill", id, service)!.body as ReactNode;

const settle = () => act(async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
});
const row = (name: string) => $(`[data-skill="${name}"]`);
const offList = () => (JSON.parse(files.get("skills.json") ?? "{}").defaultsOff ?? []) as string[];

function typeArea(el: HTMLTextAreaElement, text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

let mounted: Mounted[] = [];
afterEach(() => {
  mounted.forEach((m) => m.unmount());
  mounted = [];
});

describe("Agent settings › Skills: Wecra's default skills", () => {
  it("lists every default with a Default badge, on", async () => {
    mounted.push(mount(SkillsGroup, { service }));
    await settle();
    for (const d of DEFAULT_SKILLS) {
      expect(row(d.name), d.name).toBeTruthy();
      expect($('[data-skill-default="default"]', row(d.name)).textContent).toBe("Default");
    }
    expect(row("motion-opus").textContent).toContain("On");
  });

  it("saving a default's page makes the owner's copy; its page resets it to the default", async () => {
    const list = mount(SkillsGroup, { service });
    mounted.push(list);
    const page = mount(Page, { id: "default:ux-review" });
    mounted.push(page);
    await settle();
    const name = $("[data-skill-name]", page.host);
    expect(((name.tagName === "INPUT" ? name : $("input", name)) as HTMLInputElement).disabled).toBe(true);
    expect($("[data-skill-origin=default]", page.host)).toBeTruthy();
    expect($("[data-skill-delete]", page.host)).toBeNull();
    typeArea($("[data-skill-instructions]", page.host) as HTMLTextAreaElement, "Our own review steps.");
    click($("[data-skill-save]", page.host));
    await settle();
    expect(files.get("skills/s1.md")).toContain("name: ux-review");
    expect(files.get("skills/s1.md")).toContain("Our own review steps.");
    expect(opened.at(-1)).toBe("skill:s1");
    expect($('[data-skill-default="override"]', row("ux-review")).textContent).toBe("Default · edited");

    const copy = mount(Page, { id: "s1" });
    mounted.push(copy);
    await settle();
    expect($("[data-skill-origin=override]", copy.host)).toBeTruthy();
    expect($("[data-skill-delete]", copy.host)).toBeNull();
    click($("[data-skill-reset]", copy.host));
    await settle();
    expect(files.has("skills/s1.md")).toBe(false);
    expect(opened.at(-1)).toBe("skill:default:ux-review");
    expect($('[data-skill-default="default"]', row("ux-review"))).toBeTruthy();
  });

  it("turning a default off is remembered in the store, and back on", async () => {
    const list = mount(SkillsGroup, { service });
    mounted.push(list);
    const page = mount(Page, { id: "default:theme-factory" });
    mounted.push(page);
    await settle();
    click($("[data-skill-toggle]", page.host));
    await settle();
    expect(offList()).toEqual(["theme-factory"]);
    expect(row("theme-factory").textContent).toContain("Off");
    expect($$("[data-skill]").length).toBe(DEFAULT_SKILLS.length);
    const again = mount(Page, { id: "default:theme-factory" });
    mounted.push(again);
    await settle();
    click($("[data-skill-toggle]", again.host));
    await settle();
    expect(offList()).toEqual([]);
  });
});
