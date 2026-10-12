/**
 * The Actions panel's AI views (docs/ai.md §3): an action's form — Rewrite this…'s prompt, Translate to…'s
 * languages, Replace content's optional prompt, First Draft (prompt, suggestions, Library, "Make it", then the themes
 * and "Make changes": a prompt or the style controls) —, the run's progress with Stop, and its error in Figma's words
 * (over-limit: the AI balance). Rendered in place of the panel's list (panels/ActionsPanel.tsx).
 */
import { useMemo, useState, useSyncExternalStore } from "react";
import { Badge, Button, Icon, IconButton, NumericInput, SegmentedControl, Select, Spinner, TextArea, TextInput, cx } from "@/ds";
import { AI_ACTION_LABEL } from "@shared/ai/labels";
import { FIRST_DRAFT_SUGGESTIONS, TRANSLATE_LANGUAGES } from "@shared/ai/prompts";
import { COLOR_PRESETS, FONT_CHOICES, LIBRARY_CHOICES, kitById, type LibraryChoice } from "@shared/ai/kits";
import type { AiAction } from "@shared/ai/types";
import { openAiBalance } from "../../settings/AiBalance";
import { lookOf } from "./draft/build";
import type { AiActions, AiState } from "./service";
import styles from "./AiPanel.module.css";

export function useAiState(ai: AiActions): AiState {
  return useSyncExternalStore(
    (l) => ai.subscribe(l),
    () => ai.get()
  );
}

/** The panel shows an AI view (a form, a run it started, or that run's error). */
export const showsAiView = (s: AiState): boolean => !!s.form || !!s.run?.fromPanel || !!s.error;

const FORM_ACTION: Record<NonNullable<AiState["form"]>, AiAction> = { rewrite: "rewrite", translate: "translate", "replace-content": "replace-content", "first-draft": "first-draft" };

/** The AI badge (live: "AI", a link "AI, Learn more"). */
export function AiBadge() {
  return (
    <a className={styles.badge} href="https://help.figma.com/hc/en-us/articles/23870272542231" target="_blank" rel="noopener noreferrer" aria-label="AI, Learn more" onClick={(e) => e.stopPropagation()}>
      AI
    </a>
  );
}

export function AiPanelView({ ai, onDone }: { ai: AiActions; onDone: () => void }) {
  const s = useAiState(ai);
  const action: AiAction | null = s.run?.action ?? (s.form ? FORM_ACTION[s.form] : null) ?? s.error?.action ?? null;
  const title = action ? AI_ACTION_LABEL[action] : "";
  const finish = (r: unknown) => {
    if (r !== null && !ai.get().error) onDone();
  };
  return (
    <div className={styles.view} data-ai-view={s.form ?? s.run?.action ?? ""}>
      <div className={styles.header}>
        <IconButton icon="24.arrow.left" label="Back" tone="secondary" disabled={!!s.run} onClick={() => ai.openForm(null)} />
        <span className={styles.title}>{title}</span>
        <Badge>AI</Badge>
      </div>
      <div className={styles.body}>
        {s.run ? (
          <div className={styles.running} role="status">
            <Spinner size={24} label={s.run.label} />
            <span>{s.run.label}</span>
            <Button variant="secondary" onClick={() => ai.stop()}>
              Stop
            </Button>
          </div>
        ) : s.error ? (
          <div className={styles.error} role="alert">
            <Icon name="24.warning" />
            <p>{s.error.message}</p>
            <div className={styles.actions}>
              {s.error.code === "over-limit" && (
                <Button variant="secondary" onClick={openAiBalance}>
                  AI balance
                </Button>
              )}
              <Button variant="primary" onClick={() => ai.dismissError()}>
                Try again
              </Button>
            </div>
          </div>
        ) : s.form === "rewrite" ? (
          <PromptForm placeholder="Describe how to rewrite it" button="Rewrite" required onSubmit={(p) => void ai.editTexts({ kind: "rewrite", prompt: p }, { fromPanel: true }).then(finish)} />
        ) : s.form === "replace-content" ? (
          <PromptForm placeholder="Describe the content (optional)" button="Replace content" onSubmit={(p) => void ai.replaceContent(p, { fromPanel: true }).then(finish)} />
        ) : s.form === "translate" ? (
          <Languages onPick={(language) => void ai.editTexts({ kind: "translate", language }, { fromPanel: true }).then(finish)} />
        ) : s.form === "first-draft" ? (
          <FirstDraft ai={ai} state={s} onDone={onDone} />
        ) : null}
      </div>
    </div>
  );
}

function PromptForm({ placeholder, button, required, onSubmit }: { placeholder: string; button: string; required?: boolean; onSubmit: (prompt: string) => void }) {
  const [text, setText] = useState("");
  const submit = () => (!required || text.trim()) && onSubmit(text.trim());
  return (
    <div
      className={styles.form}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submit();
        }
      }}
    >
      <TextArea label={placeholder} placeholder={placeholder} value={text} onChange={setText} minRows={3} maxRows={6} autoFocus />
      <div className={styles.actions}>
        <Button variant="primary" disabled={required && !text.trim()} onClick={submit}>
          {button}
        </Button>
      </div>
    </div>
  );
}

