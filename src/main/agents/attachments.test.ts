// The composer's attachments on main's side (attachments.ts) on a temporary folder: checked by their bytes and size,
// copied into the chat's own attachments folder under a safe name; a turn's attachments kept only when they are files
// of that folder; Finder's clipboard read as paths.
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachmentProblem, attachmentsNote, MAX_ATTACHMENTS, safeFileName, sniffAttachment } from "../../shared/agents/attachments";
import { attachmentsDirOf, clipboardPaths, readFiles, saveAttachments, turnAttachments } from "./attachments";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const PDF = new TextEncoder().encode("%PDF-1.7\n%âãÏÓ\n");
const GIF = new TextEncoder().encode("GIF89a....");

let root: string;
let chat: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "designer-attach-"));
  chat = join(root, "work", "chat1");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("attachments", () => {
  it("knows PDF and the four image types by their bytes, and why another file can't go", () => {
    expect(sniffAttachment(PDF)).toBe("application/pdf");
    expect(sniffAttachment(PNG)).toBe("image/png");
    expect(sniffAttachment(GIF)).toBe("image/gif");
    expect(attachmentProblem("notes.txt", new TextEncoder().encode("hello"))).toBe("“notes.txt” isn’t a PDF, PNG, JPEG, WebP or GIF");
    expect(attachmentProblem("big.png", new Uint8Array(25 * 1024 * 1024 + 1))).toMatch(/larger than 25 MB/);
    expect(attachmentProblem("ok.png", PNG)).toBeNull();
  });

  it("names copies safely, with the extension their bytes say (no commas: Codex's --image list)", () => {
    expect(safeFileName("Screenshot 2026-10-09 at 23.11.04.png", "image/png")).toBe("Screenshot 2026-10-09 at 23.11.04.png");
    expect(safeFileName("../../etc/passwd", "application/pdf")).toBe("passwd.pdf");
    expect(safeFileName("a,b;c.jpeg", "image/png")).toBe("a_b_c.png");
    expect(safeFileName("", "image/gif")).toBe("image.gif");
  });

  it("copies files into the chat's attachments folder (0600), with a thumbnail; refuses others; at most a few", async () => {
    const r = await saveAttachments(chat, [
      { name: "shot.png", bytes: PNG },
      { name: "brief.pdf", bytes: PDF },
      { name: "notes.txt", bytes: new TextEncoder().encode("hi") },
    ], { thumb: async (_p, mime) => (mime === "image/png" ? "data:image/png;base64,AA==" : undefined), id: (() => { let n = 0; return () => `id${++n}`; })() });
    expect(r.errors).toEqual(["“notes.txt” isn’t a PDF, PNG, JPEG, WebP or GIF"]);
    expect(r.attachments.map((a) => [a.name, a.mime, a.size, a.path, a.thumb])).toEqual([
      ["shot.png", "image/png", PNG.length, join(chat, "attachments", "id1-shot.png"), "data:image/png;base64,AA=="],
      ["brief.pdf", "application/pdf", PDF.length, join(chat, "attachments", "id2-brief.pdf"), undefined],
    ]);
    expect(readFileSync(r.attachments[0].path)).toEqual(Buffer.from(PNG));
    expect(statSync(r.attachments[0].path).mode & 0o777).toBe(0o600);
    const many = await saveAttachments(chat, Array.from({ length: MAX_ATTACHMENTS + 2 }, (_, i) => ({ name: `${i}.png`, bytes: PNG })));
    expect(many.attachments).toHaveLength(MAX_ATTACHMENTS);
    expect(many.errors).toEqual([`Up to ${MAX_ATTACHMENTS} files a message`]);
  });

  it("a turn's attachments: only files of the chat's own attachments folder, typed by their bytes", async () => {
    const [a] = (await saveAttachments(chat, [{ name: "shot.png", bytes: PNG }])).attachments;
    const other = join(root, "work", "chat2");
    const [b] = (await saveAttachments(other, [{ name: "x.png", bytes: PNG }])).attachments;
    const outside = join(root, "secret.png");
    writeFileSync(outside, PNG);
    const link = join(attachmentsDirOf(chat), "link.png");
    symlinkSync(outside, link);
    const kept = turnAttachments(chat, [{ path: a.path, name: "shot.png", mime: "application/pdf" }, { path: b.path, name: "x.png" }, { path: outside }, { path: link }, { path: "attachments/rel.png" }, { path: join(attachmentsDirOf(chat), "..", "mcp.json") }]);
    // The claimed type is the bytes' (PNG), the other chat's file, the file outside, the symlink out and a relative path are dropped.
    expect(kept).toEqual([{ path: realpathSync(a.path), name: "shot.png", mime: "image/png" }]);
    expect(turnAttachments(join(root, "work", "none"), [{ path: a.path }])).toEqual([]);
    expect(turnAttachments(chat, "nope")).toEqual([]);
  });

  it("reads picked or copied files, the too large ones unread", () => {
    mkdirSync(join(root, "in"));
    writeFileSync(join(root, "in", "a.png"), PNG);
    const r = readFiles([join(root, "in", "a.png"), join(root, "in", "gone.png")]);
    expect(r.files.map((f) => f.name)).toEqual(["a.png"]);
    expect(r.errors).toEqual(["“gone.png” couldn’t be read"]);
  });

  it("reads Finder's clipboard: its list of paths, else one file URL", () => {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<array>\n\t<string>/Users/me/Desktop/a &amp; b.png</string>\n\t<string>/Users/me/brief.pdf</string>\n</array>\n</plist>`;
    expect(clipboardPaths({ filenames: plist })).toEqual(["/Users/me/Desktop/a & b.png", "/Users/me/brief.pdf"]);
    expect(clipboardPaths({ fileUrl: "file:///Users/me/My%20Shot.png" })).toEqual(["/Users/me/My Shot.png"]);
    expect(clipboardPaths({ fileUrl: "https://example.com/a.png" })).toEqual([]);
    expect(clipboardPaths({})).toEqual([]);
  });

  it("tells the agent the paths, what they are and how to look", () => {
    expect(attachmentsNote([], "Open them.")).toBe("");
    const note = attachmentsNote([{ path: "/w/attachments/a-shot.png", name: "shot.png", mime: "image/png" }], "Look at each with view_file.");
    expect(note).toContain("attached a file");
    expect(note).toContain("- /w/attachments/a-shot.png (PNG image, “shot.png”)");
    expect(note).toContain("view_file");
    expect(note).toContain("place_image {path}");
  });
});
