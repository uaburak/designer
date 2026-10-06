import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectFields, ProjectMeta, ProjectVersion } from "@/types/project";
import {
  ConflictError,
  errorText,
  listVersions,
  loadDesign,
  loadProjectForEdit,
  loadVersion,
  publishProject,
  saveAll,
  unpublishProject,
  type SaveRequest,
} from "@/lib/firestore";
import { withStartingVariables } from "@/components/project/designVariables";
import { withStartingTextStyles } from "@/components/project/textStyles";
import { useUndo } from "@/components/admin/useUndo";
import { newDocument, upgradeDocument, type FigmaDocument } from "./model";
import { keepsOverview, overviewFields, withOverview } from "./overview";
import { currentLibrary, detachDeleted, libraryChanged, projectChanged, splitLibrary, withLibrary } from "./systemLibrary";
import { designSystemOf, type DesignSystem, type EditState } from "./designSystem";
import { publishedPage } from "./publish";

export { errorText };

/**
 * A project open in the editor: loaded from Firestore, edited in memory,
 * written back only with Save — never on its own (no autosave). Undo and
 * redo (the last 20 steps) are in memory only: they change nothing stored,
 * and with nothing edited there is nothing to undo.
 *
 *  - Unsaved: what differs from what was last loaded or saved — the
 *    project's file, the library, the variables, the text styles, each on
 *    its own (by reference: the editor makes new objects only where it
 *    changes something). Closing it with something unsaved asks first
 *    (the shell does: the tab, the window, signing out).
 *  - Save writes the parts that changed, all at once; one saved elsewhere
 *    since (another tab) is a conflict — overwrite it, or reload.
 *  - Publish puts the saved draft on the site (saving first what isn't).
 */

export type LoadStatus = { kind: "loading" } | { kind: "missing" } | { kind: "error"; message: string } | { kind: "ready" };
export type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; warning?: string }
  | { kind: "error"; message: string }
  | { kind: "conflict"; part: ConflictError["part"] };
export type PublishState = { kind: "idle" } | { kind: "publishing" } | { kind: "error"; message: string };

interface Revs {
  project: number;
  variables: number;
  textStyles: number;
  library: number;
}

/** Which parts of `now` differ from what was saved. */
function changedParts(saved: EditState, now: EditState) {
  return {
    project: projectChanged(saved.file, now.file),
    library: libraryChanged(saved.file, now.file) || saved.deletedComponents !== now.deletedComponents,
    variables: saved.variables !== now.variables || saved.deletedVariables !== now.deletedVariables,
    textStyles: saved.textStyles !== now.textStyles || saved.deletedTextStyles !== now.deletedTextStyles,
  };
}

/** Are two files the same — every field the same object (the page left open aside)? */
function sameFile(a: FigmaDocument, b: FigmaDocument) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.delete("currentPage");
  for (const k of keys) if ((a as unknown as Record<string, unknown>)[k] !== (b as unknown as Record<string, unknown>)[k]) return false;
  return true;
}

/** The project's fields as saved: its Overview's (title, category, year, description, cover), the rest as they were. */
const fieldsOf = (slug: string, s: EditState, m: ProjectMeta): ProjectFields => ({ slug, title: m.title, category: m.category, year: m.year, company: m.company, ...(overviewFields(s.file) ?? {}) });

