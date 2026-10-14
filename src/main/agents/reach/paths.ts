import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Which local paths agents may read (docs/agents-reach.md §10): inside a folder the owner granted — after `realpath`,
 * so `..` and symlinks can't lead out — and not on the deny list (keys, credentials, browser profiles, .env files).
 * A denied or outside path answers one sentence that says nothing about whether it exists.
 */

export const OFF_LIMITS = "This path is off limits: it is outside the folders the owner granted, or it may hold secrets.";

/** A name (one part of a path) that may hold secrets. */
const DENIED_NAMES: RegExp[] = [
  /^\.ssh$/i, /^\.gnupg$/i, /^\.aws$/i, /^\.azure$/i, /^\.kube$/i, /^\.docker$/i, /^\.netrc$/i, /^\.npmrc$/i, /^\.pypirc$/i, /^\.git-credentials$/i,
  /^keychains$/i, /^\.password-store$/i, /^\.env$/i, /^\.env\..+/i, /credential/i, /secret/i, /password/i,
  /^id_rsa/i, /^id_ed25519/i, /^id_ecdsa/i, /^id_dsa/i,
  /\.(pem|key|p12|pfx|keystore|jks|kdbx|asc|gpg)$/i,
  /^cookies(\.binarycookies)?$/i, /^login data$/i,
];

/** Parts of a path (in order) that mark a browser profile or another app's secrets. */
const DENIED_SEQUENCES: string[][] = [
  [".config", "gh"],
  [".config", "gcloud"],
  ["Library", "Application Support", "Google", "Chrome"],
  ["Library", "Application Support", "Firefox"],
  ["Library", "Application Support", "BraveSoftware"],
  ["Library", "Application Support", "Microsoft Edge"],
  ["Library", "Application Support", "Arc"],
  ["Library", "Safari"],
  ["Library", "Cookies"],
  ["AppData", "Local", "Google", "Chrome"],
  ["AppData", "Roaming", "Mozilla"],
];

const partsOf = (p: string) => p.split(/[\\/]+/).filter(Boolean);

/** Whether a (real) path is on the deny list: any part a secret's name, a browser profile, or inside `.git`. */
export function isDeniedPath(path: string): boolean {
  const parts = partsOf(path);
  if (parts.some((part) => DENIED_NAMES.some((re) => re.test(part)))) return true;
  // .git internals (objects, config with remotes' credentials); the work tree beside it is fine
  if (parts.includes(".git")) return true;
  const lower = parts.map((x) => x.toLowerCase());
  return DENIED_SEQUENCES.some((seq) => {
    const s = seq.map((x) => x.toLowerCase());
    for (let i = 0; i + s.length <= lower.length; i++) if (s.every((x, k) => lower[i + k] === x)) return true;
    return false;
  });
}

/** `child` is `parent` or inside it (both real, absolute). */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel) && rel.split(sep)[0] !== "..");
}

/** Why a folder can't be granted (too wide, or itself denied), or null. */
export function grantProblem(real: string, home = homedir()): string | null {
  const wide = ["/", "/System", "/Library", "/usr", "/bin", "/sbin", "/etc", "/private", "/var", "/opt", "/Applications", "/Users", "/Volumes", home, join(home, "Library")];
  if (wide.some((w) => resolve(w) === resolve(real)) || /^[A-Za-z]:\\?$/.test(real)) return "That folder is too wide to grant: pick the project's own folder.";
  if (isDeniedPath(real)) return "That folder may hold secrets and can't be granted.";
  return null;
}

export type Resolved = { ok: true; real: string; grant: string } | { ok: false; reason: string };

/**
 * A path an agent asked for, as a real path inside a grant: absolute, or relative to the only grant. Made real
 * (`realpath`), so `..` and symlinks resolve before the check; then the deny list. `real` is injectable for tests.
 */
export function resolveGrantedPath(input: string, grants: readonly string[], real: (p: string) => string = realpathSync): Resolved {
  const raw = String(input ?? "").trim();
  if (!grants.length) return { ok: false, reason: "No folder is granted. The owner can add one in Agent settings › Access › Local files." };
  if (!raw) return { ok: false, reason: "Give a path." };
  if (raw.includes("\0")) return { ok: false, reason: OFF_LIMITS };
  let abs: string;
  if (isAbsolute(raw)) abs = raw;
  else if (raw.startsWith("~")) abs = join(homedir(), raw.slice(1));
  else if (grants.length === 1) abs = join(grants[0], raw);
  else return { ok: false, reason: `Give an absolute path: more than one folder is granted (${grants.map((g) => basename(g)).join(", ")}).` };
  let r: string;
  try {
    r = real(abs);
  } catch {
    // Not there (or not readable): the same answer whether it is inside or not, so nothing outside is probed.
    return { ok: false, reason: grants.some((g) => isInside(resolve(abs), g)) && !isDeniedPath(abs) ? "No such file or folder." : OFF_LIMITS };
  }
  const grant = grants.find((g) => isInside(r, g));
  if (!grant || isDeniedPath(r)) return { ok: false, reason: OFF_LIMITS };
  return { ok: true, real: r, grant };
}
