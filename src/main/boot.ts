import { app } from "electron";
import { applyIdentity } from "./identity";

// First of all (index.ts imports this before anything else): userData and the keychain's name (identity.ts).
applyIdentity(app);

// A dev run whose terminal went away (Ctrl-C on `npm run dev` with the window still open) closes stdout / stderr:
// the next console line would throw EPIPE as an uncaught exception and Electron's error dialog. Logs are dropped instead.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE") throw err;
  });
}
