import type { DocumentSource } from "./documentSource";
import type { ImageStore } from "./images";

/**
 * A store's source with the store's blobs as its images (everything else is the source's own). The source itself, not
 * a Proxy of it: what the source hands on keyed by itself (library usage's recorders, `noteLibraryUsage(this, …)` in
 * store/documentSource.ts) must find what the editor registered under `ed.source` — a Proxy is another object, and no
 * insert or detach of an org library was ever counted (docs/data.md §17.3).
 */
export function withImages<T extends object>(source: T, images: () => ImageStore): DocumentSource {
  if ((source as unknown as DocumentSource).images) return source as unknown as DocumentSource;
  Object.defineProperty(source, "images", { value: images(), configurable: true });
  return source as unknown as DocumentSource;
}
