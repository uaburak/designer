// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { CollectionView, type CollectionViewProps } from "../components/CollectionView";
import { FileCard } from "../components/FileCard";
import { FolderCard, type FolderCardProps } from "../components/FolderCard";
import { ListHeader, ListRow, type ListColumn } from "../components/ListView";
import { InlineEdit, type InlineEditProps } from "../components/InlineEdit";
import { Breadcrumb, type BreadcrumbProps } from "../components/Breadcrumb";
import { Banner } from "../components/Banner";
import { IS_MAC } from "../util/keys";
import { $, $$, box, click, focus, key, mount, pointer, spy, type, type Mounted } from "./dom";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

const mod = IS_MAC ? { metaKey: true } : { ctrlKey: true };

describe("CollectionView", () => {
  const ids = ["a", "b", "c", "d"];
  function setup(props: Partial<CollectionViewProps> = {}) {
    const onNavigate = spy<[string, boolean]>();
    const onSelectAll = spy<[]>();
    const onClearSelection = spy<[]>();
    const onDelete = spy<[]>();
    const onMarquee = spy<[string[], { additive: boolean; final: boolean }]>();
    const children = ids.map((id) => h(FileCard, { key: id, id, title: id.toUpperCase(), subtitle: "Edited just now" }));
    m = mount(CollectionView, { label: "Files", onNavigate, onSelectAll, onClearSelection, onDelete, onMarquee, children, ...props } as CollectionViewProps);
    // Two columns of 268 + 36
    $$("[data-collection-item]").forEach((el, i) => box(el, { left: (i % 2) * 304, top: Math.floor(i / 2) * 249, width: 268, height: 213 }));
    box($('[data-ds="CollectionView"]'), { left: 0, top: 0, width: 640, height: 600 });
    return { onNavigate, onSelectAll, onClearSelection, onDelete, onMarquee };
  }
  const item = (id: string) => $(`[data-id="${id}"]`);

  it("is a multi-select listbox of the cards", () => {
    setup();
    const root = $('[data-ds="CollectionView"]');
    expect(root.getAttribute("role")).toBe("listbox");
    expect(root.getAttribute("aria-multiselectable")).toBe("true");
  });

  it("moves focus with the arrows by layout and reports it (⇧ extends)", () => {
    const { onNavigate } = setup();
    focus(item("a"));
    key(item("a"), "ArrowRight");
    expect(document.activeElement).toBe(item("b"));
    key(item("b"), "ArrowDown", { shiftKey: true });
    expect(document.activeElement).toBe(item("d"));
    key(item("d"), "Home");
    expect(onNavigate.calls).toEqual([["b", false], ["d", true], ["a", false]]);
  });

  it("⌘A selects all, Esc clears, ⌫ deletes", () => {
    const { onSelectAll, onClearSelection, onDelete } = setup();
    focus(item("b"));
    key(item("b"), "a", mod);
    key(item("b"), "Escape");
    key(item("b"), "Backspace");
    expect([onSelectAll.calls.length, onClearSelection.calls.length, onDelete.calls.length]).toEqual([1, 1, 1]);
  });

  it("leaves keys typed in a field alone (renaming)", () => {
    const { onDelete } = setup({ children: h(FileCard, { id: "r", title: "Renaming", subtitle: "", renaming: true, onRename: () => {} }) });
    const input = $("input");
    key(input, "Backspace");
    expect(onDelete.calls).toHaveLength(0);
  });

  it("a click on empty space clears; a drag draws a marquee over the cards it meets", () => {
    const { onClearSelection, onMarquee } = setup();
    const root = $('[data-ds="CollectionView"]');
    pointer(root, "pointerdown", { clientX: 290, clientY: 230 });
    pointer(root, "pointerup", { clientX: 290, clientY: 230 });
    expect(onClearSelection.calls).toHaveLength(1);

    pointer(root, "pointerdown", { clientX: 290, clientY: 230 }); // in the gap between the four cards
    pointer(root, "pointermove", { clientX: 320, clientY: 240 });
    expect($('[data-ds="Marquee"]')).not.toBeNull();
    expect(onMarquee.calls.at(-1)).toEqual([[], { additive: false, final: false }]);
    pointer(root, "pointermove", { clientX: 310, clientY: 260 }); // into b (x ≥ 304) and d (y ≥ 249)
    expect(onMarquee.calls.at(-1)![0]).toEqual(["d"]);
    pointer(root, "pointermove", { clientX: 200, clientY: 300 }); // back left of b and d: only c
    expect(onMarquee.calls.at(-1)![0]).toEqual(["c"]);
    pointer(root, "pointerup", { clientX: 320, clientY: 300 }); // released over d again
    expect(onMarquee.calls.at(-1)).toEqual([["d"], { additive: false, final: true }]);
    expect($('[data-ds="Marquee"]')).toBeNull();
    expect(onClearSelection.calls).toHaveLength(1);
  });

  it("a press on a card is not a marquee; ⇧ makes a marquee additive", () => {
    const { onMarquee, onClearSelection } = setup();
    pointer(item("a"), "pointerdown", { clientX: 10, clientY: 10 });
    pointer(item("a"), "pointermove", { clientX: 100, clientY: 100 });
    expect(onMarquee.calls).toHaveLength(0);
    const root = $('[data-ds="CollectionView"]');
    pointer(root, "pointerdown", { clientX: 290, clientY: 230, shiftKey: true });
    pointer(root, "pointermove", { clientX: 10, clientY: 10 });
    pointer(root, "pointerup", { clientX: 10, clientY: 10 });
    expect(onMarquee.calls.at(-1)).toEqual([["a"], { additive: true, final: true }]);
    expect(onClearSelection.calls).toHaveLength(0);
  });

  it("list layout: a grid role, the header first, ↑ ↓ only", () => {
    const columns: ListColumn[] = [{ id: "name", label: "Name", sortable: true }, { id: "edited", label: "Last modified", width: 160, sortable: true }];
    const onNavigate = spy<[string, boolean]>();
    m = mount(CollectionView, {
      label: "Files",
      layout: "list",
      onNavigate,
      header: h(ListHeader, { columns, sort: { column: "edited", direction: "descending" } }),
      children: ["a", "b"].map((id, i) => h(ListRow, { key: id, id, columns, cells: { name: id, edited: `${i} days ago` } })),
    } as CollectionViewProps);
    $$("[data-collection-item]").forEach((el, i) => box(el, { left: 0, top: 32 + i * 40, width: 600, height: 40 }));
    const root = $('[data-ds="CollectionView"]');
    expect(root.getAttribute("role")).toBe("grid");
    expect(root.firstElementChild!.getAttribute("data-ds")).toBe("ListHeader");
    focus(item("a"));
    key(item("a"), "ArrowRight");
    expect(onNavigate.calls).toHaveLength(0);
    key(item("a"), "ArrowDown");
    expect(onNavigate.calls).toEqual([["b", false]]);
  });
});

