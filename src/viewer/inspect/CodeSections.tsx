/**
 * Dev Mode's code sections (docs/research/atlas/14-dev-mode.md §4, §10): each section's name and Copy — with ⇧ held
 * Copy takes every section, and hovering it with ⇧ marks them all — its lines indented 2 spaces a level, an info icon
 * on a line Figma explains (its hint as the tooltip), and a section longer than 15 lines collapsed behind
 * "Show {count} more".
 */
import { useEffect, useState } from "react";
import { Icon, IconButton, showToast, tooltipProps } from "@/ds";
import { t, useT } from "@/i18n";
import { HINT_TEXT, lineText, sectionsText, sectionText, type CodeSection } from "./code";
import styles from "../Viewer.module.css";

/** Names Figma gives its sections (the rest — a view, a text run's characters — stay as written). */
const SECTION_NAMES = new Set(["Layout", "Position", "Other", "Typography", "Style", "Variables"]);

function copy(text: string) {
  void navigator.clipboard?.writeText(text).then(
    () => showToast({ message: t("Copied to clipboard") }),
    () => showToast({ message: t("Couldn't copy") }),
  );
}

/** Whether ⇧ is held (Copy takes every section). */
function useShift(): boolean {
  const [shift, setShift] = useState(false);
  useEffect(() => {
    const on = (e: KeyboardEvent) => setShift(e.shiftKey);
    const off = () => setShift(false);
    window.addEventListener("keydown", on);
    window.addEventListener("keyup", on);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("keydown", on);
      window.removeEventListener("keyup", on);
      window.removeEventListener("blur", off);
    };
  }, []);
  return shift;
}

function Section({ section, all, shift, hovered, onHover }: { section: CodeSection; all: readonly CodeSection[]; shift: boolean; hovered: boolean; onHover: (on: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const limit = section.collapseAfterIndex;
  const shown = !open && limit !== undefined && section.lines.length > limit ? section.lines.slice(0, limit) : section.lines;
  const more = section.lines.length - shown.length;
  const name = SECTION_NAMES.has(section.name) ? t(section.name) : section.name;
  return (
    <div className={styles.codeGroup} data-code-section={section.name}>
      {all.length > 1 && <div className={styles.codeTitle}>{name}</div>}
      <div className={styles.codeSection} data-marked={shift && hovered ? "" : undefined}>
        <pre className={styles.codeLines} data-language={section.language}>
          {shown.map((l, i) => (
            <div key={i} className={styles.codeLine}>
              <span>{lineText(l) || " "}</span>
              {l.hint && (
                <span className={styles.codeHint} data-hint={l.hint.id} {...tooltipProps(t(HINT_TEXT[l.hint.id], l.hint.params))}>
                  <Icon name="16.info" />
                </span>
              )}
            </div>
          ))}
        </pre>
        <span className={styles.codeSectionCopy} onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)}>
          <IconButton
            icon="24.copy.small"
            label={shift ? t("Copy all sections") : t("Copy {sectionName}", { sectionName: name })}
            onClick={(e) => copy(e.shiftKey ? sectionsText(all) : sectionText(section))}
          />
        </span>
      </div>
      {more > 0 && (
        <button type="button" className={styles.codeMore} onClick={() => setOpen(true)}>
          {t("Show {count} more", { count: more })}
        </button>
      )}
    </div>
  );
}

export function CodeSections({ sections }: { sections: readonly CodeSection[] }) {
  useT();
  const shift = useShift();
  const [hovered, setHovered] = useState(false);
  return (
    <>
      {sections.map((s, i) => (
        <Section key={i} section={s} all={sections} shift={shift} hovered={hovered} onHover={setHovered} />
      ))}
    </>
  );
}
