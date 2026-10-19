/**
 * The first-party code of one layer in a language and its units (docs/research/atlas/14-dev-mode.md §4): CSS,
 * SwiftUI, UIKit, Compose or Android XML, each line converted to the chosen unit (UIKit and XML say unit scale isn't
 * supported, §4). The Inspect panel, Copy as code and the Dev Mode views that show code read it here.
 */
import type { CodeSection } from "./code";
import { cssSections } from "./css";
import type { InspectInput } from "./model";
import { composeSections, swiftUISections } from "./native";
import { androidXmlSections, uikitSections } from "./nativeClassic";
import { composeInUnit, cssInUnit, swiftUIInUnit, DEFAULT_UNITS, type Language, type UnitSettings } from "./units";

export function codeSections(input: InspectInput, language: Language, units: UnitSettings = DEFAULT_UNITS): CodeSection[] {
  const [sections, convert]: [CodeSection[], (code: string) => string] =
    language === "swiftui"
      ? [swiftUISections(input), (c) => swiftUIInUnit(c, units, "swiftui")]
      : language === "uikit"
        ? [uikitSections(input), (c) => c]
        : language === "compose"
          ? [composeSections(input), (c) => composeInUnit(c, units, "compose")]
          : language === "xml"
            ? [androidXmlSections(input), (c) => c]
            : [cssSections(input), (c) => cssInUnit(c, units)];
  return sections.map((s) => ({ ...s, lines: s.lines.map((l) => ({ ...l, code: convert(l.code) })) }));
}
