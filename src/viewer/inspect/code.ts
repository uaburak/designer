/**
 * The shape of Dev Mode's generated code (docs/research/atlas/14-dev-mode.md §4): a snippet is a list of sections
 * (`{name, language, lines, collapseAfterIndex}`), a line is `{code, indent, hint}` with one indent level = 2 spaces,
 * and a hint is the info icon whose tooltip explains a line (`dev_handoff.code.hints.<name>`, §4.1). The panel shows
 * each section with its own Copy (⇧: every section) and collapses one longer than 15 lines behind "Show N more" (§10).
 */

/** The hints of §4.1 our generators raise, by Figma's names. */
export type HintId =
  | "absolute_position"
  | "borders_dont_take_up_space"
  | "single_paint"
  | "unsupported_paint"
  | "unsupported_gradient_paint"
  | "leading_trim"
  | "plus_darker"
  | "background_blend_mode_plus_lighter_darker"
  | "swift_ui_separate_border_width"
  | "swift_ui_blur_no_spread"
  | "swift_ui_only_single_fill_for_shapes"
  | "swift_ui_separate_corner_radius"
  | "swift_ui_spacers_for_space_between"
  | "compose_separate_border_width"
  | "compose_shadow_incompatibility"
  | "compose_blur_tip"
  | "swift_ui_background_blur";

export interface Hint {
  id: HintId;
  /** `{name}` (absolute_position: the parent), `{value}` (the blend mode) */
  params?: Record<string, string>;
}

export interface CodeLine {
  code: string;
  /** Levels of 2 spaces */
  indent: number;
  hint?: Hint;
}

export type CodeHighlight = "css" | "swift" | "kotlin" | "xml" | "html";

export interface CodeSection {
  /** "Layout", "Style", "VStack", "Modifier"…, or a text run's first characters */
  name: string;
  language: CodeHighlight;
  lines: CodeLine[];
  /** Lines after this index are behind "Show N more" (Figma: 15) */
  collapseAfterIndex?: number;
}

/** Figma collapses a code section after its 15th line (atlas 14 §10). */
export const COLLAPSE_AFTER = 15;

/**
 * The hints' tooltips. Figma's build carries only the keys (`dev_handoff.code.hints.*`); this English says what each
 * one is raised for (§4.1) and is ours until a live Figma's wording is read (§18).
 */
export const HINT_TEXT: Record<HintId, string> = {
  absolute_position: "Positioned absolutely inside {name}",
  borders_dont_take_up_space: "Strokes aren't included in layout, so borders don't take up space",
  single_paint: "Only the first visible paint is used",
  unsupported_paint: "This paint can't be used here, so black is used instead",
  unsupported_gradient_paint: "A gradient can't be used here, so its first stop is used",
  leading_trim: "Leading trim isn't supported by every browser yet",
  plus_darker: "Plus darker is only supported by some browsers",
  background_blend_mode_plus_lighter_darker: "{value} is only supported by some browsers",
  swift_ui_separate_border_width: "SwiftUI can't set a width per side, so the widest is used",
  swift_ui_blur_no_spread: "SwiftUI shadows have no spread",
  swift_ui_only_single_fill_for_shapes: "SwiftUI shapes take only one fill",
  swift_ui_separate_corner_radius: "SwiftUI can't set a radius per corner, so the largest is used",
  swift_ui_spacers_for_space_between: "Space between is written with spacers between the views",
  compose_separate_border_width: "Compose can't set a border width per side, so the widest is used",
  compose_shadow_incompatibility: "Compose shadows are drawn from an elevation, so they won't match exactly",
  compose_blur_tip: "Modifier.blur works on Android 12 and later",
  swift_ui_background_blur: "SwiftUI has no background blur, so the layer is blurred",
};

/** One line as copied: its indent as spaces. */
export const lineText = (l: CodeLine) => `${"  ".repeat(l.indent)}${l.code}`;

/** A section's text (what its Copy puts on the clipboard). */
export const sectionText = (s: CodeSection) => s.lines.map(lineText).join("\n");

/** Every section, a blank line between (what Copy with ⇧ puts on the clipboard). */
export const sectionsText = (sections: readonly CodeSection[]) => sections.map(sectionText).join("\n\n");

/** Plain lines (each line's leading spaces read as its indent). */
export function linesOf(text: string, hint?: (line: string, i: number) => Hint | undefined): CodeLine[] {
  return text.split("\n").map((raw, i) => {
    const spaces = raw.length - raw.trimStart().length;
    return { code: raw.trimStart(), indent: Math.floor(spaces / 2), ...(hint?.(raw, i) ? { hint: hint(raw, i) } : {}) };
  });
}
