#!/usr/bin/env node
// designer-connect — Code Connect's CLI (docs/editor.md D-1); the work is in connect.mjs.
import { run } from "./connect.mjs";

process.exitCode = await run(process.argv.slice(2), { fetch: globalThis.fetch, env: process.env, cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr });
