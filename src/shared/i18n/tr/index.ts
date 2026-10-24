import type { Dictionary } from "../index";
import { shared } from "./shared";
import { ds } from "./ds";
import { app } from "./app";
import { files } from "./files";
import { settings } from "./settings";
import { admin } from "./admin";
import { panels } from "./panels";
import { editor } from "./editor";
import { tools } from "./tools";
import { collab } from "./collab";
import { share } from "./share";
import { store } from "./store";
import { access } from "./access";
import { convert } from "./convert";

/**
 * Turkish (src/shared/i18n): English → Turkish, one file per area of the app. Each key is the exact English text in
 * code (with its `{var}`s); the value keeps the same `{var}`s. Product terms stay as Turkish Figma users say them.
 */
export const TR: Dictionary = { ...access, ...shared, ...store, ...ds, ...app, ...files, ...settings, ...admin, ...panels, ...editor, ...tools, ...collab, ...share, ...convert };
