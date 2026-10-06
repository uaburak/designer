import type { FigmaDocument } from "@/figma/model";
import type { DesignVariable, TextStyle } from "@/types/design";

/**
 * A project's own fields: what its page's Overview says (see overview.ts —
 * saved with the project, read by the lists and the page's title), and what
 * the admin sets beside it.
 */
export interface ProjectFields {
  slug: string;
  title: string;
  titleEn?: string;
  category: string;
  year: string;
  description?: string;
  descriptionEn?: string;
  /** Its cover — the Overview's picture */
  coverImage?: string;
  /** The company it was made at (the CV links its experiences to their projects by it) */
  company?: string;
}

/** A project as the editor holds it: its fields and its Figma file (the system library apart — see AdminEditorClient). */
export interface ProjectData extends ProjectFields {
  canvas?: FigmaDocument;
}

/** A project as the admin lists it (projects/{slug}): its fields, where it stands, what is published of it. */
export interface ProjectMeta extends ProjectFields {
  /** Its place in the lists (low first) */
  order: number;
  /** How many times it was saved: a save is refused when someone else saved it since it was opened */
  rev: number;
  /** It has a published version on the site */
  published: boolean;
  /** It was saved since it was last published: the site shows an older version */
  changedSincePublish: boolean;
  /** ms */
  createdAt: number | null;
  updatedAt: number | null;
  publishedAt: number | null;
  /** In the trash since (ms): off the site and out of the lists, its draft kept until it is deleted for good — null when it isn't */
  trashedAt: number | null;
}

/** What the site's lists show of a published project (publishedIndex/{slug}). */
export interface ProjectSummary extends ProjectFields {
  order: number;
  /** Pictures from its page (its cover first): the home page's flying images */
  images: string[];
  publishedAt: number | null;
}

/**
 * A published project's page (published/{slug}): everything it draws,
 * frozen as it was published — its page frame and the components it uses
 * (see publishedDocument), the variables and text styles of then — so the
 * site changes only when it is published again.
 */
export interface PublishedPage {
  summary: ProjectSummary;
  doc: FigmaDocument;
  variables: DesignVariable[];
  textStyles: TextStyle[];
}

/** One of a project's saved versions (projects/{slug}/versions/{id}). */
export interface ProjectVersion {
  id: string;
  /** ms */
  savedAt: number | null;
  rev: number;
  title: string;
}
