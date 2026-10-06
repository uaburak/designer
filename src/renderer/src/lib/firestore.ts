import {
  collection,
  doc,
  getDoc,
  getDocs,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  writeBatch,
  type DocumentData,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { CVData } from "@/types/cv";
import { DEFAULT_CV_DATA } from "@/lib/cvDefaults";
import type { ProjectFields, ProjectMeta, ProjectSummary, ProjectVersion, PublishedPage } from "@/types/project";
import type { FigmaDocument } from "@/figma/model";
import { ConflictError, SlugTakenError, StoredDataError, VERSIONS_KEPT, WARN_DOCUMENT_BYTES, sized, type SaveRequest, type SaveResult, type StoredDesign, type StoredLibrary } from "@/lib/data";

export * from "@/lib/data";

/**
 * Where everything is kept (Firestore):
 *
 *  - projects/{slug} — a project as the admin keeps it: its fields, where
 *    it stands (rev, order, published…). Its Figma file, the draft, is
 *    projects/{slug}/content/canvas (one JSON text: see CANVAS_FIELD);
 *    its last saved versions, projects/{slug}/versions/{id}. Only the
 *    admin reads or writes them (see firestore.rules).
 *  - published/{slug} — what the site shows of it, frozen when it was
 *    published (see PublishedPage); publishedIndex/{slug} — its summary,
 *    what the lists read. Anyone reads them.
 *  - design/variables, design/textStyles, design/library — the site's
 *    design system, every project's (the variables, the text styles, the
 *    components). Only the admin.
 *  - cv/main — the CV page. Anyone reads it.
 *
 * Every write is the Save button's (or a project list's action): an edit
 * is never written on its own. A save writes all it changed at once (one
 * transaction), and is refused when someone else saved the same thing
 * since it was read (its `rev`).
 */

const PROJECTS = "projects";
const PUBLISHED = "published";
const PUBLISHED_INDEX = "publishedIndex";
const DESIGN = "design";
const CV_COLLECTION = "cv";
const CV_DOC_ID = "main";

/**
 * A Figma file is kept as one JSON text, not as Firestore maps: Firestore
 * takes no map or array nested more than 20 deep, and a design's frames
 * nest deeper than that soon (each frame inside another is two levels).
 */
const CANVAS_FIELD = "json";

// ── Reading what is stored ────────────────────────────────────────────────────

const ms = (value: unknown): number | null => (value instanceof Timestamp ? value.toMillis() : typeof value === "number" ? value : null);
const text = (value: unknown) => (typeof value === "string" ? value : "");
const optional = (value: unknown) => (typeof value === "string" && value ? value : undefined);

function fieldsOf(slug: string, raw: DocumentData): ProjectFields {
  return {
    slug,
    title: text(raw.title),
    titleEn: optional(raw.titleEn),
    category: text(raw.category),
    year: text(raw.year),
    description: optional(raw.description),
    descriptionEn: optional(raw.descriptionEn),
    coverImage: optional(raw.coverImage),
    company: optional(raw.company),
  };
}

/** The fields as they are written: every one there (an emptied one empty), so a save never leaves an older value behind. */
function fieldsData(fields: ProjectFields) {
  return {
    slug: fields.slug,
    title: fields.title ?? "",
    titleEn: fields.titleEn ?? "",
    category: fields.category ?? "",
    year: fields.year ?? "",
    description: fields.description ?? "",
    descriptionEn: fields.descriptionEn ?? "",
    coverImage: fields.coverImage ?? "",
    company: fields.company ?? "",
  };
}

function metaOf(slug: string, raw: DocumentData): ProjectMeta {
  return {
    ...fieldsOf(slug, raw),
    order: typeof raw.order === "number" ? raw.order : 0,
    rev: typeof raw.rev === "number" ? raw.rev : 0,
    published: raw.published === true,
    changedSincePublish: raw.changedSincePublish === true,
    createdAt: ms(raw.createdAt),
    updatedAt: ms(raw.updatedAt),
    publishedAt: ms(raw.publishedAt),
    trashedAt: ms(raw.trashedAt),
  };
}

function summaryOf(slug: string, raw: DocumentData): ProjectSummary {
  return {
    ...fieldsOf(slug, raw),
    order: typeof raw.order === "number" ? raw.order : 0,
    images: Array.isArray(raw.images) ? raw.images.filter((x): x is string => typeof x === "string") : [],
    publishedAt: ms(raw.publishedAt),
  };
}

const byOrder = <T extends { order: number; slug: string }>(a: T, b: T) => a.order - b.order || a.slug.localeCompare(b.slug);

/** A JSON text read back — a broken one is an error (see StoredDataError), never an empty file. */
function parsed<T>(part: string, json: unknown, valid: (value: unknown) => boolean): T {
  if (typeof json !== "string") throw new StoredDataError(part, new Error("not a text"));
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (err) {
    throw new StoredDataError(part, err);
  }
  if (!valid(value)) throw new StoredDataError(part, new Error("unexpected shape"));
  return value as T;
}

const isDocument = (value: unknown) => Boolean(value && typeof value === "object" && Array.isArray((value as FigmaDocument).nodes) && typeof (value as FigmaDocument).pageId === "string");

// ── The site: what is published ───────────────────────────────────────────────

/** The published projects' summaries, in their order. */
export async function listPublished(): Promise<ProjectSummary[]> {
  const snap = await getDocs(collection(db, PUBLISHED_INDEX));
  return snap.docs.map((d) => summaryOf(d.id, d.data())).sort(byOrder);
}

/** A published project's page — null when it isn't published. */
export async function loadPublished(slug: string): Promise<PublishedPage | null> {
  const snap = await getDoc(doc(db, PUBLISHED, slug));
  if (!snap.exists()) return null;
  const raw = snap.data();
  const page = parsed<Omit<PublishedPage, "summary">>("published page", raw[CANVAS_FIELD], (v) => Boolean(v && typeof v === "object" && isDocument((v as PublishedPage).doc)));
  return { summary: summaryOf(slug, raw), doc: page.doc, variables: page.variables ?? [], textStyles: page.textStyles ?? [] };
}

// ── The admin: projects ───────────────────────────────────────────────────────

const projectRef = (slug: string) => doc(db, PROJECTS, slug);
const canvasRef = (slug: string) => doc(db, PROJECTS, slug, "content", "canvas");
const versionsOf = (slug: string) => collection(db, PROJECTS, slug, "versions");

/** Every project (drafts and published), in their order. */
export async function listProjects(): Promise<ProjectMeta[]> {
  const snap = await getDocs(collection(db, PROJECTS));
  return snap.docs.map((d) => metaOf(d.id, d.data())).sort(byOrder);
}

/** A project and its file, to edit — null when there is none of that slug. A file that can't be read is an error (StoredDataError). */
export async function loadProjectForEdit(slug: string): Promise<{ meta: ProjectMeta; canvas: FigmaDocument | null } | null> {
  const [meta, content] = await Promise.all([getDoc(projectRef(slug)), getDoc(canvasRef(slug))]);
  if (!meta.exists()) return null;
  const canvas = content.exists() ? parsed<FigmaDocument>("project's file", content.data()[CANVAS_FIELD], isDocument) : null;
  return { meta: metaOf(slug, meta.data()), canvas };
}

/** A new project, its file with it — refused when its slug is taken (SlugTakenError). At the end of the list. */
export async function createProject(fields: ProjectFields, canvas: FigmaDocument): Promise<ProjectMeta> {
  const json = JSON.stringify(canvas);
  sized("project's file", json);
  const all = await getDocs(collection(db, PROJECTS));
  const order = all.docs.reduce((max, d) => Math.max(max, typeof d.data().order === "number" ? d.data().order : 0), 0) + 1;
  await runTransaction(db, async (tx) => {
    const there = await tx.get(projectRef(fields.slug));
    if (there.exists()) throw new SlugTakenError(fields.slug);
    tx.set(projectRef(fields.slug), { ...fieldsData(fields), order, rev: 1, published: false, changedSincePublish: false, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), publishedAt: null, trashedAt: null });
    tx.set(canvasRef(fields.slug), { [CANVAS_FIELD]: json });
  });
  return { ...fields, order, rev: 1, published: false, changedSincePublish: false, createdAt: Date.now(), updatedAt: Date.now(), publishedAt: null, trashedAt: null };
}

