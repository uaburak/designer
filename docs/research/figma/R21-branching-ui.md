# R21 — Figma's branching UI (wording and layout), read 2026-10-11

For Phase 7 round 2b (`src/renderer/src/editor/branching/`, docs/editor.md "Branching"). Behaviour is in
`docs/data.md` §15.1; this file holds what the editor shows. Sources were read through help.figma.com on 2026-10-11.
Help pages render images and icons as blanks, so labels drawn only in screenshots are listed under "Unverified".

Sources:
- **[guide]** Guide to branching — https://help.figma.com/hc/en-us/articles/360063144053
- **[manage]** View and manage branches — https://help.figma.com/hc/en-us/articles/5668839659415
- **[update]** Get updates from main files — https://help.figma.com/hc/en-us/articles/5665728006423
- **[request]** Request a branch review — https://help.figma.com/hc/en-us/articles/5691414603543
- **[review]** Review branch changes — https://help.figma.com/hc/en-us/articles/5693123873687
- **[merge]** Merge branch into main file — https://help.figma.com/hc/en-us/articles/5691189138839
- **[logrocket]** a third-party walkthrough with screenshots (blog.logrocket.com "How to use Figma branching properly").
  It is secondary and is used only where help.figma.com is silent.

## Where the items live

- **The file name menu.** The chevron next to the file name in the left sidebar (the toolbar in UI2) opens it. It holds:
  - on main: **"Create branch..."** [guide] and **"See all branches"** [manage];
  - on a branch: **"Update from main..."** [update], **"Review and merge changes..."** [request: with the ellipsis in
    step 3, without it in "Resend"], **"See all branches"** [manage], **"Rename"** (branch only), **"Archive"** (branch
    only; the image's alt text says "Archive branch") and **"Duplicate as new file"** [manage].
- **The title.** After Create branch the sidebar shows **"File name / Branch name"** [guide], and a branch's file name
  menu sits "next to the file/branch name".
- **Status badges** next to the branch name (the toolbar): **"In review"** (grey) [request], **"Approved"** and
  **"Changes suggested"** [review]. [logrocket] also shows "Merged".

## Create branch [guide]

- "Create branch..." asks for a name, and the branch opens.
- It needs a Full seat on Organization or Enterprise. Viewers see it only when "Allow viewers to copy, share, or export
  from the file" is on (the guide's caution).
- **Unverified**: the dialog's own title and field. Ours: "Create branch", a "Branch name" field, Cancel and Create
  ([logrocket] shows "Create").

## Branches modal [manage]

- Title **"Branches"**; tabs **"Active"**, **"Archived"** and **"Yours"**. Archived holds merged and archived branches.
- Row actions:
  - **"Open"** shows on hover;
  - the row's menu has **"Copy link"**, **"Rename"** (edit in place: Enter or a click outside commits), **"Archive"**
    (the branch moves to Archived) and, in Archived, **"Restore"**. Merged branches can't be restored.
- **Unverified**: the row's other details. Ours: author and created time, plus a badge for the review or "Merged".

## Get updates from main [update]

- Figma "will notify any branches that updates are available". The notice's text isn't on the help page.
  [logrocket] shows an alert in the **bottom-right corner** with an **"Update"** button, which leads to "Apply changes".
- "Update from main..." opens the **"Update from main file"** modal. It lists the changed items and previews their
  latest versions ("not a before and after"). There is no picking: **"Apply changes"** applies them all.
- **Conflicts**:
  - **"Resolve conflicts"** opens a view with the conflicts listed in the **left sidebar**;
  - a selected conflict shows **main on the left, the branch on the right**;
  - you pick a side, and a **badge** says **main** or **branch**;
  - the **"Resolve all"** menu offers **"Pick main file"** and **"Pick branch"**;
  - **"Next"** is enabled once every conflict is picked, then **"Apply changes"**.
- **Unverified**:
  - the change tags; the help page blanks them ("items that have been , , or ."). [logrocket] lists **"Added"**,
    **"Edited"**, **"Updated"** and **"Removed"**;
  - the pick buttons' labels in the conflict view. [logrocket] says **"Keep main"** / **"Keep branch"** and
    "Confirm picks", but help names only the badge words and Resolve all's items;
  - the notice's words. Ours: "There are updates from the main file" with **Update**.

## Request a review [request]

- "Review and merge changes..." opens the **"Branch review"** modal.
- **Reviewers**:
  - suggested reviewers, each with **"Add"**;
  - an **"Other team members"** list;
  - a **"Search"** field.
- Then **"Request review"**, a description ("context input field" in the alt text) and **"Send to reviewers"** (the alt
  text also says "Send to 1 reviewer"). The branch shows the grey **"In review"** badge.
- **Again**: "Review and merge changes" › **"Request another review"** › **"Send to reviewer"** (singular).

## Review a branch [review]

- The reviewer opens the branch from the notification or email, then uses "Review and merge changes". The left sidebar
  has a **"Review request"** section, with the changes viewed **side by side** or **overlay** and zoom controls
  **"Zoom in"**, **"Zoom out"** and **"Fit"**.
- **"Add your review"** (bottom right) opens **"Finish your review"**:
  - **"Approve"**, with the instruction "Add any comments you want to make (optional).";
  - or **"Suggest changes"**, with "Add any general comments you want to make (optional).";
  - then **"Submit"**.

  The badge becomes **"Approved"** or **"Changes suggested"**.
- **Editing**: the edit icon beside your name in the sidebar edits your review; **"Review again"** sits at the
  bottom of the modal.
- The guide's own wording of a reviewer's choices: "Approve changes", "Approve and merge branch" and "Suggest further
  changes".

## Merge [merge]

- From "Review and merge changes" with every conflict resolved. Views are **"Side by side"** (the default) and
  **"Overlay"**, with Zoom out / Zoom in / FIT. A control at the top left goes back to the summary.
- **"Merge branch"**:
  - **"Edit merge description"** gives **"Name"** and **"Description"** with **"Save"**;
  - then **"Merge"**.
- A notice at the bottom confirms the merge (its text isn't quoted). A memory-limit banner disables "Review and merge
  changes".
- Version history labels [guide]: **"Branch created"**, **"Updated from main"** and **"Branch merged"**.

## Unverified, chosen for ours

| Where | Ours | Basis |
|---|---|---|
| main-changed notice | "There are updates from the main file" · Update · × | [logrocket] bottom-right alert with "Update" |
| merge toast | "Branch merged" | the version label [guide] |
| Branches modal row details | "‹author› · ‹time ago›" | — |
| conflict picks | "Keep main" / "Keep branch" buttons, badge "main" / "branch" | [logrocket], [update] |
| group of non-page changes | "Assets" | — (variables, styles, components on the internal page) |
| the branch's archived / merged state | the title's badge "Archived" / "Merged" | [logrocket] "Merged" |
