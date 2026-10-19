import type { CodegenPreference, PluginEditorType, PluginManifest, PluginMenuItem, PluginParameter } from "./types";
import { domainEntryError, needsReasoning } from "./network";

/**
 * Figma's manifest.json (docs/plugins.md §4), checked by main before anything of a development plugin is read and
 * by the editor before a run. Pure: main's `manifests.ts` reads the file, this decides. Only Figma's fields are kept,
 * each of its type; anything else is dropped. The editor may pass the JSON text, and a development manifest's `path`
 * (a manifest without an `id` then gets `dev:<hash of the path>`). Figma's validator texts where it has one
 * (docs/research/atlas/17-plugins.md §4.1, §5.2).
 */

export type ManifestResult = { manifest: PluginManifest; warnings: string[] } | { errors: string[] };

const EDITOR_TYPES: readonly PluginEditorType[] = ["figma", "figjam", "dev", "slides", "buzz"];
/** Figma's hint lists these (not `inspect`, the legacy name of `dev`; nor `sites`, which we don't list as a type) */
const EDITOR_HINT = 'Specify a combination of ["figma", "figjam", "dev", "sites", "slides", "buzz"]';
const PERMISSIONS = ["currentuser", "activeusers", "fileusers", "payments", "teamlibrary", "clipboardwrite"] as const;
/** Figma's internal permissions: accepted in a manifest, never granted to a plugin of ours */
const INTERNAL_PERMISSIONS = ["openexternal", "analytics", "cortex", "debug", "framejudge", "filekey", "hidecursors", "ai-assistant", "camera", "microphone", "displaycapture"] as const;
const CAPABILITIES = ["textreview", "codegen", "inspect", "vscode", "panel", "linkpreview", "lint"] as const;
/** Capabilities that need `dev` in `editorType` (Figma's validator) */
const DEV_CAPABILITIES = ["panel", "inspect", "codegen", "linkpreview", "vscode"];
/** A file named by the manifest: relative, inside the plugin's folder (main checks again after symlinks) */
const isRelPath = (p: unknown): p is string => typeof p === "string" && p.length > 0 && p.length <= 1024 && !p.startsWith("/") && !p.startsWith("\\") && !/^[a-z]:/i.test(p) && !p.split(/[\\/]/).includes("..") && !p.includes("\0");
const isStr = (v: unknown, max = 1000): v is string => typeof v === "string" && v.length <= max;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A parameter list with Figma's rules (non-empty, unique keys, optional ones last); `at` is Figma's path text. */
function parameters(v: unknown, at: string, errors: string[]): PluginParameter[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return void errors.push(`${at}.parameters must be a list`), undefined;
  if (!v.length) return void errors.push(`Expected "${at}.parameters" to have non-empty parameter list.`), undefined;
  const keys = new Set<string>();
  let optional = false;
  return v.flatMap((p, i) => {
    if (!isObj(p) || !isStr(p.name) || !p.name || !isStr(p.key, 200) || !p.key) return errors.push(`${at}.parameters[${i}] needs a name and a key`), [];
    if (keys.has(p.key)) errors.push(`Expected "${at}.parameters" to have unique keys, but got more than one parameter with key: "${p.key}"`);
    keys.add(p.key);
    if (p.optional === true) optional = true;
    else if (optional) errors.push(`Optional parameters must be listed last in the parameter list. ${p.key} not marked as optional.`);
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
    const params = parameters(item.parameters, here, errors);
    if (params) out.parameters = params;
    if (typeof item.parameterOnly === "boolean") out.parameterOnly = item.parameterOnly;
    if (item.parameterOnly === true && !params?.length) errors.push(`Expected parameters to be defined for "${here}" marked as parameterOnly.`);
    return [out];
  });
}

