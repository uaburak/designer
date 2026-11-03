/**
 * Guests — people without an account who open a file's or a prototype's link (docs/multiplayer.md §2 "Guests"; Figma:
 * "anyone with the link can view it without an account", help.figma.com 360040321093). `POST /auth/guest` hands the
 * browser a signed guest token with a random id and an anonymous name; the token reaches only a file's viewing routes
 * — the file's row, the password's unlock, the snapshot, its images and the room's socket — and always as a viewer,
 * whatever the link gives: editing, commenting, exporting, sharing and Dev Mode need an account, as in Figma.
 */
import type { AccessResult } from "../../../src/shared/org/access";
import type { User } from "../db";
import { HttpError } from "../org/http";
import { randomToken, signToken } from "../tokens";

/** The token's payload; `typ` keeps it from passing for a session (whose payload has `uid`) */
export interface GuestPayload {
  typ: "guest";
  /** `g_` + random: the guest's id in rooms and link passes */
  g: string;
  /** "Anonymous Capybara" */
  n: string;
  exp: number;
}

export const GUEST_DAYS = 7;

/** Figma's anonymous viewers are "Anonymous <animal>" */
const ANIMALS = ["Axolotl", "Badger", "Capybara", "Dolphin", "Eagle", "Fox", "Giraffe", "Hedgehog", "Ibis", "Jaguar", "Koala", "Lemur", "Moose", "Narwhal", "Otter", "Panda", "Quokka", "Raccoon", "Sloth", "Tiger", "Wombat", "Yak", "Zebra"];

/** `POST /auth/guest` → `{token, user: {id, name}}` */
export async function guestToken(secret: string, nowSeconds: number): Promise<Response> {
  const id = `g_${randomToken(12)}`;
  const name = `Anonymous ${ANIMALS[crypto.getRandomValues(new Uint32Array(1))[0] % ANIMALS.length]}`;
  const payload: GuestPayload = { typ: "guest", g: id, n: name, exp: nowSeconds + GUEST_DAYS * 86400 };
  const token = await signToken({ ...payload }, secret);
  return new Response(JSON.stringify({ token, user: { id, name } }), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

export const isGuestPayload = (p: unknown): p is GuestPayload => !!p && typeof p === "object" && (p as { typ?: unknown }).typ === "guest" && typeof (p as { g?: unknown }).g === "string" && /^g_[A-Za-z0-9_-]{8,32}$/.test((p as { g: string }).g);

/** The guest as a user nobody stored: no email, so no grant, membership or invitation can match it */
export const guestUser = (p: GuestPayload): User => ({ id: p.g, email: "", name: p.n, picture: null, tokenVersion: 0 });

/** The routes a guest reaches: viewing one file by its key, nothing else (else 401 `login_required`) */
export function requireGuestRoute(parts: readonly string[], method: string, url: URL): void {
  const ok =
    parts[0] === "files" &&
    parts.length >= 2 &&
    ((parts.length === 2 && method === "GET") ||
      (parts.length === 3 && parts[2] === "unlock" && method === "POST") ||
      (parts.length === 3 && parts[2] === "snapshot" && method === "GET" && url.searchParams.get("purpose") !== "export") ||
      (parts.length === 4 && parts[2] === "blobs" && (method === "GET" || (parts[3] === "missing" && method === "POST"))) ||
      (parts.length === 3 && parts[2] === "ws" && method === "GET"));
  if (!ok) throw new HttpError(401, "log in to do that", "login_required");
}

/** What a guest gets of the file: its link's viewing, never more */
export function guestAccess(a: AccessResult): AccessResult {
  if (!a.ok) return a;
  if (!a.via.includes("link")) return { ok: false, reason: "none", role: null };
  return { ...a, role: "viewer", roomRole: "viewer", canEdit: false, canComment: false, canExport: false, canDevMode: false, canShare: false, canManage: false, capped: null, via: ["link"] };
}
