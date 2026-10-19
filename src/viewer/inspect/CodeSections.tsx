/**
 * Dev Mode's code sections (docs/research/atlas/14-dev-mode.md §4, §10; the look: live devmode-inspect-right.txt and
 * the owner's capture owner-2026-10-18 — a title bar, then the lines numbered in a ring, CSS values in pink): each
 * section's name and Copy — with ⇧ held
 * Copy takes every section, and hovering it with ⇧ marks them all — its lines indented 2 spaces a level, an info icon
 * on a line Figma explains (its hint as the tooltip), a bound variable as a pill (§4.2; the text copied is the line's),
 * and a section longer than 15 lines collapsed behind "Show {count} more".
 */
import { useEffect, useState } from "react";
import { Icon, IconButton, showToast, tooltipProps } from "@/ds";
import { t, useT } from "@/i18n";
import { HINT_TEXT, sectionsText, sectionText, variableParts, type CodeSection } from "./code";
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
  // A CSS declaration's value in the code's value colour (the owner's capture: the property as text, the value pink).
  const parts = (code: string) => {
    const value = (text: string) =>
      variableParts(text, section.language).map((p, k) =>
        p.variable ? (
          <span key={k} className={styles.codeVariable} data-variable={p.text}>
            {p.text}
          </span>
        ) : (
          p.text
        )
      );
    const colon = section.language === "css" && !code.trimStart().startsWith("/*") ? code.indexOf(": ") : -1;
    if (colon < 0) return value(code);
    const end = code.endsWith(";") ? code.length - 1 : code.length;
    return (
      <>
        {code.slice(0, colon + 2)}
        <span className={styles.codeValue}>{value(code.slice(colon + 2, end))}</span>
        {code.slice(end)}
      </>
    );
  };
  return (
    <div className={styles.codeGroup} data-code-section={section.name}>
      {/* The section's title bar: its name, Copy at the right (live devmode-inspect-right.txt; the owner's capture) */}
      <div className={styles.codeHead}>
        <span className={styles.codeTitle}>{name}</span>
        <span onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)}>
          <IconButton
            icon="24.copy.small"
            label={shift ? t("Copy all sections") : t("Copy {sectionName}", { sectionName: name })}
            onClick={(e) => copy(e.shiftKey ? sectionsText(all) : sectionText(section))}
          />
        </span>
      </div>
      <div className={styles.codeSection} data-marked={shift && hovered ? "" : undefined}>
        <pre className={styles.codeLines} data-language={section.language}>
          {shown.map((l, i) => (
            <div key={i} className={styles.codeLine}>
              <span className={styles.codeNumber} aria-hidden>
                {i + 1}
              </span>
              <span className={styles.codeText}>
                {"  ".repeat(l.indent)}
                {l.code ? parts(l.code) : " "}
              </span>
              {l.hint && (
                <span className={styles.codeHint} data-hint={l.hint.id} {...tooltipProps(t(HINT_TEXT[l.hint.id], l.hint.params))}>
                  <Icon name="16.info" />
                </span>
              )}
            </div>
          ))}
        </pre>
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
