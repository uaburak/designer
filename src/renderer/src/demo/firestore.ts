import type * as Real from "@/lib/firestore";
import { ConflictError, DEFAULT_CV_DATA, VERSIONS_KEPT, WARN_DOCUMENT_BYTES, SlugTakenError, sized, type SaveResult, type StoredLibrary } from "@/lib/data";
import type { ProjectMeta, ProjectVersion } from "@/types/project";
import type { CVData } from "@/types/cv";
import type { DesignVariable, TextStyle } from "@/types/design";
import type { FigmaDocument } from "@/figma/model";
import { newDocument } from "@/figma/model";
import { withOverview } from "@/figma/overview";
import { currentLibrary, splitLibrary, withLibrary } from "@/figma/systemLibrary";
import * as db from "./db";

/**
 * The demo's data (`--mode demo`): the same functions as lib/firestore.ts,
 * kept in this computer's IndexedDB instead of the site's Firestore — a few
 * sample projects to begin with. Saves, versions, publishing, the trash, the
 * design system all work; nothing reaches burakkoc.net.
 */

export * from "@/lib/data";

interface StoredProject {
  meta: ProjectMeta;
}
interface StoredVersion extends ProjectVersion {
  json: string;
}
interface Part<T> {
  data: T;
  rev: number;
}

const k = {
  project: (slug: string) => `project:${slug}`,
  canvas: (slug: string) => `canvas:${slug}`,
  versions: (slug: string) => `versions:${slug}`,
  published: (slug: string) => `published:${slug}`,
  variables: "design:variables",
  textStyles: "design:textStyles",
  library: "design:library",
  cv: "cv",
  seeded: "seeded",
};

// ── The samples ───────────────────────────────────────────────────────────────

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const SAMPLES: { slug: string; title: string; category: string; year: string; description: string; published: boolean; changed: boolean; edited: number; trashed?: boolean }[] = [
  { slug: "atlas-booking", title: "Atlas Booking", category: "Product Design", year: "2026", description: "A booking flow for a travel agency, from search to checkout.", published: true, changed: true, edited: 10 * 60_000 },
  { slug: "northwind-dashboard", title: "Northwind Dashboard", category: "UX / UI Design", year: "2026", description: "An operations dashboard for a logistics team.", published: false, changed: false, edited: 21 * HOUR },
  { slug: "lumen-design-system", title: "Lumen Design System", category: "Design System", year: "2025", description: "Tokens, components and documentation for a family of apps.", published: true, changed: false, edited: 1 * DAY + 3 * HOUR },
  { slug: "harbor-travel", title: "Harbor Travel", category: "Web Design", year: "2025", description: "A marketing site for a ferry company.", published: true, changed: false, edited: 6 * DAY },
  { slug: "pulse-fitness", title: "Pulse Fitness", category: "Mobile App", year: "2024", description: "A workout tracker with a social feed.", published: false, changed: false, edited: 32 * DAY },
  { slug: "orbit-crm", title: "Orbit CRM", category: "Product Design", year: "2024", description: "A CRM for small studios.", published: false, changed: false, edited: 95 * DAY, trashed: true },
];

let seeding: Promise<void> | null = null;

/** The samples, once (an emptied demo stays empty: a seeded mark is kept). */
function seeded(): Promise<void> {
  seeding ??= (async () => {
    if (await db.get(k.seeded)) return;
    const library = currentLibrary(null);
    const now = Date.now();
    let order = 0;
    for (const s of SAMPLES) {
      order += 1;
      const fields = { slug: s.slug, title: s.title, category: s.category, year: s.year, description: s.description };
      const file = withOverview(withLibrary(newDocument(s.title), library), fields);
      const meta: ProjectMeta = {
        ...fields,
        order,
        rev: 1,
        published: s.published && !s.trashed,
        changedSincePublish: s.changed,
        createdAt: now - s.edited - 30 * DAY,
        updatedAt: now - s.edited,
        publishedAt: s.published ? now - s.edited - (s.changed ? DAY : 0) : null,
        trashedAt: s.trashed ? now - 2 * DAY : null,
      };
      await db.set(k.project(s.slug), { meta } satisfies StoredProject);
      await db.set(k.canvas(s.slug), JSON.stringify(splitLibrary(file).project));
    }
    await db.set(k.seeded, true);
  })();
  return seeding;
}

async function projectOf(slug: string): Promise<StoredProject | undefined> {
  await seeded();
  return db.get<StoredProject>(k.project(slug));
}

const isDocument = (v: unknown): v is FigmaDocument => Boolean(v && typeof v === "object" && Array.isArray((v as FigmaDocument).nodes));

// ── The site's side ───────────────────────────────────────────────────────────

