// The screens capture.mjs records: a route of the web dev page (demo data) and the clicks that open a state.
// `page` is the design file's page the screen goes on.
const click = (sel, opts) => (p) => p.locator(sel).first().click(opts);
const rclick = (x, y) => (p) => p.mouse.click(x, y, { button: "right" });
const layer = (name) => (p) => p.locator('[data-ds="LayerRow"]', { hasText: name }).first().click();

export const SCENARIOS = [
  // Home
  { id: "home-grid", title: "Home — Drafts (grid)", page: "Home", url: "?nologin" },
  { id: "home-list", title: "Home — Drafts (list)", page: "Home", url: "?nologin", steps: [click('button[aria-label="List view"]')] },
  { id: "home-folder", title: "Home — Folder", page: "Home", url: "?nologin", steps: [click('[data-ds="SidebarItem"]:has-text("Client work")')] },
  { id: "home-trash", title: "Home — Trash", page: "Home", url: "?nologin", steps: [click('[data-ds="SidebarItem"]:has-text("Trash")')] },
  { id: "home-team-menu", title: "Home — Team menu", page: "Menus & popovers", url: "?nologin", steps: [click('button[aria-label="My team, account"]')] },
  { id: "home-sort-menu", title: "Home — Sort menu", page: "Menus & popovers", url: "?nologin", steps: [click('button[aria-label="Sort"]')] },
  { id: "home-file-menu", title: "Home — File context menu", page: "Menus & popovers", url: "?nologin", steps: [(p) => p.locator('[data-ds="FileCard"]').first().click({ button: "right" })] },
  // Editor
  { id: "editor-page", title: "Editor — Design (page)", page: "Editor", url: "?editor" },
  { id: "editor-frame", title: "Editor — Design (frame selected)", page: "Editor", url: "?editor", steps: [layer("Desktop")] },
  { id: "editor-shape", title: "Editor — Design (shape selected)", page: "Editor", url: "?editor", steps: [layer("Outside stroke")] },
  { id: "editor-prototype", title: "Editor — Prototype", page: "Editor", url: "?editor", steps: [layer("Desktop"), click('button:has-text("Prototype")')] },
  { id: "editor-dev", title: "Editor — Dev Mode", page: "Editor", url: "?editor", steps: [layer("Desktop"), click('button[aria-label="Dev Mode"]')] },
  { id: "editor-assets", title: "Editor — Assets", page: "Editor", url: "?editor", steps: [click('button[aria-label="Assets"]')] },
  { id: "editor-agents", title: "Editor — Agents", page: "Editor", url: "?editor", steps: [click('button[aria-label="Agents"]')] },
  { id: "editor-tools", title: "Editor — Tools", page: "Editor", url: "?editor", steps: [click('button[aria-label="Tools"]')] },
  { id: "editor-brands", title: "Editor — Brands", page: "Editor", url: "?editor", steps: [click('button[aria-label="Brands"]')] },
  { id: "editor-draw", title: "Editor — Draw", page: "Editor", url: "?editor", steps: [click('button[aria-label="Draw"]')] },
  // Menus and popovers in the editor
  { id: "menu-main", title: "Main menu", page: "Menus & popovers", url: "?editor", steps: [click('button[aria-label="Main menu"]')] },
  { id: "menu-file", title: "File name menu", page: "Menus & popovers", url: "?editor", steps: [click('button[aria-label="Edit file menu"]')] },
  { id: "menu-zoom", title: "Zoom menu", page: "Menus & popovers", url: "?editor", steps: [click('button[aria-label="Zoom"]')] },
  { id: "menu-account", title: "Account menu", page: "Menus & popovers", url: "?editor", steps: [click('button[aria-label="Account"]')] },
  { id: "menu-shapes", title: "Shape tools menu", page: "Menus & popovers", url: "?editor", steps: [click('button[aria-label="Shape tools"]')] },
  { id: "menu-canvas", title: "Canvas context menu", page: "Menus & popovers", url: "?editor", steps: [layer("Desktop"), rclick(600, 380)] },
  { id: "menu-layer", title: "Layer context menu", page: "Menus & popovers", url: "?editor", steps: [(p) => p.locator('[data-ds="LayerRow"]', { hasText: "Mobile" }).first().click({ button: "right" })] },
  { id: "menu-style", title: "Create style menu", page: "Menus & popovers", url: "?editor", steps: [click('button[aria-label="Create style"]')] },
  { id: "popover-color", title: "Color picker", page: "Menus & popovers", url: "?editor", steps: [click('button[aria-label^="Solid color hex"]')] },
  { id: "popover-actions", title: "Actions", page: "Menus & popovers", url: "?editor", steps: [click('button[aria-label="Actions"]')] },
  // Dialogs
  { id: "dialog-share", title: "Share dialog", page: "Dialogs", url: "?editor", steps: [click('[data-ds="Button"]:has-text("Share")')] },
  { id: "dialog-variables", title: "Variables", page: "Dialogs", url: "?editor", steps: [click('button[aria-label="Variables"]')] },
  { id: "dialog-settings", title: "Settings", page: "Dialogs", url: "?nologin", steps: [click('button[aria-label="My team, account"]'), (p) => p.getByRole("menuitem", { name: /Settings/ }).first().click()] },
  { id: "menu-main-file", title: "Main menu — File", page: "Menus & popovers", url: "?editor", steps: [click('button[aria-label="Main menu"]'), (p) => p.getByRole("menuitem", { name: /^File/ }).first().hover()] },
  { id: "menu-help", title: "Help — Keyboard shortcuts", page: "Menus & popovers", url: "?editor", steps: [click('button[aria-label="Help and resources"]')] },
  { id: "menu-present", title: "Present options", page: "Menus & popovers", url: "?editor", steps: [click('button[aria-label="Present options"]')] },
  // Welcome (the signed-out window: a stand-in for the preload's account)
  {
    id: "welcome",
    title: "Welcome",
    page: "Welcome",
    url: "?welcome",
    wait: 4000,
    init: `window.designer = { role: "welcome", platform: "darwin", version: "1.0.0", ready() {}, theme: { preference: "light", resolved: "light", contrast: false }, onThemeChanged: () => () => {}, locale: "en", onLocaleChanged: () => () => {}, onWindowState: () => () => {}, onFullScreen: () => () => {}, haptics: { tick() {} }, menu: { popup: async () => null }, account: { get: async () => ({ server: "https://wecra.app", user: null, signingIn: false }), signIn: async () => ({ state: { server: "", user: null, signingIn: false } }), cancelSignIn: async () => ({ server: "", user: null, signingIn: false }), onChanged: () => () => {}, onIdle: () => () => {} } };`,
  },
];
