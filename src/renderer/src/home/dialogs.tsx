import { useEffect, useState } from "react";
import { createProject, duplicateProject, errorText, listProjects, loadDesign, SlugTakenError } from "@/lib/firestore";
import { slugify, slugProblem } from "@/lib/slug";
import type { ProjectFields, ProjectMeta } from "@/types/project";
import { newDocument } from "@/figma/model";
import { overviewFields, withOverview, withOverviewTitle } from "@/figma/overview";
import { currentLibrary, splitLibrary, withLibrary } from "@/figma/systemLibrary";
import { Button, Modal, TextField } from "@/app/ui";

/**
 * The home's windows: a new project, a copy of one, deleting for good. A
 * project's slug is its address on the site (/projects/<slug>) — chosen
 * once, never changed.
 */

const TAKEN = "That slug is taken — pick another one.";

/** The slugs in use (in the trash too: a slug stays its project's until it is deleted for good). */
function useTakenSlugs(given?: ReadonlySet<string>) {
  const [taken, setTaken] = useState<ReadonlySet<string>>(given ?? new Set());
  useEffect(() => {
    if (given) return;
    let alive = true;
    listProjects()
      .then((list) => alive && setTaken(new Set(list.map((p) => p.slug))))
      .catch(() => { /* the save refuses a taken one anyway */ });
    return () => {
      alive = false;
    };
  }, [given]);
  return taken;
}

/** A title and its slug: the slug follows the title until it is typed in itself; what's wrong with it, under it. */
function TitleAndSlug({ title, slug, onTitle, onSlug, taken, onEnter }: { title: string; slug: string; onTitle: (t: string) => void; onSlug: (s: string) => void; taken: ReadonlySet<string>; onEnter: () => void }) {
  const problem = slug ? slugProblem(slug) ?? (taken.has(slug) ? TAKEN : null) : null;
  return (
    <>
      <TextField label="Title" value={title} onChange={onTitle} placeholder="Project name" autoFocus onEnter={onEnter} />
      <TextField label="Slug" value={slug} onChange={(v) => onSlug(v.trim())} placeholder="project-name" mono invalid={Boolean(problem)} onEnter={onEnter} hint={problem ?? (slug ? `burakkoc.net/projects/${slug} — it can’t be changed later.` : "Its address on the site: a–z, 0–9 and hyphens.")} />
    </>
  );
}

function useTitleAndSlug(initialTitle = "") {
  const [title, setTitle] = useState(initialTitle);
  const [slug, setSlug] = useState(() => slugify(initialTitle));
  const [slugTyped, setSlugTyped] = useState(false);
  return {
    title,
    slug,
    onTitle: (t: string) => {
      setTitle(t);
      if (!slugTyped) setSlug(slugify(t));
    },
    onSlug: (s: string) => {
      setSlugTyped(true);
      setSlug(s);
    },
  };
}

/** A new project: its page made with the site's library — the Overview first, the template's example in it to fill in — saved as a draft at once. */
export function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (slug: string, title: string) => void }) {
  const form = useTitleAndSlug();
  const taken = useTakenSlugs();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ready = Boolean(form.title.trim() && form.slug && !slugProblem(form.slug) && !taken.has(form.slug));
  const create = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    const title = form.title.trim();
    try {
      const library = currentLibrary((await loadDesign()).library);
      const base: ProjectFields = { slug: form.slug, title, category: "", year: new Date().getFullYear().toString() };
      const file = withOverview(withLibrary(newDocument(title), library), base);
      await createProject({ ...base, ...(overviewFields(file) ?? {}), title }, splitLibrary(file).project);
      onCreated(form.slug, title);
    } catch (err) {
      setError(err instanceof SlugTakenError ? TAKEN : `Couldn’t create it: ${errorText(err)}`);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="New project"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button kind="primary" disabled={!ready || busy} onClick={() => void create()}>{busy ? "Creating…" : "Create project"}</Button>
        </>
      }
    >
      <TitleAndSlug {...form} taken={taken} onEnter={() => void create()} />
      {error && <p className="text-[12px] leading-4 text-[#f24822]">{error}</p>}
      <p className="text-[11px] leading-4 text-[var(--f-text-secondary)]">It starts as a draft: Publish in the editor puts it on the site.</p>
    </Modal>
  );
}

/** A copy of a project — its page and fields under a new title and slug — as a draft at the end of the list. */
export function DuplicateDialog({ project, taken, onClose, onDone }: { project: ProjectMeta; taken: ReadonlySet<string>; onClose: () => void; onDone: (slug: string, title: string) => void }) {
  const form = useTitleAndSlug(`${project.title || project.slug} (copy)`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ready = Boolean(form.title.trim() && form.slug && !slugProblem(form.slug) && !taken.has(form.slug));
  const duplicate = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    const title = form.title.trim();
    try {
      await duplicateProject(project.slug, { slug: form.slug, title }, (canvas) => withOverviewTitle(canvas, title));
      onDone(form.slug, title);
    } catch (err) {
      setError(err instanceof SlugTakenError ? TAKEN : `Couldn’t duplicate it: ${errorText(err)}`);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Duplicate “${project.title || project.slug}”`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button kind="primary" disabled={!ready || busy} onClick={() => void duplicate()}>{busy ? "Duplicating…" : "Duplicate"}</Button>
        </>
      }
    >
      <TitleAndSlug {...form} taken={taken} onEnter={() => void duplicate()} />
      {error && <p className="text-[12px] leading-4 text-[#f24822]">{error}</p>}
    </Modal>
  );
}

/** Deleting for good — from the trash: the draft, its versions, everything stored of it (its pictures stay in Storage). */
export function DeleteForeverDialog({ projects, onClose, onConfirm }: { projects: ProjectMeta[]; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const one = projects.length === 1 ? projects[0] : null;
  const go = async () => {
    setBusy(true);
    setError("");
    try {
      await onConfirm();
    } catch (err) {
      setError(`Couldn’t delete: ${errorText(err)}`);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={one ? "Delete forever?" : `Delete ${projects.length} projects forever?`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button kind="danger" disabled={busy} onClick={() => void go()}>{busy ? "Deleting…" : "Delete forever"}</Button>
        </>
      }
    >
      <p>
        {one ? <><strong className="font-[600]">“{one.title || one.slug}”</strong>, its draft and its saved versions are</> : "Their drafts and saved versions are"} deleted for good. This can’t be undone.
      </p>
      <p className="text-[var(--f-text-secondary)]">The pictures stay in Storage — other pages may show them. The editor’s Images panel finds the unused ones.</p>
      {error && <p className="text-[12px] leading-4 text-[#f24822]">{error}</p>}
    </Modal>
  );
}
