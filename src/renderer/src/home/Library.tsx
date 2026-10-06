import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesignVariable, TextStyle } from "@/types/design";
import { errorText, loadDesign, type StoredLibrary } from "@/lib/firestore";
import { DesignSystemProvider, DesignSystemStyle } from "@/components/project/designSystem";
import { resolvedValue, splitName, withStartingVariables } from "@/components/project/designVariables";
import { withStartingTextStyles } from "@/components/project/textStyles";
import { useTheme } from "@/context/ThemeContext";
import { allComponents, byIdMap, variantsOf, type FrameNode, type SceneNode } from "@/figma/model";
import { MotionStyle, NodeView, RenderProvider } from "@/figma/NodeView";
import { currentLibrary } from "@/figma/systemLibrary";
import { Button, Spinner } from "@/app/ui";

/**
 * The site's library, as Figma's Resources: what every project shares — its
 * components (drawn as they are), its colours, its text styles. Edited from
 * any project (Assets › Edit component, the Variables window, the Styles
 * list); seen here.
 */

interface Design {
  library: StoredLibrary;
  variables: DesignVariable[];
  textStyles: TextStyle[];
}

export function LibraryView() {
  const [design, setDesign] = useState<Design | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(
    () =>
      loadDesign()
        .then((d) => setDesign({ library: currentLibrary(d.library), variables: withStartingVariables(d.variables), textStyles: withStartingTextStyles(d.textStyles) }))
        .catch((err) => setError(errorText(err))),
    []
  );
  useEffect(() => {
    void load();
  }, [load]);
  if (error)
    return (
      <div className="flex flex-col items-center gap-3 pt-24 text-center">
        <p className="text-[13px] font-[600]">Couldn’t load the library</p>
        <p className="text-[11px] text-[var(--f-text-secondary)]">{error}</p>
        <Button
          onClick={() => {
            setError("");
            void load();
          }}
        >
          Try again
        </Button>
      </div>
    );
  if (!design)
    return (
      <div className="flex justify-center pt-24">
        <Spinner />
      </div>
    );
  return (
    <DesignSystemProvider variables={design.variables} textStyles={design.textStyles}>
      <Library design={design} />
    </DesignSystemProvider>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4 mb-12">
      <h2 className="flex items-baseline gap-2 text-[13px] font-[600] leading-5">
        {title}
        <span className="text-[11px] font-[450] text-[var(--f-text-secondary)] tabular-nums">{count}</span>
      </h2>
      {children}
    </section>
  );
}

