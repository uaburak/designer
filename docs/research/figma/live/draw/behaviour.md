# Draw mode — behaviour (NOT captured: feature unavailable in this session)

Captured 2026-10-09 with the built-in browser at 1440x900 on https://www.figma.com/design/E7mHFH4VPiZ1zdhYlNoqJn/Untitled (tab "seed").

**Result: Draw mode could not be reached.** The browser session is not signed in to Figma. The file loads as an anonymous **view-only** viewer: the banner "Sign up to comment, edit, inspect and more." (Sign up / Continue with Google) sits above the bottom toolbar, and the toolbar's mode switch ("Toolbelt Mode", a fieldset of radios) offers only **Design / Motion (Beta) / Dev Mode**. There is no **Draw** radio, so no Draw toolbar, tool dropdowns, brush list/settings or right panel exist to capture. (In a signed-in editor the switch reads Draw / Design / Motion (Beta) / Dev Mode — see `../README.md`.)

Signing in (Google, password) is outside what an agent may do, so nothing further was attempted. No file was changed.

| Action | Result |
|---|---|
| Load the file | Anonymous viewer; `window.figma` undefined; mode switch has 3 radios: Design, Motion (tooltip id `motion_beta_special_tooltip`), Dev Mode (see `viewer-design-mode-toolbelt.txt`) |
| Look for Draw radio | Absent |

To finish this capture: sign in to figma.com in the built-in browser (owner), then re-run the task.