export function useEditSession(slug: string) {
  const [status, setStatus] = useState<LoadStatus>({ kind: "loading" });
  const [edit, setEdit] = useState<{ state: EditState; currentPage?: string } | null>(null);
  const [saved, setSaved] = useState<EditState | null>(null);
  const [meta, setMeta] = useState<ProjectMeta | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const [publishState, setPublishState] = useState<PublishState>({ kind: "idle" });
  const revs = useRef<Revs>({ project: 0, variables: 0, textStyles: 0, library: 0 });
  const libraryMeta = useRef<{ version: number; seeded: Record<string, string> }>({ version: 0, seeded: {} });

  // ── Load ──
  useEffect(() => {
    let alive = true;
    Promise.all([loadProjectForEdit(slug), loadDesign()])
      .then(([project, design]) => {
        if (!alive) return;
        if (!project) return setStatus({ kind: "missing" });
        const library = currentLibrary(design.library);
        libraryMeta.current = { version: library.version, seeded: library.seeded };
        revs.current = { project: project.meta.rev, variables: design.variablesRev, textStyles: design.textStylesRev, library: design.libraryRev };
        const own = detachDeleted(
          project.canvas ? upgradeDocument(project.canvas) : newDocument(project.meta.title || slug),
          library,
          design.deletedVariables,
          withStartingVariables(design.variables),
          design.deletedTextStyles
        );
        const state: EditState = {
          file: withOverview(withLibrary(own, library), project.meta),
          variables: design.variables,
          deletedVariables: design.deletedVariables,
          textStyles: design.textStyles,
          deletedTextStyles: design.deletedTextStyles,
          deletedComponents: library.deleted,
        };
        setMeta(project.meta);
        setEdit({ state });
        // What was loaded (the library brought up to date, what was deleted made the project's own) is what "unsaved" is measured from.
        setSaved(state);
        setStatus({ kind: "ready" });
      })
      .catch((err) => {
        console.error("The project could not be loaded:", err);
        if (alive) setStatus({ kind: "error", message: errorText(err) });
      });
    return () => {
      alive = false;
    };
  }, [slug]);

  const state = edit?.state ?? null;
  const parts = useMemo(() => (state && saved ? changedParts(saved, state) : null), [state, saved]);
  const dirty = Boolean(parts && (parts.project || parts.library || parts.variables || parts.textStyles));

  // ── Edits ──
  const update = useCallback((change: (s: EditState) => EditState) => {
    setEdit((e) => {
      if (!e) return e;
      const next = change(e.state);
      // An edit that would break the page's overview (delete it, move it, wrap it…) is refused.
      if (next === e.state || (next.file !== e.state.file && !keepsOverview(e.state.file, next.file))) return e;
      return { ...e, state: next };
    });
  }, []);
  /** The editor's file changed: the page left open is the editor's own (not an edit — no undo step, nothing unsaved). */
  const onDoc = useCallback((change: (doc: FigmaDocument) => FigmaDocument) => {
    setEdit((e) => {
      if (!e) return e;
      const composed: FigmaDocument = { ...e.state.file, currentPage: e.currentPage };
      const next = change(composed);
      if (next === composed) return e;
      const { currentPage, ...rest } = next;
      const changed = !sameFile(rest, e.state.file);
      const file = changed && keepsOverview(e.state.file, rest) ? rest : e.state.file;
      if (file === e.state.file && currentPage === e.currentPage) return e;
      return { state: file === e.state.file ? e.state : { ...e.state, file }, currentPage };
    });
  }, []);
  const file = useMemo(() => (edit ? { ...edit.state.file, currentPage: edit.currentPage } : null), [edit]);
  const system: DesignSystem | null = useMemo(() => (state ? designSystemOf(state, update) : null), [state, update]);

  // ── Undo / redo: the last 20 steps of the edit state, in memory only ──
  const history = useUndo(state ?? ({} as EditState), (restored) => setEdit((e) => (e ? { ...e, state: restored } : e)), { ready: Boolean(state) });

  // ── Save ──
  const saving = useRef(false);
  const latest = useRef({ state, saved, meta });
  useEffect(() => {
    latest.current = { state, saved, meta };
  });
  const save = useCallback(async (force = false): Promise<boolean> => {
    const { state: s, saved: base, meta: m } = latest.current;
    if (!s || !base || !m || saving.current) return false;
    const changed = changedParts(base, s);
    if (!changed.project && !changed.library && !changed.variables && !changed.textStyles) {
      setSaveState({ kind: "saved" });
      return true;
    }
    saving.current = true;
    setSaveState({ kind: "saving" });
    const split = splitLibrary(s.file);
    const fields = fieldsOf(slug, s, m);
    const req: SaveRequest = { force };
    if (changed.project) req.project = { fields, canvas: split.project, rev: revs.current.project };
    if (changed.library) req.library = { data: { nodes: split.nodes, effectStyles: split.effectStyles, ...libraryMeta.current, deleted: s.deletedComponents }, rev: revs.current.library };
    if (changed.variables) req.variables = { list: s.variables, deleted: s.deletedVariables, rev: revs.current.variables };
    if (changed.textStyles) req.textStyles = { list: s.textStyles, deleted: s.deletedTextStyles, rev: revs.current.textStyles };
    try {
      const res = await saveAll(slug, req);
      revs.current = {
        project: res.projectRev ?? revs.current.project,
        variables: res.variablesRev ?? revs.current.variables,
        textStyles: res.textStylesRev ?? revs.current.textStyles,
        library: res.libraryRev ?? revs.current.library,
      };
      // What was written is what is saved now — an edit made while it was being written stays unsaved.
      setSaved(s);
      if (changed.project) setMeta((prev) => (prev ? { ...prev, ...fields, rev: revs.current.project, changedSincePublish: true, updatedAt: Date.now() } : prev));
      setSaveState({ kind: "saved", warning: res.large.length ? `Large file: ${res.large.map((l) => `${l.part} ${Math.round(l.bytes / 1024)} KB`).join(", ")} of the 1 MB a document can hold.` : undefined });
      return true;
    } catch (err) {
      console.error("Save failed:", err);
      if (err instanceof ConflictError) setSaveState({ kind: "conflict", part: err.part });
      else setSaveState({ kind: "error", message: errorText(err) });
      return false;
    } finally {
      saving.current = false;
    }
  }, [slug]);

  // The saved mark fades back to Save after a moment (an error stays until the next try).
  useEffect(() => {
    if (saveState.kind !== "saved" || saveState.warning) return;
    const t = window.setTimeout(() => setSaveState((st) => (st.kind === "saved" ? { kind: "idle" } : st)), 2000);
    return () => window.clearTimeout(t);
  }, [saveState]);

  // ── Publish ──
  const publish = useCallback(async () => {
    setPublishState({ kind: "publishing" });
    // The site shows what is saved: save first what isn't.
    if (!(await save())) return setPublishState({ kind: "error", message: "Save first — the project couldn't be saved." });
    const { state: s, meta: m } = latest.current;
    if (!s || !m) return;
    try {
      const page = publishedPage(s.file, fieldsOf(slug, s, m), m.order, withStartingVariables(s.variables), withStartingTextStyles(s.textStyles));
      await publishProject(slug, page);
      setMeta((prev) => (prev ? { ...prev, published: true, changedSincePublish: false, publishedAt: Date.now() } : prev));
      setPublishState({ kind: "idle" });
    } catch (err) {
      console.error("Publish failed:", err);
      setPublishState({ kind: "error", message: errorText(err) });
    }
  }, [save, slug]);
  const unpublish = useCallback(async () => {
    setPublishState({ kind: "publishing" });
    try {
      await unpublishProject(slug);
      setMeta((prev) => (prev ? { ...prev, published: false, publishedAt: null } : prev));
      setPublishState({ kind: "idle" });
    } catch (err) {
      setPublishState({ kind: "error", message: errorText(err) });
    }
  }, [slug]);

  // ── Versions: an older save back, as an edit (undo brings the current one back; Save keeps it) ──
  const versions = useCallback(() => listVersions(slug), [slug]);
  const restoreVersion = useCallback(async (version: ProjectVersion) => {
    const doc = await loadVersion(slug, version.id);
    const { state: s, meta: m } = latest.current;
    if (!s || !m) return;
    const split = splitLibrary(s.file);
    const library = { ...libraryMeta.current, nodes: split.nodes, effectStyles: split.effectStyles, deleted: s.deletedComponents };
    const own = detachDeleted(upgradeDocument(doc), library, s.deletedVariables, withStartingVariables(s.variables), s.deletedTextStyles);
    update((prev) => ({ ...prev, file: withOverview(withLibrary(own, library), m) }));
    setEdit((e) => (e ? { ...e, currentPage: undefined } : e));
  }, [slug, update]);

  // ── Leaving: closing the tab, the window, signing out — the shell asks first (see app/Shell.tsx) ──
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  });
  /** Leaving from inside the editor: asks first when something is unsaved. */
  const confirmLeave = useCallback(() => !dirtyRef.current || window.confirm("You have unsaved changes. Leave without saving?"), []);

  return {
    status,
    meta,
    file,
    onDoc,
    system,
    undo: history.undo,
    redo: history.redo,
    dirty,
    parts,
    save,
    saveState,
    publish,
    unpublish,
    publishState,
    versions,
    restoreVersion,
    confirmLeave,
  };
}

export type EditSession = ReturnType<typeof useEditSession>;