describe("ListHeader / ListRow", () => {
  const columns: ListColumn[] = [{ id: "name", label: "Name", sortable: true }, { id: "where", label: "Location" }, { id: "edited", label: "Last modified", width: 160, align: "end", sortable: true }];
  it("marks the sorted column and reports clicks on sortable ones", () => {
    const onSort = spy<[string]>();
    m = mount(ListHeader, { columns, sort: { column: "edited", direction: "descending" }, onSort });
    const cells = $$('[role="columnheader"]');
    expect(cells.map((c) => c.getAttribute("aria-sort"))).toEqual(["none", null, "descending"]);
    expect(cells[1].querySelector("button")).toBeNull();
    click(cells[0].querySelector("button")!);
    expect(onSort.calls).toEqual([["name"]]);
    expect($('[data-ds="ListHeader"]').style.gridTemplateColumns).toBe("minmax(0, 1fr) minmax(0, 1fr) 160px");
  });
  it("a row selects on click (with the event), opens on double-click and Enter", () => {
    const onSelect = spy<[unknown]>();
    const onOpen = spy<[]>();
    m = mount(ListRow, { id: "f", columns, cells: { name: "Portfolio", edited: "Edited 1 day ago" }, selected: true, onSelect, onOpen });
    const row = $('[data-ds="ListRow"]');
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect($$('[role="gridcell"]').map((c) => c.textContent)).toEqual(["Portfolio", "", "Edited 1 day ago"]);
    click(row);
    act(() => {
      row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    key(row, "Enter");
    key(row, " ");
    expect(onSelect.calls).toHaveLength(2);
    expect(onOpen.calls).toHaveLength(2);
  });
});

describe("InlineEdit", () => {
  function setup(props: Partial<InlineEditProps> = {}) {
    const onCommit = spy<[string]>();
    const onCancel = spy<[]>();
    const onEditingChange = spy<[boolean]>();
    const onExit = spy<[string]>();
    m = mount(InlineEdit, { label: "Rename", value: "Logo.svg", editing: true, onCommit, onCancel, onEditingChange, onExit, ...props } as InlineEditProps);
    return { onCommit, onCancel, onEditingChange, onExit, input: $("input") as HTMLInputElement };
  }
  it("opens focused with the text selected (or just the name)", () => {
    let { input } = setup();
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 8]);
    m!.unmount();
    ({ input } = setup({ select: "name" }));
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 4]);
  });
  it("Enter keeps a changed, trimmed name; editing ends", () => {
    const { input, onCommit, onEditingChange, onExit, onCancel } = setup();
    type(input, "  Mark.svg ");
    key(input, "Enter");
    expect(onCommit.calls).toEqual([["Mark.svg"]]);
    expect(onCancel.calls).toHaveLength(0);
    expect(onEditingChange.calls).toEqual([[false]]);
    expect(onExit.calls).toEqual([["enter"]]);
  });
  it("Esc, an empty name or no change keep nothing", () => {
    let s = setup();
    type(s.input, "Other");
    key(s.input, "Escape");
    expect(s.onCommit.calls).toHaveLength(0);
    expect(s.onCancel.calls).toHaveLength(1);
    m!.unmount();
    s = setup();
    type(s.input, "   ");
    act(() => s.input.blur());
    expect(s.onCommit.calls).toHaveLength(0);
    expect(s.onCancel.calls).toHaveLength(1);
  });
  it("keys stop at the field; a double-click on the text asks to edit when allowed", () => {
    const outer = spy<[]>();
    document.addEventListener("keydown", outer);
    const s = setup();
    key(s.input, "Backspace");
    expect(outer.calls).toHaveLength(0);
    document.removeEventListener("keydown", outer);
    m!.unmount();
    const t = setup({ editing: false, editOnDoubleClick: true });
    expect($("input")).toBeNull();
    act(() => {
      $('[data-ds="InlineEdit"] span').dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(t.onEditingChange.calls).toEqual([[true]]);
  });
});

