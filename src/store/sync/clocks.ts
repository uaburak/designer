/**
 * The local per-field clocks of a synced file (docs/data.md §12.5, "clocks.bin"): per (guid, field) the HLC of the
 * latest write this device knows about — its own pushed writes and the remote ones it pulled — plus each node's
 * tombstone. Pull keeps only remote fields newer than these. Stored as `files/<key>/clocks.json` (JSON rather than the
 * contract's binary: a few hundred bytes per node, written once per sync pass, never on the append path).
 */
import { join } from "node:path";
import type { Hlc } from "../../shared/store/types";
import { readJsonOrNull, writeJsonAtomic } from "../local/fsutil";

export interface NodeClock {
  clk: Record<string, Hlc>;
  del: Hlc | null;
}

interface ClocksFile {
  formatVersion: 1;
  nodes: Record<string, NodeClock>;
}

export class FileClocks {
  private dirty = false;

  private constructor(
    private readonly path: string | null,
    private readonly tmpDir: string | null,
    readonly nodes: Map<string, NodeClock>,
  ) {}

  /** In memory only (tests). */
  static memory(): FileClocks {
    return new FileClocks(null, null, new Map());
  }

  static async load(fileDir: string, tmpDir: string): Promise<FileClocks> {
    const path = join(fileDir, "clocks.json");
    const raw = await readJsonOrNull<ClocksFile>(path);
    return new FileClocks(path, tmpDir, new Map(Object.entries(raw?.nodes ?? {})));
  }

  get(guid: string): NodeClock {
    return this.nodes.get(guid) ?? { clk: {}, del: null };
  }

  has(guid: string): boolean {
    return this.nodes.has(guid);
  }

  private node(guid: string): NodeClock {
    let n = this.nodes.get(guid);
    if (!n) this.nodes.set(guid, (n = { clk: {}, del: null }));
    return n;
  }

  /** A write of `field` at `hlc` (kept only if newer than what is known). */
  write(guid: string, field: string, hlc: Hlc): void {
    const n = this.node(guid);
    if ((n.clk[field] ?? "") < hlc) {
      n.clk[field] = hlc;
      this.dirty = true;
    }
  }

  /** A CREATED at `hlc` replaced the node: every older field write is superseded. */
  replace(guid: string, hlc: Hlc): void {
    const n = this.node(guid);
    for (const f of Object.keys(n.clk)) if (n.clk[f] < hlc) n.clk[f] = hlc;
    this.dirty = true;
  }

  tombstone(guid: string, hlc: Hlc): void {
    const n = this.node(guid);
    if ((n.del ?? "") < hlc) {
      n.del = hlc;
      this.dirty = true;
    }
  }

  async save(): Promise<void> {
    if (!this.dirty || !this.path || !this.tmpDir) return;
    await writeJsonAtomic(this.tmpDir, this.path, { formatVersion: 1, nodes: Object.fromEntries(this.nodes) } satisfies ClocksFile);
    this.dirty = false;
  }
}
