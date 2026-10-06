import { useCallback, useEffect, useMemo, useState } from "react";
import type { PublishedPage } from "@/types/project";
import { errorText } from "@/lib/firestore";
import { cn } from "@/lib/utils";
import { DesignSystemProvider, DesignSystemStyle } from "@/components/project/designSystem";
import { savedPage } from "@/figma/draft";
import { BASE_LANGUAGE, writtenLanguages, type LangCode } from "@/figma/model";
import { PageView } from "@/figma/PageView";
import { shellBridge } from "@/app/bridge";
import { Button, Spinner } from "@/app/ui";
import { SITE_TOKENS } from "./siteTokens";

/**
 * A project's saved draft as the site would show it (its page, the site's
 * colours, scroll effects and all) — in a tab of its own, as Figma's
 * prototype tabs. At the site's widths: a desktop's, a tablet's, a phone's.
 */

const WIDTHS = [
  { label: "Desktop", width: null },
  { label: "Tablet", width: 768 },
  { label: "Phone", width: 390 },
] as const;

export function PreviewTab({ slug, tabId }: { slug: string; tabId: string }) {
  const [page, setPage] = useState<PublishedPage | null>(null);
  const [error, setError] = useState("");
  const [width, setWidth] = useState<number | null>(null);
  const [lang, setLang] = useState<LangCode>(BASE_LANGUAGE);
  const [version, setVersion] = useState(0);
  const theme = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const shell = shellBridge();

  const load = useCallback(
    () =>
      savedPage(slug)
        .then((p) => {
          setPage(p);
          setError("");
          setVersion((v) => v + 1);
        })
        .catch((err) => setError(errorText(err))),
    [slug]
  );
  useEffect(() => {
    void load();
  }, [load]);

  const title = page?.summary.title || slug;
  useEffect(() => {
    shell?.report(tabId, { status: error ? "error" : page ? "ready" : "loading", title: `${title} — Preview`, dirty: false });
    document.title = `${title} — Preview`;
  }, [shell, tabId, title, page, error]);
  useEffect(() => {
    window.designerTab = { save: async () => true, isDirty: () => false, command: () => {} };
    return () => {
      delete window.designerTab;
    };
  }, []);

  const languages = useMemo(() => (page ? writtenLanguages(page.doc) : []), [page]);

  return (
    <div className="flex flex-col h-full bg-[var(--f-bg)] text-[var(--f-text)]">
      <div className="flex items-center gap-3 h-10 shrink-0 px-3 border-b border-[var(--f-border)] text-[11px] leading-4 select-none">
        <span className="font-[600]">{title}</span>
        <span className="text-[var(--f-text-secondary)]">The saved draft, as the site would show it — not on the site</span>
        <div className="flex-1" />
        {languages.length > 1 && (
          <div role="group" aria-label="Language" className="flex items-center gap-0.5">
            {languages.map((l) => (
              <button key={l.code} type="button" aria-pressed={l.code === lang} onClick={() => setLang(l.code)} className={cn("h-6 px-2 rounded-[5px] uppercase", l.code === lang ? "bg-[var(--f-bg-secondary)] font-[550]" : "text-[var(--f-text-secondary)] hover:bg-[var(--f-bg-hover)]")}>
                {l.code}
              </button>
            ))}
          </div>
        )}
        <div role="tablist" aria-label="Width" className="flex items-center gap-0.5">
          {WIDTHS.map((w) => (
            <button key={w.label} type="button" role="tab" aria-selected={width === w.width} onClick={() => setWidth(w.width)} className={cn("h-6 px-2 rounded-[5px]", width === w.width ? "bg-[var(--f-bg-secondary)] font-[550]" : "text-[var(--f-text-secondary)] hover:bg-[var(--f-bg-hover)]")}>
              {w.label}
            </button>
          ))}
        </div>
        <Button size="small" onClick={() => void load()}>Reload</Button>
      </div>
      <div className="relative flex-1 min-h-0 bg-[var(--edit-canvas)]">
        {error ? (
          <div className="flex flex-col items-center justify-center gap-2 h-full text-center">
            <p className="text-[13px] font-[600]">Couldn’t show the draft</p>
            <p className="max-w-[440px] text-[11px] text-[var(--f-text-secondary)]">{error}</p>
            <Button className="mt-2" onClick={() => void load()}>Try again</Button>
          </div>
        ) : !page ? (
          <div className="flex items-center justify-center h-full">
            <Spinner />
          </div>
        ) : (
          <div data-page-scroller="" className="absolute inset-0 overflow-y-auto">
            <DesignSystemProvider variables={page.variables} textStyles={page.textStyles}>
              <div data-design-scope="" className={cn("min-h-full mx-auto transition-[width]", width && "shadow-[0_0_0_1px_var(--f-border)]")} style={{ ...SITE_TOKENS[theme], width: width ?? "100%", background: "var(--bg-1)", color: "var(--text-p)" }}>
                <DesignSystemStyle />
                <div className="pt-10 pb-24">
                  <PageView key={version} doc={page.doc} variables={page.variables} lang={lang} />
                </div>
              </div>
            </DesignSystemProvider>
          </div>
        )}
      </div>
    </div>
  );
}
