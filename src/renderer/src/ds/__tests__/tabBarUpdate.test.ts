// @vitest-environment happy-dom
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { UpdaterStatus } from "@shared/ipc";
import { TabBar, TabBarUpdate, type TabBarProps, type TabBarUpdateState } from "../components/TabBar";
import { updateNotice } from "../../app/TabBarApp";
import { $, click, mount, spy, type Mounted } from "./dom";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

function bar(state: TabBarUpdateState) {
  const onRestart = spy<[]>();
  const noop = () => {};
  m = mount(TabBar, { tabs: [], active: "home", onActivate: noop, onClose: noop, notice: createElement(TabBarUpdate, { state, onRestart }) } as TabBarProps);
  return onRestart;
}

describe("the tab bar's update notice (docs/desktop.md §12.6)", () => {
  it("an update in: a “Restart to update” button that restarts on click", () => {
    const onRestart = bar({ kind: "ready", version: "0.2.0" });
    const button = $('[data-ds="Button"]') as HTMLButtonElement;
    expect(button.textContent).toBe("Restart to update");
    expect(button.title).toBe("Version 0.2.0 is ready to install");
    click(button);
    expect(onRestart.calls).toHaveLength(1);
  });

  it("a manual check's progress: checking, then the download's percent", () => {
    bar({ kind: "checking" });
    expect($('[data-ds="TabBarUpdate"]').textContent).toBe("Checking for updates…");
    m?.unmount();
    bar({ kind: "downloading", percent: 42 });
    expect($('[data-ds="TabBarUpdate"]').textContent).toBe("Downloading update… 42%");
  });
});

describe("updateNotice", () => {
  const status = (s: Partial<UpdaterStatus>): UpdaterStatus => ({ enabled: true, state: { kind: "idle" }, manual: false, current: "0.1.0", ...s });

  it("the pill whenever an update is in", () => {
    expect(updateNotice(status({ state: { kind: "ready", version: "0.2.0" } }))).toEqual({ kind: "ready", version: "0.2.0" });
  });
  it("the daily check stays quiet", () => {
    expect(updateNotice(status({ state: { kind: "checking" } }))).toBeNull();
    expect(updateNotice(status({ state: { kind: "downloading", percent: 10, version: "0.2.0" } }))).toBeNull();
  });
  it("Check for Updates… shows its progress", () => {
    expect(updateNotice(status({ manual: true, state: { kind: "checking" } }))).toEqual({ kind: "checking" });
    expect(updateNotice(status({ manual: true, state: { kind: "downloading", percent: 10, version: null } }))).toEqual({ kind: "downloading", percent: 10 });
    // Its answer is a message box, not the bar
    expect(updateNotice(status({ manual: true, state: { kind: "upToDate", version: "0.1.0" } }))).toBeNull();
  });
  it("nothing when the updater is off", () => {
    expect(updateNotice(status({ enabled: false, state: { kind: "ready", version: "0.2.0" } }))).toBeNull();
    expect(updateNotice(null)).toBeNull();
  });
});
