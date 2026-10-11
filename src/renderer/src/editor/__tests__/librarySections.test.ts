/** The Libraries modal's sections (LibrariesDialog `otherSections`): headings by team and organization in an org file. */
import { describe, expect, it } from "vitest";
import type { LibraryEntry } from "../documentSource";
import { otherSections } from "../panels/libraries/LibrariesDialog";

const entry = (name: string, org?: Record<string, unknown>) => ({ fileKey: name, name, ...(org ? { org } : {}) }) as unknown as LibraryEntry;

describe("otherSections", () => {
  it("a local file lists its workspace's libraries", () => {
    expect(otherSections([entry("Kit")], null)).toEqual([{ title: "Libraries in this workspace", entries: [entry("Kit")] }]);
  });

  it("an org file: the person's teams, then the organization's, approved first", () => {
    const team = entry("Tokens", { via: ["team"], teamName: "Design System" });
    const a = entry("Icons", { via: ["org"], teamName: "Brand" });
    const b = entry("Kit", { via: ["org"], teamName: "Brand", approved: "org" });
    expect(otherSections([team, a, b], "Acme").map((s) => [s.title, s.entries.map((e) => e.name)])).toEqual([
      ["Design System", ["Tokens"]],
      ["Acme", ["Kit", "Icons"]],
    ]);
  });

  it("an org file with every library added keeps the organization's heading (not a local workspace's)", () => {
    expect(otherSections([], "Acme")).toEqual([{ title: "Acme", entries: [] }]);
  });
});
