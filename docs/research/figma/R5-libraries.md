# R5 — Figma libraries, asset sharing, file browser

## Libraries (verified)
- Publishable: components, styles, variables (help.figma.com/hc/en-us/articles/360025508373).
- Paid plans only; Starter can make components/styles but not publish. Draft files cannot publish; move to a project first.
- Publish modal: summary of added/modified/removed assets, a description per publish (shown in version history and to subscribers' update review), per-asset deselect; "Hide when publishing" excludes assets permanently.
- Org/Enterprise: publish scope = team/org/workspace.
- Consuming: per-file Libraries modal (needs can-edit), affects all users of the file; Recommended tab = admin defaults (team/org) + approved libraries (Enterprise); browse Teams / Your organization / UI kits; preview, "Add to file" / "Open file". Removing a library leaves used assets on canvas (1500008731201).
- Assets tab (UI3 left panel, Option/Alt+2): local + library components, search, grid/list via "Libraries and settings", drag to canvas creates instance, hierarchical file > page > frame grouping; blue dot on Libraries icon for updates (360039831974).
- Updates: blue badge; Updates list (current page default, can show all); side-by-side or overlay compare; "Update selected instance" or "Update all" (360039234193).
- Deleted main component: instances not detached; show in "used in this file"; "Restore component"; swap prompt; Quick action "Repair component connections" (forum, lower confidence).
- Move published components: cut/paste between files, publish with "Move to this file" (keeps instance links) vs "Publish as a copy"; subscribers accept updates to relink; irreversible by undo/version history; paid, edit access to both (4404848314647).
- Branching: Organization/Enterprise; branch, review request, merge (5691414603543, figma.com/blog/how-and-why-we-built-branching).

## File browser (verified)
- Sidebar (Starter/Pro): Account, Search, Recents, Community, Notifications, Team, Drafts, Browse, Trash, Admin (Pro), Starred. Org/Ent: Organization, workspaces, custom sidebar sections (14381406380183).
- File types: Design (files, libraries, branches), FigJam, Slides, Buzz, Sites, Make, Prototypes.
- Drafts = personal space per team; move to project to collaborate. Starred is private to user.
- Trash: edit access to parent folder; kept until restored or permanently deleted (no auto expiry documented); permanent delete irreversible; if parent folder gone, duplicate to drafts (360047512294).

## Local single-user clone
Workspace folder -> projects -> files (+ Drafts); per-file local assets with stable keys; library publish = snapshot of published assets into workspace library index with version + description; subscriber files store enabled-library list and cached copies of imported assets keyed by (libraryFileId, assetKey, version); updates pulled explicitly via review modal; deleted/unpublished assets keep cached copy, flagged missing; move = re-keyed with "moved to" redirect record; trash with restore + permanent delete. Drop plan gating (or keep "drafts cannot publish" for fidelity).
