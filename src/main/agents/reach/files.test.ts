// Local files (docs/agents-reach.md §10) in a temp folder: listings leave secrets out and don't follow links, reads are
// untrusted text or images, binaries are refused, search finds lines but never in a secret.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanReachSettings } from "../../../shared/agents/reach";
import type { ToolResult } from "../../../shared/agents/tools";
import { filesRunner } from "./files";
import type { RunContext } from "./hub";
import { OFF_LIMITS } from "./paths";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "files-")));
  dirs.push(root);
  const grant = join(root, "app");
  const outside = join(root, "outside");
  mkdirSync(join(grant, "src"), { recursive: true });
  mkdirSync(join(grant, "node_modules", "lib"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(grant, "src", "theme.css"), ":root {\n  --brand: #0af;\n}\n");
  writeFileSync(join(grant, ".env"), "BRAND_SECRET=--brand-key\n");
  writeFileSync(join(grant, "logo.png"), Buffer.from([137, 80, 78, 71]));
  writeFileSync(join(grant, "data.bin"), Buffer.from([1, 0, 2, 3]));
  writeFileSync(join(grant, "node_modules", "lib", "x.css"), "--brand: red");
  writeFileSync(join(outside, "notes.txt"), "--brand outside");
  symlinkSync(outside, join(grant, "linked"));
  const ctx: RunContext = { turnId: "t", chatId: "c", fileKey: "f", agent: "a", settings: cleanReachSettings({ files: { folders: [grant] } }), policy: "allow", signal: new AbortController().signal };
  return { grant, ctx };
}
const text = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : `[image ${c.mimeType}]`)).join("\n");
const run = filesRunner();

describe("local files", () => {
  it("lists without secrets, links not followed, heavy folders not entered", async () => {
    const { ctx } = project();
    const r = text(await run("list_files", { path: ".", depth: 3 }, ctx));
    expect(r).toContain("src/theme.css");
    expect(r).toContain("node_modules/ (not entered)");
    expect(r).toContain("linked → (a link, not followed)");
    expect(r).not.toContain(".env");
    expect(r).not.toContain("notes.txt");
    expect(r).not.toContain("x.css");
    expect(text(await run("list_files", {}, ctx))).toContain("Granted folders");
  });

  it("reads text as untrusted data, pictures as images; refuses binaries, secrets and the way out", async () => {
    const { grant, ctx } = project();
    const css = text(await run("read_file", { path: "src/theme.css" }, ctx));
    expect(css).toContain("<untrusted-data");
    expect(css).toContain("--brand: #0af");
    expect(text(await run("read_file", { path: join(grant, "logo.png") }, ctx))).toContain("[image image/png]");
    expect(text(await run("read_file", { path: "data.bin" }, ctx))).toContain("binary");
    for (const p of [".env", "linked/notes.txt", "../outside/notes.txt"]) {
      const r = await run("read_file", { path: p }, ctx);
      expect(r.isError, p).toBe(true);
      expect(text(r), p).toBe(OFF_LIMITS);
    }
  });

  it("searches names and lines, never in secrets, dependencies or linked folders", async () => {
    const { ctx } = project();
    const r = text(await run("search_files", { query: "--BRAND" }, ctx));
    expect(r).toMatch(/theme\.css:2: --brand: #0af;/);
    expect(r).not.toContain(".env");
    expect(r).not.toContain("x.css");
    expect(r).not.toContain("notes.txt");
    expect((await run("search_files", { query: "x", path: "../outside" }, ctx)).isError).toBe(true);
  });
});