/** A copy of a project — its file (through `change`) and fields, under another slug and title — as a draft at the end of the list. */
export async function duplicateProject(from: string, fields: Pick<ProjectFields, "slug" | "title">, change: (canvas: FigmaDocument) => FigmaDocument = (c) => c): Promise<ProjectMeta> {
  const source = await loadProjectForEdit(from);
  if (!source?.canvas) throw new Error(`The project "${from}" has no file to copy`);
  const { order, rev, published, changedSincePublish, createdAt, updatedAt, publishedAt, trashedAt, ...own } = source.meta;
  void order; void rev; void published; void changedSincePublish; void createdAt; void updatedAt; void publishedAt; void trashedAt;
  return createProject({ ...own, slug: fields.slug, title: fields.title }, change(source.canvas));
}

/** A project and every document of it: its file, its versions, what is published of it. (Its pictures stay in Storage: other pages may show them.) */
export async function deleteProject(slug: string): Promise<void> {
  const versions = await getDocs(versionsOf(slug));
  const batch = writeBatch(db);
  versions.docs.forEach((d) => batch.delete(d.ref));
  batch.delete(canvasRef(slug));
  batch.delete(doc(db, PUBLISHED, slug));
  batch.delete(doc(db, PUBLISHED_INDEX, slug));
  batch.delete(projectRef(slug));
  await batch.commit();
}