function Languages({ onPick }: { onPick: (language: string) => void }) {
  const [q, setQ] = useState("");
  const list = TRANSLATE_LANGUAGES.filter((l) => l.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className={styles.form}>
      <TextInput label="Search languages" placeholder="Search languages" value={q} onChange={setQ} autoFocus prefix="24.search.small" />
      <div role="listbox" aria-label="Languages" className={styles.list}>
        {list.map((l) => (
          <div key={l} role="option" aria-selected={false} tabIndex={0} className={styles.option} onClick={() => onPick(l)} onKeyDown={(e) => e.key === "Enter" && onPick(l)}>
            {l}
          </div>
        ))}
        {!list.length && <p className={styles.note}>No languages match</p>}
      </div>
    </div>
  );
}

function FirstDraft({ ai, state, onDone }: { ai: AiActions; state: AiState; onDone: () => void }) {
  const [prompt, setPrompt] = useState("");
  const [library, setLibrary] = useState<LibraryChoice>("auto");
  const [change, setChange] = useState("");
  const [custom, setCustom] = useState("");
  const d = state.draft;
  const kit = useMemo(() => (d ? kitById(d.kit) : null), [d]);
  if (!d || !kit) {
    return (
      <div className={styles.form}>
        <TextArea label="Describe what you want to make" placeholder="Describe what you want to make" value={prompt} onChange={setPrompt} minRows={3} maxRows={5} autoFocus />
        <div className={styles.chips}>
          {FIRST_DRAFT_SUGGESTIONS.map((sg) => (
            <button key={sg} type="button" className={styles.chip} onClick={() => setPrompt(sg)}>
              {sg}
            </button>
          ))}
        </div>
        <div className={styles.actions}>
          <Select label="Library" prefix="24.library" value={library} options={LIBRARY_CHOICES.map((c) => ({ value: c.id, label: c.label }))} onChange={(v) => setLibrary(v as LibraryChoice)} width={180} />
          <Button variant="primary" disabled={!prompt.trim()} onClick={() => void ai.firstDraft(prompt.trim(), library)}>
            Make it
          </Button>
        </div>
      </div>
    );
  }
  const theme = kit.themes.find((t) => t.id === d.theme) ?? kit.themes[0];
  const look = lookOf(kit, theme, d.style);
  return (
    <div className={styles.form}>
      <div className={styles.label}>Theme</div>
      <div className={styles.themes} role="radiogroup" aria-label="Theme">
        {kit.themes.map((t) => {
          const p = d.style.mode === "dark" ? t.dark : t.light;
          return (
            <button key={t.id} type="button" role="radio" aria-checked={t.id === d.theme} aria-label={t.name} className={cx(styles.theme, t.id === d.theme && styles.themeOn)} onClick={() => ai.restyleDraft({ theme: t.id })}>
              <span className={styles.themeSwatches} style={{ background: p.background }}>
                <span style={{ background: p.primary }} />
                <span style={{ background: p.text }} />
                <span style={{ background: p.surface }} />
              </span>
              <span>{t.name}</span>
            </button>
          );
        })}
      </div>
      <div className={styles.label}>Make changes</div>
      <div className={styles.row}>
        <TextInput className={styles.grow} label="Describe a change" placeholder="Describe a change" value={change} onChange={setChange} onCommit={(v) => v.trim() && void ai.changeDraft(v.trim()).then(() => setChange(""))} />
        <Button variant="secondary" disabled={!change.trim()} onClick={() => void ai.changeDraft(change.trim()).then(() => setChange(""))}>
          Make changes
        </Button>
      </div>
      <div className={styles.row}>
        <span className={styles.field}>Color</span>
        <SegmentedControl label="Color" value={d.style.mode} options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} onChange={(v) => ai.restyleDraft({ style: { mode: v as "light" | "dark" } })} />
        <span className={styles.presets}>
          {COLOR_PRESETS.map((c) => (
            <button key={c.color} type="button" aria-label={c.name} aria-pressed={look.p.primary === c.color} className={cx(styles.preset, look.p.primary === c.color && styles.presetOn)} style={{ background: c.color }} onClick={() => ai.restyleDraft({ style: { primary: c.color } })} />
          ))}
        </span>
        <TextInput className={styles.hex} label="Custom color" placeholder="Custom" value={custom} onChange={setCustom} onCommit={(v) => /^#?[0-9a-f]{6}$/i.test(v.trim()) && ai.restyleDraft({ style: { primary: `#${v.trim().replace("#", "")}` } })} />
      </div>
      <div className={styles.row}>
        <span className={styles.field}>Border radius</span>
        <NumericInput label="Border radius" value={look.r} min={0} max={64} precision={0} onChange={(v, info) => info.final && ai.restyleDraft({ style: { radius: v } })} />
        <span className={styles.field}>Spacing</span>
        <NumericInput label="Spacing" value={look.s} min={2} max={24} precision={0} onChange={(v, info) => info.final && ai.restyleDraft({ style: { spacing: v } })} />
      </div>
      <div className={styles.row}>
        <span className={styles.field}>Typography</span>
        {(["title", "body", "label"] as const).map((role) => (
          <Select key={role} label={`${role[0].toUpperCase()}${role.slice(1)} font`} value={look.f[role].family} options={FONT_CHOICES.map((f) => ({ value: f, label: f }))} onChange={(v) => ai.restyleDraft({ style: { fonts: { ...d.style.fonts, [role]: v } } })} width={96} />
        ))}
      </div>
      <div className={styles.actions}>
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
