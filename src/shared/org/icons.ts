/**
 * Organization and team icons (docs/multiplayer.md §14.16), the parts the store and the views share: the limits, the
 * server's URL shape and bytes → data: URL. No Node or DOM imports (`btoa` is in both).
 */

/** The server refuses more (server/src/org/iconImage.ts) */
export const ICON_MAX_BYTES = 1024 * 1024;
/** The square the views crop an image to before uploading */
export const ICON_SIZE = 256;
/** What "Change icon" accepts (the file picker's `accept`) */
export const ICON_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

/** `/icons/<orgId>/<sha1>`: the server's icon route (OrgSummary.iconUrl, TeamSummary.iconUrl) */
export const ICON_URL = /^\/icons\/[0-9A-Za-z_-]{1,64}\/[0-9a-f]{40}$/;

/** `/files/<key>/thumbnail?v=<n>`: an org file's thumbnail (OrgFile.thumbnailUrl; `v` changes with each upload) */
export const THUMBNAIL_URL = /^\/files\/[0-9A-Za-z_-]{1,64}\/thumbnail(\?v=\d{1,16})?$/;

/** The picture's type from its first bytes; null for anything else */
export function iconMime(b: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}
