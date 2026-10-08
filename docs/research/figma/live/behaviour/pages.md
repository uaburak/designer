# Behaviour — Pages

Observed in Figma (web, Design mode) in the owner’s Drafts file "Untitled", page "Behaviour", on 2026-10-08, at a 1440×900 viewport (checked before each record).
State is recorded as `sel` (selected layer names), `panel` (first line of the Design panel), `focus` (the focused element; `(canvas-focus)` = Figma’s canvas keyboard input) and extra fields.
Keys marked "synthetic" were sent as JavaScript KeyboardEvents on the focused element. Clicks, drags and other keys were real input from the browser tool.

## Findings

- **"+" creates "Page N" already in inline rename** (name selected). Enter commits.
- **A page named exactly "---" is drawn as a divider** (a thin rule with no text). Names starting with "–" or "-" are ordinary pages.
- **Duplicate page naming was not observed.** The page context menu (Copy link to page, Rename page, Duplicate page, Move up, Move down, Move to top, Move to bottom, Delete page) opened once, but later right-clicks on rows did not open it.

## Log

### 1. Page names starting with dashes — observed
- **Action:** create pages named "---", "– Divider test" (en dash) and "- hyphen page" (via the plugin API) and look at the Pages list
- **Before:** —
- **After:** —
- **Notes:** Only a page named exactly "---" turns into a divider: a thin horizontal rule with no text and no row hover. "– Divider test" and "- hyphen page" show as ordinary pages. The Pages list has a fixed height with its own scroll, so "- hyphen page" was clipped. Image: behaviour/img/pages-divider-dashes.png

### 2. Duplicate page naming — could not reproduce
- **Action:** right-click a page row → Duplicate page
- **Before:** —
- **After:** —
- **Notes:** The page context menu (Copy link to page, Rename page, Duplicate page, Move up, Move down, Move to top, Move to bottom, Delete page) opened once on "Behaviour". Repeated right-clicks on "Page 3" only selected the row and opened no menu, so the duplicate name was not observed.

### 3. + opens rename — observed
- **Action:** click "Add new page" (+) in the Pages header
- **Before:** —
- **After:** focus=INPUT value="Page 3" (inline rename, text selected)
- **Notes:** Observed during the visual pass (left/pages-add-page-rename.txt): the new page is named "Page N" and its row opens straight into inline rename with the name selected. Enter commits.
