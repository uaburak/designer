import { watch as fsWatch, type FSWatcher } from "node:fs";
import { dirname, normalize } from "node:path";

/**
 * Hot reload plugin (docs/plugins.md §3.3): each development plugin's folder is watched; a change to its manifest,
 * `main` or `ui` files is told once per 300 ms of quiet (`plugins:changed {id}`), and the editor's host restarts a
 * running development plugin with the new code. Whether the item is on is the editor's (it ignores the event when off).
 */

export const RELOAD_DEBOUNCE_MS = 300;

type WatchFn = (dir: string, onChange: (file: string | null) => void) => { close(): void };

/** fs.watch on the folder and below (macOS and Windows watch recursively). */
const nodeWatch: WatchFn = (dir, onChange) => {
  let w: FSWatcher;
  try {
    w = fsWatch(dir, { recursive: true, persistent: false }, (_event, file) => onChange(file === null ? null : String(file)));
  } catch {
    return { close() {} };
  }
  w.on("error", () => w.close());
  return w;
};

interface Watched {
  dir: string;
  files: Set<string>;
  handle: { close(): void };
  timer: ReturnType<typeof setTimeout> | null;
}

export class PluginWatcher {
  private readonly watched = new Map<string, Watched>();

  constructor(
    private readonly onChanged: (id: string) => void,
    private readonly watchFn: WatchFn = nodeWatch,
    private readonly delay = RELOAD_DEBOUNCE_MS,
  ) {}

  /** Watch (or re-watch) a plugin: `files` relative to the manifest's folder. */
  watch(id: string, manifestPath: string, files: string[]) {
    const dir = dirname(manifestPath);
    const set = new Set(files.map((f) => normalize(f)));
    const old = this.watched.get(id);
    if (old && old.dir === dir) {
      old.files = set;
      return;
    }
    this.unwatch(id);
    const entry: Watched = { dir, files: set, handle: { close() {} }, timer: null };
    entry.handle = this.watchFn(dir, (file) => {
      // A rename the system can't name: assume it's ours.
      if (file !== null && !entry.files.has(normalize(file))) return;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        this.onChanged(id);
      }, this.delay);
    });
    this.watched.set(id, entry);
  }

  unwatch(id: string) {
    const w = this.watched.get(id);
    if (!w) return;
    if (w.timer) clearTimeout(w.timer);
    w.handle.close();
    this.watched.delete(id);
  }

  /** Keeps exactly these plugins watched. */
  sync(plugins: { id: string; path: string; files: string[] }[]) {
    const keep = new Set(plugins.map((p) => p.id));
    for (const id of [...this.watched.keys()]) if (!keep.has(id)) this.unwatch(id);
    for (const p of plugins) this.watch(p.id, p.path, p.files);
  }

  close() {
    for (const id of [...this.watched.keys()]) this.unwatch(id);
  }

  get ids() {
    return [...this.watched.keys()];
  }
}
