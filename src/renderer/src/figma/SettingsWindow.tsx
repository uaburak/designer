import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { fi } from "@/components/admin/figmaIcons";
import type { EditorSettings } from "./settings";
import { IconButton, Switch } from "./ui";

/** One setting: its name and what it does at the left, its toggle at the right. */
function SettingRow({ title, hint, checked, onChange, indent = false, disabled = false }: { title: string; hint: string; checked: boolean; onChange: (checked: boolean) => void; /** A part of the setting above it */ indent?: boolean; disabled?: boolean }) {
  return (
    <div className={cn("flex items-start gap-4 pr-4 py-3", indent ? "pl-8" : "pl-4", disabled && "opacity-40 pointer-events-none")} aria-disabled={disabled}>
      <div className="min-w-0 flex-1 flex flex-col gap-0.5">
        <span className="text-[11px] font-[550] leading-4 tracking-[0.055px] text-[var(--f-text)]">{title}</span>
        <span className="text-[11px] leading-4 tracking-[0.055px] text-[var(--f-text-secondary)]">{hint}</span>
      </div>
      <div className="pt-0.5"><Switch label={title} checked={checked} onChange={onChange} /></div>
    </div>
  );
}

/** Figma's Preferences, as a window over the editor: the settings in groups, each a toggle. Esc or a click outside closes it. */
export function SettingsWindow({ settings, onChange, onClose }: { settings: EditorSettings; onChange: <K extends keyof EditorSettings>(key: K, value: EditorSettings[K]) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div data-instant="" className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onPointerDown={(e) => { if (!ref.current?.contains(e.target as Node)) onClose(); }}>
      <div ref={ref} role="dialog" aria-label="Settings" className="flex w-[400px] max-w-[calc(100vw-32px)] flex-col rounded-[13px] bg-[var(--f-bg)] shadow-[0_0_0.5px_rgba(0,0,0,0.3),0_10px_16px_rgba(0,0,0,0.2)] text-[11px] leading-4 text-[var(--f-text)]">
        <div className="flex items-center justify-between h-12 pl-4 pr-2 border-b border-[var(--f-border)]">
          <span className="text-[13px] font-[550] leading-[22px] tracking-[-0.0325px]">Settings</span>
          <IconButton label="Close (Esc)" icon={fi("close.small")} onClick={onClose} />
        </div>
        <div className="flex items-center h-10 pl-4 pr-2">
          <span className="text-[11px] leading-4 tracking-[0.055px] text-[var(--f-text-secondary)] select-none">Mouse</span>
        </div>
        <SettingRow
          title="Pan with the right mouse button"
          hint="Hold the right button and drag to move the canvas. A plain right click still opens the menu."
          checked={settings.rightMousePan}
          onChange={(v) => onChange("rightMousePan", v)}
        />
        <SettingRow
          title="Horizontal scroll zooms"
          hint="The mouse's horizontal wheel — the thumb wheel of a Logitech MX Master — zooms around the pointer. Trackpad swipes still pan."
          checked={settings.horizontalScrollZoom}
          onChange={(v) => onChange("horizontalScrollZoom", v)}
        />
        <SettingRow
          indent
          disabled={!settings.horizontalScrollZoom}
          title="Reverse the direction"
          hint="Right zooms out, left zooms in."
          checked={settings.horizontalScrollZoomReversed}
          onChange={(v) => onChange("horizontalScrollZoomReversed", v)}
        />
        <div className="h-2" />
      </div>
    </div>
  );
}
