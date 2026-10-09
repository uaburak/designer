# Motion mode — behaviour (partial: viewer only)

Captured 2026-10-09 with the built-in browser at 1440x900 on the "Untitled" Drafts file, tab "seed". The session is **not signed in** (anonymous view-only viewer, banner "Sign up to comment, edit, inspect and more."), so Motion's editing UI is not reachable. No file was changed; Design mode was restored afterwards.

| Action | Result |
|---|---|
| Click "Motion" in the Toolbelt Mode switch (bottom toolbar, input id `motion_beta_special_tooltip`) | The mode switches without a prompt. The screenshot shows only the top-left file pill; the right pill, bottom toolbar and help button are no longer drawn. A "Motion  Beta" tag (90x24, `#1e1e1e`, r=5, text 11px/450) shows at 869,820 just above the switch. The canvas is unchanged. |
| Look for a timeline, keyframes, a Motion right panel or popovers | None appear in view-only mode (DOM dump: `viewer-motion-selected.txt`) |
| Click "Design" | Back to the normal viewer toolbar (`../draw/viewer-design-mode-toolbelt.txt`) |

Facts for the clone: the Motion radio carries a "Beta" tooltip; the mode switch is a 92x32 fieldset (`#444444`, r=5) whose three segments are 28x28 (r=3, selected `#383838`). Everything else (the timeline, keyframe UI, animation panels) needs a signed-in editor and is **not captured**.
