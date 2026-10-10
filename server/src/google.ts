/**
 * Google's web OAuth flow, run by the Worker (docs/multiplayer.md §2): the desktop app never holds the client secret.
 * The ID token comes straight from Google's token endpoint over HTTPS, so (per Google's OpenID Connect guide) its
 * signature needs no check; its claims do.
 */
import { fromB64url } from "./tokens";

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string | null;
  picture: string | null;
}

export function authorizeUrl(cfg: Pick<GoogleConfig, "clientId" | "redirectUri">, state: string): string {
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
    access_type: "online",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export class GoogleError extends Error {}

/** Exchanges Google's code for the account's profile (`now` in seconds). */
export async function exchangeCode(code: string, cfg: GoogleConfig, fetchImpl: typeof fetch, now: number): Promise<GoogleProfile> {
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, grant_type: "authorization_code" }),
  });
  if (!res.ok) throw new GoogleError(`token endpoint ${res.status}`);
  const { id_token } = (await res.json()) as { id_token?: string };
  if (!id_token) throw new GoogleError("no id_token");
  return checkIdToken(id_token, cfg.clientId, now);
}

export function checkIdToken(idToken: string, clientId: string, now: number): GoogleProfile {
  const part = idToken.split(".")[1];
  const json = part ? fromB64url(part) : null;
  if (!json) throw new GoogleError("malformed id_token");
  const c = JSON.parse(new TextDecoder().decode(json)) as Record<string, unknown>;
  if (c.iss !== "https://accounts.google.com" && c.iss !== "accounts.google.com") throw new GoogleError("wrong issuer");
  if (c.aud !== clientId) throw new GoogleError("wrong audience");
  if (typeof c.exp !== "number" || c.exp <= now) throw new GoogleError("expired");
  if (typeof c.sub !== "string" || typeof c.email !== "string") throw new GoogleError("no subject or email");
  if (c.email_verified !== true && c.email_verified !== "true") throw new GoogleError("email not verified");
  return { sub: c.sub, email: c.email, name: typeof c.name === "string" ? c.name : null, picture: typeof c.picture === "string" ? c.picture : null };
}