export const listPublished: typeof Real.listPublished = async () => {
  const list = await listProjects();
  return list.filter((p) => p.published).map((p) => ({ ...p, images: p.coverImage ? [p.coverImage] : [] }));
};

export const loadPublished: typeof Real.loadPublished = async (slug) => {
  const json = await db.get<string>(k.published(slug));
  return json ? JSON.parse(json) : null;
};

// ── Projects ──────────────────────────────────────────────────────────────────

export const listProjects: typeof Real.listProjects = async () => {
  await seeded();
  const keys = await db.keys("project:");
  const list = (await Promise.all(keys.map((key) => db.get<StoredProject>(key)))).filter((p): p is StoredProject => Boolean(p)).map((p) => p.meta);
  return db.later(list.sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug)));
};

export const loadProjectForEdit: typeof Real.loadProjectForEdit = async (slug) => {
  const project = await projectOf(slug);
  if (!project) return db.later(null);
  const json = await db.get<string>(k.canvas(slug));
  const canvas = json ? (JSON.parse(json) as unknown) : null;
  return db.later({ meta: project.meta, canvas: isDocument(canvas) ? canvas : null }, 250);
};

export const createProject: typeof Real.createProject = async (fields, canvas) => {
  const json = JSON.stringify(canvas);
  sized("project's file", json);
  if (await projectOf(fields.slug)) throw new SlugTakenError(fields.slug);
  const all = await listProjects();
  const order = all.reduce((max, p) => Math.max(max, p.order), 0) + 1;
  const now = Date.now();
  const meta: ProjectMeta = { ...fields, order, rev: 1, published: false, changedSincePublish: false, createdAt: now, updatedAt: now, publishedAt: null, trashedAt: null };
  await db.set(k.project(fields.slug), { meta } satisfies StoredProject);
  await db.set(k.canvas(fields.slug), json);
  return meta;
};

export const duplicateProject: typeof Real.duplicateProject = async (from, fields, change = (c) => c) => {
  const source = await loadProjectForEdit(from);
  if (!source?.canvas) throw new Error(`The project "${from}" has no file to copy`);
  const { slug: _s, title: _t, order: _o, rev: _r, published: _p, changedSincePublish: _c, createdAt: _ca, updatedAt: _u, publishedAt: _pa, trashedAt: _ta, ...own } = source.meta;
  return createProject({ ...own, slug: fields.slug, title: fields.title }, change(source.canvas));
};

export const deleteProject: typeof Real.deleteProject = async (slug) => {
  await Promise.all([k.project(slug), k.canvas(slug), k.versions(slug), k.published(slug)].map(db.del));
};

async function patchMeta(slug: string, patch: Partial<ProjectMeta>) {
  const project = await projectOf(slug);
  if (!project) throw new Error(`The project "${slug}" is gone`);
  await db.set(k.project(slug), { meta: { ...project.meta, ...patch } } satisfies StoredProject);
}

export const trashProject: typeof Real.trashProject = async (slug) => {
  await db.del(k.published(slug));
  await patchMeta(slug, { trashedAt: Date.now(), published: false, publishedAt: null });
};

export const restoreProject: typeof Real.restoreProject = async (slug) => patchMeta(slug, { trashedAt: null });

export const reorderProjects: typeof Real.reorderProjects = async (projects) => {
  for (const [i, p] of projects.entries()) await patchMeta(p.slug, { order: i + 1 });
};

export const listVersions: typeof Real.listVersions = async (slug) => {
  const versions = (await db.get<StoredVersion[]>(k.versions(slug))) ?? [];
  return db.later(versions.map(({ json: _json, ...v }) => v).sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0) || b.rev - a.rev));
};

export const loadVersion: typeof Real.loadVersion = async (slug, id) => {
  const version = ((await db.get<StoredVersion[]>(k.versions(slug))) ?? []).find((v) => v.id === id);
  if (!version) throw new Error("That version is gone");
  return JSON.parse(version.json) as FigmaDocument;
};

// ── The design system ─────────────────────────────────────────────────────────

export const loadDesign: typeof Real.loadDesign = async () => {
  const [variables, textStyles, library] = await Promise.all([
    db.get<Part<{ list: DesignVariable[]; deleted: DesignVariable[] }>>(k.variables),
    db.get<Part<{ list: TextStyle[]; deleted: TextStyle[] }>>(k.textStyles),
    db.get<Part<string>>(k.library),
  ]);
  return db.later({
    variables: variables?.data.list ?? [],
    deletedVariables: variables?.data.deleted ?? [],
    variablesRev: variables?.rev ?? 0,
    textStyles: textStyles?.data.list ?? [],
    deletedTextStyles: textStyles?.data.deleted ?? [],
    textStylesRev: textStyles?.rev ?? 0,
    library: library ? (JSON.parse(library.data) as StoredLibrary) : null,
    libraryRev: library?.rev ?? 0,
  });
};

