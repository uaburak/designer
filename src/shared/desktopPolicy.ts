/** Managed deployment keys (docs/desktop.md §12.5; Figma's names) as main read them at start */
export interface DesktopPolicy {
  disableUpdater: boolean;
  /** Empty: no restriction */
  allowedOriginHosts: string[];
  /** null: the system's settings; "direct://": no proxy */
  proxyUrl: string | null;
  /** Where each key came from ("HKLM", "HKCU", "/Library/Managed Preferences", "/Library/Preferences", "user") — logged at start */
  sources: Partial<Record<"DisableUpdater" | "AllowedOriginHosts" | "ProxyUrl", string>>;
}

export const NO_POLICY: DesktopPolicy = { disableUpdater: false, allowedOriginHosts: [], proxyUrl: null, sources: {} };

/** An origin against AllowedOriginHosts entries: "https://*.example.com" matches https subdomains of example.com (not
 *  example.com itself), "https://example.com" that origin exactly, a bare "example.com" means https://example.com. */
export function originAllowed(origin: string, patterns: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  return patterns.some((raw) => {
    const p = raw.trim().toLowerCase();
    if (!p) return false;
    const withScheme = /^[a-z]+:\/\//.test(p) ? p : `https://${p}`;
    const scheme = withScheme.slice(0, withScheme.indexOf("://") + 1);
    const host = withScheme.slice(withScheme.indexOf("://") + 3).replace(/\/.*$/, "");
    if (u.protocol !== scheme) return false;
    if (host.startsWith("*.")) return u.host.endsWith(host.slice(1)) && u.host.length > host.length - 1;
    return u.host === host;
  });
}
