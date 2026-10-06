import type { DesignVariable, TextStyle } from "@/types/design";
import type { EffectStyle, FigmaDocument, SceneNode } from "@/figma/model";
import type { ProjectFields } from "@/types/project";
export { DEFAULT_CV_DATA } from "@/lib/cvDefaults";

/**
 * What the data layer's two sides share — the site's Firestore
 * (firestore.ts) and the demo's own storage (demo/firestore.ts): the
 * limits, the errors a save or a load ends with, the stored shapes. No
 * Firebase here.
 */

/** How many saved versions a project keeps. */
export const VERSIONS_KEPT = 20;

/** Firestore's limit for a document is 1 MiB: a file bigger than this isn't written (the fields beside it need some room). */
export const MAX_DOCUMENT_BYTES = 1_000_000;
/** …and from this size on, a save warns that the file grows near it. */
export const WARN_DOCUMENT_BYTES = 700_000;

// ── Errors a save or a load ends with ─────────────────────────────────────────

/** A project with that slug is there already. */
export class SlugTakenError extends Error {
  constructor(public slug: string) {
    super(`A project with the slug "${slug}" already exists`);
  }
}

/** What is saved changed since it was read (another tab, another device): saving would overwrite it. */
export class ConflictError extends Error {
  constructor(public part: "project" | "variables" | "textStyles" | "library") {
    super(`The ${part} was saved elsewhere since it was opened`);
  }
}

/** A file too big for a Firestore document. */
export class TooLargeError extends Error {
  constructor(public part: string, public bytes: number) {
    super(`The ${part} is ${Math.round(bytes / 1024)} KB — more than a Firestore document can hold`);
  }
}

/** What is stored couldn't be read (its JSON is broken): it is kept as it is — never overwritten with an empty one. */
export class StoredDataError extends Error {
  constructor(public part: string, cause: unknown) {
    super(`The stored ${part} could not be read`);
    this.cause = cause;
  }
}

/** The size of a text in bytes, as Firestore counts it (UTF-8). */
export const byteSize = (text: string) => new TextEncoder().encode(text).length;

/** A file's size checked against a document's room (TooLargeError): its bytes. */
export function sized(part: string, json: string) {
  const bytes = byteSize(json);
  if (bytes > MAX_DOCUMENT_BYTES) throw new TooLargeError(part, bytes);
  return bytes;
}

// ── The design system, as stored ──────────────────────────────────────────────

/** A deleted component, kept so the projects still using it can be detached from it when they are opened (see systemLibrary.ts). */
export interface DeletedComponent {
  id: string;
  node: SceneNode;
}

/** The site's components (design/library): the library's page, its effect styles, what the starting library seeded of it. */
export interface StoredLibrary {
  nodes: SceneNode[];
  effectStyles: EffectStyle[];
  /** The starting library's version it was last brought up to */
  version: number;
  /** Each starting component's signature as it was seeded: an unchanged one may be replaced by a newer starting one */
  seeded: Record<string, string>;
  deleted: DeletedComponent[];
}

/** The site's design system, as stored — each part with its rev (0: never saved). */
export interface StoredDesign {
  variables: DesignVariable[];
  /** Deleted variables, kept so the values bound to them keep theirs (see detachDeleted) */
  deletedVariables: DesignVariable[];
  variablesRev: number;
  textStyles: TextStyle[];
  /** Deleted text styles, kept so the texts in them keep their typography (see detachDeleted) */
  deletedTextStyles: TextStyle[];
  textStylesRev: number;
  /** null: never saved — the starting library seeds it */
  library: StoredLibrary | null;
  libraryRev: number;
}

// ── Save ──────────────────────────────────────────────────────────────────────

/** What a save writes: each part only when it changed, with the rev it was read at. */
export interface SaveRequest {
  project?: { fields: ProjectFields; canvas: FigmaDocument; rev: number };
  variables?: { list: DesignVariable[]; deleted: DesignVariable[]; rev: number };
  textStyles?: { list: TextStyle[]; deleted: TextStyle[]; rev: number };
  library?: { data: StoredLibrary; rev: number };
  /** Overwrite what was saved elsewhere since (after the user said so) */
  force?: boolean;
}

/** What it wrote: each part's new rev, and the sizes of the files near Firestore's limit. */
export interface SaveResult {
  projectRev?: number;
  variablesRev?: number;
  textStylesRev?: number;
  libraryRev?: number;
  /** Parts over WARN_DOCUMENT_BYTES: their sizes */
  large: { part: string; bytes: number }[];
}

// ── What went wrong, in words ─────────────────────────────────────────────────

/** An error's words for the user: Firestore's code with its message. */
export function errorText(err: unknown): string {
  if (err instanceof TooLargeError) return `${err.message}. Remove some layers or pictures and save again.`;
  if (err instanceof StoredDataError) return `${err.message} — nothing was changed. Open a saved version, or ask for help.`;
  const code = (err as { code?: string }).code;
  if (code === "permission-denied") return "Not allowed — sign in with the admin account (or the rules aren't deployed yet).";
  if (code === "unavailable") return "Offline — check the connection and try again.";
  return err instanceof Error ? err.message : String(err);
}