/**
 * A project to the trash: off the site (what was published of it, gone) and
 * out of the lists — its draft and its versions kept, until it is restored
 * or deleted for good (deleteProject).
 */
export async function trashProject(slug: string): Promise<void> {
  const batch = writeBatch(db);
  batch.delete(doc(db, PUBLISHED, slug));
  batch.delete(doc(db, PUBLISHED_INDEX, slug));
  batch.update(projectRef(slug), { trashedAt: serverTimestamp(), published: false, publishedAt: null });
  await batch.commit();
}

/** A project back from the trash — as a draft: it was taken off the site. */
export async function restoreProject(slug: string): Promise<void> {
  await updateDoc(projectRef(slug), { trashedAt: null });
}

/** The projects' order: each one's place as listed (the published ones' on the site too). */
export async function reorderProjects(projects: Pick<ProjectMeta, "slug" | "published">[]): Promise<void> {
  const batch = writeBatch(db);
  projects.forEach((p, i) => {
    batch.update(projectRef(p.slug), { order: i + 1 });
    if (p.published) batch.set(doc(db, PUBLISHED_INDEX, p.slug), { order: i + 1 }, { merge: true });
  });
  await batch.commit();
}

/** A project's saved versions, the latest first. */
export async function listVersions(slug: string): Promise<ProjectVersion[]> {
  const snap = await getDocs(versionsOf(slug));
  return snap.docs
    .map((d) => ({ id: d.id, savedAt: ms(d.data().savedAt), rev: typeof d.data().rev === "number" ? d.data().rev : 0, title: text(d.data().title) }))
    .sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0) || b.rev - a.rev);
}

/** One saved version's file. */
export async function loadVersion(slug: string, id: string): Promise<FigmaDocument> {
  const snap = await getDoc(doc(db, PROJECTS, slug, "versions", id));
  if (!snap.exists()) throw new Error("That version is gone");
  return parsed<FigmaDocument>("version", snap.data()[CANVAS_FIELD], isDocument);
}

/** The versions beyond the last VERSIONS_KEPT, taken away (after a save; what fails stays for the next one). */
async function pruneVersions(slug: string) {
  const versions = await listVersions(slug);
  if (versions.length <= VERSIONS_KEPT) return;
  const batch = writeBatch(db);
  versions.slice(VERSIONS_KEPT).forEach((v) => batch.delete(doc(db, PROJECTS, slug, "versions", v.id)));
  await batch.commit();
}

// ── The admin: the site's design system ───────────────────────────────────────

const designRef = (id: "variables" | "textStyles" | "library") => doc(db, DESIGN, id);
const rev = (raw: DocumentData | undefined) => (raw && typeof raw.rev === "number" ? raw.rev : 0);

