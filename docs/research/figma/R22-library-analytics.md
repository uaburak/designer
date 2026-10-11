# R22 — Library analytics and org libraries in the editor

Read 2026-10-11 for Phase 7 round 3c (`src/renderer/src/editor/analytics/`, `editor/libraryUsage.ts`, the Libraries and Publish dialogs; contracts docs/data.md §16–§17). Verified facts carry their source; **(ours)** marks a choice where Figma's page says nothing; **(unverified)** a guess.

## Sources
- **[A-help]** View and explore library analytics — https://help.figma.com/hc/en-us/articles/360039238353 (headings, wording, image descriptions read 2026-10-11)
- **[L-org]** Share libraries in an organization — https://help.figma.com/hc/en-us/articles/360040529593
- **[L-find]** Help people find and use libraries — https://help.figma.com/hc/en-us/articles/21310245473815
- **[A-api]** Library Analytics REST endpoints — https://developers.figma.com/docs/rest-api/library-analytics-endpoints/ (as cited in docs/data.md §17)

## Who and where [A-help]
- Organization and Enterprise; members with "can view" or "can edit" on the library file; guests can't.
- One library: open the library file, click the canvas so nothing is selected, the ⌄ next to the file name › **Library analytics**; or right-click the library in the file browser › **Library analytics**.
- All libraries: file browser › **All teams** (Enterprise with workspaces: **All workspaces**) › **Libraries** (round 3f).

## The article's structure (headings, in order)
"View and explore library analytics" › "View library analytics" › "For all libraries within the organization" / "For a specific library" › "View statistics and usage for a specific asset" › "Components and component sets" (with "Usage view for a component", "Usage view for a component set and its variants") › "Styles" ("Usage view for a style") › "Variables and modes" ("Usage view for a variable") › "Library Analytics API".

## One library's modal
- Two tabs: **Overview** and **Analytics** [A-help].
- **Overview**: "Teams using the library", "Total components", "Total styles", "Total variables", "Activity this week" (the last seven days); every style, every variable collection and every component listed. Image description: "Library overview showing team component, style, and variable usage."
- **Analytics**: a **Type** filter (Components / Styles / Variables) and a **Duration** filter (30, 60 or 90 days, or "last year" — a rolling 12 months).
  - The **insertions graph**: "Current data is blue", "Unavailable data is grey", "Comparison data is black", "A dashed line indicates an incomplete week"; it runs to the end of the current week.
  - **Compare with** another library's insertions.
  - **Top teams**: teams with insertion totals and their share of all insertions.
  - **Download CSV** only when more than five teams use the library; with five or fewer the data can be copied from the modal.
  - The statistics table: "Statistics for each asset in the library for the selected time period"; "Click the name of each column to sort the data by ascending or descending values". Image description: "Component statistics table showing names, variants, total instances, inserts, and detaches for the last 30 days." Styles: total instances, inserts, detaches. Variables: "name, collection, total instances, inserts, and detaches over 30 days".
- **Variables and modes**: "Filter variables by Collection"; "The Modes list includes the mode's name, the collection to which it belongs, and the number of instances"; modes have no usage drill-down.
- **Usage views**: a component's **Description**, **Total**, **Used by** ("Total number of teams that use this component"), **Used in**, and a file table ("The files where the component or variant is used": file, team, instances, last modified). A component set adds a variant table (Instances, Inserts — "The number of times the variant has been inserted into any file in the last 30 days" —, Detaches); a variant opens its own component view. Styles and variables: the same fields and file table.
- File usage shows only for teams open to the organization or "Only those invited" teams the viewer is in [A-help]; the API calls the rest "File not visible" [A-api].
- Analytics update daily, keep up to one year; styles and variables tracked since 2024-10-10 [A-help].

## Org libraries in the editor
- Publish dialog: "Allow any member of ‹organization name› to access the file" — unchecked shares within the team, checked with the organization [L-org].
- Libraries button tooltips: "Review library updates" (libraries used in the file have updates), "Review unpublished changes" (the file has unpublished changes) [L-org].
- Approved libraries: "everyone sees a check mark next to the library name wherever it appears in design files"; "Approved libraries are also pinned to the top of the list of available libraries in files"; the screenshot's tooltip reads "Approved by Twigma admin" (the org's name) [L-find].
- Default variable modes: "When someone creates a new file in the workspace, the page-level default mode is set to …"; "People can always switch to another mode if they need to" [L-find].

## As built (round 3c) and what is ours
- The modal's title is "Library analytics" with the library's name under it **(ours: the header layout wasn't captured)**; the Duration labels read "Last 30 days", "Last 60 days", "Last 90 days", "Last year" **(the help says "30, 60, or 90 days, or last year")**; "No comparison" as Compare with's first choice **(ours)**; Top teams lists five **(unverified)**; the default sort is Inserts, descending **(ours)**.
- A component set's variant table comes from the CSV of the Components type (the server's views list sets and components outside sets; the CSV lists each variant with its set).
- Libraries modal of an org file: the person's teams by name, then the organization's libraries under its name; approved first in each list **(the section headings are ours: Figma's UI3 modal for orgs wasn't captured)**; a workspace approval's tooltip "Approved by workspace admin" **(unverified)**.
- Graph: Sunday weeks (Figma's API), hover shows "Week of ‹date›" with its insertions **(ours)**.
