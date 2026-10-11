import type { CodegenPreference, PluginEditorType, PluginManifest, PluginMenuItem, PluginParameter } from "./types";
import { needsReasoning, parseDomain } from "./network";

/**
 * Figma's manifest.json (docs/plugins.md §4), checked by main before anything of a development plugin is read and
 * by the editor before a run. Pure: main's `manifests.ts` reads the file, this decides. Only Figma's fields are kept,
 * each of its type; anything else is dropped. The editor may pass the JSON text, and a development manifest's `path`
 * (a manifest without an `id` then gets `dev:<hash of the path>`).
 */

export type ManifestResult = { manifest: PluginManifest; warnings: string[] } | { errors: string[] };

const EDITOR_TYPES: readonly PluginEditorType[] = ["figma", "figjam", "dev", "slides", "buzz"];
const PERMISSIONS = ["currentuser", "activeusers", "fileusers", "payments", "teamlibrary"] as const;
const CAPABILITIES = ["textreview", "codegen", "inspect", "vscode"] as const;
/** A file named by the manifest: relative, inside the plugin's folder (main checks again after symlinks) */
const isRelPath = (p: unknown): p is string => typeof p === "string" && p.length > 0 && p.length <= 1024 && !p.startsWith("/") && !p.startsWith("\\") && !/^[a-z]:/i.test(p) && !p.split(/[\\/]/).includes("..") && !p.includes("\0");
const isStr = (v: unknown, max = 1000): v is string => typeof v === "string" && v.length <= max;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function parameters(v: unknown, at: string, errors: string[]): PluginParameter[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return void errors.push(`${at} must be a list`), undefined;
  return v.flatMap((p, i) => {
    if (!isObj(p) || !isStr(p.name) || !p.name || !isStr(p.key, 200) || !p.key) return errors.push(`${at}[${i}] needs a name and a key`), [];
    const out: PluginParameter = { name: p.name, key: p.key };
    if (isStr(p.description)) out.description = p.description;
    if (typeof p.allowFreeform === "boolean") out.allowFreeform = p.allowFreeform;
    if (typeof p.optional === "boolean") out.optional = p.optional;
    return [out];
  });
}

function menu(v: unknown, at: string, errors: string[], depth = 0): PluginMenuItem[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || depth > 8) return void errors.push(`${at} must be a list`), undefined;
  return v.flatMap((item, i): PluginMenuItem[] => {
    const here = `${at}[${i}]`;
    if (!isObj(item)) return errors.push(`${here} isn't a menu item`), [];
    if (item.separator === true) return [{ separator: true }];
    if (!isStr(item.name) || !item.name) return errors.push(`${here} needs a name`), [];
    if (item.menu !== undefined) return [{ name: item.name, menu: menu(item.menu, `${here}.menu`, errors, depth + 1) ?? [] }];
    if (!isStr(item.command, 200)) return errors.push(`${here} needs a command or a menu`), [];
    const out: PluginMenuItem = { name: item.name, command: item.command };
    const params = parameters(item.parameters, `${here}.parameters`, errors);
    if (params) out.parameters = params;
    if (typeof item.parameterOnly === "boolean") out.parameterOnly = item.parameterOnly;
    return [out];
  });
}

function domains(v: unknown, at: string, errors: string[]): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return void errors.push(`${at} must be a list`), undefined;
  const out: string[] = [];
  for (const d of v) {
    if (d === "none") out.push(d);
    else if (parseDomain(d)) out.push((d as string).trim());
    else errors.push(`${at}: "${String(d).slice(0, 200)}" isn't a domain`);
  }
  return out;
}

