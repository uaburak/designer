import { app, safeStorage } from "electron";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_AI_SETTINGS, type AiAction, type AiRoute, type AiSettings } from "../../shared/ai/types";
import { t } from "../../shared/i18n";

/**
 * Settings › AI (docs/ai.md §2.1, §7): kept by main in userData/ai/settings.json; the image APIs' keys (OpenAI,
 * Gemini) in userData/ai/keys.json, sealed with safeStorage (the OS keychain) — the views only learn whether one is
 * set (`imageKeys`). 6b's image clients read a key with `imageKey`.
 */

export const AI_ACTIONS: readonly AiAction[] = [
  "rename-layers", "rewrite", "translate", "shorten", "replace-content", "add-interactions", "first-draft",
  "make-image", "edit-image", "remove-background", "boost-resolution", "expand-image", "erase-object", "isolate-object", "vectorize",
  "visual-search", "search", "agent",
];

const dir = () => join(app.getPath("userData"), "ai");
const file = (name: string) => join(dir(), name);

function writePrivate(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

function readJson<T>(path: string): Partial<T> {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return v && typeof v === "object" ? (v as Partial<T>) : {};
  } catch {
    return {};
  }
}

/** A route as plain checked data, or null. */
export function cleanRoute(v: unknown): AiRoute | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const id = typeof r.providerId === "string" && r.providerId.length > 0 && r.providerId.length <= 100 ? r.providerId : null;
  if (!id) return null;
  const opt = (x: unknown, max: number) => (typeof x === "string" && x.length > 0 && x.length <= max ? x : undefined);
  const model = opt(r.model, 300);
  const effort = opt(r.effort, 20);
  return { providerId: id, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

/** A stored or patched settings object made whole and valid (`imageKeys` is never taken from it). */
export function cleanSettings(raw: Partial<AiSettings>, base: AiSettings = DEFAULT_AI_SETTINGS): Omit<AiSettings, "imageKeys"> {
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const actions: Partial<Record<AiAction, AiRoute>> = {};
  const src = raw.actions && typeof raw.actions === "object" ? raw.actions : base.actions;
  for (const a of AI_ACTIONS) {
    const r = cleanRoute((src as Record<string, unknown>)[a]);
    if (r) actions[a] = r;
  }
  const credits = typeof raw.monthlyCredits === "number" && Number.isFinite(raw.monthlyCredits) ? Math.max(0, Math.min(10_000_000, Math.round(raw.monthlyCredits))) : base.monthlyCredits;
  return {
    enabled: bool(raw.enabled, base.enabled),
    text: "text" in raw ? cleanRoute(raw.text) : base.text,
    image: "image" in raw ? cleanRoute(raw.image) : base.image,
    actions,
    monthlyCredits: credits,
    stopAtLimit: bool(raw.stopAtLimit, base.stopAtLimit),
    indexForSearch: bool(raw.indexForSearch, base.indexForSearch),
  };
}

const canEncrypt = () => {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
};

type Keys = Partial<Record<"openai" | "gemini", string>>;

const readKeys = (): Keys => readJson<Keys>(file("keys.json"));

/** An image API's key (6b's clients), or null. */
export function imageKey(provider: "openai" | "gemini"): string | null {
  const v = readKeys()[provider];
  if (!v?.startsWith("enc:")) return null;
  try {
    return safeStorage.decryptString(Buffer.from(v.slice(4), "base64"));
  } catch {
    return null;
  }
}

export function aiSettings(): AiSettings {
  const stored = cleanSettings(readJson<AiSettings>(file("settings.json")));
  const keys = readKeys();
  return { ...stored, imageKeys: { openai: !!keys.openai, gemini: !!keys.gemini } };
}

export function setAiSettings(patch: Partial<Omit<AiSettings, "imageKeys">>): AiSettings {
  const now = aiSettings();
  const p = patch && typeof patch === "object" ? patch : {};
  const merged = cleanSettings({ ...now, ...p, actions: p.actions && typeof p.actions === "object" ? p.actions : now.actions }, now);
  writePrivate(file("settings.json"), JSON.stringify(merged, null, 1));
  return aiSettings();
}

export function setImageKey(p: { provider: "openai" | "gemini"; key: string | null }): AiSettings {
  if (p?.provider !== "openai" && p?.provider !== "gemini") throw new Error("ai:set-image-key: openai or gemini");
  const keys = readKeys();
  const key = typeof p.key === "string" ? p.key.trim() : "";
  if (key) {
    if (key.length > 4000) throw new Error("ai:set-image-key: the key is too long");
    if (!canEncrypt()) throw new Error(t("This computer's keychain isn't available: the key wasn't kept"));
    keys[p.provider] = `enc:${safeStorage.encryptString(key).toString("base64")}`;
  } else delete keys[p.provider];
  writePrivate(file("keys.json"), JSON.stringify(keys));
  return aiSettings();
}

/** The runs' working folders (a CLI's empty folder per run). */
export const aiWorkDir = () => file("work");