/** The site's design system — an error when any part can't be read (nothing is ever saved over what wasn't read). */
export async function loadDesign(): Promise<StoredDesign> {
  const [variables, textStyles, library] = await Promise.all([getDoc(designRef("variables")), getDoc(designRef("textStyles")), getDoc(designRef("library"))]);
  const v = variables.exists() ? variables.data() : undefined;
  const t = textStyles.exists() ? textStyles.data() : undefined;
  const l = library.exists() ? library.data() : undefined;
  return {
    variables: Array.isArray(v?.variables) ? v.variables : [],
    deletedVariables: Array.isArray(v?.deleted) ? v.deleted : [],
    variablesRev: rev(v),
    textStyles: Array.isArray(t?.styles) ? t.styles : [],
    deletedTextStyles: Array.isArray(t?.deleted) ? t.deleted : [],
    textStylesRev: rev(t),
    library: l ? parsed<StoredLibrary>("library", l[CANVAS_FIELD], (x) => Boolean(x && typeof x === "object" && Array.isArray((x as StoredLibrary).nodes))) : null,
    libraryRev: rev(l),
  };
}

// ── Save: everything that changed, at once ────────────────────────────────────

/**
 * The project's draft and the design system's parts that changed, in one
 * transaction: all of them, or nothing (an error). A part saved elsewhere
 * since it was read is a ConflictError, unless `force`. A saved project
 * keeps a version of itself (the last VERSIONS_KEPT stay).
 */
export async function saveAll(slug: string, req: SaveRequest): Promise<SaveResult> {
  const large: SaveResult["large"] = [];
  const projectJson = req.project ? JSON.stringify(req.project.canvas) : null;
  const libraryJson = req.library ? JSON.stringify(req.library.data) : null;
  for (const [part, json] of [["project's file", projectJson], ["library", libraryJson]] as const) {
    if (!json) continue;
    const bytes = sized(part, json);
    if (bytes > WARN_DOCUMENT_BYTES) large.push({ part, bytes });
  }
  const result = await runTransaction(db, async (tx) => {
    const out: SaveResult = { large };
    const reads = await Promise.all([
      req.project ? tx.get(projectRef(slug)) : null,
      req.variables ? tx.get(designRef("variables")) : null,
      req.textStyles ? tx.get(designRef("textStyles")) : null,
      req.library ? tx.get(designRef("library")) : null,
    ]);
    const [p, v, t, l] = reads;
    const check = (part: ConflictError["part"], snap: (typeof reads)[number], expected: number) => {
      if (!req.force && snap && rev(snap.exists() ? snap.data() : undefined) !== expected) throw new ConflictError(part);
      return rev(snap?.exists() ? snap.data() : undefined) + 1;
    };
    if (req.project && p) {
      if (!p.exists()) throw new Error(`The project "${slug}" is gone (deleted elsewhere)`);
      const next = check("project", p, req.project.rev);
      tx.update(projectRef(slug), { ...fieldsData(req.project.fields), rev: next, changedSincePublish: true, updatedAt: serverTimestamp() });
      tx.set(canvasRef(slug), { [CANVAS_FIELD]: projectJson });
      tx.set(doc(versionsOf(slug)), { [CANVAS_FIELD]: projectJson, rev: next, title: req.project.fields.title, savedAt: serverTimestamp() });
      out.projectRev = next;
    }
    if (req.variables && v) {
      const next = check("variables", v, req.variables.rev);
      tx.set(designRef("variables"), { variables: req.variables.list, deleted: req.variables.deleted, rev: next, updatedAt: serverTimestamp() });
      out.variablesRev = next;
    }
    if (req.textStyles && t) {
      const next = check("textStyles", t, req.textStyles.rev);
      tx.set(designRef("textStyles"), { styles: req.textStyles.list, deleted: req.textStyles.deleted, rev: next, updatedAt: serverTimestamp() });
      out.textStylesRev = next;
    }
    if (req.library && l) {
      const next = check("library", l, req.library.rev);
      tx.set(designRef("library"), { [CANVAS_FIELD]: libraryJson, rev: next, updatedAt: serverTimestamp() });
      out.libraryRev = next;
    }
    return out;
  });
  if (req.project) pruneVersions(slug).catch((err) => console.warn("Old versions could not be pruned:", err));
  return result;
}

// ── What the site refers to in Storage ────────────────────────────────────────

/**
 * Every Storage address the site refers to anywhere — the projects' drafts,
 * the library, what is published, the CV — as their texts hold them (the
 * Images panel's "unused": a file none of them mention). The projects'
 * older saved versions are not read (they may still mention a file).
 */
