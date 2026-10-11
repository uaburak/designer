/**
 * designer-connect (docs/editor.md D-1 "The CLI") against the real server handler in-process (server/src/testing,
 * node:sqlite): publish of templates and batches, substitutions, Figma-style links, refusals, --dry-run, unpublish,
 * parse and create. The CLI's `fetch` is routed straight into `handle`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handle } from "../../server/src/api";
import { LIB, type Any } from "../../server/src/testing/orgWorld";
import { restWorld, type RestWorld } from "../../server/src/testing/restWorld";
import { parseNodeLink, run, staticExtras, toScript } from "./connect.mjs";

const ORIGIN = "https://designer.example.workers.dev";
const API = `${ORIGIN}/v1`;
let w: RestWorld;
let dir: string;
let token: string;
let calls: { method: string; url: string; body: Any }[];

beforeEach(async () => {
  w = await restWorld();
  token = await w.pat("bob", ["file_code_connect:write", "file_content:read"]);
  dir = mkdtempSync(join(tmpdir(), "designer-connect-"));
  calls = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const fetchIntoServer = (async (input: RequestInfo | URL, init?: RequestInit) => {
  calls.push({ method: init?.method ?? "GET", url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
  return handle(new Request(input, init), w.deps);
}) as typeof fetch;

async function cli(...argv: string[]) {
  let out = "";
  let err = "";
  const code = await run([...argv], { fetch: fetchIntoServer, env: { DESIGNER_ACCESS_TOKEN: token }, cwd: dir, stdout: { write: (s: string) => void (out += s) }, stderr: { write: (s: string) => void (err += s) } });
  return { code, out, err };
}

const put = (rel: string, text: string) => {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};

const BUTTON = `// url=${ORIGIN}/f/${LIB}?node-id=1-2
// source=https://github.com/acme/ui/blob/main/Button.tsx
// component=Button
import figma from 'figma'

const instance = figma.selectedInstance
const label: string = instance.getString('Label')

export default {
  example: figma.code\`<Button>\${label}</Button>\`,
  imports: ['import { Button } from "./Button"'],
  id: 'button',
  metadata: { nestable: false },
}
`;

const mappings = async () => (await w.call("GET", `/files/${LIB}/code-connect`, w.people.bob.token)).body.mappings as Any[];

describe("designer-connect", () => {
  it("turns a template into the runtime's script", async () => {
    const s = await toScript(BUTTON, "Button.figma.ts");
    expect(s).not.toMatch(/^import /m);
    expect(s).toMatch(/^__codeConnectResult = /m);
    expect(s).not.toMatch(/: string/);
    expect(await toScript(`const figma = require("figma");\nexport default { example: figma.code\`x\` };`, "a.figma.js")).toMatch(/^__codeConnectResult = /m);
    await expect(toScript(`import figma from "figma"\nimport x from "./x"\nexport default { example: figma.code\`\${x}\` }`, "a.figma.ts")).rejects.toThrow("templates can only import 'figma'");
    expect(staticExtras(BUTTON)).toEqual({ imports: ['import { Button } from "./Button"'], nestable: false });
    expect(parseNodeLink(`https://www.figma.com/design/${LIB}/DS?node-id=12%3A34`)).toEqual({ fileKey: LIB, nodeId: "12:34" });
  });

  it("publishes a template and a batch; reads back through /v1 and the private route", async () => {
    put("src/Button.figma.ts", BUTTON);
    put("src/icons.figma.batch.ts", `// source=src/icons.tsx\nimport figma from "figma"\nexport default { example: figma.code\`<\${figma.batch.component} />\` }\n`);
    put("src/icons.figma.batch.json", JSON.stringify({ templateFile: "icons.figma.batch.ts", components: [{ url: `https://www.figma.com/design/${LIB}/DS?node-id=1-3`, component: "IconA" }, { url: `${ORIGIN}/f/${LIB}?node-id=1-4`, component: "IconB", size: 16 }] }));
    put("node_modules/x/Bad.figma.ts", "nothing here");
    const r = await cli("publish", "-a", API);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      [
        `Successfully uploaded to Figma, for Button:\n-> ${ORIGIN}/f/${LIB}?node-id=1-2 (React)`,
        `Successfully uploaded to Figma, for IconA:\n-> ${ORIGIN}/f/${LIB}?node-id=1-3 (React)`,
        `Successfully uploaded to Figma, for IconB:\n-> ${ORIGIN}/f/${LIB}?node-id=1-4 (React)`,
        "",
      ].join("\n"),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: `${API}/code_connect` });
    const m = await mappings();
    expect(m.map((x) => [x.nodeId, x.label, x.language, x.component, x.source])).toEqual([
      ["1:2", "React", "tsx", "Button", "https://github.com/acme/ui/blob/main/Button.tsx"],
      ["1:3", "React", "tsx", "IconA", "src/icons.tsx"],
      ["1:4", "React", "tsx", "IconB", "src/icons.tsx"],
    ]);
    expect(m[0]).toMatchObject({ imports: ['import { Button } from "./Button"'], nestable: false, origin: "cli" });
    expect(m[0].template).toMatch(/^\/\/ url=.*\n[\s\S]*__codeConnectResult = /);
    expect(m[2].template.split("\n")[0]).toBe(`var __codeConnectBatch = ${JSON.stringify({ url: `${ORIGIN}/f/${LIB}?node-id=1-4`, component: "IconB", size: 16 })};`);
    const docs = (await w.rest("GET", `/v1/files/${LIB}/code_connect`, token)).body.docs;
    expect(docs).toHaveLength(3);
  });

  it("applies documentUrlSubstitutions and the config's label, include and apiUrl", async () => {
    put("figma.config.json", JSON.stringify({ codeConnect: { include: ["ui/**/*.figma.ts"], label: "SwiftUI", apiUrl: API, documentUrlSubstitutions: { "<LIB>": `https://www.figma.com/design/${LIB}/DS` } } }));
    put("ui/Card.figma.ts", `// url=<LIB>?node-id=1-5\nimport figma from "figma"\nexport default { example: figma.code\`Card()\` }\n`);
    put("other/Skip.figma.ts", "// url=nope\n");
    const r = await cli("publish");
    expect([r.code, r.err]).toEqual([0, ""]);
    expect((await mappings()).map((x) => [x.nodeId, x.label, x.language])).toEqual([["1:5", "SwiftUI", "swift"]]);
  });

  it("reports a missing url header and refuses parser-format files, sending nothing for them", async () => {
    put("A.figma.ts", `import figma from "figma"\nexport default { example: figma.code\`A\` }\n`);
    put("B.figma.tsx", `import figma from "@figma/code-connect"\nfigma.connect(B, "${ORIGIN}/f/${LIB}?node-id=1-2", { example: () => <B /> })\n`);
    put("C.figma.ts", BUTTON.replace("node-id=1-2", "node-id=1-6"));
    const r = await cli("publish", "-a", API, "-r", ".");
    expect(r.code).toBe(1);
    expect(r.err).toContain("A.figma.ts has no `// url=<node link>` header comment");
    // .tsx isn't in the default include; -f names it
    const b = await cli("parse", "-f", "B.figma.tsx");
    expect(b.code).toBe(1);
    expect(b.err).toContain("npx figma connect migrate");
    expect((await mappings()).map((x) => x.nodeId)).toEqual(["1:6"]);
  });

  it("--dry-run prints the request and sends nothing; parse prints or writes the docs", async () => {
    put("Button.figma.ts", BUTTON);
    const r = await cli("publish", "--dry-run", "-a", API);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Dry run: would POST 1 doc to ${API}/code_connect`);
    expect(calls).toHaveLength(0);
    const p = await cli("parse");
    expect(JSON.parse(p.out)).toEqual([expect.objectContaining({ url: `${ORIGIN}/f/${LIB}?node-id=1-2`, label: "React", language: "tsx", component: "Button", nestable: false })]);
    expect((await cli("parse", "--outFile", "docs.json")).code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "docs.json"), "utf8"))).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it("unpublishes by --node and by label", async () => {
    put("Button.figma.ts", BUTTON);
    put("Card.figma.ts", BUTTON.replace("node-id=1-2", "node-id=1-7").replace("component=Button", "component=Card"));
    expect((await cli("publish", "-a", API)).code).toBe(0);
    expect((await cli("unpublish", "-a", API)).err).toContain("unpublish needs --label");
    const one = await cli("unpublish", "-a", API, "-l", "React", "--node", `https://www.figma.com/design/${LIB}/DS?node-id=1-7`);
    expect(one).toEqual({ code: 0, err: "", out: `Successfully unpublished 1 mapping (React)\n-> ${ORIGIN}/f/${LIB}?node-id=1-7\n` });
    expect((await mappings()).map((x) => x.nodeId)).toEqual(["1:2"]);
    const all = await cli("unpublish", "-a", API, "--label", "React");
    expect(all.out).toContain("Successfully unpublished 1 mapping (React)");
    expect(await mappings()).toEqual([]);
  });

  it("prints the server's error and exits 1 without a valid token", async () => {
    put("Button.figma.ts", BUTTON);
    let err = "";
    const code = await run(["publish", "-a", API, "-t", "nope"], { fetch: fetchIntoServer, env: {}, cwd: dir, stdout: { write: () => undefined }, stderr: { write: (s: string) => void (err += s) } });
    expect(code).toBe(1);
    expect(err).toMatch(/^Failed to upload to Figma \(\d{3}\): /);
  });

  it("create writes a starter template named from the node id", async () => {
    const r = await run(["create", `${ORIGIN}/f/${LIB}?node-id=1-2`, "--outDir", "connect"], { fetch: fetchIntoServer, env: {}, cwd: dir, stdout: { write: () => undefined }, stderr: { write: () => undefined } });
    expect(r).toBe(0);
    const text = readFileSync(join(dir, "connect", "Node1_2.figma.ts"), "utf8");
    expect(text.startsWith(`// url=${ORIGIN}/f/${LIB}?node-id=1-2\n`)).toBe(true);
    expect(text).toContain("figma.selectedInstance");
    expect(await toScript(text, "Node1_2.figma.ts")).toMatch(/__codeConnectResult = /);
    expect(calls).toHaveLength(0);
  });
});
