import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { isImageArg, MAX_IMAGE_BYTES, sniffImage, type ImageArg } from "../../shared/agents/images";

/**
 * Image paths in a tool call (place_image's `path`, `image.path` in create_nodes / update_nodes specs) read here in
 * main — the editor view can't read files — and handed on as base64. A path is resolved against `root` and must stay
 * inside it after symlinks: a chat's own working folder (where its CLI, e.g. Nano Banana, saves pictures) and its
 * agent's own picture folder for that chat (Antigravity's conversation folder), or the home folder for an outside MCP
 * client. Only real PNG / JPEG / WebP / GIF bytes pass, up to MAX_IMAGE_BYTES.
 */

export interface ImageFs {
  realpath(p: string): string;
  size(p: string): number;
  read(p: string): Uint8Array;
}

export const nodeFs: ImageFs = { realpath: (p) => realpathSync(p), size: (p) => statSync(p).size, read: (p) => readFileSync(p) };

export class ImagePathError extends Error {}

function readImage(arg: ImageArg, roots: string[], fs: ImageFs): ImageArg {
  if (typeof arg.path !== "string") return arg;
  const asked = arg.path.replace(/^file:\/\//, "");
  const bases = roots.flatMap((r) => {
    try {
      return [fs.realpath(r)];
    } catch {
      return [];
    }
  });
  let real: string;
  try {
    // A relative path is the working folder's (the first root).
    real = fs.realpath(isAbsolute(asked) ? asked : resolve(bases[0] ?? roots[0], asked));
  } catch {
    throw new ImagePathError(`image ${JSON.stringify(arg.path)}: no such file`);
  }
  const inside = (base: string) => {
    const rel = relative(base, real);
    return !rel.startsWith("..") && !isAbsolute(rel);
  };
  if (!bases.some(inside)) throw new ImagePathError(`image ${JSON.stringify(arg.path)}: only files in your working folder (${bases[0] ?? roots[0]}) can be placed`);
  if (fs.size(real) > MAX_IMAGE_BYTES) throw new ImagePathError(`image ${JSON.stringify(arg.path)}: larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
  const bytes = fs.read(real);
  if (!sniffImage(bytes)) throw new ImagePathError(`image ${JSON.stringify(arg.path)}: not a PNG, JPEG, WebP or GIF`);
  const { path: _p, ...rest } = arg;
  return { ...rest, name: arg.name ?? basename(real).replace(/\.[^.]+$/, ""), data: Buffer.from(bytes).toString("base64") };
}

/** The call's arguments with every image path read into base64 (unchanged when it has none). Throws ImagePathError. */
export function resolveImagePaths(tool: string, args: Record<string, unknown>, root: string | string[], fs: ImageFs = nodeFs): Record<string, unknown> {
  const roots = Array.isArray(root) ? root : [root];
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 24 || !v || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const o = v as Record<string, unknown>;
    let out: Record<string, unknown> | null = null;
    for (const [k, x] of Object.entries(o)) {
      const next = k === "image" && isImageArg(x) ? readImage(x, roots, fs) : walk(x, depth + 1);
      if (next !== x) (out ??= { ...o })[k] = next;
    }
    return out ?? o;
  };
  if (tool === "place_image" && isImageArg(args)) return readImage(args as ImageArg, roots, fs) as Record<string, unknown>;
  if (tool === "create_nodes" || tool === "update_nodes") return walk(args, 0) as Record<string, unknown>;
  return args;
}
