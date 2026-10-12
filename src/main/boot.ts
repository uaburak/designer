import { app } from "electron";
import { applyIdentity } from "./identity";

// First of all (index.ts imports this before anything else): userData and the keychain's name (identity.ts).
applyIdentity(app);
