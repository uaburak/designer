/**
 * A team's "Enabled by default" for one library (docs/data.md §16.5; help.figma.com 360039234953 "Enable a library
 * for a team": Off › Design files, FigJam boards, Slide decks, Buzz files, All files): what the team's row resolves
 * to, and the smallest row that gives a choice — a type the org already turns on stays null (inherit), one it turns
 * on that the team doesn't want is an explicit off (Figma: lower levels override higher ones). Pure.
 */
import { LIBRARY_EDITOR_TYPES, type LibraryEditorType, type TeamLibraryRow } from "@shared/libraries/orgTypes";

export type DefaultChoice = "off" | "all" | LibraryEditorType;

/** Figma's names in the team's dropdown */
export const EDITOR_TYPE_LABEL: Record<LibraryEditorType, string> = { design: "Design files", figjam: "FigJam boards", slides: "Slide decks", buzz: "Buzz files" };
export const DEFAULT_CHOICE_LABEL = (c: DefaultChoice): string => (c === "off" ? "Off" : c === "all" ? "All files" : EDITOR_TYPE_LABEL[c]);
export const DEFAULT_CHOICES: readonly DefaultChoice[] = ["off", "all", ...LIBRARY_EDITOR_TYPES];

/** On by default above the team (the org's row; a workspace's says no type, read as Design files — ours) */
export function inherited(row: Pick<TeamLibraryRow, "defaultIn">, t: LibraryEditorType, workspaceId: string | null): boolean {
  return row.defaultIn.org.includes(t) || (t === "design" && workspaceId != null && row.defaultIn.workspaceIds.includes(workspaceId));
}

/** The editor types the team's files get the library in */
export function effectiveTypes(row: Pick<TeamLibraryRow, "defaultIn" | "setting">, workspaceId: string | null): LibraryEditorType[] {
  return LIBRARY_EDITOR_TYPES.filter((t) => row.setting.defaults[t] ?? inherited(row, t, workspaceId));
}

/** The dropdown's value; a mix the dropdown can't name is its types' labels joined */
export function defaultChoice(types: readonly LibraryEditorType[]): DefaultChoice | string {
  if (!types.length) return "off";
  if (types.length === LIBRARY_EDITOR_TYPES.length) return "all";
  if (types.length === 1) return types[0];
  return types.map((t) => EDITOR_TYPE_LABEL[t]).join(", ");
}

/** The team row's `defaults` for a choice */
export function defaultsFor(choice: DefaultChoice, row: Pick<TeamLibraryRow, "defaultIn">, workspaceId: string | null): Record<LibraryEditorType, boolean | null> {
  const out = {} as Record<LibraryEditorType, boolean | null>;
  for (const t of LIBRARY_EDITOR_TYPES) {
    const want = choice === "all" || choice === t;
    const above = inherited(row, t, workspaceId);
    out[t] = want === above ? null : want;
  }
  return out;
}
