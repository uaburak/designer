// export_animation's files saved by main (docs/motion.md §9): in the given folder, never outside it, unique names.
import { describe, expect, it } from "vitest";
import { safeFileName, saveToolFiles, type ToolFilesFs } from "./toolFiles";

function memoryFs(): ToolFilesFs & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return { files, exists: (p) => files.has(p), mkdir: () => {}, write: (p, b) => void files.set(p, b) };
}

describe("tool files", () => {
  it("saves into the folder under the file's own name, numbering a name already there", () => {
    const fs = memoryFs();
    const data = Buffer.from("GIF89a").toString("base64");
    expect(saveToolFiles("/work/chat", [{ name: "Logo.gif", data, mimeType: "image/gif" }], fs)).toEqual(["/work/chat/Logo.gif"]);
    expect(saveToolFiles("/work/chat", [{ name: "Logo.gif", data, mimeType: "image/gif" }], fs)).toEqual(["/work/chat/Logo (2).gif"]);
    expect(new TextDecoder().decode(fs.files.get("/work/chat/Logo.gif"))).toBe("GIF89a");
  });

  it("never leaves the folder, and skips empty files", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("..")).toBe("Export");
    expect(safeFileName('a:b*c?.mp4')).toBe("a_b_c_.mp4");
    const fs = memoryFs();
    expect(saveToolFiles("/w", [{ name: "../x.gif", data: Buffer.from("x").toString("base64"), mimeType: "image/gif" }, { name: "empty.gif", data: "", mimeType: "image/gif" }], fs)).toEqual(["/w/x.gif"]);
  });
});
