# R12: Agents (AI chat) and the Figma MCP server

Research for the Agents left-rail tab, our MCP server over the open file, and one-click setup in MCP clients. Done on 2026-10-09 from help.figma.com, developers.figma.com, each client's official docs, and a read-only look at this Mac.

- **verified**: stated on the cited page, or seen in our live capture (`live/`).
- **[unverified]**: inferred, or found only in third-party sources; check it before relying on it.

## 1. Figma MCP server

### Two servers

| | Desktop (local) | Remote (preferred) |
|---|---|---|
| URL | `http://127.0.0.1:3845/mcp` | `https://mcp.figma.com/mcp` |
| Runs in | Figma desktop app | Figma's cloud, OAuth |
| Targeting | **current selection**, or a link | **link only** (file key plus node id) |
| Write tools | none (Code Connect mapping only) | `use_figma`, `generate_figma_design`, etc. |

- **Desktop URL and how to enable it** (verified, [local server installation](https://developers.figma.com/docs/figma-mcp-server/local-server-installation)):
  - Open a Design file in the desktop app and switch to Dev Mode (⇧D).
  - In the inspect panel's **MCP server** section, click **"Enable desktop MCP server"**. A confirmation toast appears at the bottom.
  - "Open settings modal" holds Image settings ("Local server" or "Download assets") and "Enable Code Connect".
- **Remote URL; remote is preferred** (verified, [Guide to the Figma MCP server](https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server)). Help Center's remote guide describes a **"Set up an MCP client"** button in the Dev Mode inspect panel with nothing selected ([remote setup](https://help.figma.com/hc/en-us/articles/35281350665623)).
- **Panel change, Sept 2026** (verified only as a forum staff reply, [forum](https://forum.figma.com/report-a-problem-6/enable-mcp-mcp-server-section-not-showing-up-on-figma-dev-56962)):
  - "Enable desktop MCP server" was replaced by **"Connect to AI agent"**, which points at the remote server.
  - The desktop server is now enabled from ⌘K by searching "Enable desktop MCP server".
- **Transport.** `/mcp` is Streamable HTTP (POST JSON-RPC, optional SSE responses).
  - **[unverified]** Figma's docs never name the transport.
  - Older guides used `http://127.0.0.1:3845/sse` (legacy SSE), now replaced by `/mcp`.
- **Selection vs nodeId** (verified, [tools page](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/)):
  - "Selection-based prompting only works with the desktop MCP server. The remote server requires a link to a frame or layer."
  - For a link, the client takes `node-id=1-2` from the URL and passes it to the tool.
  - **[unverified]**, from the tools' JSON schemas as clients show them:
    - `nodeId` is `"123:456"`, and `"123-456"` is accepted too.
    - On desktop it is optional; when omitted, the tool uses the current selection.
    - Remote tools also take `fileKey`, the `/design/<fileKey>/` part of the URL.

### Tools: read tools

Verified names, from the [tools page](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/).

| Tool | Where | Params (documented) | Returns |
|---|---|---|---|
| `get_design_context` | both | `clientFrameworks` (remote); **[unverified]** `nodeId`, `fileKey`, `clientLanguages`, `forceCode`, `dirForAssetWrites` | Code for the layer or selection, React + Tailwind by default, with Code Connect snippets and asset URLs |
| `get_metadata` | both | `nodeId` (optional) | Sparse XML outline of the node tree: ids, names, types, x/y, sizes. With no `nodeId`, it lists the top-level pages, and an invalid id returns an error plus that list |
| `get_screenshot` | both | `enableBase64Response`; **[unverified]** `nodeId`, `fileKey` | Image of the selection or node |
| `get_variable_defs` | both | none documented (selection-based) | Variables and styles used, e.g. `{"color/bg": "#fff"}` |
| `get_code_connect_map` | both | `clientFrameworks`, `clientLanguages` (remote) | `{nodeId: {codeConnectSrc, codeConnectName, snippet, label}}` |
| `get_code_connect_suggestions` | both | none documented | Suggested mappings |
| `get_figjam` | both | none documented | FigJam XML plus node screenshots |
| `get_motion_context` | both | node id, `recursive` | Keyframes, CSS `@keyframes`, motion.dev snippets |
| `whoami` | remote | none | Email, plans, seats |
| `get_libraries` | remote | none documented | Subscribed and available libraries |
| `search_design_system` | remote | `queries: string[]` | Components, variables, styles |
| `download_assets` | remote | `defaultFormat`, `defaultScale` (0.01–4), ≤20 nodes | Temporary export URLs |
| `get_context_for_code_connect` | remote | none documented | Component metadata for templates |
| `list_shaders`, `get_shader`, `list_file_shaders` | mixed | `cursor` / `id`, `version`, `includeSource` / `fileKey` | Shader manifests |
| `list_generative_plugins`, `get_generative_plugin` | remote | `cursor` / `id`, `version`, `includeSource` | Plugin manifests |

### Tools: write tools

| Tool | Where | Params / notes |
|---|---|---|
| `use_figma` | remote | "The general-purpose tool for writing to Figma files": create, edit, delete or inspect objects in Design, FigJam and Slides. The client "execute[s] JavaScript in the context of a Figma file through the Plugin API" ([write to canvas](https://developers.figma.com/docs/figma-mcp-server/write-to-canvas)). The exact params are undocumented; **[unverified]** roughly `fileKey` plus JS `code` plus a description. Clients load the `figma-use` skill first. |
| `generate_figma_design` | remote | Sends live web UI to a new file, an existing file or the clipboard as layers ("code to canvas"); select clients only |
| `create_new_file` | remote | Blank Design, FigJam or Slides file |
| `add_code_connect_map` | both | Adds a node→component mapping |
| `send_code_connect_mappings` | both | Confirms suggested mappings |
| `upload_assets`, `generate_image` | remote | Images as fills or frames; a temporary image URL |
| `generate_diagram` | remote | Mermaid or natural language → FigJam |
| `create_shader`, `update_shader`, `create_generative_plugin`, `update_generative_plugin` | remote | `name`, `description`, `planKey`, `kind`; updates take `id`, `commitMessage`, `files[{path,content}]`, `metadata` |
| `weave_*` (6 tools) | ? | Weave published tools: list, get inputs, run, output, cancel, upload asset |

- **Prompt:** `create_design_system_rules` is an MCP *prompt*, not a tool. It writes a rules file for `rules/` or `instructions/`.
- **Skills:** write-to-canvas is guided by markdown skills (`figma-use`, `figma-code-connect`, `figma-create-new-file`, ...), shipped as client plugins. Sources: [blog](https://www.figma.com/blog/the-figma-canvas-is-now-open-to-agents/), [mcp-server-guide](https://github.com/figma/mcp-server-guide).
- **For us:** the shape to copy is the desktop server's selection-based reads (`get_design_context`, `get_metadata`, `get_screenshot`, `get_variable_defs`) plus a `use_figma`-like write tool. Our write tool would take document ops rather than Plugin-API JS (our decision, not Figma's).

## 2. How Figma's UI shows MCP and "Set up agents"

- **Live capture** (verified, `live/design/page-nothing-selected.txt`): design mode, right panel, nothing selected, after Export:
  - section header **"MCP"**;
  - a span whose tooltip is **"Figma MCP in Claude"**, with the text **"1 connection"**;
  - a 24×24 icon button **"Set up agents for Figma MCP"**.
  - So the connected-client count is shown in Design mode, not only in Dev Mode.
- **Preferences** (verified, `live/menus/main-preferences.txt`): **"Show Agents on canvas"** and "Play audio notifications in AI chat".
  - The help article still calls the first one "Show AI Chat on canvas" (older wording).
- **Setup dialog wording:** not documented anywhere public.
  - Dev Mode's equivalents are "Set up an MCP client" (remote, older) and "Connect to AI agent" (since Sept 2026).
  - Figma's per-client setup articles cover **Claude Code, Codex, Cursor, VS Code, Gemini CLI, Xcode** ([remote setup](https://help.figma.com/hc/en-us/articles/35281350665623)).
  - The supported-client table also lists Amazon Q, Android Studio, Augment, Claude Desktop, Copilot CLI, Factory, Firebender, Kiro, OpenHands, Replit and Warp.
  - **[unverified]** The dialog probably lists those clients, each with an install action (a plugin command, a deep link or a copy URL). It needs a live capture: click the button.
- **Install routes Figma documents** ([mcp-server-guide](https://github.com/figma/mcp-server-guide), [local install](https://developers.figma.com/docs/figma-mcp-server/local-server-installation)):

| Client | Install route |
|---|---|
| Claude Code | `claude plugin install figma@claude-plugins-official`, or `claude mcp add --transport http figma https://mcp.figma.com/mcp` (desktop: `figma-desktop http://127.0.0.1:3845/mcp`) |
| Cursor | `/add-plugin figma`, or Settings → MCP → "+ Add new global MCP server" |
| VS Code | "MCP: Add Server" → HTTP → URL, server id `figma` or `figma-desktop` |
| Codex | `codex mcp add figma --url https://mcp.figma.com/mcp` |
| Gemini CLI | `gemini extensions install https://github.com/figma/mcp-server-guide`, then `/mcp auth figma` |

## 3. Figma's Agents (in-app AI chat)

Verified from [Work with the Figma agent in design files](https://help.figma.com/hc/en-us/articles/37998629035799) unless marked otherwise.

### Entry points

- **Left rail "Agents"** (File, Agents, Assets, Tools, Variables, from our capture) opens a **persistent chat sidebar**.
- **On-canvas prompt box:** select a layer, then click Agents or press **⌘↩**.
  - Preference "Show Agents on canvas" turns it off.
  - A sparkle (AI) button floats at the top-right of the selection (our capture, `live/README.md`).
- **"Pop out Agents panel"** at the top of the sidebar (desktop app).
- Hovering Agents in the rail shows the status of recent threads.

### Prompt box

- Buttons: **"Dictate"** and **"Send"**, plus **"Stop"** while a task runs.
- An attachment control offers **"Attach Figma files"**. Its modal accepts design URLs, several designs, and dragged or pasted images and files. Frames and images can also be pasted into the chat.
- **"Libraries"** connects a library; then **@** references its components, variables and styles.
- Context can also come from skills, connected apps (MCP connectors) and the canvas selection.

### Threads

- The sidebar lists the file's chats by recency, each with a preview of the last message.
- **"New chat"** starts a conversation, and **"Back"** returns to the list.
- Since 2026-06-23, new chats are visible to Full-seat editors.

### Runs

- Several prompts can run at once. Each shows an animated loading indicator on the canvas.
- Clicking an indicator opens a chat window with the agent's steps and its result.

### Undo

- **"Undo"** in the chat reverts the agent's most recent change.
- The help article suggests duplicating the layer first if you want to compare versions.

### Capabilities

- **Can:**
  - 0→1 generation, layout editing, instance editing, styles, variables;
  - bulk content edits, image creation and editing, image-to-vector;
  - layer renaming, library search, comment review, design feedback;
  - design system authoring, file actions and search, canvas selection;
  - web search, MCP connectors, skills, shaders, plugin generation, motion.
- **Coming soon:** vector and Draw tools, icons, slots, prototyping.
- **Not supported:** exporting assets, diagrams and charts (FigJam AI does those), contacting support.

### Not documented

- **Model picker:** no source mentions one **[unverified]**.
- **Placeholder text:** unknown, needs a live capture.
- Older single-purpose Figma AI actions (Make designs responsive, First Draft, Rename layers) are still offered in the Actions palette ("AI actions" in our capture). The agent subsumes them **[unverified]**.

## 4. MCP client configs

### Claude Code (verified, [MCP](https://code.claude.com/docs/en/mcp), [CLI reference](https://code.claude.com/docs/en/cli-reference), [headless](https://code.claude.com/docs/en/headless))

**Adding a server:**
- `claude mcp add --transport http <name> <url> --header "Authorization: Bearer <t>"` (`-t`, `-H`); `-s local|project|user`.
- `claude mcp add-json <name> '<json>'`.
- stdio: `claude mcp add <name> -- <cmd> [args]`.

**Where configs live:**
- local and user scopes: `~/.claude.json` (user scope in the top-level `mcpServers`; local scope under that project's entry);
- project scope: `.mcp.json`.

**Format:**
```json
{"mcpServers":{"designer":{"type":"http","url":"http://127.0.0.1:3846/mcp","headers":{"Authorization":"Bearer ${DESIGNER_TOKEN}"}}}}
```
- stdio entries use `{"type":"stdio","command","args","env"}`.
- `${VAR}` and `${VAR:-default}` expand in `url`, `headers`, `command`, `args` and `env`.

**Headless:**
```
claude -p "<prompt>" --output-format stream-json --verbose [--include-partial-messages]
  --mcp-config <file|json> --strict-mcp-config --allowedTools "mcp__designer__*"
  --permission-mode default|acceptEdits|plan|auto|dontAsk|bypassPermissions
  [--model] [--resume <id>] [--session-id <uuid>] [--append-system-prompt] [--max-turns]
  [--input-format stream-json]
```

**Headless flags:**
- `--bare` skips local hooks, CLAUDE.md and MCP auto-discovery.
- `--permission-prompts none` denies anything that would prompt.

**stream-json event shapes** (NDJSON; verified, [Agent SDK TS types](https://code.claude.com/docs/en/agent-sdk/typescript)):
- `{"type":"system","subtype":"init","session_id","cwd","model","tools":[],"mcp_servers":[{"name","status"}],"permissionMode","claude_code_version",...}`
- `{"type":"assistant","message":{...Anthropic message, content:[{type:"text",text}|{type:"tool_use",id,name,input}|{type:"thinking"}]},"parent_tool_use_id":null,"session_id"}`
- `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id","content","is_error"}]},...}`
- `{"type":"stream_event","event":<raw Anthropic SSE event, e.g. content_block_delta/text_delta>,"parent_tool_use_id"}` (with `--include-partial-messages`)
- `{"type":"result","subtype":"success"|"error_max_turns"|"error_during_execution"|...,"is_error","result","session_id","num_turns","duration_ms","total_cost_usd","usage","permission_denials"}`
- also `system/api_retry`, and `permission_denied` system messages.

### Cursor (verified, [MCP](https://cursor.com/docs/context/mcp), [CLI headless](https://cursor.com/docs/cli/headless), [CLI MCP](https://cursor.com/docs/cli/mcp))

**Config:**
- files: `~/.cursor/mcp.json` (global), `.cursor/mcp.json` (project);
- HTTP: `{"mcpServers":{name:{"url","headers"}}}`;
- stdio: `{"command","args","env"}`;
- interpolation: `${env:NAME}`, `${userHome}`, `${workspaceFolder}`.

**Headless CLI:**
- the binary is `agent` (formerly `cursor-agent`): `agent -p --force --output-format text|json|stream-json [--stream-partial-output]`;
- stream-json events: `system/init` (`model`), `assistant` (`message.content[0].text`), `tool_call` `started`/`completed`, and `result` (`duration_ms`);
- MCP: the CLI uses the same `mcp.json` as the editor (`agent mcp list`, `agent mcp login <id>`, `--approve-mcps`).

**Local:** `~/.cursor` exists; `Cursor.app` is installed; the `agent` CLI is not on PATH; there is no `mcp.json`.

### VS Code (verified, [MCP servers](https://code.visualstudio.com/docs/copilot/customization/mcp-servers))

**Config:**
- user file: `mcp.json` in the profile folder; on macOS `~/Library/Application Support/Code/User/mcp.json` (the dir exists here; no file yet). Open it with "MCP: Open User Configuration".
- workspace file: `.vscode/mcp.json`.
- format: `{"servers":{name:{"type":"http","url","headers"}}}`; stdio is `{"type":"stdio","command","args","env"}`.
- secrets go in `"inputs":[{"type":"promptString","id","password":true}]` and are referenced as `${input:id}` (inputs syntax from memory, **[unverified]** on this page).

**CLI:** `code --add-mcp '{"name":"designer","type":"http","url":"..."}'`. The doc example is stdio; the http form is **[unverified]**.

**Headless:** none (Copilot agent mode is in-editor only).

### Google Antigravity (verified, [docs](https://antigravity.google/docs/mcp))

**Config:**
- global file: `~/.gemini/config/mcp_config.json`; workspace file: `.agents/mcp_config.json`.
- format: `{"mcpServers":{name:{"serverUrl","headers"}}}`. "Legacy fields like `url` or `httpUrl` aren't supported."
- stdio: `command`, `args`, `env`, `cwd`.
- optional keys: `oauth{clientId,clientSecret}`, `disabled`, `disabledTools`.
- UI: IDE "…" → MCP Servers → Manage MCP Servers → "View raw config". In 2.0: Settings → Customizations → Installed MCP Servers.

**Local:**
- `Antigravity.app` 2.0.0 (`com.google.antigravity`) and `Antigravity IDE.app` 2.5.5 (`com.google.antigravity-ide`, CLI at `Contents/Resources/app/bin/antigravity-ide`).
- Configs (keys only):
  - `~/.gemini/config/mcp_config.json` and `~/.gemini/antigravity/mcp_config.json` each have `figma` (`command`/`args`/`env`) and `figma-dev-mode-mcp-server` (`serverUrl`);
  - `~/.gemini/antigravity-ide/mcp_config.json` has `figma` (stdio).
  - Write to `~/.gemini/config/mcp_config.json`. Older builds read `~/.gemini/antigravity/` and the IDE reads `~/.gemini/antigravity-ide/` **[unverified]**.
- `~/.gemini/antigravity/mcp/agy` is a dangling symlink into the old app's bin.

**Headless:** an "Antigravity CLI" exists (`/mcp` overlay), but no documented `-p`/JSON mode was found **[unverified]**.

### Gemini CLI (verified, [MCP](https://geminicli.com/docs/tools/mcp-server/), [headless](https://geminicli.com/docs/cli/headless/))

**Config:**
- files: `~/.gemini/settings.json` (user) or `.gemini/settings.json`;
- format: `{"mcpServers":{name:{"httpUrl","headers","timeout","trust","includeTools","excludeTools"}}}`. `url` means SSE and `httpUrl` means Streamable HTTP; stdio uses `command`/`args`/`env`/`cwd`.
- add: `gemini mcp add --transport http --header "Authorization: Bearer x" <name> <url>`.

**Headless:**
- `gemini -p "<prompt>" --output-format json|stream-json`;
- stream-json event types: `init`, `message`, `tool_use`, `tool_result`, `error`, `result` (stats);
- `--yolo` / `--approval-mode` exist but are not on that page **[unverified]**.

**Local:** `gemini` is not installed and there is no `~/.gemini/settings.json`.

### OpenAI Codex CLI (verified, [MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode))

**Config:** `~/.codex/config.toml` (or trusted-project `.codex/config.toml`):
```toml
[mcp_servers.designer]
url = "http://127.0.0.1:3846/mcp"
bearer_token_env_var = "DESIGNER_TOKEN"   # or http_headers = { Authorization = "Bearer ..." }
# stdio: command = "node", args = ["server.js"], env = { K = "v" }, cwd = "..."
startup_timeout_sec = 10
tool_timeout_sec = 60
enabled = true
```
- add: `codex mcp add <name> --url <url>`, or `codex mcp add <name> --env K=V -- <cmd>`.

**Headless:**
- command: `codex exec --json "<prompt>" [--sandbox read-only|workspace-write|danger-full-access]`; `codex exec resume --last|<id>`.
- JSONL events: `thread.started{thread_id}`, `turn.started`, `item.started|updated|completed{item:{id,type,...}}`, `turn.completed{usage}`, `turn.failed`, `error`.
- item types: `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call{server,tool,status}`, `web_search`, `todo_list`. These names come from third-party references **[unverified]**.

**Local:** `codex` is not installed and there is no `~/.codex`.

### Local models (for a built-in chat without an external agent)

**Ollama** (verified, [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)):
- `http://localhost:11434/v1/chat/completions` supports tools and streaming; the API key is ignored (send `ollama`); `/v1/models` lists models.
- Streamed tool calls arrive as `choices[0].delta.tool_calls[]` with `finish_reason:"tool_calls"`. Recent Ollama sends each call whole, not in argument fragments, so accumulate by `index` anyway. Source: a third-party bug report **[unverified]**.
- Native `GET /api/tags` returns `{"models":[{name,model,modified_at,size,digest,details{family,parameter_size,quantization_level}}]}` **[unverified, from memory]**.

**LM Studio** (verified, [OpenAI compat](https://lmstudio.ai/docs/developer/openai-compat)):
- `http://localhost:1234/v1`: `GET /v1/models`, plus POST `/v1/chat/completions`, `/v1/responses`, `/v1/embeddings`.
- Tool use is documented on a separate page; OpenAI-style `tools` / `tool_calls` with streaming is **[unverified]** here.

**Local:** neither `ollama` nor `lms` is on PATH.

## Implementation notes for us

**Our server:**
- one Streamable HTTP endpoint on loopback, e.g. `http://127.0.0.1:<port>/mcp`, with a per-install bearer token;
- the main process hosts it, and reads/writes go through the store and engine of the focused file view;
- tool names mirror Figma's: `get_design_context`, `get_metadata`, `get_screenshot`, `get_variable_defs`, plus a write tool;
- each tool takes an optional `nodeId` (`"12:34"`, also accept `12-34`); omitted means the current selection, as on Figma desktop;
- also offer a stdio shim (`node <app>/mcp-stdio.js`) that forwards to the HTTP endpoint, for clients or configs that prefer stdio.

**"N connections":** count live MCP sessions (`Mcp-Session-Id`) and name the client from `initialize.clientInfo.name` (Figma shows "Figma MCP in Claude").

**Per-client setup:**

| Client | Config file (macOS) | HTTP + bearer entry | stdio entry | Headless agent |
|---|---|---|---|---|
| Claude Code | `~/.claude.json` → `mcpServers` (user), or `<proj>/.mcp.json`. Prefer running `claude mcp add -s user -t http designer <url> -H "Authorization: Bearer <t>"` to hand-editing | `{"type":"http","url":U,"headers":{"Authorization":"Bearer T"}}` | `{"type":"stdio","command":C,"args":[..],"env":{..}}` | `claude -p --output-format stream-json --verbose --include-partial-messages --mcp-config '<json>' --strict-mcp-config --allowedTools "mcp__designer__*" --permission-mode default`. NDJSON events: system/init, assistant, user(tool_result), stream_event, result |
| Cursor | `~/.cursor/mcp.json` | `{"mcpServers":{"designer":{"url":U,"headers":{"Authorization":"Bearer T"}}}}` | `{"command":C,"args":[..],"env":{..}}` | `agent -p --force --output-format stream-json [--stream-partial-output] --approve-mcps`. Events: system/init, assistant, tool_call started/completed, result |
| VS Code | `~/Library/Application Support/Code/User/mcp.json`, or `code --add-mcp '<json>'` | `{"servers":{"designer":{"type":"http","url":U,"headers":{"Authorization":"Bearer T"}}}}` | `{"type":"stdio","command":C,"args":[..]}` | none |
| Antigravity | `~/.gemini/config/mcp_config.json` (also `~/.gemini/antigravity/` and `~/.gemini/antigravity-ide/` on this Mac) | `{"mcpServers":{"designer":{"serverUrl":U,"headers":{"Authorization":"Bearer T"}}}}`. Note it is `serverUrl`, not `url` | `{"command":C,"args":[..],"env":{..}}` | none documented |
| Gemini CLI | `~/.gemini/settings.json` | `{"mcpServers":{"designer":{"httpUrl":U,"headers":{"Authorization":"Bearer T"}}}}` | `{"command":C,"args":[..]}` | `gemini -p "<p>" --output-format stream-json`. Events: init, message, tool_use, tool_result, error, result |
| Codex | `~/.codex/config.toml` | `[mcp_servers.designer]` `url=U` `http_headers={Authorization="Bearer T"}` (or `bearer_token_env_var`) | `command=C` `args=[..]` | `codex exec --json "<p>"`. JSONL events: thread.started, turn.*, item.* (agent_message, mcp_tool_call) |
| Ollama / LM Studio | none (we are the agent loop) | We call `POST /v1/chat/completions` with `tools` and `stream:true`, and run the MCP tools in-process | n/a | n/a |

**Editing configs safely:**
- Merge into existing files: parse, then set only `mcpServers.designer` (or `servers.designer`, or `[mcp_servers.designer]`), keep every other key, and write atomically.
- Never print or log other servers' secrets.
- Detect clients by app bundle or config directory existence, as in the local checks above.

**Still to capture live in Figma:**
- the "Set up agents for Figma MCP" dialog (client list and wording);
- the Agents panel placeholder and empty state;
- whether a model picker exists.