// ── Save ──────────────────────────────────────────────────────────────────────

export const saveAll: typeof Real.saveAll = async (slug, req) => {
  const large: SaveResult["large"] = [];
  const projectJson = req.project ? JSON.stringify(req.project.canvas) : null;
  const libraryJson = req.library ? JSON.stringify(req.library.data) : null;
  for (const [part, json] of [["project's file", projectJson], ["library", libraryJson]] as const) {
    if (!json) continue;
    const bytes = sized(part, json);
    if (bytes > WARN_DOCUMENT_BYTES) large.push({ part, bytes });
  }
  const out: SaveResult = { large };
  // Read everything first: a part saved elsewhere since is a conflict, and then nothing is written.
  const [project, variables, textStyles, library] = await Promise.all([
    req.project ? projectOf(slug) : null,
    req.variables ? db.get<Part<unknown>>(k.variables) : null,
    req.textStyles ? db.get<Part<unknown>>(k.textStyles) : null,
    req.library ? db.get<Part<string>>(k.library) : null,
  ]);
  const check = (part: ConflictError["part"], current: number, expected: number) => {
    if (!req.force && current !== expected) throw new ConflictError(part);
    return current + 1;
  };
  if (req.project && !project) throw new Error(`The project "${slug}" is gone (deleted elsewhere)`);
  const projectRev = req.project && project ? check("project", project.meta.rev, req.project.rev) : null;
  const variablesRev = req.variables ? check("variables", variables?.rev ?? 0, req.variables.rev) : null;
  const textStylesRev = req.textStyles ? check("textStyles", textStyles?.rev ?? 0, req.textStyles.rev) : null;
  const libraryRev = req.library ? check("library", library?.rev ?? 0, req.library.rev) : null;

  if (req.project && project && projectRev !== null && projectJson) {
    const now = Date.now();
    await db.set(k.project(slug), { meta: { ...project.meta, ...req.project.fields, rev: projectRev, changedSincePublish: true, updatedAt: now } } satisfies StoredProject);
    await db.set(k.canvas(slug), projectJson);
    const versions = (await db.get<StoredVersion[]>(k.versions(slug))) ?? [];
    const next = [{ id: Math.random().toString(36).slice(2, 12), savedAt: now, rev: projectRev, title: req.project.fields.title, json: projectJson }, ...versions].slice(0, VERSIONS_KEPT);
    await db.set(k.versions(slug), next);
    out.projectRev = projectRev;
  }
  if (req.variables && variablesRev !== null) {
    await db.set(k.variables, { data: { list: req.variables.list, deleted: req.variables.deleted }, rev: variablesRev });
    out.variablesRev = variablesRev;
  }
  if (req.textStyles && textStylesRev !== null) {
    await db.set(k.textStyles, { data: { list: req.textStyles.list, deleted: req.textStyles.deleted }, rev: textStylesRev });
    out.textStylesRev = textStylesRev;
  }
  if (req.library && libraryRev !== null && libraryJson) {
    await db.set(k.library, { data: libraryJson, rev: libraryRev });
    out.libraryRev = libraryRev;
  }
  return db.later(out, 300);
};

// ── Storage's references, publishing ─────────────────────────────────────────

export const referencedUrls: typeof Real.referencedUrls = async () => {
  const texts: string[] = [];
  for (const key of [...(await db.keys("canvas:")), ...(await db.keys("published:")), k.library]) {
    const value = await db.get<unknown>(key);
    if (value) texts.push(typeof value === "string" ? value : JSON.stringify(value));
  }
  const urls = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/g)) urls.add(m[0]);
  return [...urls];
};

export const publishProject: typeof Real.publishProject = async (slug, page) => {
  const json = JSON.stringify({ ...page, summary: { ...page.summary, publishedAt: Date.now() } });
  sized("published page", json);
  await db.set(k.published(slug), json);
  await patchMeta(slug, { published: true, changedSincePublish: false, publishedAt: Date.now() });
  await db.later(null, 400);
};

export const unpublishProject: typeof Real.unpublishProject = async (slug) => {
  await db.del(k.published(slug));
  await patchMeta(slug, { published: false, publishedAt: null });
};

// ── CV ────────────────────────────────────────────────────────────────────────

export const getCVData: typeof Real.getCVData = async () => (await db.get<CVData>(k.cv)) ?? DEFAULT_CV_DATA;
export const saveCVData: typeof Real.saveCVData = async (data) => db.set(k.cv, data);
