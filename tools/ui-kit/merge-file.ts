// Debug helper: a store file's snapshot + journal frames up to a seq, merged into one kiwi Message (what the editor
// loads) — read-only on the inputs. vite-node tools/ui-kit/merge-file.ts <fileDir> <out.kiwi> [upTo|list]
import { promises as fsp, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codec } from "../../src/shared/schema/document.generated";
import { NodeTable } from "../../src/shared/schema/patch";
import { nodeCodecs } from "../../src/store/kiwi/codecs";
import { scanSegment } from "../../src/store/local/journal";
import { currentMessage, readSnapshotFile } from "../../src/store/local/snapshot";

const [dir, out, arg] = process.argv.slice(2);
const store = JSON.parse(await fsp.readFile(join(dir, "store.json"), "utf8"));
const head = store.head;
const snap = await readSnapshotFile(join(dir, head.snapshot));
const table = NodeTable.fromMessage(currentMessage(snap));
let n = 0;
for (const seg of head.segments) {
  const scan = scanSegment(new Uint8Array(await fsp.readFile(join(dir, seg))), nodeCodecs.inflateRaw, head.snapshotSeq + 1);
  for (const f of scan.frames) {
    if (arg?.startsWith("dump:") && f.seq === Number(arg.slice(5))) {
      const msg = codec.decodeMessage(f.message);
      for (const c of msg.nodeChanges ?? []) console.log(JSON.stringify({ guid: c.guid, type: c.type, name: c.name, parent: c.parentIndex?.guid, isStateGroup: c.isStateGroup, symbol: c.symbolData?.symbolID, keys: Object.keys(c).filter((k) => (c as Record<string, unknown>)[k] != null).join(",") }).slice(0, 400));
      continue;
    }
    if (arg === "list") {
      console.log(f.seq, f.kind, f.label, f.message.length);
      continue;
    }
    if (arg && f.seq > Number(arg)) break;
    table.apply(codec.decodeMessage(f.message));
    n++;
  }
}
if (arg !== "list" && !arg?.startsWith("dump:")) {
  writeFileSync(out, codec.encodeMessage(table.toMessage({ keepDerived: true })));
  console.log(`merged ${n} frames, ${table.size} nodes → ${out}`);
}