describe("Breadcrumb", () => {
  const items = [{ id: "team", label: "burakkoc.net" }, { id: "clients", label: "Clients" }, { id: "acme", label: "Acme" }, { id: "2026", label: "2026" }, { id: "q4", label: "Q4" }];
  function setup(props: Partial<BreadcrumbProps> = {}) {
    const onNavigate = spy<[string]>();
    const onMenuSelect = spy<[string]>();
    m = mount(Breadcrumb, { items: items.slice(0, 3), onNavigate, onMenuSelect, ...props } as BreadcrumbProps);
    return { onNavigate, onMenuSelect };
  }
  it("ancestors navigate; the last is the current page", () => {
    const { onNavigate } = setup();
    const buttons = $$('[data-ds="Breadcrumb"] li button');
    expect(buttons.map((b) => b.textContent)).toEqual(["burakkoc.net", "Clients"]);
    click(buttons[1]);
    expect(onNavigate.calls).toEqual([["clients"]]);
    expect($('[aria-current="page"]').textContent).toBe("Acme");
  });
  it("folds the middle of a long path into a menu", () => {
    const { onNavigate } = setup({ items, maxItems: 4 });
    const texts = $$('[data-ds="Breadcrumb"] li:not([aria-hidden])').map((li) => li.textContent);
    expect(texts).toEqual(["burakkoc.net", "…", "2026", "Q4"]);
    click($('[aria-label="Show path"]'));
    const entries = $$('[role="menuitem"]').map((e) => e.textContent);
    expect(entries.join("|")).toContain("Clients");
    expect(entries.join("|")).toContain("Acme");
    click($$('[role="menuitem"]').find((e) => e.textContent?.includes("Acme"))!);
    expect(onNavigate.calls).toEqual([["acme"]]);
  });
  it("the current place opens its own menu", () => {
    const { onMenuSelect } = setup({ menu: [{ id: "rename", label: "Rename" }, { id: "delete", label: "Delete" }] });
    click($('[aria-label="Acme menu"]'));
    click($$('[role="menuitem"]').find((e) => e.textContent?.includes("Rename"))!);
    expect(onMenuSelect.calls).toEqual([["rename"]]);
  });
});

describe("FolderCard and Banner", () => {
  function folder(props: Partial<FolderCardProps> = {}) {
    const onRename = spy<[string | null]>();
    const onOpen = spy<[]>();
    m = mount(FolderCard, { id: "f", title: "Clients", subtitle: "3 files", onRename, onOpen, ...props } as FolderCardProps);
    return { onRename, onOpen };
  }
  it("shows up to four thumbnails, or the folder glyph", () => {
    folder({ thumbnails: ["1.png", "2.png", "3.png", "4.png", "5.png"] });
    expect($$('[data-ds="FolderCard"] img')).toHaveLength(4);
    m!.unmount();
    folder();
    expect($$('[data-ds="FolderCard"] img')).toHaveLength(0);
    expect($$('[data-ds="FolderCard"] [data-ds="Icon"]').length).toBeGreaterThanOrEqual(2);
  });
  it("renames once: the new name, or null when cancelled", () => {
    let s = folder({ renaming: true });
    type($("input") as HTMLInputElement, "Partners");
    key($("input"), "Enter");
    expect(s.onRename.calls).toEqual([["Partners"]]);
    m!.unmount();
    s = folder({ renaming: true });
    key($("input"), "Escape");
    expect(s.onRename.calls).toEqual([[null]]);
    expect(s.onOpen.calls).toHaveLength(0); // Enter in the field does not open the folder
  });
  it("banner: status role, action and dismiss", () => {
    const onAction = spy<[]>();
    const onDismiss = spy<[]>();
    m = mount(Banner, { tone: "warning", children: "Files in trash are deleted after 30 days.", action: { label: "Empty trash", onClick: onAction }, onDismiss });
    expect($('[data-ds="Banner"]').getAttribute("role")).toBe("status");
    click($$('[data-ds="Banner"] button').find((b) => b.textContent === "Empty trash")!);
    click($('[aria-label="Dismiss"]'));
    expect([onAction.calls.length, onDismiss.calls.length]).toEqual([1, 1]);
  });
});
