// Atlas 21 (settings and accessibility, wave 8): where the preferences live — this machine, the account, the store's
// migration — the Accessibility settings' editor switches, the Nudge amount window's rules and the shortcut blocking
// in text fields, as plain data.
import { afterEach, describe, expect, it } from "vitest";
import { ACCESSIBILITY_PREFERENCES, ROAMING, STORAGE_KEY, loadPreferences, migratePreferences, pref, reconcileRoaming, setPreference, setPreferencesAccount, syncRoamingPreferences, type AccountCall } from "../preferences";
import { NUDGE_FIELDS } from "../canvas/CanvasTools";
import { menuCommandInField } from "../desktop";
import type { EditorController } from "../controller";
import type { UIState } from "../uiStore";

/** A localStorage of its own (Node has none). */
function storage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}
const g = globalThis as { localStorage?: unknown };
const saved = g.localStorage;
afterEach(() => {
  g.localStorage = saved;
  setPreferencesAccount((() => Promise.reject(new Error("signed out"))) as AccountCall);
});

/** The editor as preferences.ts uses it: its UI state. */
function fakeEditor(state: Partial<UIState> = {}) {
  let ui = state as UIState;
  return { ui: { get: () => ui, set: (p: Partial<UIState>) => void (ui = { ...ui, ...p }) } } as unknown as EditorController;
}

/** The account's side: what was asked, and the prefs it holds. */
function fakeAccount(prefs: Record<string, boolean>) {
  const calls: { method: string; body?: unknown }[] = [];
  const call = (async (method: string, _path: string, body?: unknown) => {
    calls.push({ method, body });
    return { prefs } as never;
  }) as AccountCall;
  setPreferencesAccount(call);
  return calls;
}

describe("atlas 21 §3: the store's version 2 (Right-click and drag to pan off by default)", () => {
  it("a store from before keeps the old default as the user's choice; a fresh machine gets Figma's", () => {
    expect(migratePreferences({ invertZoom: true }, false)).toEqual({ values: { invertZoom: true, rightDragPan: true, v: 2 }, changed: true });
    expect(migratePreferences({ rightDragPan: false }, false).values).toEqual({ rightDragPan: false, v: 2 });
    expect(migratePreferences(null, true).values).toEqual({ rightDragPan: true, v: 2 });
    expect(migratePreferences(null, false).values).toEqual({ v: 2 });
    expect(migratePreferences({ v: 2 }, true)).toEqual({ values: { v: 2 }, changed: false });
  });

  it("on load: written back once, nothing else lost; another of the app's keys counts as a machine used before", () => {
    const store = storage({ [STORAGE_KEY]: JSON.stringify({ snapToObjects: false, smartQuotes: true }) });
    g.localStorage = store;
    expect(loadPreferences()).toEqual({ snapToObjects: false, smartQuotes: true, rightDragPan: true });
    expect(JSON.parse(store.data.get(STORAGE_KEY)!)).toEqual({ snapToObjects: false, smartQuotes: true, rightDragPan: true, v: 2 });
    g.localStorage = storage({ "designer.nudge": JSON.stringify({ small: 2, big: 20 }) });
    expect(loadPreferences()).toEqual({ rightDragPan: true });
    g.localStorage = storage();
    expect(loadPreferences()).toEqual({});
    expect(pref({} as UIState, "rightDragPan")).toBe(false);
    // The browser build's stand-in workspace is Home's, written before any editor ran: a fresh machine still.
    g.localStorage = storage({ "designer.devStore.v1.workspace": "{}" });
    expect(loadPreferences()).toEqual({});
  });

  it("a change keeps only its key beside the others", () => {
    const store = storage({ [STORAGE_KEY]: JSON.stringify({ invertZoom: true, v: 2 }) });
    g.localStorage = store;
    fakeAccount({});
    const ed = fakeEditor();
    setPreference(ed, "smartQuotes", false);
    expect(JSON.parse(store.data.get(STORAGE_KEY)!)).toEqual({ invertZoom: true, smartQuotes: false, v: 2 });
    expect(ed.ui.get().smartQuotes).toBe(false);
  });
});

