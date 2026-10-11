/**
 * designer-connect — Code Connect's CLI for our server (docs/editor.md D-1 "The CLI"), shaped as Figma's
 * `npx figma connect`: `publish`, `unpublish`, `parse`, `create`, with Figma's flags and `figma.config.json`.
 *
 * Input: template files (`*.figma.ts|js|tsx|jsx`) and batch files (`x.figma.batch.json` = {templateFile, components:
 * [{url, source?, component?, …}]}). The parser formats (`figma.connect(…)`) are refused: Figma's own
 * `npx figma connect migrate` turns them into templates first.
 *
 * The stored template (CodeConnectDoc.template, src/shared/rest/types.ts) — the convention the app's runtime relies on:
 *   - the template file's header comments (`// url=`, `// source=`, `// component=`), as written, then
 *   - the file's code with TypeScript stripped by esbuild's `transform` (format esm, target es2020), then
 *   - `import figma from "figma"` (also `import * as figma from "figma"` and `const figma = require("figma")`)
 *     removed — the runtime provides the global `figma`; any other import is an error (templates import only 'figma');
 *   - `export default <expr>` rewritten to `__codeConnectResult = <expr>` (also `export { x as default }` →
 *     `__codeConnectResult = x;`); other exports are an error. The runtime runs the result as a plain (sloppy)
 *     script with the global `figma` and reads the global `__codeConnectResult` (it may declare it first).
 *   - A batch's doc (one per component) is prefixed with the line `var __codeConnectBatch = <JSON of that
 *     component's entry>;` — the runtime maps `figma.batch` to it.
 *
 * `imports` and `nestable` are read statically when the export literal spells them (`imports: ['…', …]`,
 * `nestable: false`); otherwise omitted — the runtime gets them when it runs the template.
 *
 * Pure functions plus `run(argv, io)`; bin.mjs is the thin entry. Tests inject `fetch` (tools/code-connect/connect.test.ts).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** The deployed server's API URL — set at deploy (docs/multiplayer.md); override with -a, codeConnect.apiUrl or DESIGNER_SERVER */
export const DEFAULT_API_URL = "https://designer-server.workers.dev/v1";
export const CONFIG_FILE = "figma.config.json";
export const DEFAULT_INCLUDE = ["**/*.figma.ts", "**/*.figma.js", "**/*.figma.batch.json"];
const TEMPLATE_RE = /\.figma\.(ts|tsx|js|jsx|mjs)$/;

// ---- links ----------------------------------------------------------------------------------------------------------

/**
 * A node link: ours (`<server>/f/<key>?node-id=1-2`) or Figma-style (`…/design|file|proto/<key>/<name>?node-id=1-2`).
 * Keep in sync with server/src/devmode/codeConnect.ts `parseNodeLink` (the server's is TypeScript; this tool is plain JS).
 */
export function parseNodeLink(link) {
  let u;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  const path = /^\/(?:f|file|design|proto)\/([A-Za-z0-9_-]{6,64})(?:\/|$)/.exec(u.pathname);
  const raw = u.searchParams.get("node-id");
  if (!path || !raw) return null;
  const n = /^(I?-?\d+)[-:](-?\d+)$/.exec(raw.trim());
  if (!n) return null;
  return { fileKey: path[1], nodeId: `${n[1]}:${n[2]}` };
}

/** Every key of `documentUrlSubstitutions` replaced by its value (plain string replace, all occurrences) */
export function substitute(url, subs) {
  let out = url;
  for (const [from, to] of Object.entries(subs ?? {})) if (from) out = out.split(from).join(String(to));
  return out;
}

/** Our server's link to a node, from the API URL (its origin without /v1) */
export const linkOf = (apiUrl, fileKey, nodeId) => `${apiUrl.replace(/\/v1\/?$/, "")}/f/${fileKey}?node-id=${nodeId.replace(":", "-")}`;

// ---- labels and languages -------------------------------------------------------------------------------------------

const PARSER_LABELS = { react: "React", html: "Web Components", swift: "SwiftUI", compose: "Compose", custom: "Code" };

