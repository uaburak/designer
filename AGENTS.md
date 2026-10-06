# DesignerV2

burakkoc.net's admin as an Electron app: the site's own Firebase data, Figma's desktop look (a tab bar, Home as the file browser, each file's editor in a tab). How it fits together — the window, the tabs, the sign-in, the data — is in `docs/architecture.md`. Rules that hold everywhere:

- Firestore is written only by Save (and Home's actions), in one transaction per save; uploads are the one immediate write.
- Variables, text styles and components are the site's, shared by every project (`design/*`), not a project's own.
- Each open file is a document of its own (an iframe of the shell): the shell and a tab talk through `src/renderer/src/app/bridge.ts` only.
- The UI is English, in Figma's wording; the site's content (text style and variable names, the CV) stays as written.
- The editor (`src/renderer/src/figma`) is the web admin's: a change to the model or to how a node draws must also be made in the site's copy (`burakkoc.net/Web/portfolio/src/figma`), which draws published pages.

Before committing: `npm run check` (types, lint, tests). To see a change: `npm run dev:demo` (demo data, no Firebase), or drive the built app with `scripts/drive.mjs`.
