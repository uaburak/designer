import { useEffect, useRef, useState } from "react";
import { fi } from "@/components/admin/figmaIcons";
import { VERSIONS_KEPT } from "@/lib/firestore";
import type { ProjectVersion } from "@/types/project";
import { errorText, type EditSession } from "./session";
import { IconButton } from "./ui";

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString("tr-TR", { dateStyle: "medium", timeStyle: "short" }) : "—");

/**
 * Figma's version history, as a window over the editor: the project's last
 * saves, the latest first. One brought back is an edit like any other —
 * undo takes it back; Save keeps it (as a new version: nothing is lost).
 */
export function VersionsWindow({ session, onClose }: { session: EditSession; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [list, setList] = useState<ProjectVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    session.versions().then(setList, (err) => setError(errorText(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, as it opens
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const restore = async (v: ProjectVersion) => {
    setBusy(v.id);
    try {
      await session.restoreVersion(v);
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(null);
    }
  };
  return (
    <div data-instant="" className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onPointerDown={(e) => { if (!ref.current?.contains(e.target as Node)) onClose(); }}>
      <div ref={ref} role="dialog" aria-label="Version history" className="flex w-[400px] max-w-[calc(100vw-32px)] max-h-[min(560px,calc(100vh-64px))] flex-col rounded-[13px] bg-[var(--f-bg)] shadow-[0_0_0.5px_rgba(0,0,0,0.3),0_10px_16px_rgba(0,0,0,0.2)] text-[11px] leading-4 text-[var(--f-text)]">
        <div className="shrink-0 flex items-center justify-between h-12 pl-4 pr-2 border-b border-[var(--f-border)]">
          <span className="text-[13px] font-[550] leading-[22px] tracking-[-0.0325px]">Version history</span>
          <IconButton label="Close (Esc)" icon={fi("close.small")} onClick={onClose} />
        </div>
        <p className="shrink-0 px-4 pt-3 pb-2 text-[var(--f-text-secondary)]">
          The last {VERSIONS_KEPT} saves of this project. Restoring one puts it in the editor as an edit: undo takes it back, Save keeps it{session.dirty ? " — what isn't saved now goes with it (undo brings it back)" : ""}.
        </p>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {error && <p className="px-2 py-2 text-[#f24822]">{error}</p>}
          {!list && !error && <p className="px-2 py-2 text-[var(--f-text-secondary)]">Loading…</p>}
          {list?.length === 0 && <p className="px-2 py-2 text-[var(--f-text-secondary)]">No saved versions yet.</p>}
          {list?.map((v, i) => (
            <div key={v.id} className="group/version flex items-center gap-2 h-10 px-2 rounded-[5px] hover:bg-[var(--f-bg-row-hover)]">
              <div className="min-w-0 flex-1 flex flex-col">
                <span className="truncate font-[550]">{when(v.savedAt)}{i === 0 && <span className="ml-1.5 font-[450] text-[var(--f-text-secondary)]">· latest</span>}</span>
                <span className="truncate text-[var(--f-text-secondary)]">{v.title || "Untitled"} · save {v.rev}</span>
              </div>
              <button type="button" disabled={Boolean(busy)} onClick={() => void restore(v)} className="shrink-0 h-6 px-2 rounded-[5px] border border-[var(--f-border)] opacity-0 group-hover/version:opacity-100 focus-visible:opacity-100 hover:bg-[var(--f-bg-hover)] cursor-pointer disabled:opacity-50">
                {busy === v.id ? "Restoring…" : "Restore"}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
