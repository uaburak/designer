// Image paths in tool calls, read by main: inside the caller's folder only, real image bytes only, as base64.
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { base64Bytes, sniffAudio, sniffImage } from "../../shared/agents/images";
import { ImagePathError, resolveImagePaths } from "./imageArgs";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
let dirs: string[] = [];
afterEach(() => {
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  dirs = [];
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "img-args-"));
  dirs.push(d);
  return d;
};

describe("image paths", () => {
  it("place_image's path, relative to the chat folder, becomes base64 with the file's name", () => {
    const root = tmp();
    mkdirSync(join(root, "images-out"));
    writeFileSync(join(root, "images-out", "hero_photo.png"), PNG);
    const out = resolveImagePaths("place_image", { path: "images-out/hero_photo.png", x: 10 }, root);
    expect(out).toEqual({ x: 10, name: "hero_photo", data: Buffer.from(PNG).toString("base64") });
    expect(sniffImage(base64Bytes(out.data as string)!)).toBe("image/png");
  });

  it("fill_slots' picture path (docs/social.md §7.2)", () => {
    const root = tmp();
    writeFileSync(join(root, "pack.png"), PNG);
    const out = resolveImagePaths("fill_slots", { nodeId: "1:2", values: { headline: "Hi" }, picture: { path: "pack.png", scaleMode: "FILL" } }, root);
    expect(out).toEqual({ nodeId: "1:2", values: { headline: "Hi" }, picture: { name: "pack", scaleMode: "FILL", data: Buffer.from(PNG).toString("base64") } });
  });

  it("`image.path` in create_nodes' nested specs and update_nodes' updates", () => {
    const root = tmp();
    writeFileSync(join(root, "a.png"), PNG);
    const c = resolveImagePaths("create_nodes", { nodes: [{ type: "FRAME", children: [{ type: "RECTANGLE", image: { path: join(root, "a.png"), scaleMode: "FIT" } }] }] }, root) as { nodes: { children: { image: Record<string, unknown> }[] }[] };
    expect(c.nodes[0].children[0].image).toMatchObject({ name: "a", scaleMode: "FIT", data: expect.any(String) });
    expect(c.nodes[0].children[0].image.path).toBeUndefined();
    const u = resolveImagePaths("update_nodes", { updates: [{ nodeId: "1:2", image: { path: "a.png" } }] }, root) as { updates: { image: Record<string, unknown> }[] };
    expect(u.updates[0].image.data).toBeTruthy();
    // Other tools' arguments are left alone.
    expect(resolveImagePaths("get_metadata", { path: "/etc/passwd" }, root)).toEqual({ path: "/etc/passwd" });
  });

  it("refuses files outside the folder (also through a symlink), missing files and non-images", () => {
    const root = tmp();
    const other = tmp();
    writeFileSync(join(other, "secret.png"), PNG);
    writeFileSync(join(root, "notes.png"), "not an image");
    symlinkSync(join(other, "secret.png"), join(root, "link.png"));
    expect(() => resolveImagePaths("place_image", { path: join(other, "secret.png") }, root)).toThrow(ImagePathError);
    expect(() => resolveImagePaths("place_image", { path: "../" + other.split("/").pop() + "/secret.png" }, root)).toThrow(/working folder/);
    expect(() => resolveImagePaths("place_image", { path: "link.png" }, root)).toThrow(/working folder/);
    expect(() => resolveImagePaths("place_image", { path: "missing.png" }, root)).toThrow(/no such file/);
    expect(() => resolveImagePaths("place_image", { path: "notes.png" }, root)).toThrow(/not a PNG/);
  });

  it("an agent's own picture folder for the chat is a second root; relative paths stay the chat folder's", () => {
    const root = tmp();
    const brain = tmp();
    const other = tmp();
    writeFileSync(join(brain, "red_circle.png"), PNG);
    writeFileSync(join(other, "x.png"), PNG);
    expect(resolveImagePaths("place_image", { path: join(brain, "red_circle.png") }, [root, brain])).toMatchObject({ name: "red_circle", data: expect.any(String) });
    expect(() => resolveImagePaths("place_image", { path: "red_circle.png" }, [root, brain])).toThrow(/no such file/);
    expect(() => resolveImagePaths("place_image", { path: join(other, "x.png") }, [root, brain])).toThrow(/working folder/);
  });

  it("knows images by their bytes", () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffImage(new TextEncoder().encode("GIF89a"))).toBe("image/gif");
    expect(sniffImage(new TextEncoder().encode("<svg"))).toBeNull();
    expect(base64Bytes("data:image/png;base64,iVBORw0KGgo=")?.[1]).toBe(0x50);
    expect(base64Bytes("not base64!")).toBeNull();
  });

  it("add_audio's path: a sound in the folder, known by its bytes, becomes base64 with its type and name", () => {
    const root = tmp();
    const wav = new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt ");
    writeFileSync(join(root, "beat.wav"), wav);
    writeFileSync(join(root, "fake.mp3"), "not a sound");
    expect(resolveImagePaths("add_audio", { nodeId: "1:1", path: "beat.wav", offset: 1 }, root)).toEqual({ nodeId: "1:1", offset: 1, name: "beat", mime: "audio/wav", data: Buffer.from(wav).toString("base64") });
    expect(() => resolveImagePaths("add_audio", { path: "fake.mp3" }, root)).toThrow(/not an AAC, MP3, WAV or M4A/);
    expect(() => resolveImagePaths("add_audio", { path: "/etc/hosts" }, root)).toThrow(/working folder/);
    expect(sniffAudio(new TextEncoder().encode("ID3\u0004"))).toBe("audio/mpeg");
    expect(sniffAudio(new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]))).toBe("audio/mp4");
    expect(sniffAudio(new Uint8Array([0xff, 0xf1]))).toBe("audio/aac");
    expect(sniffAudio(new Uint8Array([0xff, 0xfb]))).toBe("audio/mpeg");
  });
});
