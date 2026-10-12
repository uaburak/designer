/**
 * The identity the Worker hands a file's room (`x-user-id`, `x-user-name`, `x-role` — policy/region.ts `roomsOn`, read
 * by fileRoom.ts and roomBox.ts). Header values are bytes, not text: a name like "Burak Koç" or "Şule" isn't a valid
 * value (Workers re-encode it with a warning, Node's Headers refuse characters past U+00FF), so free text rides
 * percent-encoded (`encodeURIComponent`) and is decoded by the room. A value that isn't valid percent-encoding is taken
 * as it is (an older Worker's raw name during a deploy).
 */

/** A header value for free text (a person's name): ASCII only */
export const headerText = (text: string): string => encodeURIComponent(text);

/** The text of a `headerText` value; null when absent or empty */
export function fromHeaderText(value: string | null): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value) || null;
  } catch {
    return value;
  }
}

/** The identity headers of a room call */
export function setIdentityHeaders(headers: Headers, identity: { userId: string; name: string | null; role: string }): void {
  headers.set("x-user-id", identity.userId);
  headers.set("x-user-name", headerText(identity.name ?? ""));
  headers.set("x-role", identity.role);
}
