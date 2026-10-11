/**
 * Figma's manifest.json, parsed and checked (docs/plugins.md §4): `parseManifest(json, {development})` gives the
 * manifest with its warnings (Figma's console warnings: `"*"` or localhost without `reasoning`), or the errors that
 * make it unusable. Main validates on import (5e); the editor checks again before a run.
 */
import type { PluginEditorType, PluginManifest, PluginMenuItem, PluginParameter } from "./types";

export type ManifestResult = { manifest: PluginManifest; warnings: string[] } | { errors: string[] };

const EDITOR_TYPES: readonly PluginEditorType[] = ["figma", "figjam", "dev", "slides", "buzz"];
const PERMISSIONS = ["currentuser", "activeusers", "fileusers", "payments", "teamlibrary"] as const;
const CAPABILITIES = ["textreview", "codegen", "inspect", "vscode"] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";

/** A manifest without an `id` gets one from its path (Figma assigns ids on publish): `dev:<hash>`. */
export function developmentId(path: string): string {
  // FNV-1a 64 as two 32-bit halves: stable, no crypto needed in the view.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return `dev:${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

function parameters(v: unknown, at: string, errors: string[]): PluginParameter[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return void errors.push(`${at} must be a list`);
  const out: PluginParameter[] = [];
  v.forEach((p, i) => {
    if (!isObj(p) || !isStr(p.name) || !isStr(p.key)) return void errors.push(`${at}[${i}] needs "name" and "key"`);
    out.push({
      name: p.name,
      key: p.key,
      ...(isStr(p.description) ? { description: p.description } : {}),
      ...(typeof p.allowFreeform === "boolean" ? { allowFreeform: p.allowFreeform } : {}),
      ...(typeof p.optional === "boolean" ? { optional: p.optional } : {}),
    });
  });
  return out;
}

function menu(v: unknown, at: string, errors: string[]): PluginMenuItem[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return void errors.push(`${at} must be a list`);
  const out: PluginMenuItem[] = [];
  v.forEach((m, i) => {
    const here = `${at}[${i}]`;
    if (!isObj(m)) return void errors.push(`${here} must be an object`);
    if (m.separator === true) return void out.push({ separator: true });
    if (!isStr(m.name)) return void errors.push(`${here} needs a "name"`);
    if (Array.isArray(m.menu)) return void out.push({ name: m.name, menu: menu(m.menu, `${here}.menu`, errors) ?? [] });
    if (!isStr(m.command)) return void errors.push(`${here} needs a "command" or a "menu"`);
    const params = parameters(m.parameters, `${here}.parameters`, errors);
    out.push({ name: m.name, command: m.command, ...(params ? { parameters: params } : {}), ...(m.parameterOnly === true ? { parameterOnly: true } : {}) });
  });
  return out;
}

const isLocalhost = (d: string) => /^(?:[a-z]+:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(d);

/** Figma's manifest fields with Figma's rules; `development`: a manifest imported from disk (an id is made up when missing). */
export function parseManifest(json: unknown, options: { development?: boolean; path?: string } = {}): ManifestResult {
  let raw = json;
  if (isStr(raw)) {
    try {
      raw = JSON.parse(raw);
    } catch (e) {
      return { errors: [`manifest.json isn't valid JSON: ${(e as Error).message}`] };
    }
  }
  if (!isObj(raw)) return { errors: ["manifest.json must be an object"] };
  const m = raw;
  const errors: string[] = [];
  const warnings: string[] = [];
  if (m.containsWidget === true || isStr(m.widgetApi)) return { errors: ["Widgets aren't supported in DesignerV2 yet"] };
  if (!isStr(m.name) || !m.name.trim()) errors.push('"name" is required');
  if (!isStr(m.api)) errors.push('"api" is required (e.g. "1.0.0")');
  if (!isStr(m.main) || !m.main.trim()) errors.push('"main" is required (the plugin\'s code file)');
  let id = isStr(m.id) ? m.id.trim() : "";
  if (!id) {
    if (options.development && options.path) id = developmentId(options.path);
    else errors.push('"id" is required');
  }
  let ui: PluginManifest["ui"];
  if (isStr(m.ui)) ui = m.ui;
  else if (isObj(m.ui)) {
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.ui)) {
      if (isStr(v)) map[k] = v;
      else errors.push(`"ui.${k}" must be a file name`);
    }
    ui = map;
  } else if (m.ui !== undefined) errors.push('"ui" must be a file name or a map of file names');
  let editorType: PluginEditorType[] | undefined;
  if (m.editorType !== undefined) {
    if (!Array.isArray(m.editorType) || !m.editorType.every((t) => EDITOR_TYPES.includes(t as PluginEditorType))) errors.push(`"editorType" must list ${EDITOR_TYPES.join(", ")}`);
    else editorType = m.editorType as PluginEditorType[];
  }
  if (m.documentAccess !== undefined && m.documentAccess !== "dynamic-page") errors.push('"documentAccess" must be "dynamic-page"');
  let networkAccess: PluginManifest["networkAccess"];
  if (m.networkAccess !== undefined) {
    const n = m.networkAccess;
    if (!isObj(n) || !Array.isArray(n.allowedDomains) || !n.allowedDomains.length || !n.allowedDomains.every(isStr)) errors.push('"networkAccess.allowedDomains" must list at least one domain (["none"] blocks everything)');
    else {
      const dev = n.devAllowedDomains;
      if (dev !== undefined && (!Array.isArray(dev) || !dev.every(isStr))) errors.push('"networkAccess.devAllowedDomains" must be a list of domains');
      networkAccess = { allowedDomains: n.allowedDomains as string[], ...(isStr(n.reasoning) ? { reasoning: n.reasoning } : {}), ...(Array.isArray(dev) ? { devAllowedDomains: dev as string[] } : {}) };
      const reasoned = isStr(n.reasoning) && n.reasoning.trim() !== "";
      if (!reasoned && networkAccess.allowedDomains.includes("*")) warnings.push('networkAccess: "*" needs a "reasoning"');
      if (!reasoned && networkAccess.allowedDomains.some(isLocalhost)) warnings.push('networkAccess: localhost needs a "reasoning"');
    }
  }
  const params = parameters(m.parameters, "parameters", errors);
  const items = menu(m.menu, "menu", errors);
  let relaunchButtons: PluginManifest["relaunchButtons"];
  if (m.relaunchButtons !== undefined) {
    if (!Array.isArray(m.relaunchButtons) || !m.relaunchButtons.every((b) => isObj(b) && isStr(b.command) && isStr(b.name))) errors.push('"relaunchButtons" must list {command, name}');
    else relaunchButtons = (m.relaunchButtons as Obj[]).map((b) => ({ command: b.command as string, name: b.name as string, ...(b.multipleSelection === true ? { multipleSelection: true } : {}) }));
  }
  const listOf = <T extends string>(key: string, allowed: readonly T[]): T[] | undefined => {
    const v = m[key];
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || !v.every((x) => allowed.includes(x as T))) {
      errors.push(`"${key}" must list ${allowed.join(", ")}`);
      return undefined;
    }
    return v as T[];
  };
  const permissions = listOf("permissions", PERMISSIONS);
  const capabilities = listOf("capabilities", CAPABILITIES);
  let codegenLanguages: PluginManifest["codegenLanguages"];
  if (m.codegenLanguages !== undefined) {
    if (!Array.isArray(m.codegenLanguages) || !m.codegenLanguages.every((l) => isObj(l) && isStr(l.label) && isStr(l.value))) errors.push('"codegenLanguages" must list {label, value}');
    else codegenLanguages = (m.codegenLanguages as Obj[]).map((l) => ({ label: l.label as string, value: l.value as string }));
  }
  if (capabilities?.includes("codegen") && !codegenLanguages?.length) errors.push('a codegen plugin needs "codegenLanguages"');
  if (errors.length) return { errors };
  const manifest: PluginManifest = {
    name: (m.name as string).trim(),
    id,
    api: m.api as string,
    main: m.main as string,
    ...(ui !== undefined ? { ui } : {}),
    ...(editorType ? { editorType } : {}),
    ...(m.documentAccess === "dynamic-page" ? { documentAccess: "dynamic-page" as const } : {}),
    ...(networkAccess ? { networkAccess } : {}),
    ...(params ? { parameters: params } : {}),
    ...(m.parameterOnly === true ? { parameterOnly: true } : {}),
    ...(items ? { menu: items } : {}),
    ...(relaunchButtons ? { relaunchButtons } : {}),
    ...(m.enableProposedApi === true ? { enableProposedApi: true } : {}),
    ...(m.enablePrivatePluginApi === true ? { enablePrivatePluginApi: true } : {}),
    ...(isStr(m.build) ? { build: m.build } : {}),
    ...(permissions ? { permissions } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(codegenLanguages ? { codegenLanguages } : {}),
    ...(Array.isArray(m.codegenPreferences) ? { codegenPreferences: m.codegenPreferences as PluginManifest["codegenPreferences"] } : {}),
  };
  return { manifest, warnings };
}

/** The editor types a manifest runs in here (Figma design and Dev Mode; the others are set aside). */
export function runnableIn(manifest: Pick<PluginManifest, "editorType">): ("figma" | "dev")[] {
  const types = manifest.editorType ?? ["figma"];
  return (["figma", "dev"] as const).filter((t) => types.includes(t));
}

/** Why a manifest can't run in this app, or null (Figma's wording where it has one). */
export function notRunnableReason(manifest: Pick<PluginManifest, "editorType">): string | null {
  return runnableIn(manifest).length ? null : "This plugin doesn't run in Figma Design or Dev Mode";
}
