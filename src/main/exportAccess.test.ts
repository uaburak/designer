import { describe, expect, it } from "vitest";
import { mayExportFile } from "./exportAccess";

function store(role: "viewer" | "editor" | null, canExport: boolean | undefined) {
  const calls: string[] = [];
  return {
    calls,
    fileState: async (k: string) => (calls.push(`state:${k}`), { shared: role !== null, role }),
    fileInfo: async (k: string) => (calls.push(`info:${k}`), { access: canExport === undefined ? null : { canExport } }),
  };
}

describe("Save local copy's export access (governance §2.7)", () => {
  it("refuses only a restricted viewer, asking the server only for viewers", async () => {
    const local = store(null, false);
    expect(await mayExportFile(local, "f")).toBe(true);
    expect(local.calls).toEqual(["state:f"]);
    expect(await mayExportFile(store("editor", false), "f")).toBe(true);
    expect(await mayExportFile(store("viewer", false), "f")).toBe(false);
    expect(await mayExportFile(store("viewer", true), "f")).toBe(true);
    expect(await mayExportFile(store("viewer", undefined), "f")).toBe(true);
  });
});
