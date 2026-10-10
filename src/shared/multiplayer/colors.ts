/**
 * Multiplayer colours (docs/multiplayer.md §6): each person in a file gets one, by their room session, for their
 * cursor, name chip, selection outlines and avatar ring. Saturated, distinct on the light and dark canvas.
 */
export const PEER_COLORS = ["#f24822", "#9747ff", "#0d99ff", "#14ae5c", "#ff7262", "#ffcd29", "#1bc4b5", "#ff24bd", "#667799", "#a259ff", "#fe7a00", "#4d6aff"] as const;

export function peerColor(sessionID: number): string {
  return PEER_COLORS[(((sessionID - 1) % PEER_COLORS.length) + PEER_COLORS.length) % PEER_COLORS.length];
}
