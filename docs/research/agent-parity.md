# Agent parity — what a person can do in Wecra, and how an agent does it (2026-10-21, [ours])

The owner (translated): "Does our agent have access to the latest things we built — prototypes, components …? Whatever I as a real human can access, it must access — except the Operator features. E.g. when I say 'go find yourself a UX skill and add it', it should add a skill to itself in the app's Agents › Skills."

This page audits every capability of a signed-in, non-operator person and maps it to an agent tool (`src/shared/agents/tools.ts`, `appTools.ts`, `reach.ts`; `run_command` ids from `src/renderer/src/editor/commands.ts` and the engine's `CommandId`). As built: `docs/ai.md` §8.5.

Legend: **covered** = a tool existed before this round; **added** = this round; **gap** = still missing, with the reason.

## 1. Rules

- **Same code as the UI.** Every new tool calls what the menu, panel or dialog calls: the store's repositories through `getStoreClient()`, the document source, `libraries.ts`, `devStatus.ts`, `preferences.ts`, the plugins' service. So what an agent does shows in the UI as if the person clicked it.
- **Excluded on purpose (never agent-reachable):**
  - Operator: `settings/OperatorTab.tsx`, `useIsOperator`, `OPERATOR_EMAILS`.
  - Org admin (`src/renderer/src/admin`, `AdminRepository`) and plugin approvals.
  - Account security: sessions, access tokens, password, delete account.
  - AI / agent provider keys and sign-in, connectors and their policies.
  - **Agents' Access (reach) policies**, allowed hosts, repositories, folders, the GitHub token.
  - Deleting files forever and emptying the trash.
  - `set_app_setting` refuses these keys by name, and has no route to them.
- **Confirmation.** Destructive or outward actions wait for the person's click on a card in the chat ("Agent wants to …", the target, a preview, Allow / Deny — never remembered), as reach's "Ask each time". The check is in main (`confirmationFor` in `appTools.ts`, `host.ts` `runAnyTool`) before the call reaches the view. An outside MCP client has no chat and is refused.
  - Confirmed: trash, restore a version, publish a library, share / invite / link access, delete a comment, a comment or reply that @mentions people, run a plugin, every Skills change (create, update, remove, install).
- **Undo.** Document writes are one undo step each (`env.write`, or the UI code's own `ed.batch` step — restore version, accept updates, insert a library component, dev status).

## 2. The map

### Editor: canvas, layers, pages, menus

| Capability | Agent route | State |
|---|---|---|
| Create / edit / delete / duplicate / reparent layers, auto layout, constraints, fills, strokes, effects, text | `create_nodes`, `update_nodes`, `delete_nodes`, `duplicate_nodes`, `reparent_nodes`, `set_auto_layout`, `set_properties` | covered |
| Read: outline, details, screenshot, selection, CSS / code | `get_metadata`, `get_design_context`, `get_screenshot`, `get_selection` | covered |
| Pictures, SVG | `place_image`, `create_nodes {svg}` | covered |
| Edit / Object / Arrange / Vector / Text menus; boolean, flatten, mask, align, group | `run_command` (editor ids + engine commands), `pathfinder` | covered |
| Components: create, variants, properties, instances, swap, reset, detach | `run_command` engine commands (`CREATE_COMPONENT`, `COMBINE_AS_VARIANTS`, `ADD_COMPONENT_PROPERTY`, `BIND_COMPONENT_PROPERTY`, `INSERT_INSTANCE`, `SWAP_INSTANCE` …), `update_nodes {componentProperties}` | covered |
| Pages: create, rename, duplicate, delete, reorder, go to | `run_command` page commands, `reparent_nodes`, `set_current_page` | covered |
| Variables, modes, collections; styles | `create_variable*`, `edit_variable*`, `set_variable_*`, `bind_variable`, `create_*_style`, `apply_style`, `get_variable_defs` | covered |
| Selection the person sees | `set_selection` (at the end of the turn) | covered |
| Every menu / shortcut command with its enabled state | `list_commands` / `run_command` | covered |
| Menu commands that only open a dialog (Export…, Version history, Libraries…, Publish…, Rename / Move file, Nudge…, Branching) | the app tools below | **added** (dialog-free routes) |
| Copy as PNG / SVG / CSS (clipboard) | `run_command edit.copy-as-*` (nothing returns to the agent; `get_design_context` / `export_nodes` give the content) | covered |
| Canvas context menu: reset one instance property | `object.reset-all-changes` only | gap (low value; `update_nodes` sets the value back) |
| Desktop shell: windows, tabs, interface scale, devtools | — | out of scope (the shell, not the file) |

### Prototype

| Capability | Agent route | State |
|---|---|---|
| Interactions, triggers, actions, transitions, variables / modes, conditionals | `get_prototype`, `add_interaction`, `update_interaction`, `remove_interaction` | covered |
| Flows, device, background, scrolling, overlay position / background | `set_flow_starting_point`, `remove_flow_starting_point`, `set_prototype_settings` | covered |
| Website behaviours: `prototypeTextInput`, `prototypeCursor`, `overlayEdgeBehavior` (Keep in window), `overlayStack`, `overlayFitWindow` | `set_prototype_settings.nodes[]` (validated, `null` clears); `get_prototype` reads all five | **added** (was only raw `set_properties`) |
| Presentation options: Website behaviours, Keep state on reload | `set_app_setting present.websiteBehaviours / present.keepState` | **added** |
| Present / Preview | `run_command view.present` / `view.preview` (opens it; nothing returns) | covered |

### Motion, draw, Dev Mode, export

| Capability | Agent route | State |
|---|---|---|
| Timeline, keyframes, presets, styles, audio, generated sound, exports | `animate`, `set_keyframes` …, `generate_sound`, `export_animation` | covered |
| Draw: brushes, vector strokes | `run_command object.create-brush.*`, `create_nodes` vectors | covered (brush settings: gap, low value) |
| Dev status: ready for dev / completed / remove, with a description | `set_dev_status` (top-level frames and sections; one step; reported to the server like the menu) | **added** |
| Annotations, measurements | `set_properties {annotations, measurements}` (`describe_schema Annotation`) | covered (raw shape) |
| Code Connect read | `get_code_connect_map` | covered |
| Code Connect write, dev resources (links) | — | gap: store-side mapping writes (`DevModeRepository.setCodeConnect`, `addDevResource`) — next round |
| Export settings on a layer | `set_properties {exportSettings}` | covered |
| Export to files (PNG / JPG / SVG / PDF, scale, suffix, or the layer's own settings) | `export_nodes` → files in the agent's working folder (main saves `ToolResult.files`) | **added** |

### Libraries, assets

| Capability | Agent route | State |
|---|---|---|
| See this file's library, the workspace's libraries, waiting updates, a library's assets | `get_libraries` | **added** |
| Enable / disable a library in this file | `set_library_enabled` | **added** |
| Accept updates (all or some) | `accept_library_updates` | **added** |
| Insert a library component | `insert_library_component` | **added** |
| Publish with a description | `publish_library` (confirmed) | **added** |
| Swap library | — | gap (a review dialog of matches; rare) |

### Comments, versions, branching, sharing

| Capability | Agent route | State |
|---|---|---|
| Read threads, who can be @mentioned | `get_comments` | **added** |
| Post a thread pinned on a layer or a page point, reply, edit, resolve / re-open, react | `add_comment`, `reply_comment`, `edit_comment`, `resolve_comment` | **added** (mentions confirmed) |
| Delete a comment | `delete_comment` (confirmed) | **added** |
| Version history: list, save named, rename / describe | `list_versions`, `save_version` | **added** |
| Restore (one undoable step), duplicate a version to Drafts | `restore_version` (restore confirmed) | **added** |
| Create a branch | `file_action branch` | **added** |
| Review and merge a branch | — | gap: a conflict review the person should do in the app |
| Share: invite, link access, read people | `share_file` (changes confirmed) | **added** |
| Link password / expiry, remove people, access requests, publish a developer preview | — | gap: security-sensitive settings left to the Share dialog |

### Home

| Capability | Agent route | State |
|---|---|---|
| Recents, Drafts, Starred, Trash, folders, search | `list_files` | **added** |
| New file (and open it) | `create_file` | **added** |
| Rename, duplicate, move, star / unstar, new folder, rename folder, open | `file_action` | **added** |
| Move to trash / restore | `file_action trash` (confirmed) / `restore` | **added** |
| Delete forever, empty trash | refused | excluded |
| Import a .fig, save a local copy | — | gap: they go through the OS file dialogs |
| Teams, projects, invites to teams | — | gap: org / team administration, next round with roles |

### Settings, plugins, Skills, Social / Studio

| Capability | Agent route | State |
|---|---|---|
| Language, theme, mode (Design / Dev / Draw / Social / Motion) | `get_app_settings` / `set_app_setting` | **added** |
| Preferences (snap, keep tool, highlight on hover, rename duplicates, invert zoom …, accessibility switches), nudge amounts | `set_app_setting preferences.* / nudge` (set to a value; `run_command` only toggles) | **added** |
| View options (rulers, pixel grid, layout guides, outlines, slices, cursors, comments) | `set_app_setting view.*`, `run_command view.*` | **added** / covered |
| Notifications preferences, profile name / avatar, uploaded fonts | — | gap: account-level, low value for agents |
| Plugins: list (with menu commands), run | `list_plugins`, `run_plugin` (confirmed) | **added** |
| Skills: list, read | `list_skills`, `get_skill` | **added** / covered |
| Skills: create, update (rename, turn on / off), remove | `create_skill`, `update_skill`, `remove_skill` (confirmed, the card shows the text) | **added** |
| Find and install a skill from the web or GitHub | `find_skills`, `read_skill` (Access › Web), `install_skill {url}` or `{repo, path}` (Access › GitHub) | **added** |
| Social: board, posts, templates, campaign, checks, export | `get_board` … `export_posts`; manager `make_posts`, `review` … | covered |
| Brands library: find, save brand / product / image | `library_*` (manager) | covered |
| Brands: delete a brand / product / image | — | gap (destructive, rare; `BrandsRepository.remove*` — next round with a card) |
| Providers, keys, connectors, Access, sessions, tokens, Operator | — | excluded |

## 3. "Find yourself a UX skill and add it"

1. `find_skills {query: "ux"}`:
   - A reach tool with capability Web: Off is refused, Ask shows the access card, and the call is logged.
   - It reads the public repository's tree through `api.github.com` (default `anthropics/skills`, or `repo`).
   - It reads the first 4 KB of each SKILL.md from `raw.githubusercontent.com` for the frontmatter.
   - It ranks by the query, with design synonyms ("ux" → design, interface, frontend …).
   - It returns name, description and the ready `install_skill {url}` call, as untrusted data.
2. `read_skill {url}` (optional) shows one skill's text.
3. `install_skill {url}`:
   - It reads the SKILL.md through the same gate (`ReachHub.call` with a per-call runner): policy, consent, budget, time limit, access log.
   - A GitHub page address becomes its raw file; a folder becomes its SKILL.md.
   - Every hop is checked by reachNet's rules plus a public-DNS check. Redirects are followed by hand and checked again. The size cap is 256 KB. HTML pages and binaries are refused.
   - Then `parseSkillFile` / `skillProblem` validate it: name format, description ≤ 1024, instructions ≤ 64 KB.
   - A name already taken is refused unless `replace: true`.
   - The confirmation card shows:
     - the name and description;
     - the source;
     - a note when the text mentions scripts or commands (only the text is installed; nothing is run);
     - the instructions.
   - On Allow: `ai.saveSkill`, which is the store's `Workspace/spaces/ai/skills/<id>.md`.
   - When the step finishes, the Agents panel reads the list again (`skillsBox.refresh` on the tool's done event).
   - The skill is in Agents › Skills, and enabled skills go with the next message.
4. `{repo, path, ref}` reads a repository the person picked in Access › GitHub (`GithubAccess.readSkillText`). A public repository the person didn't pick goes by `url` under Web.

## 4. Left (next round)

- Code Connect and dev resource writes.
- Branch review and merge.
- Swap library.
- Team / project administration (mirroring the person's role).
- Brands deletes behind the card.
- Notifications and profile settings.
- Import .fig / save a local copy (OS dialogs).
- Other views (Home's settings page, other editor tabs) re-read Skills when they next load the list: a live broadcast (`agents:skills-changed`) is not built.
- `insert_library_component` selects the new instance for the person, as the Assets panel does (not the agent's own actor).
