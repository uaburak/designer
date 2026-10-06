import { useEffect, useLayoutEffect, useState, useRef, useCallback, useMemo } from "react";
import { Input } from "@/components/Input";
import { PillButton } from "@/components/Button";
import { Segmented } from "@/components/Segmented";
import { Select } from "@/components/Select";
import { getCVData, saveCVData } from "@/lib/firestore";
import { useUndo } from "@/components/admin/useUndo";
import { uploadMedia } from "@/lib/storage";
import { CVData } from "@/types/cv";
import { CVClient } from "./CVPage";
import { SITE_URL } from "@/lib/siteConfig";
import { shellBridge } from "@/app/bridge";
import { useTheme } from "@/context/ThemeContext";
import { SITE_TOKENS } from "@/tab/siteTokens";
import { cn } from "@/lib/utils";
import { JsonEditor } from "@/components/admin/JsonEditor";
import { Spinner } from "@/components/icons";

function uid() {
  return "id-" + Math.random().toString(36).slice(2, 9);
}

const ICON_TYPES = [
  "figma",
  "illustrator",
  "photoshop",
  "ai",
  "indesign",
  "office",
  "aftereffect",
  "html",
  "css",
  "tailwind",
];

const SOURCE_MODES = ["URL", "Upload"];

// ── Icons ─────────────────────────────────────────────────────────────────────

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M8 3.333v9.334M3.333 8h9.334" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Pill label matching AdminEditorClient ──────────────────────────────────────
function PillLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center px-[6px] text-[16px] font-medium text-[var(--text-title)] select-none whitespace-nowrap">
      {children}
    </span>
  );
}

// ── Traffic light action dots matching AdminEditorClient ────────────────────────
function TrafficDots({
  onUp,
  onDown,
  onDelete,
}: {
  onUp?: () => void;
  onDown?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      {onUp && (
        <button
          type="button"
          onClick={onUp}
          title="Move up"
          data-traffic-color="#00e288"
          data-traffic-icon="up"
          className="w-3 h-3 rounded-full transition-opacity duration-150 cursor-pointer flex-shrink-0 hover:opacity-75"
          style={{ background: "#00e288" }}
        />
      )}
      {onDown && (
        <button
          type="button"
          onClick={onDown}
          title="Move down"
          data-traffic-color="#e2d300"
          data-traffic-icon="down"
          className="w-3 h-3 rounded-full transition-opacity duration-150 cursor-pointer flex-shrink-0 hover:opacity-75"
          style={{ background: "#e2d300" }}
        />
      )}
      {onDelete && (
        <button
          type="button"
          onClick={() => {
            // (Undo — ⌘Z — brings it back too, until the page is left.)
            if (window.confirm("Delete this item?")) onDelete();
          }}
          title="Delete"
          data-traffic-color="#e20000"
          data-traffic-icon="trash"
          className="w-3 h-3 rounded-full transition-opacity duration-150 cursor-pointer flex-shrink-0 hover:opacity-75"
          style={{ background: "#e20000" }}
        />
      )}
    </div>
  );
}

// ── Auto-expanding Textarea without scrollbar ─────────────────────────────────

