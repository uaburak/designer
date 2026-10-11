/**
 * Shared fonts (docs/desktop.md §14.3): organization and team fonts uploaded by admins, served by the multiplayer
 * server, cached by main next to Google fonts. Committed before Phase 7 round 3.
 */

/** Where a shared font belongs */
export type SharedFontScope = { type: "org"; orgId: string } | { type: "team"; orgId: string; teamId: string };

/** A face as the uploader's client parsed it (main's parseFile) */
export interface SharedFontFaceInput {
  family: string;
  style: string;
  postscriptName: string;
  /** 1–1000 */
  weight: number;
  italic: boolean;
  /** 1–9 */
  stretch: number;
  /** A named instance of a variable font */
  variable: boolean;
}

export interface SharedFontFace extends SharedFontFaceInput {
  /** The face's id; in the font index it is "s:" + id */
  id: string;
  sha1: string;
  format: "ttf" | "otf";
  size: number;
  fileName: string;
  orgId: string;
  /** null: an organization font */
  teamId: string | null;
  uploadedAt: number;
  uploadedBy: { id: string; name: string | null } | null;
}

/** GET /me/fonts; FontIndex.shared is its `faces` */
export interface SharedFontList {
  /** Changes whenever the faces do */
  version: string;
  faces: SharedFontFace[];
}

/** A family already in the scope: Skip or Replace */
export interface FontConflict {
  family: string;
  /** Faces of that family already uploaded */
  existing: number;
}
export type FontConflictChoice = "skip" | "replace";

/** One picked file, parsed by main (its path stays in main) */
export interface FontUploadCandidate {
  token: string;
  fileName: string;
  format: "ttf" | "otf";
  size: number;
  sha1: string;
  faces: SharedFontFaceInput[];
}

/** PUT /orgs/:org/fonts */
export interface FontUploadAnswer {
  uploaded: SharedFontFace[];
  /** Families whose faces were replaced */
  replaced: string[];
}

export interface FontUploadResult {
  uploaded: SharedFontFace[];
  skipped: string[];
  replaced: string[];
  failed: { fileName: string; reason: string }[];
}

/** The IPC channels round 3d adds to src/shared/ipc.ts (Home and editor views; main does the dialog and the upload) */
export interface SharedFontsChannels {
  "fonts:shared-list": { args: [{ scope: SharedFontScope }]; result: { faces: SharedFontFace[] } };
  "fonts:shared-pick": {
    args: [{ scope: SharedFontScope }];
    result: { candidates: FontUploadCandidate[]; conflicts: FontConflict[]; failed: { fileName: string; reason: string }[] } | { cancelled: true };
  };
  "fonts:shared-upload": {
    args: [{ scope: SharedFontScope; tokens: string[]; licenceConfirmed: true; choices: Record<string, FontConflictChoice> }];
    result: FontUploadResult;
  };
  "fonts:shared-remove": { args: [{ scope: SharedFontScope; ids?: string[]; family?: string }]; result: { faces: SharedFontFace[] } };
}

/** Face ids in the font index */
export const sharedFaceId = (id: string): string => `s:${id}`;
export const isSharedFaceId = (id: string): boolean => id.startsWith("s:");