/** The language a label implies — mirrors server/src/devmode/codeConnect.ts `languageOf` */
export function languageOf(label) {
  const l = label.toLowerCase();
  if (l === "react" || l === "storybook") return "tsx";
  if (l === "swiftui" || l === "uikit") return "swift";
  if (l === "compose" || l === "jetpack compose") return "kotlin";
  if (l === "vue") return "vue";
  if (l === "html" || l === "web components" || l === "angular") return "html";
  return "raw";
}

export const labelOf = (flag, cfg) => flag || cfg.label || PARSER_LABELS[String(cfg.parser ?? "react").toLowerCase()] || "React";

// ---- config and files -----------------------------------------------------------------------------------------------

/** `figma.config.json`'s `codeConnect` and the directory globs are relative to */
export function loadConfig(path, dir) {
  const file = path ? resolve(dir, path) : join(dir, CONFIG_FILE);
  if (!existsSync(file)) {
    if (path) throw new Error(`Config file not found: ${file}`);
    return { cfg: {}, dir, file: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e.message}`);
  }
  return { cfg: parsed?.codeConnect ?? {}, dir: dirname(file), file };
}

/** A glob (`**`, `*`, `?`) as a regular expression over a /-separated relative path */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        re += "(?:.*/)?";
      } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function walk(dir, root, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, root, out);
    else if (e.isFile()) out.push(relative(root, p).split(sep).join("/"));
  }
  return out;
}

/** The files the config's include / exclude name (node_modules always excluded), absolute, sorted */
export function findFiles(dir, cfg) {
  const inc = (cfg.include ?? DEFAULT_INCLUDE).map(globToRegExp);
  const exc = (cfg.exclude ?? []).map(globToRegExp);
  return walk(dir, dir, [])
    .filter((f) => inc.some((r) => r.test(f)) && !exc.some((r) => r.test(f)))
    .sort()
    .map((f) => join(dir, f));
}

// ---- templates ------------------------------------------------------------------------------------------------------

/** The header comments at the top of a template: {url?, source?, component?, lines} */
export function readHeader(src) {
  const h = { lines: [] };
  for (const raw of src.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    if (!l.startsWith("//")) break;
    h.lines.push(l);
    const m = /^\/\/\s*(url|source|component)\s*=\s*(.*)$/.exec(l);
    if (m && m[2].trim()) h[m[1]] = m[2].trim();
  }
  return h;
}

const loaderOf = (file) => ({ ".ts": "ts", ".tsx": "tsx", ".jsx": "jsx" })[extname(file)] ?? "js";

function refuseParserFormat(src, file) {
  if (/\bfigma\s*\.\s*connect\s*\(/.test(src))
    throw new Error(`${file} uses a parser format (figma.connect). Convert it to a template with Figma's \`npx figma connect migrate\` first.`);
}

/** The template's code as the runtime runs it (see the header of this file) */
export async function toScript(src, file) {
  refuseParserFormat(src, file);
  const { transform } = await import("esbuild");
  let code;
  try {
    code = (await transform(src, { loader: loaderOf(file), format: "esm", target: "es2020", sourcefile: file })).code;
  } catch (e) {
    throw new Error(`${file}: ${e.message}`);
  }
  code = code
    .replace(/^[ \t]*import\s+(?:\*\s+as\s+)?figma\s+from\s*["']figma["'];?[ \t]*\r?\n?/gm, "")
    .replace(/^[ \t]*(?:const|let|var)\s+figma\s*=\s*require\(\s*["']figma["']\s*\);?[ \t]*\r?\n?/gm, "");
  if (/^[ \t]*import[\s{*"']/m.test(code) || /\brequire\(\s*["']/.test(code)) throw new Error(`${file}: templates can only import 'figma'`);
  code = code.replace(/^([ \t]*)export\s+default\s+/m, "$1__codeConnectResult = ").replace(/^[ \t]*export\s*\{\s*([A-Za-z_$][\w$]*)\s+as\s+default\s*\};?/m, "__codeConnectResult = $1;");
  if (/^[ \t]*export\b/m.test(code)) throw new Error(`${file}: a template exports only its default`);
  if (!code.includes("__codeConnectResult")) throw new Error(`${file}: a template needs a default export ({example: figma.code\`…\`})`);
  return code;
}

/** `imports: ['…']` and `nestable: false|true` when the export literal spells them */
export function staticExtras(src) {
  const out = {};
  const im = /\bimports\s*:\s*\[([^\]]*)\]/.exec(src);
  if (im) {
    const list = [...im[1].matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2].replace(/\\(["'`\\])/g, "$1"));
    if (!/\$\{/.test(im[1])) out.imports = list;
  }
  const ne = /\bnestable\s*:\s*(true|false)\b/.exec(src);
  if (ne) out.nestable = ne[1] === "true";
  return out;
}

function docOf(url, label, language, header, template, extras) {
  return {
    url,
    label,
    language,
    ...(header.source ? { source: header.source } : {}),
    ...(header.component ? { component: header.component } : {}),
    template,
    ...extras,
  };
}

/** The docs of one template file */
export async function templateDocs(file, opts) {
  const src = readFileSync(file, "utf8");
  refuseParserFormat(src, file);
  const header = readHeader(src);
  if (!header.url) throw new Error(`${file} has no \`// url=<node link>\` header comment`);
  const url = substitute(header.url, opts.subs);
  if (!parseNodeLink(url)) throw new Error(`${file}: url is not a link to a node (…?node-id=1-2): ${url}`);
  const script = await toScript(src, file);
  return [docOf(url, opts.label, opts.language, header, `${header.lines.join("\n")}\n${script}`, staticExtras(src))];
}

/** The docs of one batch file: one per component */
export async function batchDocs(file, opts) {
  let b;
  try {
    b = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${e.message}`);
  }
  if (typeof b?.templateFile !== "string" || !Array.isArray(b.components)) throw new Error(`${file}: a batch file is {templateFile, components: [{url, …}]}`);
  const tfile = resolve(dirname(file), b.templateFile);
  if (!existsSync(tfile)) throw new Error(`${file}: template file not found: ${b.templateFile}`);
  const src = readFileSync(tfile, "utf8");
  const header = readHeader(src);
  const script = await toScript(src, tfile);
  const extras = staticExtras(src);
  return b.components.map((c, i) => {
    if (typeof c?.url !== "string") throw new Error(`${file}: components[${i}] has no url`);
    const url = substitute(c.url, opts.subs);
    if (!parseNodeLink(url)) throw new Error(`${file}: components[${i}].url is not a link to a node (…?node-id=1-2): ${url}`);
    const entry = { ...c, url };
    const h = { source: typeof c.source === "string" ? c.source : header.source, component: typeof c.component === "string" ? c.component : header.component };
    return { ...docOf(url, opts.label, opts.language, h, `var __codeConnectBatch = ${JSON.stringify(entry)};\n${header.lines.join("\n")}\n${script}`, extras), _file: file };
  });
}

/** Every doc the inputs make: {docs, errors}; each doc keeps `_file` for printing (dropped before sending) */
export async function collectDocs(o) {
  const { cfg, dir } = loadConfig(o.config, o.dir);
  const label = labelOf(o.label, cfg);
  const opts = { label, language: cfg.language || languageOf(label), subs: cfg.documentUrlSubstitutions };
  const files = o.file ? [resolve(o.dir, o.file)] : findFiles(dir, cfg);
  const batches = files.filter((f) => f.endsWith(".batch.json"));
  const inBatch = new Set();
  for (const b of batches) {
    try {
      const t = JSON.parse(readFileSync(b, "utf8"))?.templateFile;
      if (typeof t === "string") inBatch.add(resolve(dirname(b), t));
    } catch {
      // reported by batchDocs
    }
  }
  const docs = [];
  const errors = [];
  for (const f of files) {
    try {
      if (f.endsWith(".batch.json")) docs.push(...(await batchDocs(f, opts)));
      else if (TEMPLATE_RE.test(f) && !inBatch.has(f)) docs.push(...(await templateDocs(f, opts)).map((d) => ({ ...d, _file: f })));
      else if (o.file) errors.push(`${f} is not a template (*.figma.ts / *.figma.js) or a batch file (*.figma.batch.json)`);
    } catch (e) {
      errors.push(e.message);
    }
  }
  return { docs, errors, cfg, label };
}

const wire = (d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== "_file"));
const nameOf = (d) => d.component || basename(d._file ?? "").replace(/\.figma(\.batch)?\.\w+$/, "") || "component";

// ---- the command line -----------------------------------------------------------------------------------------------

const HELP = `Usage: designer-connect <command> [options]

Commands:
  publish                     Publish the Code Connect templates to the server
  unpublish                   Remove published mappings (--label, optionally --node <link>)
  parse                       Print the docs that publish would send (no network)
  create <node link>          Write a starter template for a component

Options:
  -t, --token <token>         Access token (else DESIGNER_ACCESS_TOKEN or FIGMA_ACCESS_TOKEN)
  -a, --api-url <url>         The server's API URL, with /v1 (else codeConnect.apiUrl, DESIGNER_SERVER, the default)
  -c, --config <path>         Path to figma.config.json
  -r, --dir <dir>             The directory to search (default: the current directory)
  -f, --file <path>           One template or batch file instead of the config's include globs
  -l, --label <label>         The mappings' label (React, SwiftUI, Compose …)
      --node <link>           unpublish: only this node
      --outFile <path>        parse: write the docs to a file
      --outDir <dir>          create: where to write the template
      --dry-run               Show what publish / unpublish would send, send nothing
      --verbose               Print the requests
  -h, --help                  Show this help
`;

const FLAGS = {
  "-t": "token", "--token": "token", "-a": "apiUrl", "--api-url": "apiUrl", "-c": "config", "--config": "config",
  "-r": "dir", "--dir": "dir", "-f": "file", "--file": "file", "-l": "label", "--label": "label",
  "--node": "node", "--outFile": "outFile", "--out-file": "outFile", "--outDir": "outDir", "--out-dir": "outDir",
};
const BOOLS = { "--dry-run": "dryRun", "--verbose": "verbose", "-h": "help", "--help": "help" };

export function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let v;
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    if (eq > 0) [a, v] = [a.slice(0, eq), a.slice(eq + 1)];
    if (BOOLS[a]) o[BOOLS[a]] = true;
    else if (FLAGS[a]) {
      if (v === undefined) v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      o[FLAGS[a]] = v;
    } else if (a.startsWith("-") && a !== "-") throw new Error(`Unknown option ${a}`);
    else o._.push(a);
  }
  if (o._[0] === "connect") o._.shift(); // `designer-connect connect publish`, as `figma connect publish`
  return o;
}

export function apiUrlOf(o, cfg, env) {
  const raw = o.apiUrl || cfg.apiUrl || (env.DESIGNER_SERVER ? env.DESIGNER_SERVER.replace(/\/+$/, "").replace(/(?<!\/v1)$/, "/v1") : "") || DEFAULT_API_URL;
  return raw.replace(/\/+$/, "");
}

async function request(io, method, url, token, body, verbose) {
  if (verbose) io.stderr.write(`${method} ${url}\n`);
  let res;
  try {
    res = await io.fetch(url, { method, headers: { "content-type": "application/json", "x-figma-token": token }, body: JSON.stringify(body) });
  } catch (e) {
    return { ok: false, status: 0, error: `Couldn't reach ${url}: ${e.message}` };
  }
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }
  if (!res.ok) return { ok: false, status: res.status, error: (parsed && (parsed.err || parsed.error || parsed.message)) || text || res.statusText };
  return { ok: true, status: res.status, body: parsed };
}

const tokenOf = (o, env) => o.token || env.DESIGNER_ACCESS_TOKEN || env.FIGMA_ACCESS_TOKEN || "";
const NO_TOKEN = "Couldn't find an access token. Pass -t <token>, or set DESIGNER_ACCESS_TOKEN (or FIGMA_ACCESS_TOKEN).\n";

async function publish(o, io) {
  const { docs, errors, cfg } = await collectDocs(o);
  for (const e of errors) io.stderr.write(`${e}\n`);
  if (!docs.length) {
    io.stderr.write("No Code Connect files found.\n");
    return 1;
  }
  const apiUrl = apiUrlOf(o, cfg, io.env);
  const body = { docs: docs.map(wire) };
  if (o.dryRun) {
    io.stdout.write(`Dry run: would POST ${docs.length} doc${docs.length === 1 ? "" : "s"} to ${apiUrl}/code_connect\n${JSON.stringify(body, null, 2)}\n`);
    return errors.length ? 1 : 0;
  }
  const token = tokenOf(o, io.env);
  if (!token) return io.stderr.write(NO_TOKEN), 1;
  const r = await request(io, "POST", `${apiUrl}/code_connect`, token, body, o.verbose);
  if (!r.ok) {
    io.stderr.write(`Failed to upload to Figma${r.status ? ` (${r.status})` : ""}: ${r.error}\n`);
    return 1;
  }
  const published = r.body?.published ?? [];
  const failed = r.body?.errors ?? [];
  for (const p of published) {
    const d = docs.find((x) => x.label === p.label && JSON.stringify(parseNodeLink(x.url)) === JSON.stringify({ fileKey: p.fileKey, nodeId: p.nodeId }));
    io.stdout.write(`Successfully uploaded to Figma, for ${d ? nameOf(d) : p.nodeId}:\n-> ${p.url ?? linkOf(apiUrl, p.fileKey, p.nodeId)} (${p.label})\n`);
  }
  for (const e of failed) io.stderr.write(`Failed to upload to Figma, for ${e.url} (${e.label}): ${e.error}\n`);
  return errors.length || failed.length ? 1 : 0;
}

async function unpublish(o, io) {
  const { cfg } = loadConfig(o.config, o.dir);
  const label = o.label || cfg.label;
  if (!label) return io.stderr.write("unpublish needs --label <label> (or codeConnect.label in figma.config.json)\n"), 1;
  const body = { label };
  if (o.node) {
    const url = substitute(o.node, cfg.documentUrlSubstitutions);
    if (!parseNodeLink(url)) return io.stderr.write(`--node is not a link to a node (…?node-id=1-2): ${url}\n`), 1;
    body.nodes = [{ url }];
  }
  const apiUrl = apiUrlOf(o, cfg, io.env);
  if (o.dryRun) {
    io.stdout.write(`Dry run: would DELETE ${apiUrl}/code_connect\n${JSON.stringify(body, null, 2)}\n`);
    return 0;
  }
  const token = tokenOf(o, io.env);
  if (!token) return io.stderr.write(NO_TOKEN), 1;
  const r = await request(io, "DELETE", `${apiUrl}/code_connect`, token, body, o.verbose);
  if (!r.ok) return io.stderr.write(`Failed to unpublish${r.status ? ` (${r.status})` : ""}: ${r.error}\n`), 1;
  const removed = r.body?.removed ?? [];
  const failed = r.body?.errors ?? [];
  io.stdout.write(`Successfully unpublished ${removed.length} mapping${removed.length === 1 ? "" : "s"} (${label})\n`);
  for (const x of removed) io.stdout.write(`-> ${linkOf(apiUrl, x.fileKey, x.nodeId)}\n`);
  for (const e of failed) io.stderr.write(`Failed to unpublish ${e.fileKey} ${e.nodeId}: ${e.error}\n`);
  return failed.length ? 1 : 0;
}

async function parse(o, io) {
  const { docs, errors } = await collectDocs(o);
  for (const e of errors) io.stderr.write(`${e}\n`);
  const text = `${JSON.stringify(docs.map(wire), null, 2)}\n`;
  if (o.outFile) {
    const out = resolve(o.dir, o.outFile);
    writeFileSync(out, text);
    io.stdout.write(`Wrote ${docs.length} doc${docs.length === 1 ? "" : "s"} to ${out}\n`);
  } else io.stdout.write(text);
  return errors.length ? 1 : 0;
}

const pascal = (s) => s.replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : "")).replace(/^./, (c) => c.toUpperCase()).replace(/^(\d)/, "_$1");
const camel = (s) => {
  const p = pascal(s);
  return p.charAt(0).toLowerCase() + p.slice(1);
};

/** The node's name and component property definitions, when the server answers (best effort) */
async function nodeInfo(io, apiUrl, token, fileKey, nodeId, verbose) {
  if (!token) return null;
  const url = `${apiUrl}/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`;
  if (verbose) io.stderr.write(`GET ${url}\n`);
  try {
    const res = await io.fetch(url, { headers: { "x-figma-token": token }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const doc = (await res.json())?.nodes?.[nodeId]?.document;
    return doc && typeof doc.name === "string" ? doc : null;
  } catch {
    return null;
  }
}

/** A starter template for the node */
export function starterTemplate(link, name, defs) {
  const props = Object.entries(defs ?? {})
    .map(([key, d]) => {
      const prop = key.replace(/#[^#]*$/, "");
      const v = camel(prop) || "prop";
      if (d?.type === "BOOLEAN") return [v, `instance.getBoolean(${JSON.stringify(prop)})`];
      if (d?.type === "TEXT") return [v, `instance.getString(${JSON.stringify(prop)})`];
      if (d?.type === "INSTANCE_SWAP") return [v, `instance.getInstanceSwap(${JSON.stringify(prop)})`];
      if (d?.type === "VARIANT") {
        const map = Object.fromEntries((d.variantOptions ?? []).map((x) => [x, x]));
        return [v, `instance.getEnum(${JSON.stringify(prop)}, ${JSON.stringify(map)})`];
      }
      return null;
    })
    .filter(Boolean);
  const lines = props.map(([v, e]) => `const ${v} = ${e};`);
  const attrs = props.filter(([, e]) => !e.startsWith("instance.getInstanceSwap")).map(([v]) => ` ${v}={\${${v}}}`).join("");
  return `// url=${link}
// source=
// component=${name}
import figma from "figma";

const instance = figma.selectedInstance;
${lines.length ? `${lines.join("\n")}\n` : ""}
export default {
  example: figma.code\`<${name}${attrs} />\`,
  imports: ['import { ${name} } from "./${name}"'],
  id: ${JSON.stringify(name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase())},
  metadata: { nestable: true },
};
`;
}

async function create(o, io) {
  const link = o._[1];
  const { cfg } = loadConfig(o.config, o.dir);
  const url = link ? substitute(link, cfg.documentUrlSubstitutions) : "";
  const at = parseNodeLink(url);
  if (!at) return io.stderr.write("create needs a node link (…?node-id=1-2)\n"), 1;
  const apiUrl = apiUrlOf(o, cfg, io.env);
  const info = await nodeInfo(io, apiUrl, tokenOf(o, io.env), at.fileKey, at.nodeId, o.verbose);
  const name = (info && pascal(info.name)) || `Node${at.nodeId.replace(/[^0-9]+/g, "_")}`;
  const outDir = resolve(o.dir, o.outDir ?? ".");
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.figma.ts`);
  if (existsSync(file)) return io.stderr.write(`${file} already exists\n`), 1;
  writeFileSync(file, starterTemplate(link, name, info?.componentPropertyDefinitions));
  io.stdout.write(`Created ${file}\n`);
  return 0;
}

/**
 * The CLI: `run(process.argv.slice(2), {fetch, env, cwd, stdout, stderr})` → the exit code. Never throws for the
 * person's mistakes — they're printed to stderr with exit code 1.
 */
export async function run(argv, io) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    io.stderr.write(`${e.message}\n${HELP}`);
    return 1;
  }
  const cmd = o._[0];
  if (o.help || !cmd) {
    (cmd || o.help ? io.stdout : io.stderr).write(HELP);
    return o.help ? 0 : 1;
  }
  const cwd = io.cwd ?? process.cwd();
  o.dir = o.dir ? (isAbsolute(o.dir) ? o.dir : resolve(cwd, o.dir)) : cwd;
  if (!existsSync(o.dir) || !statSync(o.dir).isDirectory()) {
    io.stderr.write(`Not a directory: ${o.dir}\n`);
    return 1;
  }
  try {
    if (cmd === "publish") return await publish(o, io);
    if (cmd === "unpublish") return await unpublish(o, io);
    if (cmd === "parse") return await parse(o, io);
    if (cmd === "create") return await create(o, io);
  } catch (e) {
    io.stderr.write(`${e.message}\n`);
    return 1;
  }
  io.stderr.write(`Unknown command ${cmd}\n${HELP}`);
  return 1;
}
