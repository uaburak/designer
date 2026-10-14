import { BrowserWindow, desktopCapturer, shell, systemPreferences } from "electron";
import { untrustedResult, type PickableWindow, type ReachView } from "../../../shared/agents/reach";
import type { ToolResult } from "../../../shared/agents/tools";
import type { ReachRunner, RunContext } from "./hub";

/**
 * Local apps (docs/agents-reach.md §9): a screenshot of a window the owner picks in the chat — the picker card is the
 * consent — with its title and size. Wecra's own windows aren't offered. Nothing is sent to the other app. On macOS the
 * Screen Recording permission is needed; without it the agent and the Access page say how to give it.
 */

export const SCREEN_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

export function screenPermission(): ReachView["screenPermission"] {
  if (process.platform !== "darwin") return "unknown";
  try {
    const s = systemPreferences.getMediaAccessStatus("screen");
    return s === "granted" || s === "denied" || s === "restricted" || s === "not-determined" ? s : "unknown";
  } catch {
    return "unknown";
  }
}

export const openScreenSettings = async () => {
  if (process.platform === "darwin") await shell.openExternal(SCREEN_SETTINGS_URL);
};

const NEEDS_PERMISSION =
  "Wecra isn't allowed to see other windows yet. The owner can allow it in System Settings › Privacy & Security › Screen & System Audio Recording (Agent settings › Access › Local apps has a button), then quit and reopen Wecra. Ask the owner to do that; don't call this again until then.";

const error = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** Wecra's own windows' capture ids ("window:<id>:0"). */
const ownWindows = () => new Set(BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId().split(":").slice(0, 2).join(":")));
const baseId = (id: string) => id.split(":").slice(0, 2).join(":");

export interface AppsDeps {
  /** The window picker card in the turn's chat: the picked window's id, or null (Deny, a stopped turn, 5 minutes) */
  pick(ctx: RunContext, windows: PickableWindow[]): Promise<string | null>;
}

export function appsRunner(deps: AppsDeps): ReachRunner {
  /** Windows the owner picked in a chat: with Always allow, the agent may see them again without a card */
  const picked = new Map<string, Set<string>>();
  return async (tool, args, ctx) => {
    if (tool !== "capture_app_window") return error(`Unknown tool: ${tool}`);
    const perm = screenPermission();
    if (perm === "denied" || perm === "restricted") return error(NEEDS_PERMISSION);
    const own = ownWindows();
    const maxSize = Math.min(2560, Math.max(320, Math.round(Number(args.maxSize) || 1600)));
    let windowId = typeof args.windowId === "string" ? args.windowId : null;
    const again = windowId && ctx.policy === "allow" && picked.get(ctx.chatId)?.has(baseId(windowId));
    if (!again) {
      let sources;
      try {
        sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: false });
      } catch {
        return error(NEEDS_PERMISSION);
      }
      const windows = sources
        .filter((s) => s.name.trim() && !own.has(baseId(s.id)) && !s.thumbnail.isEmpty())
        .slice(0, 40)
        .map((s): PickableWindow => ({ id: s.id, name: s.name.slice(0, 120), thumb: s.thumbnail.toDataURL() }));
      if (!windows.length) return error(perm === "granted" || perm === "unknown" ? "There are no other app windows to see. Ask the owner to open the app first." : NEEDS_PERMISSION);
      const choice = await deps.pick(ctx, windows);
      if (!choice || !windows.some((w) => w.id === choice)) return error("The owner didn't pick a window. Don't call this again for this request.");
      windowId = choice;
      const set = picked.get(ctx.chatId) ?? new Set<string>();
      set.add(baseId(choice));
      picked.set(ctx.chatId, set);
    }
    const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: maxSize, height: maxSize }, fetchWindowIcons: false }).catch(() => []);
    const src = sources.find((s) => baseId(s.id) === baseId(windowId!));
    if (!src || src.thumbnail.isEmpty()) return error("That window isn't open any more.");
    const size = src.thumbnail.getSize();
    const png = src.thumbnail.toPNG();
    const image = png.length < 3.5 * 1024 * 1024 ? { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" } : { type: "image" as const, data: src.thumbnail.toJPEG(80).toString("base64"), mimeType: "image/jpeg" };
    const r = untrustedResult("app-window", `Window: ${src.name}`, [image]);
    r.content.push({ type: "text", text: `Screenshot ${size.width} × ${size.height} px. windowId: ${src.id} (pass it to see this window again${ctx.policy === "allow" ? "" : " — the owner picks again each time"}).` });
    return r;
  };
}

