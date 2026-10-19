import { describe, expect, it } from "vitest";
import { hasUnsaved, reminderText, saveIcon, SAVE_STATUS, type SaveInputs } from "../saveStatus";

const base: SaveInputs = { now: 100_000, shared: false, connection: "offline", downSince: null, editedWhileDown: false, local: { since: null, last: 0 }, server: null };

describe("the save status (atlas 22 §3.4)", () => {
  it("shows nothing while changes are taken in time", () => {
    expect(saveIcon(base)).toEqual({ icon: null, reason: null });
    expect(saveIcon({ ...base, local: { since: 95_000, last: 0 } }).icon).toBeNull(); // 5 s
  });

  it("shows the unsaved icon after 10 s without an acknowledgement, or 30 s in all", () => {
    expect(saveIcon({ ...base, local: { since: 89_000, last: 0 } })).toEqual({ icon: "unsaved", reason: "local" });
    // Acknowledgements keep coming: 10 s since the last one isn't reached, 30 s since the first is.
    expect(saveIcon({ ...base, local: { since: 75_000, last: 95_000 } }).icon).toBeNull();
    expect(saveIcon({ ...base, local: { since: 69_000, last: 99_000 } }).icon).toBe("unsaved");
    const live = { ...base, shared: true, connection: "live" as const };
    expect(saveIcon({ ...live, server: { since: 85_000, last: 0 } })).toEqual({ icon: "unsaved", reason: "server" });
  });

  it("shows the offline icon when a shared file's link has been down past 10 s", () => {
    const down = { ...base, shared: true, connection: "connecting" as const, downSince: 100_000 - SAVE_STATUS.disconnectedMs + 1 };
    expect(saveIcon(down).icon).toBeNull();
    expect(saveIcon({ ...down, downSince: 85_000 })).toEqual({ icon: "offline", reason: "disconnected" });
    // A local file is never "offline".
    expect(saveIcon({ ...base, downSince: 0 }).icon).toBeNull();
  });

  it("counts as unsaved what the store or the room hasn't taken (edits while down too)", () => {
    expect(hasUnsaved(base)).toBe(false);
    expect(hasUnsaved({ ...base, local: { since: 1, last: 0 } })).toBe(true);
    expect(hasUnsaved({ ...base, shared: true, connection: "live", server: { since: 1, last: 0 } })).toBe(true);
    expect(hasUnsaved({ ...base, shared: true, connection: "offline", editedWhileDown: true })).toBe(true);
    expect(hasUnsaved({ ...base, shared: true, connection: "offline" })).toBe(false);
  });

  it("⌘S's reminder: offline, unsaved, or once in 14 days that there's nothing to save", () => {
    expect(reminderText({ offline: true, unsaved: true }, null, 0)).toMatch(/offline/);
    expect(reminderText({ offline: false, unsaved: true }, null, 0)).toMatch(/still being saved/);
    expect(reminderText({ offline: false, unsaved: false }, null, 0, () => 0.3)).toBe("💾  You don't need to save. Your changes are saved as you go.");
    expect(reminderText({ offline: false, unsaved: false }, 1, SAVE_STATUS.reminderEveryMs)).toBeNull();
    expect(reminderText({ offline: false, unsaved: false }, 0, SAVE_STATUS.reminderEveryMs)).not.toBeNull();
  });
});
