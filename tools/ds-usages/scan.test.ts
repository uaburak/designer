import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classInfo, scan, similarTo } from "./scan";
import type { UsageIndex } from "../../src/renderer/src/ds/gallery/usageTypes";

/** A tiny app: a ds, two screens, a CSS module, a test file and a dev tool that must be left out. */
const FILES: Record<string, string> = {
  "src/ds/index.ts": `export * from "./components/Button";`,
  "src/ds/tokens.css": `:root { --ds-size-control: 24px; --ds-radius-medium: 5px; }`,
  "src/ds/components/Button.tsx": `export function Button() { return <button>ds</button>; }`,
  "src/app/Panel.module.css": `
    .iconBtn { width: var(--ds-size-control); height: var(--ds-size-control); padding: 0; border-radius: var(--ds-radius-medium); }
    .row:hover .reveal { opacity: 1; }
    .floating { position: absolute; top: 0; }
  `,
  "src/app/Panel.tsx": `
    import { Button, IconButton as IB, Icon } from "@/ds";
    import * as ds from "../ds";
    import styles from "./Panel.module.css";
    import { cx } from "../ds/util/cx";
    export function Panel({ busy, wide }: { busy: boolean; wide: boolean }) {
      return (
        <div>
          <Button variant="primary" onClick={() => {}}>{t("Save")}</Button>
          <Button variant="primary" disabled={busy}>Save again</Button>
          <Button variant={wide ? "secondary" : "ghost"} icon="24.plus.small">Add</Button>
          <Button variant="primary" disabled>Off</Button>
          <IB icon="24.more" label="More" tone="secondary" />
          <ds.Button variant="link" />
          <button className={styles.iconBtn} onClick={() => {}}><Icon name="24.close" /></button>
          <button className={cx(styles.iconBtn, busy && styles.floating)}><Icon name="24.more" /></button>
          <button className={styles.reveal}>Show</button>
          <span role="button" className={styles.floating}>Drag</span>
          <input type="checkbox" className="raw" />
          <input placeholder="Search layers" />
          <a className={styles.iconBtn} href="#">Help</a>
          <a href="#">plain link, not counted</a>
        </div>
      );
    }
  `,
  "src/app/__tests__/Panel.test.tsx": `import { Button } from "@/ds"; export const x = <Button variant="primary">t</Button>;`,
  "src/devtools/Tool.tsx": `export const y = <button>dev</button>;`,
};

let root = "";
let index: UsageIndex;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ds-usages-"));
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  index = scan({ root, src: join(root, "src"), ds: join(root, "src/ds") });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("ds:usages scan", () => {
  it("reads the app's .tsx files only: not the ds, tests or dev tools", () => {
    expect(index.files).toBe(1);
  });

  it("groups each ds component's uses by their visual props", () => {
    const button = index.ds.find((c) => c.name === "Button")!;
    expect(button.count).toBe(5);
    expect(button.files).toBe(1);
    const keys = button.variants.map((v) => v.props);
    // A computed `disabled` is a run-time state, not a variant: the first two are one
    expect(keys).toContainEqual({ variant: "primary", children: "text" });
    expect(button.variants.find((v) => v.props.variant === "primary" && !v.props.disabled)!.count).toBe(2);
    expect(keys).toContainEqual({ variant: "primary", disabled: "true", children: "text" });
    // A choice of literals, an icon given, the namespace import
    expect(keys).toContainEqual({ variant: "secondary | ghost", icon: "✓", children: "text" });
    expect(keys).toContainEqual({ variant: "link" });
    const choice = button.variants.find((v) => v.props.variant === "secondary | ghost")!;
    expect(choice.sample).toEqual({ variant: "secondary", icon: "24.plus.small" });
    expect(choice.text).toBe("Add");
    expect(button.variants.find((v) => v.props.variant === "primary" && !v.props.disabled)!.text).toBe("Save");
    expect(choice.locs).toEqual([{ file: "src/app/Panel.tsx", line: 11 }]);
  });

  it("follows renamed imports", () => {
    const ib = index.ds.find((c) => c.name === "IconButton")!;
    expect(ib.variants[0].props).toEqual({ icon: "✓", label: "✓", tone: "secondary" });
    expect(ib.variants[0].sample).toEqual({ icon: "24.more", label: "More", tone: "secondary" });
  });

  it("indexes hand-made controls by their CSS module class", () => {
    const by = (cls: string, tag = "button") => index.custom.find((c) => c.className === cls && c.tag === tag);
    const icon = by("iconBtn")!;
    expect(icon.count).toBe(2);
    expect(icon.cssFile).toBe("src/app/Panel.module.css");
    expect(icon.extraClasses).toEqual(["floating"]);
    expect(icon.hasIcon).toBe(true);
    expect(icon.hasText).toBe(false);
    expect(icon.icon).toBe("24.close");
    expect(icon.box).toMatchObject({ width: "24px", height: "24px", "border-radius": "5px" });
    expect(icon.similarTo).toBe("IconButton");
    expect(icon.needsContext).toBeUndefined();
    // Styled only under a parent's hover; absolutely placed
    expect(by("reveal")!.needsContext).toMatch(/inside \.row:hover/);
    expect(by("floating", "span[role=button]")!.needsContext).toBe("position: absolute");
    // Literal classes, unstyled inputs, styled anchors only
    expect(by("raw", "input")).toMatchObject({ type: "checkbox", cssFile: null, similarTo: "Checkbox" });
    expect(index.custom.find((c) => c.tag === "input" && c.className === null)).toMatchObject({ type: "text", text: "Search layers", similarTo: "SearchField" });
    expect(index.custom.filter((c) => c.tag === "a")).toHaveLength(1);
    // Most used first
    expect(index.custom[0]).toBe(icon);
  });
});

describe("helpers", () => {
  it("classInfo tells a class's own rule from contextual ones", () => {
    const info = classInfo(".a { height: 24px; } .p .a { color: red; } .a:hover { opacity: 1; }", "a");
    expect(info.own).toEqual({ height: "24px" });
    expect(info.ownRules).toBe(2);
    expect(info.contextual).toEqual([".p .a"]);
  });

  it("similarTo matches obvious ds look-alikes", () => {
    expect(similarTo({ tag: "button", className: "x", hasText: true, hasIcon: false, box: { height: "24px" } })?.name).toBe("Button");
    expect(similarTo({ tag: "select", className: null, hasText: false, hasIcon: false })?.name).toBe("Select");
    expect(similarTo({ tag: "input", type: "range", className: null, hasText: false, hasIcon: false })?.name).toBe("Slider");
    expect(similarTo({ tag: "div[role=button]", role: "button", className: "card", hasText: false, hasIcon: false })).toBeNull();
  });
});
