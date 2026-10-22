/**
 * `npm run ds:usages`: writes the usage index the Gallery's Developer page
 * reads (src/renderer/src/ds/gallery/usages.generated.json). Run it again after changing the app's UI.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scan } from "./scan";

const root = fileURLToPath(new URL("../..", import.meta.url));
const src = join(root, "src/renderer/src");
const index = scan({ root, src, ds: join(src, "ds"), exclude: ["engine/Playground.tsx", "admin/fake"] });
const out = join(src, "ds/gallery/usages.generated.json");
writeFileSync(out, JSON.stringify(index) + "\n");
const uses = index.ds.reduce((n, c) => n + c.count, 0);
const looks = index.ds.reduce((n, c) => n + c.looks.length, 0);
const custom = index.custom.reduce((n, c) => n + c.count, 0);
console.log(`ds:usages — ${index.files} files: ${index.ds.length} ds components (${uses} uses, ${looks} distinct looks), ${index.custom.length} hand-made controls (${custom} uses) → ${out}`);
