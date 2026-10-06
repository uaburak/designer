import { publishProject } from "@/lib/firestore";
import { savedPage } from "@/figma/draft";

/** Publish from the home, with no editor open: the project's saved draft on the site, as the editor's Publish puts it (see savedPage). */
export async function publishSaved(slug: string): Promise<void> {
  await publishProject(slug, await savedPage(slug));
}
