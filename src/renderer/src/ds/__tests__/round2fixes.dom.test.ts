// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement as h, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { FOLDER_COLORS } from "@shared/store/types";
import { ContextMenu } from "../components/Menu";
import { Dialog } from "../components/Dialog";
import { Portal, inheritedTheme } from "../overlay/Portal";
import { FOLDER_COLOR_IDS, FOLDER_COLOR_VARS, folderColor } from "../util/folderColor";
import { appColor } from "../tokens";
import { ICONS } from "../icons/registry";
import { $, click, mount, type Mounted } from "./dom";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  document.documentElement.removeAttribute("data-theme");
});

describe("overlay theme", () => {
  it("a dialog opened from a context menu item takes the app's theme, not the menu's dark", () => {
    document.documentElement.setAttribute("data-theme", "light");
    function Demo() {
      const [menu, setMenu] = useState(true);
      const [dialog, setDialog] = useState(false);
      return h("div", null,
        menu && h(ContextMenu, { at: { x: 10, y: 10 }, entries: [{ id: "rename", label: "Rename…" }], onClose: () => setMenu(false), onSelect: () => setDialog(true) }),
        dialog && h(Dialog, { title: "Rename", open: true, onClose: () => setDialog(false) }, "Body"),
      );
    }
    m = mount(Demo, {});
    const item = $('[role="menuitem"]');
    item.focus(); // focus sits in the dark menu when the item is picked
    click(item);
    const dialog = $('[data-ds="Dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog.closest("[data-theme]")!.getAttribute("data-theme")).toBe("light");
  });

  it("forced-dark overlays are skipped; a themed subtree (the Gallery's) still wins", () => {
    document.documentElement.setAttribute("data-theme", "light");
    const menu = document.createElement("div");
    menu.setAttribute("data-theme", "dark");
    menu.setAttribute("data-theme-forced", "");
    const inMenu = document.createElement("button");
    menu.appendChild(inMenu);
    const column = document.createElement("div");
    column.setAttribute("data-theme", "dark");
    const inColumn = document.createElement("button");
    column.appendChild(inColumn);
    document.body.append(menu, column);
    expect(inheritedTheme(inMenu)).toBe("light");
    expect(inheritedTheme(inColumn)).toBe("dark");
    expect(inheritedTheme(null)).toBe("light");
    menu.remove();
    column.remove();
  });

  it("menus keep forcing dark", () => {
    document.documentElement.setAttribute("data-theme", "light");
    m = mount(Portal, { theme: "dark", children: h("span", { id: "x" }) });
    const wrapper = document.getElementById("x")!.parentElement!;
    expect(wrapper.getAttribute("data-theme")).toBe("dark");
    expect(wrapper.hasAttribute("data-theme-forced")).toBe(true);
  });
});

describe("folder colours", () => {
  it("match the store's ids", () => {
    expect([...FOLDER_COLOR_IDS]).toEqual([...FOLDER_COLORS]);
  });
  it("each has a token, light and dark, in tokens.css", () => {
    const css = readFileSync(join(process.cwd(), "src/renderer/src/ds/tokens.css"), "utf8");
    for (const id of FOLDER_COLOR_IDS) {
      if (id === "none") continue;
      expect(appColor).toHaveProperty(`folder-${id}`);
      expect(FOLDER_COLOR_VARS[id]).toBe(`var(--ds-color-folder-${id})`);
      expect(css).toContain(`--ds-color-folder-${id}:`);
    }
    expect(folderColor("teal")).toBe("var(--ds-color-folder-teal)");
    expect(folderColor("none")).toBeUndefined();
    expect(folderColor("plaid")).toBeUndefined();
  });
});

describe("star icons", () => {
  it("the filled star is filled; the outline one is not", () => {
    const star = ICONS["24.star"] as unknown as unknown[];
    const outline = ICONS["24.star.outline"] as unknown as unknown[];
    expect(star.slice(2).some((p) => typeof p === "string" && p.startsWith("f|"))).toBe(true);
    expect(outline.slice(2).some((p) => typeof p === "string" && p.startsWith("f|"))).toBe(false);
  });
});
