// Stand-in for src/renderer/src/editor/agents/service.ts (vite.config.ts SHIMS). The real AgentsService drives the
// chats (the store, the engine, the CLIs over IPC); the site's Studio scene renders the app's own TaskCard and
// ManagerCard (editor/panels/agents/StudioCards.tsx) with a scripted service (scenes/ai/studioService.ts), so only
// the steps' labels are needed at run time. They are the app's words (service.ts TOOL_LABEL), for the tools the
// scenes show.
const TOOL_LABEL: Record<string, string> = {
  get_selection: "Looked at the selection",
  get_metadata: "Read the layers",
  get_design_context: "Read the design",
  get_screenshot: "Took a screenshot",
  get_variable_defs: "Read variables and styles",
  create_nodes: "Created layers",
  update_nodes: "Edited layers",
  set_auto_layout: "Set auto layout",
  apply_variable: "Applied a variable",
  apply_style: "Applied a style",
  set_selection: "Selected the result",
  place_image: "Placed an image",
  generate_image: "Made an image",
  delegate_task: "Handed out a task",
  wait_tasks: "Waited for the tasks",
  ask_choice: "Asked you",
  make_posts: "Started the posts",
  review: "Looked at the results",
  report_review: "Reported the review",
  library_find: "Searched the library",
  library_get: "Read the library",
  library_missing: "Checked what is missing",
  library_read_labels: "Read the labels",
};

export const toolLabel = (name: string) => TOOL_LABEL[name] ?? name.replace(/_/g, " ");
