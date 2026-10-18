import { describe, expect, it } from "vitest";
import type { VersionInfo } from "../documentSource";
import { historyRows, isAutosave, linkedVersion, steppable, versionLink, viewingLabel } from "../versionList";

const v = (id: string, at: number, kind: VersionInfo["kind"] = "autosave", title: string | null = null): VersionInfo => ({ id, kind, title, description: null, createdAt: at });
const shape = (rows: ReturnType<typeof historyRows>) => rows.map((r) => (r.type === "version" ? r.version.id : `${r.open ? "+" : "-"}[${r.versions.map((x) => x.id).join(",")}]`));

describe("version history", () => {
  it("names a version by its label, branching or restore; the rest are autosaves", () => {
    expect([v("a", 1), v("b", 1, "named"), v("c", 1, "named", "Ready"), v("d", 1, "restore"), v("e", 1, "merge"), v("f", 1, "autosave", "Named")].map(isAutosave)).toEqual([true, true, false, false, false, false]);
  });

  it("lists newest first, folding two or more autosaves in a row; a single one stays a row", () => {
    const list = [v("a1", 1), v("a2", 2), v("n1", 3, "named", "One"), v("a3", 4), v("n2", 5, "restore"), v("a4", 6), v("a5", 7), v("a6", 8)];
    expect(shape(historyRows(list, { showAutosaves: true }, new Set(), null))).toEqual(["-[a6,a5,a4]", "n2", "a3", "n1", "-[a2,a1]"]);
    // Opened by hand, or holding the selected version
    expect(shape(historyRows(list, { showAutosaves: true }, new Set(["group-a6"]), "a1"))).toEqual(["+[a6,a5,a4]", "n2", "a3", "n1", "+[a2,a1]"]);
    // Show autosave versions off
    expect(shape(historyRows(list, { showAutosaves: false }, new Set(), null))).toEqual(["n2", "n1"]);
    // While no named version exists, groups are open
    expect(shape(historyRows([v("a", 1), v("b", 2)], { showAutosaves: true }, new Set(), null))).toEqual(["+[b,a]"]);
  });

  it("pages 30 at a time and steps through what is listed", () => {
    const many = Array.from({ length: 70 }, (_, i) => v(`n${i}`, i, "named", `V${i}`));
    expect(historyRows(many, { showAutosaves: true }, new Set(), null)).toHaveLength(30);
    expect(historyRows(many, { showAutosaves: true }, new Set(), null, 60)).toHaveLength(60);
    expect(steppable([v("a", 1), v("n", 2, "named", "N")], { showAutosaves: false }).map((x) => x.id)).toEqual(["n"]);
  });

  it("cuts the Viewing label at 34 characters and links a version by version-id", () => {
    expect(viewingLabel("x".repeat(34))).toBe("x".repeat(34));
    expect(viewingLabel("x".repeat(40))).toBe(`${"x".repeat(34)}…`);
    const link = versionLink("http://localhost/?editor&file=f1#comment-x", "v_9");
    expect(link).toBe("http://localhost/?editor=&file=f1&version-id=v_9");
    expect(linkedVersion(new URL(link).search)).toBe("v_9");
  });
});
