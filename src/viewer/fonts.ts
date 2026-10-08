/**
 * The viewer's fonts: only the bundled Inter (Figma's Inter 3.19, upright and italic in one variable file), for the
 * canvas's own labels (frame titles, measurements) and texts set in Inter. Every other face is reported missing on
 * purpose: those texts draw from the glyph outlines stored in the snapshot (`derivedTextData`), so no font file of
 * the owner's is shipped (docs/data.md §13). The faces are all listed so a request matches its exact face.
 */
import { BUNDLED_FACES, type FontSource } from "@/engine/fonts";
import interUrl from "@/engine/fonts/Inter-3.19.ttf?url";

export const viewerFontSource: FontSource = {
  list: async () => BUNDLED_FACES,
  read: async (face) => {
    if (face.id !== "bundled:inter") throw new Error(`${face.family} ${face.style} isn't part of the preview`);
    return new Uint8Array(await (await fetch(interUrl)).arrayBuffer());
  },
};