function AutoTextarea({
  value,
  onChange,
  placeholder,
  rows = 2,
  bgContext = "block",
}: {
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  rows?: number;
  bgContext?: "section" | "block";
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const autoResize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useEffect(() => {
    autoResize();
  }, [value, autoResize]);

  return (
    <textarea
      ref={ref}
      rows={rows}
      value={value}
      onChange={(e) => {
        onChange(e.target.value);
        autoResize();
      }}
      placeholder={placeholder}
      className={cn(
        "w-full resize-none overflow-hidden rounded-[18px] px-4 py-3 text-sm font-light leading-6 text-[var(--text-p)] placeholder:text-[var(--text-subtitle)] focus:outline-none focus:border-[var(--border-hover)] transition-all duration-150",
        bgContext === "section"
          ? "border border-[var(--border)] bg-[var(--bg-1)] hover:bg-[var(--bg-4)] hover:border-[var(--border-hover)]"
          : "border border-transparent bg-[var(--bg-1)] hover:bg-[var(--bg-1)] hover:border-[var(--border-hover)]"
      )}
    />
  );
}

// ── Reusable Media Upload Component ────────────────────────────────────────────

function MediaUploadField({
  value,
  onChange,
  folderSlug,
  accept = "image/*",
  placeholder = "Image URL — https://…",
}: {
  value: string;
  onChange: (url: string) => void;
  folderSlug: string;
  accept?: string;
  placeholder?: string;
}) {
  const [tab, setTab] = useState<"URL" | "Upload">("URL");
  const fileRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);

  const handleFile = async (file: File) => {
    setProgress(0);
    try {
      // The CV's own folder (cv/…): never a project's, so no project's deletion takes it.
      const url = await uploadMedia(file, `cv/${folderSlug.replace(/^cv-/, "")}`, setProgress);
      onChange(url);
    } catch (err) {
      console.error("Upload failed:", err);
      alert(err instanceof Error ? `Couldn’t upload the file: ${err.message}` : "Couldn’t upload the file.");
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="flex items-center gap-[10px]">
      <Segmented
        options={SOURCE_MODES}
        value={tab}
        onChange={(v) => setTab(v as "URL" | "Upload")}
        size="md"
      />
      {tab === "URL" ? (
        <Input
          type="url"
          bgContext="block"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          size="md"
          className="flex-1"
        />
      ) : (
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <input
            ref={fileRef}
            type="file"
            accept={accept}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
          />
          <PillButton
            size="md"
            bgContext="block"
            onClick={() => fileRef.current?.click()}
            startIcon={
              progress !== null ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="animate-spin">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="30 70" strokeLinecap="round"/>
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  <polyline points="17 8 12 3 7 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  <line x1="12" y1="3" x2="12" y2="15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              )
            }
          >
            {progress !== null ? `${progress}%` : "Choose file"}
          </PillButton>
          {value && (
            <span className="text-xs text-[var(--text-subtitle)] truncate max-w-[200px]">
              {value.split("/").pop()?.split("?")[0]}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main CV Admin Client ───────────────────────────────────────────────────────

/** What the JSON editor may put in the CV: its lists lists, its words words — else what is wrong. */
function cvProblem(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "It must be an object: { … }";
  const v = value as Record<string, unknown>;
  for (const key of ["aboutParagraphs", "experience", "education", "skillsList", "hobbies", "contact"]) {
    if (!Array.isArray(v[key])) return `“${key}” must be a list: [ … ]`;
  }
  for (const key of ["myname", "myrole", "profileImage", "cvPdfUrl"]) {
    if (v[key] !== undefined && typeof v[key] !== "string") return `“${key}” must be text`;
  }
  if ((v.aboutParagraphs as unknown[]).some((p) => typeof p !== "string")) return "“aboutParagraphs” must hold texts";
  if ((v.hobbies as unknown[]).some((p) => typeof p !== "string")) return "“hobbies” must hold texts";
  for (const key of ["experience", "education", "skillsList", "contact"]) {
    if ((v[key] as unknown[]).some((x) => !x || typeof x !== "object" || Array.isArray(x))) return `“${key}” must hold objects`;
  }
  return null;
}

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

/**
 * The CV page's editor, in a tab of its own: the form on the left, the page
 * as the site shows it on the right. Written to the site's CV (cv/main) only
 * with Save (⌘S); undo and redo in memory. The shell asks before the tab
 * closes with something unsaved.
 */
export function CVEditor({ tabId }: { tabId: string }) {
  const [cvData, setCvData] = useState<CVData | null>(null);
  const [saved, setSaved] = useState<CVData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });

  const load = useCallback(() => {
    getCVData()
      .then((data) => {
        setLoadError(null);
        setCvData(data);
        setSaved(data);
      })
      .catch((err) => {
        console.error("Failed to load CV data:", err);
        setLoadError(err instanceof Error ? err.message : String(err));
      });
  }, []);
  useEffect(load, [load]);

  // Undo / redo (⌘Z, ⇧⌘Z): the last 20 steps, in memory; nothing is written until Kaydet.
  const state = useMemo(() => ({ cv: cvData }), [cvData]);
  const history = useUndo(state, (step) => setCvData(step.cv), { ready: Boolean(cvData) });
  const dirty = Boolean(cvData && saved && cvData !== saved);

  const latest = useRef({ cvData, dirty });
  useEffect(() => {
    latest.current = { cvData, dirty };
  });
  const handleSave = useCallback(async (): Promise<boolean> => {
    const data = latest.current.cvData;
    if (!data) return false;
    setSaveState({ kind: "saving" });
    try {
      await saveCVData(data);
      // What was written is saved — an edit made meanwhile stays unsaved.
      setSaved(data);
      setSaveState({ kind: "saved" });
      window.setTimeout(() => setSaveState((st) => (st.kind === "saved" ? { kind: "idle" } : st)), 2000);
      return true;
    } catch (err) {
      console.error("Failed to save CV data:", err);
      const code = (err as { code?: string }).code;
      setSaveState({ kind: "error", message: code === "permission-denied" ? "Not allowed — sign in with the admin account." : err instanceof Error ? err.message : String(err) });
      return false;
    }
  }, []);

  // ⌘S saves, ⌘Z / ⇧⌘Z undo and redo (not while a field is typed in: its own undo is the browser's).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.code === "KeyS") {
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur?.();
        window.setTimeout(() => void handleSave(), 0);
        return;
      }
      const typing = document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
      if (typing || e.code !== "KeyZ") return;
      e.preventDefault();
      if (e.shiftKey) history.redo();
      else history.undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleSave, history]);

  // The shell: this tab's name and whether something is unsaved — it asks before the tab, or the window, closes.
  const shell = shellBridge();
  const { theme } = useTheme();
  useEffect(() => {
    shell?.report(tabId, { status: loadError ? "error" : cvData ? "ready" : "loading", title: "CV", dirty });
    document.title = "CV";
  }, [shell, tabId, loadError, cvData, dirty]);
  const saving = useRef(handleSave);
  useLayoutEffect(() => {
    saving.current = handleSave;
  });
  useEffect(() => {
    window.designerTab = {
      save: async () => (latest.current.dirty ? saving.current() : true),
      isDirty: () => latest.current.dirty,
      command: () => {},
    };
    return () => {
      delete window.designerTab;
    };
  }, []);

  if (loadError) {
    return (
      <div className="h-full w-full bg-[var(--bg-1)] flex flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-base font-medium text-[var(--text-title)]">Couldn’t load the CV</p>
        <p className="max-w-[420px] text-sm text-[var(--text-subtitle)]">{loadError}</p>
        <button type="button" onClick={() => { setLoadError(null); load(); }} className="h-9 px-4 rounded-full border border-[var(--border)] text-sm text-[var(--text-p)] hover:bg-[var(--bg-4)] cursor-pointer">Try again</button>
      </div>
    );
  }
  if (!cvData) {
    return (
      <div className="h-full w-full bg-[var(--bg-1)] flex items-center justify-center">
        <Spinner className="w-6 h-6 text-[var(--text-subtitle)]" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-hidden flex flex-col bg-[var(--bg-1)] transition-colors duration-200">
      {/* ── Split Editor (fills remaining height) ── */}
      <div className="flex-1 min-h-0 flex h-full">
        {/* ── LEFT PANEL — Editor Form ── */}
        <div className="flex flex-col w-1/2 border-r border-[var(--border)] overflow-y-auto">
          {/* Sticky Editor Header */}
          <div className="sticky top-0 z-30 flex items-center justify-between px-5 py-3 border-b border-[var(--border)] bg-[var(--bg-1)]/90 backdrop-blur-md">
            <div className="inline-flex items-center h-10 px-3.5 rounded-full border border-[var(--border)] bg-[var(--bg-1)] text-[var(--text-title)] text-sm font-medium select-none truncate max-w-[240px]">
              {cvData.myname || "CV"}
            </div>
            <div className="flex items-center gap-2">
              {saveState.kind === "error" && <span className="max-w-[220px] truncate text-xs text-red-500" title={saveState.message}>Couldn’t save: {saveState.message}</span>}
              <PillButton size="md" variant={saveState.kind === "saved" ? "filled" : "default"} onClick={() => void handleSave()} disabled={saveState.kind === "saving"} className="relative" title="Save (⌘S)">
                {saveState.kind === "saving" ? "Saving…" : saveState.kind === "saved" && !dirty ? "Saved" : "Save"}
                {dirty && saveState.kind !== "saving" && <span aria-label="Unsaved changes" className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-amber-400" />}
              </PillButton>
            </div>
          </div>

          {/* Form Scroll Area */}
          <div className="flex flex-col gap-6 px-5 py-8">
            {/* ─── 01 Profil ─── */}
            <div className="flex flex-col gap-[10px] p-[18px] rounded-[32px] border border-[var(--border)] bg-[var(--bg-2)] transition-colors duration-200">
              <PillLabel>01 Profile</PillLabel>

              <div className="flex flex-col gap-[10px] p-[12px] rounded-[18px] border border-[var(--border)] bg-[var(--bg-4)]">
                <PillLabel>Personal details</PillLabel>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <Input
                    size="md"
                    bgContext="block"
                    placeholder="Full name (myname)"
                    value={cvData.myname ?? ""}
                    onChange={(e) => setCvData({ ...cvData, myname: e.target.value })}
                  />
                  <Input
                    size="md"
                    bgContext="block"
                    placeholder="Title / role (myrole)"
                    value={cvData.myrole ?? ""}
                    onChange={(e) => setCvData({ ...cvData, myrole: e.target.value })}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-[10px] p-[12px] rounded-[18px] border border-[var(--border)] bg-[var(--bg-4)]">
                <PillLabel>Profile picture</PillLabel>
                <MediaUploadField
                  value={cvData.profileImage}
                  onChange={(url) => setCvData({ ...cvData, profileImage: url })}
                  folderSlug="cv-profile"
                  accept="image/*"
                  placeholder="Profile picture URL — https://…"
                />
              </div>

              <div className="flex flex-col gap-[10px] p-[12px] rounded-[18px] border border-[var(--border)] bg-[var(--bg-4)]">
                <PillLabel>CV PDF link</PillLabel>
                <MediaUploadField
                  value={cvData.cvPdfUrl}
                  onChange={(url) => setCvData({ ...cvData, cvPdfUrl: url })}
                  folderSlug="cv-pdf"
                  accept=".pdf"
                  placeholder="CV PDF URL — /CV-EN.pdf"
                />
              </div>

              <div className="flex flex-col gap-[10px] p-[12px] rounded-[18px] border border-[var(--border)] bg-[var(--bg-4)]">
                <PillLabel>CV PDF hover preview image</PillLabel>
                <MediaUploadField
                  value={cvData.cvPreviewImage || ""}
                  onChange={(url) => setCvData({ ...cvData, cvPreviewImage: url })}
                  folderSlug="cv-preview"
                  accept="image/*"
                  placeholder="Hover preview image URL — https://…"
                />
              </div>
            </div>

            {/* ─── 02 About ─── */}
            <div className="flex flex-col gap-[10px] p-[18px] rounded-[32px] border border-[var(--border)] bg-[var(--bg-2)] transition-colors duration-200">
              <div className="flex items-center justify-between">
                <PillLabel>02 About</PillLabel>
                <PillButton
                  size="md"
                  onClick={() =>
                    setCvData({
                      ...cvData,
                      aboutParagraphs: [...cvData.aboutParagraphs, ""],
                    })
                  }
                  startIcon={<PlusIcon />}
                >
                  Add paragraph
                </PillButton>
              </div>

              <div className="flex flex-col gap-3">
                {cvData.aboutParagraphs.map((paragraph, index) => (
                  <div
                    key={index}
                    className="flex flex-col gap-[10px] p-[12px] rounded-[18px] border border-[var(--border)] bg-[var(--bg-4)] transition-colors duration-150"
                  >
                    <div className="flex items-center justify-between">
                      <PillLabel>Paragraph {index + 1}</PillLabel>
                      <TrafficDots
                        onDelete={() => {
                          const next = cvData.aboutParagraphs.filter((_, i) => i !== index);
                          setCvData({ ...cvData, aboutParagraphs: next });
                        }}
                      />
                    </div>
                    <AutoTextarea
                      rows={3}
                      value={paragraph}
                      onChange={(val) => {
                        const next = [...cvData.aboutParagraphs];
                        next[index] = val;
                        setCvData({ ...cvData, aboutParagraphs: next });
                      }}
                      placeholder={`Paragraph ${index + 1}…`}
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* ─── 03 Deneyimler ─── */}
            <div className="flex flex-col gap-[10px] p-[18px] rounded-[32px] border border-[var(--border)] bg-[var(--bg-2)] transition-colors duration-200">
              <div className="flex items-center justify-between">
                <PillLabel>03 Experience</PillLabel>
                <PillButton
                  size="md"
                  onClick={() =>
                    setCvData({
                      ...cvData,
                      experience: [
                        {
                          id: uid(),
                          year: "2024 — Present",
                          company: "Company",
                          role: "Role",
                          description: "",
                        },
                        ...cvData.experience,
                      ],
                    })
                  }
                  startIcon={<PlusIcon />}
                >
                  Add experience
                </PillButton>
              </div>

              <div className="flex flex-col gap-3">
                {cvData.experience.map((exp, index) => (
                  <div
                    key={exp.id || index}
                    className="flex flex-col gap-[10px] p-[12px] rounded-[18px] border border-[var(--border)] bg-[var(--bg-4)] transition-colors duration-150"
                  >
                    <div className="flex items-center justify-between">
                      <PillLabel>Experience {index + 1}</PillLabel>
                      <TrafficDots
                        onUp={
                          index > 0
                            ? () => {
                                const arr = [...cvData.experience];
                                const item = arr.splice(index, 1)[0];
                                arr.splice(index - 1, 0, item);
                                setCvData({ ...cvData, experience: arr });
                              }
                            : undefined
                        }
                        onDown={
                          index < cvData.experience.length - 1
                            ? () => {
                                const arr = [...cvData.experience];
                                const item = arr.splice(index, 1)[0];
                                arr.splice(index + 1, 0, item);
                                setCvData({ ...cvData, experience: arr });
                              }
                            : undefined
                        }
                        onDelete={() => {
                          const next = cvData.experience.filter((_, i) => i !== index);
                          setCvData({ ...cvData, experience: next });
                        }}
                      />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                      <Input
                        size="md"
                        bgContext="block"
                        placeholder="Date / year (Jul 2024 — Present)"
                        value={exp.year}
                        onChange={(e) => {
                          const next = [...cvData.experience];
                          next[index] = { ...next[index], year: e.target.value };
                          setCvData({ ...cvData, experience: next });
                        }}
                      />
                      <Input
                        size="md"
                        bgContext="block"
                        placeholder="Company"
                        value={exp.company}
                        onChange={(e) => {
                          const next = [...cvData.experience];
                          next[index] = { ...next[index], company: e.target.value };
                          setCvData({ ...cvData, experience: next });
                        }}
                      />
                      <Input
                        size="md"
                        bgContext="block"
                        placeholder="Role / position"
                        value={exp.role}
                        onChange={(e) => {
                          const next = [...cvData.experience];
                          next[index] = { ...next[index], role: e.target.value };
                          setCvData({ ...cvData, experience: next });
                        }}
                      />
                    </div>

                    <AutoTextarea
                      rows={2}
                      value={exp.description}
                      onChange={(val) => {
                        const next = [...cvData.experience];
                        next[index] = { ...next[index], description: val };
                        setCvData({ ...cvData, experience: next });
                      }}
                      placeholder="What you did there…"
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* ─── 04 Education ─── */}
            <div className="flex flex-col gap-[10px] p-[18px] rounded-[32px] border border-[var(--border)] bg-[var(--bg-2)] transition-colors duration-200">
              <div className="flex items-center justify-between">
                <PillLabel>04 Education</PillLabel>
                <PillButton
                  size="md"
                  onClick={() =>
                    setCvData({
                      ...cvData,
                      education: [
                        {
                          id: uid(),
                          year: "2020 — 2024",
                          institution: "School",
                          degree: "Degree",
                          description: "",
                        },
                        ...cvData.education,
                      ],
                    })
                  }
                  startIcon={<PlusIcon />}
                >
                  Add education
                </PillButton>
              </div>

              <div className="flex flex-col gap-3">
                {cvData.education.map((edu, index) => (
                  <div
                    key={edu.id || index}
                    className="flex flex-col gap-[10px] p-[12px] rounded-[18px] border border-[var(--border)] bg-[var(--bg-4)] transition-colors duration-150"
                  >
                    <div className="flex items-center justify-between">
                      <PillLabel>Education {index + 1}</PillLabel>
                      <TrafficDots
                        onUp={
                          index > 0
                            ? () => {
                                const arr = [...cvData.education];
                                const item = arr.splice(index, 1)[0];
                                arr.splice(index - 1, 0, item);
                                setCvData({ ...cvData, education: arr });
                              }
                            : undefined
                        }
                        onDown={
                          index < cvData.education.length - 1
                            ? () => {
                                const arr = [...cvData.education];
                                const item = arr.splice(index, 1)[0];
                                arr.splice(index + 1, 0, item);
                                setCvData({ ...cvData, education: arr });
                              }
                            : undefined
                        }
                        onDelete={() => {
                          const next = cvData.education.filter((_, i) => i !== index);
                          setCvData({ ...cvData, education: next });
                        }}
                      />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                      <Input
                        size="md"
                        bgContext="block"
                        placeholder="Date / year (2017 — 2019)"
                        value={edu.year}
                        onChange={(e) => {
                          const next = [...cvData.education];
                          next[index] = { ...next[index], year: e.target.value };
                          setCvData({ ...cvData, education: next });
                        }}
                      />
                      <Input
                        size="md"
                        bgContext="block"
                        placeholder="School / institution"
                        value={edu.institution}
                        onChange={(e) => {
                          const next = [...cvData.education];
                          next[index] = { ...next[index], institution: e.target.value };
                          setCvData({ ...cvData, education: next });
                        }}
                      />
                      <Input
                        size="md"
                        bgContext="block"
                        placeholder="Degree / field"
                        value={edu.degree}
                        onChange={(e) => {
                          const next = [...cvData.education];
                          next[index] = { ...next[index], degree: e.target.value };
                          setCvData({ ...cvData, education: next });
                        }}
                      />
                    </div>

                    <AutoTextarea
                      rows={2}
                      value={edu.description}
                      onChange={(val) => {
                        const next = [...cvData.education];
                        next[index] = { ...next[index], description: val };
                        setCvData({ ...cvData, education: next });
                      }}
                      placeholder="About it…"
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* ─── 05 Yetenekler ─── */}
            <div className="flex flex-col gap-[10px] p-[18px] rounded-[32px] border border-[var(--border)] bg-[var(--bg-2)] transition-colors duration-200">
              <div className="flex items-center justify-between">
                <PillLabel>05 Skills</PillLabel>
                <PillButton
                  size="md"
                  onClick={() =>
                    setCvData({
                      ...cvData,
                      skillsList: [
                        ...cvData.skillsList,
                        { id: uid(), name: "Yeni Yetenek", level: 80, iconType: "figma" },
                      ],
                    })
                  }
                  startIcon={<PlusIcon />}
                >
                  Add skill
                </PillButton>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {cvData.skillsList.map((skill, index) => (
                  <div
                    key={skill.id || index}
                    className="flex flex-col gap-[10px] p-[12px] rounded-[18px] border border-[var(--border)] bg-[var(--bg-4)] transition-colors duration-150 relative"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <Input
                        size="sm"
                        bgContext="block"
                        type="text"
                        placeholder="Skill"
                        value={skill.name}
                        onChange={(e) => {
                          const next = [...cvData.skillsList];
                          next[index] = { ...next[index], name: e.target.value };
                          setCvData({ ...cvData, skillsList: next });
                        }}
                        className="flex-1 font-medium"
                      />
                      <Select
                        size="sm"
                        bgContext="block"
                        options={ICON_TYPES}
                        value={skill.iconType}
                        onChange={(val) => {
                          const next = [...cvData.skillsList];
                          next[index] = { ...next[index], iconType: val };
                          setCvData({ ...cvData, skillsList: next });
                        }}
                        className="w-28"
                      />
                      <TrafficDots
                        onDelete={() => {
                          const next = cvData.skillsList.filter((_, i) => i !== index);
                          setCvData({ ...cvData, skillsList: next });
                        }}
                      />
                    </div>
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={skill.level}
                        onChange={(e) => {
                          const next = [...cvData.skillsList];
                          next[index] = { ...next[index], level: Number(e.target.value) };
                          setCvData({ ...cvData, skillsList: next });
                        }}
                        className="flex-1 accent-[var(--text-title)] cursor-pointer"
                      />
                      <span className="text-xs font-mono w-8 text-right text-[var(--text-subtitle)]">
                        {skill.level}%
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* ─── 06 Hobiler ─── */}
            <div className="flex flex-col gap-[10px] p-[18px] rounded-[32px] border border-[var(--border)] bg-[var(--bg-2)] transition-colors duration-200">
              <div className="flex items-center justify-between">
                <PillLabel>06 Hobbies</PillLabel>
                <PillButton
                  size="md"
                  onClick={() =>
                    setCvData({
                      ...cvData,
                      hobbies: [...cvData.hobbies, "Yeni Hobi"],
                    })
                  }
                  startIcon={<PlusIcon />}
                >
                  Add hobby
                </PillButton>
              </div>

              <div className="flex flex-wrap gap-2">
                {cvData.hobbies.map((hobby, index) => (
                  <div
                    key={index}
                    className="flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-transparent bg-[var(--bg-1)] hover:border-[var(--border-hover)] transition-all duration-150"
                  >
                    <input
                      type="text"
                      placeholder="Hobby…"
                      value={hobby}
                      onChange={(e) => {
                        const next = [...cvData.hobbies];
                        next[index] = e.target.value;
                        setCvData({ ...cvData, hobbies: next });
                      }}
                      className="bg-transparent text-sm font-light text-[var(--text-p)] focus:outline-none w-36 placeholder:text-[var(--text-subtitle)]"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const next = cvData.hobbies.filter((_, i) => i !== index);
                        setCvData({ ...cvData, hobbies: next });
                      }}
                      title="Remove"
                      data-traffic-color="#e20000"
                      data-traffic-icon="trash"
                      className="w-3 h-3 rounded-full transition-opacity duration-150 cursor-pointer flex-shrink-0 hover:opacity-75"
                      style={{ background: "#e20000" }}
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* ─── 07 Contact ─── */}
            <div className="flex flex-col gap-[10px] p-[18px] rounded-[32px] border border-[var(--border)] bg-[var(--bg-2)] transition-colors duration-200">
              <div className="flex items-center justify-between">
                <PillLabel>07 Contact</PillLabel>
                <PillButton
                  size="md"
                  onClick={() =>
                    setCvData({
                      ...cvData,
                      contact: [
                        ...cvData.contact,
                        { id: uid(), label: "Sosyal Medya", value: "/kullanici", href: "https://" },
                      ],
                    })
                  }
                  startIcon={<PlusIcon />}
                >
                  Add contact
                </PillButton>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {cvData.contact.map((item, index) => (
                  <div
                    key={item.id || index}
                    className="flex flex-col gap-[10px] p-[12px] rounded-[18px] border border-[var(--border)] bg-[var(--bg-4)] transition-colors duration-150 relative"
                  >
                    <div className="flex items-center justify-between">
                      <PillLabel>Link {index + 1}</PillLabel>
                      <TrafficDots
                        onDelete={() => {
                          const next = cvData.contact.filter((_, i) => i !== index);
                          setCvData({ ...cvData, contact: next });
                        }}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2.5">
                      <Input
                        size="md"
                        bgContext="block"
                        placeholder="Label (e.g. Email)"
                        value={item.label}
                        onChange={(e) => {
                          const next = [...cvData.contact];
                          next[index] = { ...next[index], label: e.target.value };
                          setCvData({ ...cvData, contact: next });
                        }}
                      />
                      <Input
                        size="md"
                        bgContext="block"
                        placeholder="Shown as"
                        value={item.value}
                        onChange={(e) => {
                          const next = [...cvData.contact];
                          next[index] = { ...next[index], value: e.target.value };
                          setCvData({ ...cvData, contact: next });
                        }}
                      />
                    </div>
                    <Input
                      size="md"
                      bgContext="block"
                      placeholder="Link (href — https://…)"
                      value={item.href}
                      onChange={(e) => {
                        const next = [...cvData.contact];
                        next[index] = { ...next[index], href: e.target.value };
                        setCvData({ ...cvData, contact: next });
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Editable JSON Output */}
            <JsonEditor value={cvData} onChange={setCvData} validate={cvProblem} />
          </div>
        </div>

        {/* ── RIGHT PANEL — Live Preview ── */}
        <div className="flex flex-col w-1/2 overflow-y-auto bg-[var(--bg-1)] border-l border-[var(--border)]">
          {/* Sticky Preview Header */}
          <div className="sticky top-0 z-30 flex items-center justify-between px-5 py-3 border-b border-[var(--border)] bg-[var(--bg-1)]/90 backdrop-blur-md">
            <div className="inline-flex items-center h-10 px-3.5 rounded-full border border-[var(--border)] bg-[var(--bg-1)] text-[var(--text-title)] text-sm font-medium select-none">
              Live preview
            </div>
            <div className="flex items-center gap-3">
              <a
                href={`${SITE_URL}/cv`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-2)] text-xs font-medium text-[var(--text-title)] hover:bg-[var(--bg-4)] transition-colors"
              >
                Open on site
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path
                    d="M7 2h3v3M10 2L5.5 6.5M5 3H3C2.45 3 2 3.45 2 4v5c0 .55.45 1 1 1h5c.55 0 1-.45 1-1V7"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </a>
            </div>
          </div>

          {/* Live CV Page Preview — in the site's own colours */}
          <div className="relative w-full" style={{ ...SITE_TOKENS[theme], background: "var(--bg-1)", color: "var(--text-p)" }}>
            <CVClient previewData={cvData} isPreview={true} />
          </div>
        </div>
      </div>
    </div>
  );
}
