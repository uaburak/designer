/**
 * The viewer's fonts: only the bundled Inter's upright file, for the canvas's own labels (frame titles,
 * measurements) and texts set in upright Inter. Every other face — Inter's italics included — is reported missing on
 * purpose: those texts draw from the glyph outlines stored in the snapshot (`derivedTextData`), so no font file of
 * the owner's is shipped (docs/data.md §13). The faces are all listed so a request matches its exact face (an italic
 * never falls back to the upright file, which would relay the text in the wrong face).
 */
import { BUNDLED_FACES, type FontSource } from "@/engine/fonts";
import interUrl from "@/engine/fonts/InterVariable.ttf?url";

export const viewerFontSource: FontSource = {
  list: async () => BUNDLED_FACES,
  read: async (face) => {
    if (face.id !== "bundled:inter") throw new Error(`${face.family} ${face.style} isn't part of the preview`);
    return new Uint8Array(await (await fetch(interUrl)).arrayBuffer());
  },
};