/** `allowedDomains` / `devAllowedDomains` with Figma's texts (§4.1): each a URL with its scheme, no duplicates. */
function domains(v: unknown, field: "allowedDomains" | "devAllowedDomains", errors: string[]): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return void errors.push(`Invalid value for ${field}. It must be a list.`), undefined;
  const out: string[] = [];
  for (const d of v) {
    const entry = typeof d === "string" ? d.trim() : String(d).slice(0, 200);
    if (out.includes(entry)) {
      errors.push(`Invalid value for ${field}. '${entry}' is duplicated.`);
      continue;
    }
    const problem = entry === "none" && field === "allowedDomains" ? null : domainEntryError(d);
    if (problem === "scheme" && field === "allowedDomains") errors.push(`Invalid value for allowedDomains. '${entry}' must include a scheme, such as https://.`);
    else if (problem) errors.push(`Invalid value for ${field}. '${entry}' must be a valid URL.`);
    else out.push(entry);
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
  if (json.containsWidget === true || json.widgetApi !== undefined) return { errors: ["Widgets aren't supported in Wecra yet"] };
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
  // Figma: a manifest names its editors ("inspect" is the legacy name of "dev"; "sites" is Figma Sites, not run here).
  if (json.editorType === undefined) errors.push(`Missing editorType in manifest.  ${EDITOR_HINT}`);
  else if (!Array.isArray(json.editorType) || !json.editorType.length || !json.editorType.every((t) => EDITOR_TYPES.includes(t as PluginEditorType) || t === "inspect" || t === "sites")) errors.push(`Invalid editorType in manifest.  ${EDITOR_HINT}`);
  else {
    const types = (json.editorType as string[]).map((t) => (t === "inspect" ? "dev" : t)).filter((t): t is PluginEditorType => EDITOR_TYPES.includes(t as PluginEditorType));
    m.editorType = [...new Set(types)];
  }
  if (json.documentAccess !== undefined) {
    if (json.documentAccess !== "dynamic-page") errors.push('"documentAccess" must be "dynamic-page"');
    else m.documentAccess = "dynamic-page";
  }
  if (json.networkAccess !== undefined) {
    const n = json.networkAccess;
    if (!isObj(n)) errors.push('"networkAccess" must be an object');
    else {
      const listed = Array.isArray(n.allowedDomains) && n.allowedDomains.length > 0;
      const allowed = listed ? domains(n.allowedDomains, "allowedDomains", errors) : undefined;
      if (!listed) errors.push('Invalid value for allowedDomains. To block all network access, set allowedDomains: ["none"]');
      else if (allowed?.includes("none") && (n.allowedDomains as unknown[]).length > 1) errors.push("Invalid value for allowedDomains. 'none' must be the only value in the array.");
      const dev = domains(n.devAllowedDomains, "devAllowedDomains", errors);
      const reasoning = typeof n.reasoning === "string" ? n.reasoning : undefined;
      if (n.reasoning !== undefined && reasoning === undefined) errors.push('Invalid value for networkAccess. The "reasoning" field must be a string.');
      if (reasoning !== undefined && reasoning.length >= 1000) errors.push('Invalid value for networkAccess. The "reasoning" field must be less than 1000 characters.');
      m.networkAccess = { allowedDomains: allowed ?? [] };
      if (reasoning !== undefined) m.networkAccess.reasoning = reasoning;
      if (dev) m.networkAccess.devAllowedDomains = dev;
      // Figma: "*" and localhost are errors without a reasoning (localhost for development belongs in devAllowedDomains).
      if (!reasoning?.trim()) {
        if ((allowed ?? []).includes("*")) errors.push('Invalid value for networkAccess. If you want to allow all domains, please add a "reasoning" field to the networkAccess object.');
        else if ((allowed ?? []).some((d) => d !== "none" && needsReasoning(d))) errors.push('Invalid value for networkAccess. If you want to allow localhost, please add a "reasoning" field to the networkAccess object. If you only need to access localhost for development, please add a "devAllowedDomains" field instead.');
      }
    }
  }
  if (json.menu !== undefined && json.parameters !== undefined) errors.push("manifest.parameters should not be specified when menu items are defined");
  const params = parameters(json.parameters, "manifest", errors);
  if (params) m.parameters = params;
  if (typeof json.parameterOnly === "boolean") m.parameterOnly = json.parameterOnly;
  if (json.parameterOnly === true && json.menu === undefined && !params?.length) errors.push('Expected parameters to be defined for "manifest" marked as parameterOnly.');
  const items = menu(json.menu, "manifest.menu", errors);
  if (items) m.menu = items;
  if (json.relaunchButtons !== undefined) {
    if (!Array.isArray(json.relaunchButtons)) errors.push('"relaunchButtons" must be a list');
    else {
      const seen = new Set<string>();
      m.relaunchButtons = json.relaunchButtons.flatMap((b, i) => {
        if (!isObj(b) || !isStr(b.command, 200) || !isStr(b.name) || !b.name) return errors.push(`relaunchButtons[${i}] needs a command and a name`), [];
        if (seen.has(b.command)) errors.push(`Expected "manifest.relaunchButtons" to have unique commands, but got more than one button with command: "${b.command}"`);
        seen.add(b.command);
        return [{ command: b.command, name: b.name, ...(typeof b.multipleSelection === "boolean" ? { multipleSelection: b.multipleSelection } : {}) }];
      });
    }
  }
  if (typeof json.enableProposedApi === "boolean") m.enableProposedApi = json.enableProposedApi;
  if (typeof json.enablePrivatePluginApi === "boolean") m.enablePrivatePluginApi = json.enablePrivatePluginApi;
  // Kept and shown, never run (§3.3): running a manifest's shell command is refused.
  if (isStr(json.build, 2000)) m.build = json.build;
  if (json.permissions !== undefined) {
    if (!Array.isArray(json.permissions)) errors.push('"permissions" must be a list');
    else {
      for (const p of json.permissions) if (!(PERMISSIONS as readonly unknown[]).includes(p) && !(INTERNAL_PERMISSIONS as readonly unknown[]).includes(p)) errors.push(`Invalid permission specified: ${String(p)}`);
      // Figma strips its internal permissions from untrusted local and installed plugins (all of ours are such).
      if (json.permissions.some((p) => (INTERNAL_PERMISSIONS as readonly unknown[]).includes(p))) warnings.push("Untrusted local plugin denied internal api permissions");
      m.permissions = [...new Set(json.permissions.filter((p): p is (typeof PERMISSIONS)[number] => (PERMISSIONS as readonly unknown[]).includes(p)))];
    }
  }
  if (json.capabilities !== undefined) {
    if (!Array.isArray(json.capabilities)) errors.push('"capabilities" must be a list');
    else {
      for (const c of json.capabilities) {
        if (!(CAPABILITIES as readonly unknown[]).includes(c)) errors.push(`Invalid capability specified: ${String(c)}`);
        else if (DEV_CAPABILITIES.includes(c as string) && m.editorType && !m.editorType.includes("dev")) errors.push(`Capability "${String(c)}" requires "editorType" to include "dev"`);
      }
      m.capabilities = [...new Set(json.capabilities.filter((c): c is (typeof CAPABILITIES)[number] => (CAPABILITIES as readonly unknown[]).includes(c)))];
    }
  }
  const codegen = !!m.capabilities?.includes("codegen");
  if (json.codegenLanguages !== undefined) {
    if (!Array.isArray(json.codegenLanguages) || !json.codegenLanguages.every((l) => isObj(l) && isStr(l.label, 200) && isStr(l.value, 200))) errors.push('"codegenLanguages" must be a list of {label, value}');
    else if (!codegen) errors.push("codegenLanguages only supported for codegen plugins");
    else m.codegenLanguages = (json.codegenLanguages as { label: string; value: string }[]).map((l) => ({ label: l.label, value: l.value }));
  }
  if (json.codegenPreferences !== undefined) {
    if (!Array.isArray(json.codegenPreferences) || !json.codegenPreferences.every((p) => isObj(p) && (p.itemType === "unit" || p.itemType === "select" || p.itemType === "action"))) errors.push('"codegenPreferences" items need an itemType of unit, select or action');
    else {
      // A plain-data copy: JSON in, JSON out.
      const prefs = JSON.parse(JSON.stringify(json.codegenPreferences)) as CodegenPreference[];
      const actions = prefs.filter((p) => p.itemType === "action").map((p) => p.propertyName);
      if (new Set(actions).size !== actions.length) errors.push('codegenPreferences "action" itemType settings must have unique propertyName values');
      if (prefs.some((p) => p.itemType === "select" && (p.options ?? []).filter((o) => o.isDefault).length !== 1)) errors.push('codegenPreferences itemType: "select" should have exactly one default option');
      if (prefs.filter((p) => p.itemType === "unit").length > 1) errors.push('codegenPreferences should have at most one itemType: "unit"');
      m.codegenPreferences = prefs;
    }
  }
  if (codegen && !(Array.isArray(json.codegenLanguages) && json.codegenLanguages.length)) errors.push("codegen plugins must define at least one language in codegenLanguages");
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
  return runnableIn(manifest).length ? null : 'The manifest editorType does not include "figma"';
}