/** `{manifest, warnings}` or `{errors}`. `development`: a manifest without an `id` is accepted (main names it). */
export function parseManifest(input: unknown, opts: { development?: boolean; path?: string } = {}): ManifestResult {
  let json = input;
  if (typeof json === "string") {
    try {
      json = JSON.parse(json) as unknown;
    } catch (e) {
      return { errors: [`manifest.json isn't valid JSON: ${(e as Error).message}`] };
    }
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(json)) return { errors: ["The manifest isn't a JSON object"] };
  if (json.containsWidget === true || json.widgetApi !== undefined) return { errors: ["Widgets aren't supported in DesignerV2 yet"] };
  if (!isStr(json.name, 300) || !json.name.trim()) errors.push('"name" is required');
  if (json.id !== undefined && (!isStr(json.id, 200) || !json.id)) errors.push('"id" must be a string');
  if (json.id === undefined && !opts.development) errors.push('"id" is required');
  if (!isStr(json.api, 40) || !json.api) errors.push('"api" is required');
  if (!isRelPath(json.main)) errors.push('"main" must be a file inside the plugin\'s folder');
  const id = typeof json.id === "string" ? json.id : opts.development && opts.path ? developmentId(opts.path) : "";
  const m: PluginManifest = { name: String(json.name ?? "").trim(), id, api: String(json.api ?? ""), main: String(json.main ?? "") };

  if (json.ui !== undefined) {
    if (isRelPath(json.ui)) m.ui = json.ui;
    else if (isObj(json.ui) && Object.keys(json.ui).length > 0 && Object.keys(json.ui).length <= 50 && Object.entries(json.ui).every(([k, p]) => /^[A-Za-z0-9_.-]{1,64}$/.test(k) && isRelPath(p))) m.ui = { ...(json.ui as Record<string, string>) };
    else errors.push('"ui" must be a file inside the plugin\'s folder, or a map of them');
  }
  if (json.editorType !== undefined) {
    if (!Array.isArray(json.editorType) || !json.editorType.length || !json.editorType.every((t) => EDITOR_TYPES.includes(t as PluginEditorType))) errors.push('"editorType" must list figma, figjam, dev, slides or buzz');
    else m.editorType = [...new Set(json.editorType as PluginEditorType[])];
  }
  if (json.documentAccess !== undefined) {
    if (json.documentAccess !== "dynamic-page") errors.push('"documentAccess" must be "dynamic-page"');
    else m.documentAccess = "dynamic-page";
  }
  if (json.networkAccess !== undefined) {
    const n = json.networkAccess;
    if (!isObj(n)) errors.push('"networkAccess" must be an object');
    else {
      const allowed = domains(n.allowedDomains, "networkAccess.allowedDomains", errors);
      if (!allowed?.length) errors.push('"networkAccess.allowedDomains" needs at least one entry');
      else if (allowed.includes("none") && allowed.length > 1) errors.push('"none" must be the only entry of networkAccess.allowedDomains');
      const dev = domains(n.devAllowedDomains, "networkAccess.devAllowedDomains", errors);
      const reasoning = isStr(n.reasoning, 2000) ? n.reasoning : undefined;
      if (n.reasoning !== undefined && reasoning === undefined) errors.push('"networkAccess.reasoning" must be a string');
      m.networkAccess = { allowedDomains: allowed ?? [] };
      if (reasoning !== undefined) m.networkAccess.reasoning = reasoning;
      if (dev) m.networkAccess.devAllowedDomains = dev;
      // Figma asks for a reasoning with "*" and localhost; ours is a warning in the console, not an error (§4).
      if (!reasoning && (allowed ?? []).some((d) => d !== "none" && needsReasoning(d))) warnings.push('networkAccess: "*" and localhost need a "reasoning"');
    }
  }
  const params = parameters(json.parameters, "parameters", errors);
  if (params) m.parameters = params;
  if (typeof json.parameterOnly === "boolean") m.parameterOnly = json.parameterOnly;
  const items = menu(json.menu, "menu", errors);
  if (items) m.menu = items;
  if (json.relaunchButtons !== undefined) {
    if (!Array.isArray(json.relaunchButtons)) errors.push('"relaunchButtons" must be a list');
    else
      m.relaunchButtons = json.relaunchButtons.flatMap((b, i) => {
        if (!isObj(b) || !isStr(b.command, 200) || !isStr(b.name) || !b.name) return errors.push(`relaunchButtons[${i}] needs a command and a name`), [];
        return [{ command: b.command, name: b.name, ...(typeof b.multipleSelection === "boolean" ? { multipleSelection: b.multipleSelection } : {}) }];
      });
  }
  if (typeof json.enableProposedApi === "boolean") m.enableProposedApi = json.enableProposedApi;
  if (typeof json.enablePrivatePluginApi === "boolean") m.enablePrivatePluginApi = json.enablePrivatePluginApi;
  // Kept and shown, never run (§3.3): running a manifest's shell command is refused.
  if (isStr(json.build, 2000)) m.build = json.build;
  if (json.permissions !== undefined) {
    if (!Array.isArray(json.permissions) || !json.permissions.every((p) => (PERMISSIONS as readonly unknown[]).includes(p))) errors.push('"permissions" must list currentuser, activeusers, fileusers, payments or teamlibrary');
    else m.permissions = [...new Set(json.permissions as NonNullable<PluginManifest["permissions"]>)];
  }
  if (json.capabilities !== undefined) {
    if (!Array.isArray(json.capabilities) || !json.capabilities.every((c) => (CAPABILITIES as readonly unknown[]).includes(c))) errors.push('"capabilities" must list codegen, inspect, textreview or vscode');
    else m.capabilities = [...new Set(json.capabilities as NonNullable<PluginManifest["capabilities"]>)];
  }
  if (json.codegenLanguages !== undefined) {
    if (!Array.isArray(json.codegenLanguages) || !json.codegenLanguages.every((l) => isObj(l) && isStr(l.label, 200) && isStr(l.value, 200))) errors.push('"codegenLanguages" must be a list of {label, value}');
    else m.codegenLanguages = (json.codegenLanguages as { label: string; value: string }[]).map((l) => ({ label: l.label, value: l.value }));
  }
  if (json.codegenPreferences !== undefined) {
    if (!Array.isArray(json.codegenPreferences) || !json.codegenPreferences.every((p) => isObj(p) && (p.itemType === "unit" || p.itemType === "select" || p.itemType === "action"))) errors.push('"codegenPreferences" items need an itemType of unit, select or action');
    // A plain-data copy: JSON in, JSON out.
    else m.codegenPreferences = JSON.parse(JSON.stringify(json.codegenPreferences)) as CodegenPreference[];
  }
  if (m.capabilities?.includes("codegen") && !m.codegenLanguages?.length) errors.push('A codegen plugin needs "codegenLanguages"');
  return errors.length ? { errors } : { manifest: m, warnings };
}

/** Does it run in Figma Design or Dev Mode? (§4: one that doesn't is listed, disabled) */
export const runsHere = (m: PluginManifest) => !m.editorType || m.editorType.includes("figma") || m.editorType.includes("dev");

/** A manifest without an `id` gets one from its path (Figma assigns ids on publish): `dev:<hash>`. */
export function developmentId(path: string): string {
  // FNV-1a over two 32-bit lanes: stable, no crypto needed in the view.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return `dev:${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/** The editor types a manifest runs in here (Figma design and Dev Mode; the others are set aside). */
export function runnableIn(manifest: Pick<PluginManifest, "editorType">): ("figma" | "dev")[] {
  const types = manifest.editorType ?? ["figma"];
  return (["figma", "dev"] as const).filter((t) => types.includes(t));
}

/** Why a manifest can't run in this app, or null. */
export function notRunnableReason(manifest: Pick<PluginManifest, "editorType">): string | null {
  return runnableIn(manifest).length ? null : "This plugin doesn't run in Figma Design or Dev Mode";
}