function Library({ design }: { design: Design }) {
  const { theme } = useTheme();
  const byId = useMemo(() => byIdMap(design.variables), [design.variables]);
  const render = useMemo(() => ({ nodes: design.library.nodes, byId, lang: "tr" as const, play: false }), [design.library.nodes, byId]);
  // A set once (its first variant drawn), a component on its own once.
  const components = useMemo(
    () =>
      allComponents(design.library.nodes)
        .filter(({ component, set }) => !set || variantsOf(set)[0]?.id === component.id)
        .map(({ component, set }) => ({ node: (set ?? component) as FrameNode, shown: component, variants: set ? variantsOf(set).length : 0 }))
        // The page's own Overview (the project's fields) isn't a block to place.
        .filter(({ node }) => node.id !== "c-overview"),
    [design.library.nodes]
  );
  const colors = useMemo(() => design.variables.filter((v) => v.kind === "color"), [design.variables]);
  return (
    <div data-design-scope="" className="select-none">
      <DesignSystemStyle />
      <MotionStyle />
      <p className="-mt-2 mb-8 max-w-[640px] text-[11px] leading-4 text-[var(--f-text-secondary)]">
        Shared by every project: a change made in one project — a component edited from Assets, a variable in the Variables window, a text style — is everyone’s once it is saved, and reaches a published page when that page is published again.
      </p>
      <Section title="Components" count={components.length}>
        <RenderProvider value={render}>
          <div className="grid gap-6" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
            {components.map(({ node, shown, variants }) => (
              <ComponentCard key={node.id} node={shown} name={node.name} variants={variants} />
            ))}
          </div>
        </RenderProvider>
      </Section>
      <Section title="Colors" count={colors.length}>
        <div className="grid gap-x-6 gap-y-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
          {colors.map((v) => {
            const value = resolvedValue(v, theme, byId);
            const [group, own] = splitName(v.name);
            return (
              <div key={v.id} className="flex items-center gap-3 min-w-0">
                <span className="w-8 h-8 shrink-0 rounded-[6px] border border-[var(--f-border-translucent)]" style={{ background: typeof value === "string" ? value : undefined }} />
                <span className="min-w-0 flex flex-col">
                  <span className="truncate text-[11px] font-[500] leading-4">{own}</span>
                  <span className="truncate text-[11px] leading-4 text-[var(--f-text-secondary)]">{[group, typeof value === "string" ? value.toUpperCase() : ""].filter(Boolean).join(" · ")}</span>
                </span>
              </div>
            );
          })}
        </div>
      </Section>
      <Section title="Text styles" count={design.textStyles.length}>
        <div className="flex flex-col divide-y divide-[var(--f-border)] border-y border-[var(--f-border)]">
          {design.textStyles.map((s) => {
            const [group, own] = splitName(s.name);
            const size = "value" in s.fontSize ? s.fontSize.value : resolvedValue(byId.get(s.fontSize.alias)!, theme, byId);
            const weight = "value" in s.fontWeight ? s.fontWeight.value : resolvedValue(byId.get(s.fontWeight.alias)!, theme, byId);
            return (
              <div key={s.id} className="flex items-center gap-6 min-h-14 py-3">
                <span data-text-style={s.id} className="w-[45%] min-w-0 truncate">
                  {own}
                </span>
                <span className="flex-1 min-w-0 truncate text-[11px] leading-4 text-[var(--f-text-secondary)]">{group}</span>
                <span className="shrink-0 text-[11px] leading-4 tabular-nums text-[var(--f-text-secondary)]">
                  {size ?? "—"} · {weight ?? "—"}
                </span>
              </div>
            );
          })}
        </div>
      </Section>
    </div>
  );
}

/** A component drawn in a card, scaled to fit it (never past its own size). */
const ComponentCard = memo(function ComponentCard({ node, name, variants }: { node: SceneNode; name: string; variants: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = size.width ? Math.min(1, (size.width - 32) / Math.max(1, node.width), (size.height - 32) / Math.max(1, node.height)) : 0;
  return (
    <div className="flex flex-col rounded-[8px] border border-[var(--home-card-border)] overflow-hidden">
      <div ref={box} className="relative aspect-video overflow-hidden bg-[var(--home-thumb)]">
        {scale > 0 && (
          <div className="absolute pointer-events-none" style={{ left: "50%", top: "50%", width: node.width, height: node.height, transform: `translate(-50%, -50%) scale(${scale})` }}>
            <div className="absolute" style={{ left: -node.x, top: -node.y }}>
              <NodeView node={node} parentLayout="none" />
            </div>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 h-11 px-3 border-t border-[var(--home-card-border)]">
        <span className="flex shrink-0 text-[var(--f-text-component)]">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <path d="M8 2.2l2.1 2.1L8 6.4 5.9 4.3zM11.7 5.9l2.1 2.1-2.1 2.1L9.6 8zM4.3 5.9L6.4 8l-2.1 2.1L2.2 8zM8 9.6l2.1 2.1L8 13.8l-2.1-2.1z" />
          </svg>
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-[500] leading-4">{name}</span>
        {variants > 0 && <span className="shrink-0 text-[11px] leading-4 text-[var(--f-text-secondary)]">{variants} variants</span>}
      </div>
    </div>
  );
});