describe("atlas 21 §2: the user record's preferences go with the account", () => {
  it("Figma's four, by their account names", () => {
    expect(ROAMING.map((r) => r.key)).toEqual(["numberKeysOpacity", "scrollWheelZoom", "rightDragPan", "screenReader"]);
  });

  it("this machine first, else the account's, else the default — and the account told when it differs", () => {
    // Nothing here: the account's taken in; it already holds them.
    expect(reconcileRoaming({}, { scrollWheelZoom: true, rightDragPan: true, screenReader: false })).toEqual({ adopt: { scrollWheelZoom: true, rightDragPan: true, screenReader: false }, push: {} });
    // This machine's wins and goes to the account.
    expect(reconcileRoaming({ scrollWheelZoom: false, rightDragPan: true, screenReader: false }, { scrollWheelZoom: true })).toEqual({ adopt: {}, push: { scrollWheelZoom: false, rightDragPan: true, screenReader: false } });
    // Neither: the defaults are written to the account (Figma's `a!==r&&m(e,r)`).
    expect(reconcileRoaming({}, {}).push).toEqual({ scrollWheelZoom: false, rightDragPan: false, screenReader: false });
    // Use number keys for opacity is the account's alone once it has one.
    expect(reconcileRoaming({ numberKeysOpacity: true }, { numberKeysOpacity: false }).adopt).toEqual({ numberKeysOpacity: false });
    // What this machine kept before it roamed goes to the account; an untouched default doesn't.
    expect(reconcileRoaming({ numberKeysOpacity: false }, {}).push.numberKeysOpacity).toBe(false);
    expect(reconcileRoaming({}, {}).push.numberKeysOpacity).toBeUndefined();
  });

  it("a change to one of them is sent to the account; the others aren't", () => {
    g.localStorage = storage();
    const calls = fakeAccount({});
    const ed = fakeEditor();
    setPreference(ed, "scrollWheelZoom", true);
    setPreference(ed, "invertZoom", true);
    expect(calls).toEqual([{ method: "PATCH", body: { prefs: { scrollWheelZoom: true } } }]);
  });

  it("at start: the account's adopted into the UI, signed out nothing changes", async () => {
    g.localStorage = storage({ [STORAGE_KEY]: JSON.stringify({ v: 2 }) });
    const calls = fakeAccount({ rightDragPan: true, scrollWheelZoom: false, screenReader: false, numberKeysOpacity: false });
    const ed = fakeEditor();
    await syncRoamingPreferences(ed);
    expect(ed.ui.get()).toMatchObject({ rightDragPan: true, numberKeysOpacity: false });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
    setPreferencesAccount((() => Promise.reject(new Error("Log in first"))) as AccountCall);
    const alone = fakeEditor();
    await syncRoamingPreferences(alone);
    expect(alone.ui.get()).toEqual({});
  });
});

describe("atlas 21 §4.1: Accessibility settings' editor switches", () => {
  it("defaults: screen reader, Actions menu focus and shortcut blocking off; spotlight auto-follow on (unverified)", () => {
    expect(Object.fromEntries(ACCESSIBILITY_PREFERENCES.map((p) => [p.key, p.on]))).toEqual({ screenReader: false, actionsTabFocus: false, textInputShortcutBlocking: false, spotlightAutoFollow: true });
    expect(pref({} as UIState, "rotateWithArrows")).toBe(false);
  });

  it("Ignore shortcuts in text fields: the canvas's text field drops the menu bar's shortcuts too", () => {
    expect(menuCommandInField("object.group", "accelerator", "canvas-text")).toBe("run");
    expect(menuCommandInField("object.group", "accelerator", "canvas-text", true)).toBe("drop");
    // Clicked in the menu it still runs; the field's own Undo stays the field's.
    expect(menuCommandInField("object.group", "menu", "canvas-text", true)).toBe("run");
    expect(menuCommandInField("edit.undo", "accelerator", "canvas-text", true)).toBe("native");
  });
});

describe("atlas 21 §3.1: Nudge amount", () => {
  it("Small nudge at least 0.1, Big nudge at least 1, no upper bound", () => {
    expect(NUDGE_FIELDS.map((f) => [f.key, f.label, f.min])).toEqual([
      ["small", "Small nudge", 0.1],
      ["big", "Big nudge", 1],
    ]);
    expect(NUDGE_FIELDS.some((f) => "max" in f)).toBe(false);
  });
});
