import { loadDesign, loadProjectForEdit } from "@/lib/firestore";
import type { PublishedPage } from "@/types/project";
import { withStartingVariables } from "@/components/project/designVariables";
import { withStartingTextStyles } from "@/components/project/textStyles";
import { newDocument, upgradeDocument } from "./model";
import { overviewFields, withOverview } from "./overview";
import { publishedPage } from "./publish";
import { currentLibrary, detachDeleted, withLibrary } from "./systemLibrary";

/**
 * A project's saved draft as the site would show it once published — put
 * together as the editor opens it (the site's library, its Overview), frozen
 * as Publish freezes it. For the draft's preview and for publishing from the
 * home (no editor open: what a tab holds unsaved isn't in it).
 */
export async function savedPage(slug: string): Promise<PublishedPage> {
  const [project, design] = await Promise.all([loadProjectForEdit(slug), loadDesign()]);
  if (!project) throw new Error(`There is no project “${slug}”.`);
  const library = currentLibrary(design.library);
  const variables = withStartingVariables(design.variables);
  const own = detachDeleted(project.canvas ? upgradeDocument(project.canvas) : newDocument(project.meta.title || slug), library, design.deletedVariables, variables, design.deletedTextStyles);
  const file = withOverview(withLibrary(own, library), project.meta);
  const { title, titleEn, category, year, description, descriptionEn, coverImage, company } = project.meta;
  const fields = { slug, title, titleEn, category, year, description, descriptionEn, coverImage, company, ...(overviewFields(file) ?? {}) };
  return publishedPage(file, fields, project.meta.order, variables, withStartingTextStyles(design.textStyles));
}