export async function referencedUrls(): Promise<string[]> {
  const texts: string[] = [];
  const [projects, published, library, cv] = await Promise.all([
    getDocs(collection(db, PROJECTS)),
    getDocs(collection(db, PUBLISHED)),
    getDoc(designRef("library")),
    getDoc(doc(db, CV_COLLECTION, CV_DOC_ID)),
  ]);
  const contents = await Promise.all(projects.docs.map((d) => getDoc(canvasRef(d.id))));
  for (const d of [...projects.docs, ...published.docs]) texts.push(JSON.stringify(d.data()));
  for (const c of contents) if (c.exists()) texts.push(String(c.data()[CANVAS_FIELD] ?? ""));
  if (library.exists()) texts.push(String(library.data()[CANVAS_FIELD] ?? ""));
  if (cv.exists()) texts.push(JSON.stringify(cv.data()));
  const urls = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(/https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/[^"\\\s)'<>]+/g)) urls.add(m[0]);
  return [...urls];
}

// ── Publish ───────────────────────────────────────────────────────────────────

/** What the site shows of a project, made from its saved draft (see publishedPage): its page, its summary in the lists. */
export async function publishProject(slug: string, page: PublishedPage): Promise<void> {
  const json = JSON.stringify({ doc: page.doc, variables: page.variables, textStyles: page.textStyles });
  sized("published page", json);
  const summary = { ...fieldsData(page.summary), order: page.summary.order, images: page.summary.images, publishedAt: serverTimestamp() };
  const batch = writeBatch(db);
  batch.set(doc(db, PUBLISHED, slug), { ...summary, [CANVAS_FIELD]: json });
  batch.set(doc(db, PUBLISHED_INDEX, slug), summary);
  batch.update(projectRef(slug), { published: true, changedSincePublish: false, publishedAt: serverTimestamp() });
  await batch.commit();
}

/** The project off the site (its draft stays). */
export async function unpublishProject(slug: string): Promise<void> {
  const batch = writeBatch(db);
  batch.delete(doc(db, PUBLISHED, slug));
  batch.delete(doc(db, PUBLISHED_INDEX, slug));
  batch.update(projectRef(slug), { published: false, publishedAt: null });
  await batch.commit();
}

// ── CV ────────────────────────────────────────────────────────────────────────

const shortId = () => Math.random().toString(36).slice(2, 9);
type Raw = Record<string, unknown>;
const list = (value: unknown): Raw[] => (Array.isArray(value) ? value.filter((x): x is Raw => Boolean(x && typeof x === "object")) : []);
const str = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);

/** The CV — the empty one when there is none yet. */
export async function getCVData(): Promise<CVData> {
  const snap = await getDoc(doc(db, CV_COLLECTION, CV_DOC_ID));
  if (!snap.exists()) return DEFAULT_CV_DATA;
  const data = snap.data();
  return {
    myname: str(data.myname),
    myrole: str(data.myrole),
    profileImage: str(data.profileImage),
    cvPdfUrl: str(data.cvPdfUrl),
    cvPreviewImage: str(data.cvPreviewImage),
    aboutParagraphs: Array.isArray(data.aboutParagraphs) ? data.aboutParagraphs.filter((p: unknown): p is string => typeof p === "string") : [],
    experience: list(data.experience).map((exp) => ({
      id: str(exp.id) || shortId(),
      year: str(exp.year),
      company: str(exp.company),
      role: str(exp.role) || str(exp.title),
      description: str(exp.description),
    })),
    education: list(data.education).map((edu) => ({
      id: str(edu.id) || shortId(),
      year: str(edu.year),
      institution: str(edu.institution),
      degree: str(edu.degree) || str(edu.title),
      description: str(edu.description),
    })),
    skillsList: list(data.skillsList).map((sk) => ({
      id: str(sk.id) || shortId(),
      name: str(sk.name),
      level: typeof sk.level === "number" ? sk.level : 50,
      iconType: str(sk.iconType, "figma"),
    })),
    hobbies: Array.isArray(data.hobbies) ? data.hobbies.filter((h: unknown): h is string => typeof h === "string") : [],
    contact: list(data.contact).map((c) => ({
      id: str(c.id) || shortId(),
      label: str(c.label),
      value: str(c.value),
      href: str(c.href),
    })),
  };
}

export async function saveCVData(data: CVData): Promise<void> {
  await setDoc(doc(db, CV_COLLECTION, CV_DOC_ID), { ...data, myname: data.myname || "", myrole: data.myrole || "", updatedAt: serverTimestamp() });
}
