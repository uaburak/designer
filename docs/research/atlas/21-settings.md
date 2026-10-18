# 21 — Settings, preferences, accessibility and localisation

Figma Design desktop 126.9.13, read statically on 2026-10-16. Evidence marks: **C** = CONFIRMED (read directly in the build), **I** = INFERRED (deduced; the reason is given), **L** = seen in a live capture in the repo.

## 1. Scope and sources

In scope: the editor's Preferences submenu and where each preference is stored, the Nudge amount dialog, the Accessibility settings dialog, the account Settings modal (Account, Community, Notifications, Security), theme and enhanced contrast, localisation, local fonts, the desktop shell's own settings (interface scale, GPU, menu bar, troubleshooting), and debug toggles.

Sources read:

| Source | What was read |
|---|---|
| `~/.cache/figma-rea/figma/fullscreen__fullscreen-wasm__compiled_wasm.js` | The `EditorPreferences_Internal` bindings (100 properties), the `CoreUtils_{get,set}LocalStorage` imports, `FigmaApp_saveUseNumbersForOpacityPreference`, `FigmaApp_setUserFlag`, `FigmaApp_showNudgeAmountPicker` |
| `…compiled_wasm.wasm` (`strings -n 6`, 103 967 lines) | Kebab-case localStorage keys (`small-nudge-amount`, `snap-to-pixel-grid`, `property-labels-visible` …), `EditorPreferences_Internal___getProperty_*` symbols |
| `figma_app.min.js` | The `NudgeAmountPicker` module (`914527`); the number-formatter defaults; the preference toggle toasts (`visual_bell.*`); the theme module (`global-debug-theme-preference`); the user-record schema (`auto_open_in_desktop … utc_offset`); scroll-wheel-zoom / right-click-pan (`418726`); the user colour profile; the locale switch; viewport navigation and reduced motion |
| `3187.min.js` (the same code is in `5519` / `7362`) | `ACCOUNT_SETTINGS_MODAL` (`rO` @≈6 321 700), Account tab (`rk` @6 314 524), local fonts (`i8` @6 304 161), closed captions (`rr`), Notifications tab (`t7`), Security tab (`ir` @6 285 479), the token modal (`nQ=[1,7,30,90]`), `ACCESSIBILITY_SETTINGS` dialog, enhanced contrast (`global-debug-enhanced-contrast-preference`), link underline, `LanguageSelectorModal` (`773110`), the `product_locale` cookie (`141130`), the screen-reader reducer |
| `mobile_viewer.min.js` / `figma_app.min.js` module `610579` / `76191` | Locale lists `EO` / `Yv` / `cN`, display names, `Intl` / help-centre locale maps |
| `858.min.js`, `7621.min.js` | The menu-item records of the Preferences submenu (already tabulated in chapter 03) |
| `/Applications/Figma.app/Contents/Resources/app.asar` → `main.js` (extracted to scratch only) | Desktop state defaults (`YKe`), the settings file, `ZOOM_STOPS`, Troubleshooting, Graphics Backend, the English desktop strings |
| Repo | `docs/research/figma/R17-settings.md` (help-centre research), `R16-notifications.md` (live captures of Notifications), `live/menus/main-preferences.txt` and `main-help.txt`, atlas chapters 02, 03, 07, 20 |

Prior work this chapter builds on, summarised and not repeated:

- **R17** (`docs/research/figma/R17-settings.md`): where Settings opens, the help-centre wording of each Account / Community / Security row, deletion consequences, REST token scopes. Most of its "unverified" items are settled in §6 below.
- **R16** (`docs/research/figma/R16-notifications.md` §4): the Notifications tab, verbatim from the owner's captures, with layout numbers. §6.4 adds the data model behind it.
- **Chapter 03** §3.9 / §3.10 (`03-menus-shortcuts.md`): every Preferences and Help-and-account item with its action id, check property and flags. This chapter adds storage, defaults and the dialogs behind the "…" items.
- **Chapter 07** §colour management: document colour profile, the change modal and the user display profile. Only the storage is added in §3.6.
- **Chapter 20**: the hardware-acceleration detector and the rendering debug toggles.

## 2. Where each setting lives — the four stores

Figma keeps settings in four places, each with its own scope. Knowing which store a setting uses tells you whether it follows the user to another computer.

| Store | Scope | Mechanism | Examples | Evidence |
|---|---|---|---|---|
| **Editor preferences** (C++ `EditorPreferences`) | Per browser profile / per desktop install. Shared by all tabs, all files and all accounts on that machine. | The C++ reads and writes `window.localStorage` through `CoreUtils_getLocalStorage` / `setLocalStorage`, using kebab-case keys | snapping, nudge, invert zoom, sticky tools, rulers, pixel preview, panel sizes | C: the glue `_CoreUtils_setLocalStorage(e,t)` → `window.localStorage[e]=t`; key strings `small-nudge-amount`, `big-nudge-amount`, `snap-to-pixel-grid`, `snap-to-geometry`, `snap-to-objects`, `render-annotations`, `render-rulers`, `render-redlines`, `render-grid`, `property-labels-visible`, `active-canvas-pixel-preview`, `show-sidebar`, `low-power`, `sidebar-split-position`, `pages-panel-height` … in the wasm. L: the desktop profile's Local Storage holds `render-redlines`, `active-canvas-pixel-preview`, `property-labels-visible`, `mouse-scroll-wheel-zoom`, `right-click-drag-to-pan`, `global-debug-theme-preference`. |
| **Web-side local preferences** (JS) | Per machine; broadcast live to the machine's other tabs (`sendToOtherTabs`) | localStorage keys plus an IPC key | theme, enhanced contrast, link underline, keyboard layout, scroll-wheel zoom, right-click pan, screen reader | C (see §3.5, §4, §5) |
| **The user record** (`/api/user`, Sinatra / LiveGraph `User`) | Per account; follows the user to every machine | `PUT /api/user {field}` | `locale`, `keyboard_layout`, `mouse_scroll_to_zoom`, `right_click_drag_to_pan`, `screenreader_enabled`, `use_numbers_for_opacity`, `color_profile`, `auto_open_in_desktop`, `utc_offset` | C: figma_app user schema, `"…keyboard_layout:e.drop(),locale:e.drop(),mfa_setup_token…mouse_scroll_to_zoom…"` |
| **Server `UserPreferences` / user flags** | Per account | LiveGraph `UserPreferences.preferences{…}`; user flags via `setUserFlag` | `auto_open_in_desktop`, `check_designs_show_violation_count`, `show_voice_call_transcripts` (closed captions); `disable_file_view_history`; `opted_in_email`; one-time nudges | C: `"preferences:{auto_open_in_desktop:…,check_designs_show_violation_count:…,show_voice_call_transcripts:m}"` |
| **Desktop state** (`main.js`) | Per desktop install | `~/Library/Application Support/Figma/settings.json` (`appData/Figma`), saved 5 s after a change via a temp file and rename | interface scale, hardware acceleration, menu-bar icon, haptics, theme / contrast mirror, windows and tabs | C: `yR=RE.join(uo,"settings.json")`; `af(){…setTimeout(()=>{tR()…},5*1e3)}` |

Some settings have **two layers**: a local value first, then the server value as a fallback. Scroll-wheel zoom, right-click pan and the screen reader work like this.

- At start the code reads localStorage. If the key is absent, it uses the user-record value. If both are absent, the default is `false`.
- It then writes the result back to the server when the two differ.
- Truthy stored values are `true`, `1`, `"1"` and `"true"`.
- C: `function v(e,t=!1){…l.x4.getItem(e)…null!==i?r=g(i):null!=a&&(r=a)…a!==r&&m(e,r)}`, `f=[!0,1,"1","true"]`.

The C++ preference keys are **not** always the camelCase property name turned into kebab-case. The Additional labels preference (`showPropertyLabels`) is stored as `property-labels-visible`. There is also a special case: if that key has never been written and the account was created before a cut-off date, the code turns the preference off. C: `getItem("property-labels-visible")!=null … showPropertyLabels.set(!1)`.

Keys only seem to be written once a value changes. The owner's profile holds no `snap-*` or `*nudge*` keys, although those key strings exist in the wasm. **I**: this suggests a missing key means the default.

## 3. Preferences submenu — storage, defaults, side effects

The list of items, their action ids and flags are in chapter 03 §3.9. The table below adds the C++ property behind each item, its default and its store.

"Live state" is the check mark in the owner's capture `live/menus/main-preferences.txt`. It is the owner's state, not necessarily a fresh install's. "Default" is CONFIRMED only where the code states it. Otherwise it is INFERRED from the live state plus the help centre, and marked I.

| Item (English, L) | C++ property / store key | Live state | Default | Store | Notes |
|---|---|---|---|---|---|
| Snap to geometry | `snapToGeometry` / `snap-to-geometry` | ✔ | on (I) | local (C++) | Toast `visual_bell.snap_to_geometry_enabled/_disabled` (C) |
| Snap to objects | `snapToObjects` / `snap-to-objects` | ✔ | on (I) | local | Toast `visual_bell.snap_to_objects_*` |
| Snap to pixel grid ⇧⌘' | `snapToPixelGrid` / `snap-to-pixel-grid` | ✔ | on (I) | local | Toast `visual_bell.snap_to_pixel_grid_*`. The shortcut depends on the keyboard layout (German ⇧⌘#, Norwegian ⇧⌘@ …; C, wasm keymap JSON). |
| (FigJam) Snap to dots | `snapToDotGrid` | — | — | local | Toast `visual_bell.snap_to_dot_grid_*` |
| Keep tool selected after use | `stickyTools` | — | off (I) | local | Hidden from Quick actions (`hideForQuickCommand`). |
| (Windows) Disable pinch-zoom fix | `disablePinchZoomFix` / `disable-pinch-zoom-fix` | — | off (I) | local | `platforms:["windows"]` |
| Highlight layers on hover | `layerHover` | ✔ | on (I) | local | |
| Rename duplicated layers | `copyRenaming` | ✔ | on (I) | local | |
| Show dimensions on objects | `renderAnnotations` / `render-annotations` | ✔ | on (I) | local | |
| Hide canvas UI during changes | `temporarilyHideViewportOverlay` / `temporarily-hide-viewport-overlay` | ✔ | on (I) | local | |
| Use smart quotes/symbols | `smartQuotes` | ✔ | on (I) | local | |
| Flip objects while resizing | `flipDuringResize` | ✔ | on (I) | local | |
| (Sites) Set constraints automatically | `setConstraintsAutomaticallyToggle` | — | — | local | |
| Keyboard zooms into selection | `keyboardZoomToSelection` | — | off (I) | local | |
| Invert zoom direction | `invertZoom` | — | off (I) | local | |
| Ctrl+click opens right click menus | `ctrlClickContextMenu` | — | off (I) | local | |
| Use number keys for opacity | `EditorState.useNumbersForOpacity` (not an EditorPreferences property) | ✔ | on (I) | **user record** `use_numbers_for_opacity` | The engine calls `saveUseNumbersForOpacityPreference(b)`, which dispatches a user update. C: `"saveUseNumbersForOpacityPreference(e){this._store.dispatch((0,rr.n8)({use_numbers_for_opacity:e}))}"` |
| Use old shortcuts for outlines | `useOldOutlineShortcuts` | — | off (I) | local | Swaps Outline mode between ⇧O and ⌘⇧O. The keymap entry is `"pref:use-old-outline-shortcuts"` (C, wasm JSON). |
| Use ⌘⌥↑/↓ to rotate layers | `enableRotationShortcuts` / `enable-rotation-shortcuts` | — | **off** (C: `ut(…enableRotationShortcuts,!1)`) | local | Also in the Accessibility dialog (§4) |
| Play audio notifications in AI chat | `aiSoundNotificationsEnabled` | ✔ | on (I) | local | |
| Open links in desktop app | — | ✔ | on when the desktop app is installed (I) | **server** `UserPreferences.auto_open_in_desktop` | Mac / Windows only |
| Show text suggestions | `wantsTextSuggestions` | ✔ | on (I) | local | AI gate. The nudge `fullscreen.text_suggestion_nudge_turn_off` offers to turn it off. |
| Show tool suggestions | `wantsSuggestedAiActions` | ✔ | on (I) | local | AI gate |
| Show Agents on canvas | `showChatOnCanvas` | ✔ | on (I) | local | The nudge `ai_assistant_canvas_entrypoint_preference_nudge` can turn it off. |
| Use scroll wheel zoom | `scrollWheelZoom` | — | **off** (C) | localStorage `mouse-scroll-wheel-zoom` and user `mouse_scroll_to_zoom` | Two-layer read (§2). Synced to other tabs. Logged as `navigation_preferences`. |
| Right-click and drag to pan | `rightClickPan` | ✔ | **off** (C) | localStorage `right-click-drag-to-pan` and user `right_click_drag_to_pan` | Same mechanism. Hidden in Figma Make and Figma Spec. The ✔ is the owner's choice. |
| Theme ▸ Light / Dark / System | — | — | **System** (C) | localStorage `global-debug-theme-preference` and desktop `themePreference` | §5 |
| Color profile… | — | — | `DEFAULT` (= sRGB) | user `color_profile` / `UserColorProfilePreference` (DEFAULT, SRGB, DISPLAY_P3) | Opens `user_color_profile_modal` (chapter 07) |
| Keyboard layout… | — | — | auto-detected | localStorage `keyboardLayoutPreference` and user `keyboard_layout` | Chapter 03 §keyboard layout |
| Accessibility settings… | — | — | — | — | §4 |
| Permissions and helpers… | — | — | — | — | Browser only (`!desktop`). Covers local-network access for the font helper and the desktop app (§8). |
| Nudge amount… | `smallNudgeAmount`, `bigNudgeAmount` | — | **1 / 10** (C) | local `small-nudge-amount`, `big-nudge-amount` | §3.1 |

Preferences that are kept but are **not** in this submenu (C, `EditorPreferences` getters plus their menu records):

- **View menu:**
  - Pixel grid `renderGrid`
  - Layout guides `showFrameGrids`
  - Rulers `renderRulers`, with the unit as px / in / cm (`renderRulerUnitAs*`)
  - Show slices `showSlices`
  - Pixel preview `activeCanvasPixelPreview`
  - Mask outlines `showMasks`
  - Frame outlines `showArtboardOutlines`
  - Additional labels `showPropertyLabels`, action `toggle-show-property-labels`
  - Minimize left navigation bar `leftNavigationBarMinimized`
  - Show/Hide UI `showSidebar`
  - Redlines `renderRedlines`
  - Print marks `renderPrintMarks`
- **Search-only actions** (Quick actions):
  - `toggle-pressure-sensitivity` (`enablePressureSensitivity`)
  - `toggle-pen-tool-avoid-single-handles`
  - `toggle-include-everything-in-tab-order` (`includeEverythingInTabOrder`, FigJam)
  - `toggle-text-input-shortcut-blocking`
  - `adapt-content-for-screenreaders`
  - `theme-enhanced-contrast-on` (synonyms: enhance, contrast, readability, mode, accessibility)
- **Remembered UI state:**
  - Panels: `sidebarSplitPosition`, `propertiesPanelSplitPosition`, `pagesPanelHeight`, `pagesPanelIsOpen`, `devHandoffInspectSplitPosition`, `timelineHeight`, `speakerNotesHeight`
  - Pickers and formats: `colorFormat`, `expandedFramePresetType`, `exportSelectionSettings`, `handoffOutputFormat`, `handoffPlatformTarget`, `defaultEmojiSkinTone`
  - Other: `spellCheckPreference`, `hideHelpWidget`, `customCursor`, `lowPower`, `metronomePixelDensity`, `similarIncludesMatching`, `autoUseDefaultMakeKits`, `enableCodegenMcpServer` (desktop: "toggle-enable-codegen-mcp-server")
- **Toggle toasts** (C, figma_app list `L`): pixel preview (`visual_bell.pixel_preview_enabled {scaling: "2x"|"1x"}`), render grid, snap to pixel grid, show masks, snap to dot grid, snap to geometry, snap to objects, layout guides (`show_frame_guides_visible/hidden`, plus a "hide" button variant).

### 3.1 Nudge amount… dialog (C, figma_app module `914527`, `NudgeAmountPicker`)

| Property | Value | Evidence |
|---|---|---|
| Opened by | `show-nudge-amount-picker`. The engine can also ask for it via `FigmaApp_showNudgeAmountPicker`. Flags: edit, design, sites, slides, cooper. | C |
| Kind | A draggable, non-modal window (header drag, `defaultPosition`) | C `defaultPosition:S` |
| Width | **180 px** | C `E=(0,u.GO)("180px")` |
| Initial position | x = `innerWidth/2 − 90`, y = `innerHeight/3` | C `new m.Mi(window.innerWidth/2-E/2,window.innerHeight/3)` |
| Title | `fullscreen.nudge.nudge_amount` ("Nudge amount", repo i18n) | C, repo |
| Row 1 | "Small nudge" (`fullscreen.nudge.small_nudge`). Input id `small-nudge-input`. Formatter min **0.1**, its own nudge 1 / ⇧ 10. | C `(0,h.S)({min:.1,nudge:1,bigNudge:10})` |
| Row 2 | "Big nudge" (`fullscreen.nudge.big_nudge`). Input id `big-nudge-input`. Min **1**, nudge 1 / 10. | C `{min:1,nudge:1,bigNudge:10}` |
| Commit | Each change writes `EditorPreferences.smallNudgeAmount` / `bigNudgeAmount` at once. There is no Save button. | C `.smallNudgeAmount.set(e)` |
| Close | **Enter** in either field, or the window's close button | C `e.keyCode===ENTER&&I()` |
| No max | No upper bound is set | C (formatter without max) |
| Defaults | small **1**, big **10** (`?? 1`, `?? 10` in the number-field base) | C |
| Who uses it | Arrow / ⇧Arrow on the canvas, every number field, the layout grid "size" default (= big nudge), comment pins, prototype scroll offsets | chapters 02, 09, 13, 16 |

### 3.2 Number keys for opacity

Covered in chapter 07 §opacity. The preference is the only Preferences item that lives in the **user record** (not localStorage), so it roams between machines. C.

### 3.3 Keyboard layout…

Covered in chapter 03 §keyboard layout. It is stored in localStorage `keyboardLayoutPreference` and, on a manual change, in `PUT /api/user {keyboard_preference, keyboard_preference_method:"manual"}`.

### 3.4 Spell check

`spellCheckPreference` is a C++ preference. When spell check is first activated, it starts enabled only if one of `navigator.languages` is `en*` or `ru*`. In the desktop app it is always enabled. C: `shouldEnableWhenFirstActivated(){…if(!(t.includes("en")||t.includes("ru")))return!1…}`.

### 3.5 Theme (C, figma_app theme module)

| Property | Value |
|---|---|
| Options | `light`, `dark`, `system` (array `C_:["light","dark","system"]`) |
| Default | `system`. Any stored value outside the three reads as `system`. |
| Resolution | `system` follows `matchMedia("(prefers-color-scheme: dark)")` live, via a change listener |
| Store (web) | localStorage **`global-debug-theme-preference`**. Other tabs are told through **`theme-update-ipc-key`**. |
| Store (desktop) | `settings.json → themePreference` (default `"system"`). It is pushed to the tab bar (`updateShellAppThemePreference`), and the web-view background colours follow. |
| Analytics | `theme_preference_updated {from, theme}` on a user-initiated change |
| Entry points | Preferences ▸ Theme; Settings › Account › Theme (a Select over the three); the account menu's Theme ›; Quick actions `theme-light-mode` / `-dark-mode` / `-system`, with `…-quick-command` labels "Use light mode" (I, from the key `fullscreen_actions.theme.use_light_mode`) |
| Not per account | The theme is per machine. Logging in elsewhere does not carry it. |

Per-editor brand theming (`data-editor-theme`: design, figjam, dev …) is separate from the light / dark choice. Dialogs carry `data-preferred-theme`, `data-editor-theme` and `data-enhanced-contrast`.

### 3.6 Colour profile

The user's display profile is a server record `UserColorProfilePreference {id, colorProfilePreference: DEFAULT|SRGB|DISPLAY_P3}`, mirrored into `user.color_profile`. DEFAULT and SRGB both render as sRGB. C: `case _.MU.DEFAULT:case _.MU.SRGB:return o.RY.SRGB`. The desktop app has its own View › Color Management › Color Space submenu (Managed / sRGB / Unmanaged, §7). The document profile is in chapter 07.

## 4. Accessibility

### 4.1 Accessibility settings… dialog (C, 3187 `ACCESSIBILITY_SETTINGS`)

A modal of width `md`, titled `fullscreen.accessibility_settings.dialog_title`. It holds switch rows, each a label plus a description, in this order:

| # | Row (i18n key) | Shown when | Store | Default |
|---|---|---|---|---|
| 1 | Screen reader: `enable_screenreader_label` / `enable_screenreader_description` | Editor type is FigJam, Buzz, Slides or **Design** | redux `screenreader.enabled`, scope `PERSISTENT`: localStorage plus user `screenreader_enabled` | off. On the desktop with the `screenReaderDetection` feature, the row is disabled and the note `enable_screenreader_description_desktop_auto` says it turns on automatically. Errors: `fullscreen.accessibility.platform_error`, `fullscreen.accessibility.dom_error`. |
| 2 | Underline links: `underline_links.heading` / `.description` | always | localStorage **`global-debug-link-underline-preference`** (`"true"`/`"false"`), IPC `on-link-underline-update-ipc-key`, desktop `underlineLinks` | **off**. It sets `data-underline-links` on `<body>`. Logged as `link_underline_preference_updated`. |
| 3 | Tab focuses Quick actions: `quick_action_menu.heading` / `.description` | always | a local atom (I: `C.yU`) | off (I). Logged as `QUICK_ACTIONS_MENU_TAB_FOCUS_ON/OFF`. |
| 4 | Enhanced contrast: `enhanced_contrast_label` / `_description` | always | localStorage **`global-debug-enhanced-contrast-preference`**, IPC `on-enhanced-contrast-update-ipc-key`, desktop `enhancedContrast` | **null (unset) → follows `matchMedia("(prefers-contrast: more)")` live**. Once the user sets it, the stored value wins. Logged as `enhanced_contrast_preference_updated`. |
| 5 | Text-input shortcut blocking: `text_input_shortcut_blocking_label` / `_description` | always | C++ `textInputShortcutBlocking` | **off** (C `ut(…textInputShortcutBlocking,!1)`). Action `toggle-text-input-shortcut-blocking`. |
| 6 | Rotation shortcuts: `rotation_shortcuts_label` / `_description` with `{shortcutUp: "⌘⌥↑" \| "Ctrl+Alt+↑", shortcutDown}` | always | C++ `enableRotationShortcuts` | **off** |
| 7 | Spotlight auto-follow: `collaboration.spotlight.auto_follow_label` / `_description` | always | jotai atom `T.X` | (not read) |

When the dialog closes in FigJam, focus returns to the canvas's custom focus element. C: `focusCustomCanvasFocusElement()`.

### 4.2 Other accessibility behaviour

- **Screen-reader DOM.** "Adapt content for screenreaders" (`adapt-content-for-screenreaders`, search-only, synonyms: screenreader, accessibility) builds an accessible DOM mirror of the canvas. Announcements use keys like `fullscreen.accessibility.chit_image`, `chit_gradient_linear` and `timeline_panel_hidden`. The engine has `accessibilityDomDebug` and `includeEverythingInTabOrder` (FigJam) preferences. C.
- **Reduced motion.**
  - With `prefers-reduced-motion: reduce`, animated viewport navigation (zoom to selection, go to a comment, page jumps) **jumps instantly**. Otherwise it animates for **200 ms** with a cubic ease-in-out, `t<.5 ? 4t³ : (t−1)(2t−2)(2t−2)+1`. C: `navigationDurationMs:200 … if(d.matches||…||0===n.duration) return this.updateViewport(…)`.
  - The engine is told about the media query (`updatePrefersReducedMotion`, live listener). C.
  - Sites pages have `ignoreReducedMotion` (Sites only).
- **Enhanced contrast in Settings.** Settings › Account › Theme repeats the switch: "Enhance contrast", "When enabled, contrast between text and controls and their backgrounds will be increased" (repo i18n). It is the same store as row 4.
- **Interface scale** (desktop only, §7) is the UI-zoom accessibility control. The browser uses its own page zoom.
- **Colour-vision options:** none exist as a user setting in this build. Colour-blind simulation exists only in plugins. I: no key or preference found for daltonism, protanopia or deuteranopia.
- **Focus rings:** the design system's `:focus-visible` outlines. There is no user toggle. I.
- **Contrast helper** for design work: `getWCAG2Contrast(fg, bg)` in the accessibility bindings. C.

## 5. Localisation

| Topic | Finding | Evidence |
|---|---|---|
| Shipped UI languages | `en`, `ja`, `fr`, `de`, `es-es`, `es-la`, `ko-kr`, `pt-br` (list `EO`, plus the dummy `du-ds`) | C module `610579` |
| In development | `nl-nl`, `pl-pl`, `it-it`, `hi-in`, `th-th`, `id-id` (list `cN`). Their dictionaries are loaded per locale (`y.F(o)`). Each is gated by a per-locale feature flag (`_.Pu(e)` → flag name, e.g. `i18n_du_ds`). | C |
| Pseudo-locales | `aaa` "AAA (Pseudolocale: Figma → AAA)" and `aal` "AAL (Pseudolocale: Figma → [~~Ḟįįğṃąą~~])". Offered when the build is internal or `i18n_pseudolocales` is on. | C |
| Picker display names | English · 日本語 · Français · Deutsch · Español (España) · Español (Latinoamérica) · 한국어 · Português (Brasil) · Nederlands · Polski · Italiano · हिन्दी · ไทย · Bahasa Indonesia | C `Xo` |
| Intl tags (for number and date formats) | en→`en`, ja→`ja`, fr→`fr-FR`, de→`de-DE`, es-es→`es-ES`, es-la→`es-419`, ko-kr→`ko`, pt-br→`pt-BR`, nl→`nl-NL` … pseudo→`en-US` | C `JL` |
| Help-centre locale | en→`en-us`, es-la→`es-419`, ko-kr→`ko` … | C `gL` |
| Where it is chosen | Settings › Account › Language (current name, plus a "Change language" link). Also from Help and from an announcement modal (`source`: "User Settings" / "Help" / "Announcement Modal"). | C |
| Dialog | `LanguageSelectorModal`, width `lg`. Title `settings.account_settings.change_languages`. A radio list with a legend (`settings.language_selector.modal.description`) and autofocus. Buttons Cancel / **Save** (`settings.language_selector.cancel` / `.save`). Both are disabled while saving. Restricted contexts (`b.sL()`) offer English only. | C |
| On Save | If the choice is unchanged, the dialog closes. Otherwise: (1) the cookie **`product_locale`** is set with max-age **31 536 000 s** (1 year), only for a known locale; (2) `PUT /api/user {locale}` (skipped when logged out); (3) **a full reload** ("User changed locale preference"). On error the toast is `help_widget.language_selector.an_error_occurred`. | C `141130`, `773110` |
| Initial locale | The server's `user.locale`. Logged-out users get the `product_locale` cookie or the browser language (I). The desktop shell uses the active tab's `locale`, else its own default (`fn.DEFAULT`). Its dictionaries are bundled (`app.asar/i18n/{de,es-es,es-la,fr,ja,ko-kr,pt-br}.json`, 328 keys each). | C main.js |
| Engine | The C++ asks `FigmaApp_getUserLocale` / `CurrentUserInfo_getUserLocale` | C |
| Numbers and dates | Through `Intl` with the tags above. Currency formatting knows jpy, usd, gbp, cad, eur (it uses `navigator.languages[0]`, else `en-US`). Arabic-Indic digits (U+0660–0669) are normalised in number fields before expressions are evaluated (`preProcessForExpressionEvaluation`). | C |
| RTL UI | None: no RTL locale ships, and the chrome has no `dir="rtl"` switch. RTL is supported only **in text content** (chapter 06). | I |
| Community URLs | Localised community paths per locale (`/es-la/comunidad`, `/pt-br/comunidade`, `/ko-kr/community` …) | C |

## 6. Account Settings modal (C, 3187 `ACCOUNT_SETTINGS_MODAL`)

- **Frame.** Width **650**, height `full` (fills the window height). The header shows "Settings" (`general.settings`) and a tab strip.
- **Tabs, in order:** **Account · Community · Notifications · Security** (`settings.account_setting.{account, community, notifications, security}`). Community is hidden in restricted contexts (I: `!(0,I.SI)()`, the same gate that hides Security's password and SMS rows).
- **Opening options.** The modal can open on a given tab and scroll to a section (`{tab, section}`). Font settings use this to land on "Your uploaded fonts".
- **Sub-views.** A back button replaces the header with a sub-view title: Purchases (`settings.account_setting.purchases`) or "Inactive" (`.inactive`).
- **Weave.** When opened from Weave, it uses the Weave brand.
- **Openers:** Help and account › Account settings (`open-account-settings`), the file browser's account menu › Settings, and Open font settings (browser only).

### 6.1 Account tab — rows in order (C, `rk`)

1. **Avatar header** (`eu` with avatar type ACCOUNT): the photo and Edit (R17).
2. **Name.** `name_section_header` · the value · link "Change name" (`change_name_link`). The dialog is `change_name_modal_title` with a placeholder. Errors: `change_name_required`, `change_name_too_long`.
3. **Email.** `email_section_header` · value · link "Change email". The link is hidden for SSO accounts, which show instead "Managed by Google" (`managed_by_google`) or `managed_by_your_organization_email` (SAML).
   - The change-email dialog has a context line, plus extra lines for edu and org accounts. It warns that 2FA is required (`change_email_mfa_required_warning.title/description`) and asks for the current password (`change_email_confirm_password_placeholder`).
4. **Job title.** `job_title_section_header`. With a value: the value plus "Change job title". Without: a warning icon, `job_title_missing` and "Add job title".
5. **Upgrade block.** `upgrade_figma_plan_header` / `_reason` / "View plans". Shown only when the user is not SSO, has no org, no team has a subscription, and the current team is Starter with permission.
6. **Plan sections** (`rx`): "Your spaces" (`user_settings.plan_sections.your_spaces`).
   - One row per space with its role (Guest / Member / Admin) and seat: Full (`EXPERT`), Dev (`DEVELOPER`), Collab (`COLLABORATOR`) or View. Pending seat requests and provisional-access texts appear per seat.
   - Also "What products are used" with a link to figma.com/pricing, "See all", "Leave". The leave-org confirm is 400 wide and destructive.
   - "Use a verified work email address to become a full member".
7. **Language.** The current language name and "Change language" (§5).
8. **Theme.** A Select (Light / Dark / System) plus the **Enhance contrast** switch and its description (§3.5, §4).
9. **New features.** `new_features` › "Closed captions" with a **Beta** badge.
   - Where available: the switch "Enable closed captioning when using audio" (`enable_closed_captioning_when_using_audio`), stored in `UserPreferences.show_voice_call_transcripts` and logged as `voice_captions_toggle`.
   - Otherwise, in the browser: "learn more about captioning … here".
10. **Fonts** (`i8`, **browser only**: hidden in the desktop app, `!tT.eD`). Its states:
    - Agent running: "Local fonts are enabled, you have {localFontCount} fonts available in Figma", plus an uninstall note linking to help article 19764441960599.
    - Mobile or a non-Mac/Windows OS: "not supported for this operating system".
    - Local-network-access prompt pending or denied: `local_fonts_lna_message` with a grant or "how to connect" button.
    - Otherwise: `local_fonts_not_enabled_message` plus the primary button `local_fonts_cta` (downloads the installer).
11. **Your uploaded fonts** (`UserUploadedFontsSection`).
    - Shows the fonts listed under `sharedFonts.fontsByResourceId["user-<id>"]`, sorted by family and then style, plus collisions.
    - Has an upload button with an acknowledgement checkbox, "No fonts yet", and Remove / Delete family with a confirmation.
12. **Library.** `library_section_header`: "…enable libraries for all files in your drafts" with a link that opens the library modal (entry point `ACCOUNT_SETTINGS_ENABLE_LIBRARIES_LINK`).
13. **View history.** Shown only for users in a Student-plus plan context (`inStudentPlusPlan`; I: the gate is wider than the name suggests).
    - Text: "enabled" or "disabled" description, with **Off** in bold and Learn more linking to help article 29638316371479. Link "Change preference".
    - The modal `file_view_history_modal` has enabled / disabled options, Cancel / Save, and the note "change only applies moving forward".
    - Stored as the user flag `disable_file_view_history`.
14. **Account › Delete account.** A destructive link. It is shown only when the email's domain is **not** captured by one of the user's orgs.
    - The flow (`delete_user_account.*`) first requires a verified email ("You must verify your email…", resend link).
    - It then lists what is affected: libraries are unpublished, files become view-only or ownerless, you lose access.
    - Confirmation: type **"delete my account"** into a field (`to_confirm_please_type_strong_delete_my_account_strong_below`), then the button "Delete my account". A progress state follows (`account_deletion_is_in_progress`).
    - A password re-entry modal may come first (`require_password.*`: "For security purposes, please re-enter your password below", Continue, Forgot password).

### 6.2 Community tab

Handle, profile, connections and notifications (R17 §3). The tab is a separate component (`th`). It also carries the Community email toggles (`fig_feed.*`, `product_tips_and_news`). (I: the key set found near it.)

### 6.3 Security tab (C, `ir`) — four blocks in order

1. **Password and 2FA** (`ia`).
   - "Password" + "Change password". Hidden for Google / SAML SSO and in restricted contexts.
   - The change-password dialog (width `md`) has current / new / confirm fields. A client-side mismatch error reads "Please retype your new password, they don't match" (`api_user.error.please_retype_your_new_password_they_don_t_match`). Also "Forgot password" and Submit.
   - Without 2FA: the link "Enable two-factor authentication".
   - With 2FA: the header "Two-factor authentication is enabled" and, as present:
     - "Authenticator apps are enabled" + "Disable authenticator app". This is disabled with a tooltip when the org requires MFA and no phone is set.
     - "Connected cell phone number {phoneNumber}" + "Configure SMS".
     - "Connect authenticator app".
     - "Connect cell phone number" (not in restricted contexts).
     - "Show recovery codes".
2. **Sessions** (`is`, `GET` sessions).
   - Title and description `sessions.header.*`.
   - Columns: Location / IP, OS / Browser, Accessed / Created, Manage.
   - The current session sorts first and is labelled `sessions.session.current_session`. Other rows have "Revoke session".
   - Toasts `sessions.bell.success` / `.fail`. Null placeholders for location and IP. Errors: logged-out, no sessions.
3. **Personal access tokens** (`ie`).
   - `tokens.settings.developer_tokens_title` / `_description`, button "Generate new token". Rows show last used / never used, expires / never expires, and "Revoke access" (`token_was_revoked`, `token_will_be_revoked`, `remove_revoked`).
   - The generate modal:
     - Description; name field (autofocus).
     - **Expiration** Select over **1, 7, 30, 90 days** (`expiration_option {numDays}`), default **1 day**. Some emails get 1 day only (`np.fT(email)`, I: internal staff). The description shows the expiry date.
     - Scopes header plus one checkbox per scope with its description.
     - The scope list depends on context: org-only and enterprise-only scopes, Code Connect when `code_connect_on_pro`, file variables when the flag is on.
   - After creation, "Copy token" and the reminder `new_token_reminder`.
4. **Connected apps** (`it`). `connected_apps_title` / `_description`, "connected {time} ago", "Revoke access", empty state `no_connected_apps`.

### 6.4 Notifications tab (C, `t7`; live wording in R16 §4)

The tab is built from **channel blocks**, each a `t5` with a channel type and a CSV list of policy types:

| Block | Shown when | Channel | Policy types |
|---|---|---|---|
| Browser notifications | Push is supported. If permission is `prompt`, only the link "Enable browser notifications" shows, and it calls `requestPushNotifications(SETTINGS)`. | `browser_push` | `FileCommentMentionsAndReplies`, `InvitesAndRequestsActions` (+ `AssistantActivity`, `MakeCompletion` behind flags) |
| Desktop notifications | Desktop app only | `desktop_push` | `FileComments` (+ the same flags) |
| Email notifications | always; info line "You'll still get emails from Figma about your account" | `email` | `FileComments`, `InvitesAndRequests`, `CommunityComments`, `CommunityWeeklySummary` (+ `TeamFeed`, `FeedWeeklyDigest`, `WorkspaceActivity`, `UserGroups` when relevant) |
| Feed block (`tK`) | Team feed enabled | — | — |
| Product tips and news | always | user `opted_in_email` | a single checkbox |

Each block has a master checkbox ("Send me … notifications"). The policy rows (radios or checkboxes) are disabled while the master is off. The footer has the unsubscribe disclaimer and a Privacy Policy link to `https://figma.com/privacy`. Errors: `error_loading_settings`, `error_changing_setting`.

## 7. Desktop-app-only settings (C, `app.asar` `main.js`)

Desktop state is stored in `~/Library/Application Support/Figma/settings.json`. Defaults (`YKe`):

| Key | Default | UI | Notes |
|---|---|---|---|
| `zoomStop` | **100** | View › Interface Scale ▸ "{n}%" (disabled label) · Reset to Default ⇧⌘⌥0 · Make Larger ⇧⌘⌥= · Make Smaller ⇧⌘⌥- | Stops **25, 33, 50, 66, 80, 90, 100, 110, 120, 130, 140, 150, 175, 200, 250, 300, 400, 500** %. Applied as Electron `zoomFactor = zoomStop/100` to every web view, popout and overlay. Overlay geometry is divided by it. |
| `showFigmaInMenuBar` | **true** | App menu › Preferences › "Show Figma in Menu Bar" (mac) / "Show Figma in System Tray" (win) | Creates or destroys the tray (the notifications feed window) |
| `macHaptics` | **true** | "Enable Trackpad Haptic Feedback" | macOS |
| `disableHardwareAcceleration` | **false** | Help › Troubleshooting › "Disable Hardware Acceleration" (checkbox) | Asks first: "Restart required", Restart / Cancel. Then **relaunches**. At launch it also always adds `ignore-gpu-blocklist` and `disableDomainBlockingFor3DAPIs`. |
| `preferHighPerformanceGPU` | **null** (follows the flag `desktop_default_hp_gpu_setting`) | Troubleshooting › "Prefer High-Performance GPU" (**Windows only**, `visible:!mac`) | The same restart dialog. Sets `force-high-performance-gpu`. |
| Graphics backend | Default (session only, not saved) | Troubleshooting › Graphics Backend ▸ Default / WebGL1 / WebGL2 / WebGPU (radio) | Adds `force-webgl1` / `force-webgl2` / `force-webgpu` to tab URLs, then **Reload All Tabs** |
| `showTabsInFullScreen` | false | View › "Always Show Tabs When Presenting" | |
| Colour space | Managed | View › Color Management › Color Space ▸ Managed / sRGB / Unmanaged | P3-capable displays only (`isP3ColorSpaceCapable`) |
| `themePreference` / `enhancedContrast` / `underlineLinks` | `"system"` / false / false | Mirrors the web values for the tab bar | |
| `locale` | `fn.DEFAULT` | — | §5 |
| `disableNetworkConnection` | false | (debug) | Cuts the web views' network |
| `lastOpenWindow`, `sharedTabHistory`, windows and tabs | — | — | **Tabs restore**: the last window's bounds, Home path and tabs are saved and reopened at launch (`$Ke` → `JKe`); then `lastOpenWindow` is cleared. There is no user toggle for this. |
| `minUpdateStage`, `clientID`, `featureFlags`, `experiments`, `navigationConfig`, MCP directories | — | — | internal |

- **Open at login:** none for Figma itself. Only the Figma Agent registry has a login item (`removeAgentRegistryLoginItem`). C.
- **Developer override file.** `~/figma_desktop_settings.json` (or the dotted `~/.figma_desktop_settings.json`; per channel: beta, gov, sycamore …) can set:
  - `appURL`
  - `allowedOrigins` (wildcards)
  - `stagingCommitSha`, `stagingAdditionalFFs`, `isCanary`, `stagingFigcodeSha`
  - `figdevStagingMode` (`localhost` | `coder`), `figdevStagingCoderUrl`

  Developer menus appear when `FIGMA_SHOW_DEV_MENU` is set or in non-external builds. C.
- **Troubleshooting menu** (English, C):
  - Save Debug Info…
  - Save Network Log…: "You'll get a prompt after 30 seconds to save the network log file."
  - Save Performance Log… / Stop Performance Logging…
  - Restart and Save Performance Log…: the logs are saved to the chosen file after 30 s.
  - Disable Hardware Acceleration
  - Prefer High-Performance GPU
  - Graphics Backend
  - Reload All Tabs
  - Reset Figma and Restart: "{appName} app data will reset and the app will restart. You will need to log back into {appName} after this is done." Failure: "{appName} Reset Failed".
  - Open Test WebSocket Page (flag `desktop_show_connection_test`)
  - Debug Figma Agent (flag `desktop_agent_debug`)
- **Updates:** Check for Updates… → "No Update Available" (with "Reload All Tabs") or "Update Available": "Install now" / "Install on next launch".

## 8. Fonts: local font agent

The full routes are in `docs/research/figma/R11-fonts.md`. This section adds what the build shows.

- **Endpoint choice.** Chromium and Edge with WebAssembly, or Firefox 56 and later, use **`http://127.0.0.1:44950`**. Other browsers use **`https://figmadaemon.com:44960`** (a DNS name resolving to localhost, I). Paths must start with `/` and are prefixed `/figma`. Retries are 0. C: `"http://127.0.0.1:44950":"https://figmadaemon.com:44960"`.
- **Desktop app.** The desktop app ships its own agent (`FigmaAgent.app` in Application Support) and parses fonts itself (`desktop.shell_app.parsed_fonts`). For that reason the Fonts section is hidden in the desktop app's Settings (§6.1 row 10).
- **Browser permission.** Chrome's local-network-access permission state (`prompt` / `denied`) drives the Fonts section and the "Permissions and helpers…" dialog (`autoExpandLocalNetworkAccessConnectionSteps`).
- **Font picker.** It shows `localFontAgentVersion`. The picker's scroll container is 160 px high in the compact variant (C, `scrollContainerHeight:160`).

## 9. Hidden and debug settings

- **C++ debug preferences** (reachable from search-only actions, mostly behind `internal_only_debug_tools`):
  - `toggleDisplayCpuTimerTree`, `toggleDisplayDirtyRects`, `toggleDisplayDirtyTiles`, `toggleDisplayExpensiveTiles`, `toggleDisplayGpuMetrics`, `toggleDisplayMetronomeTextureCache`, `toggleDisplayNodeOccluders`, `toggleDisplayPixelHeatMap`
  - `togglePerfModeMedium`, `toggleSimilarHighlights`, `toggleCollaborativeTextDebugLogging`, `toggleResponsiveSetAutoFocus`
  - `showGuids`, `showVectorNetworkLabels`, `showTextOnPathDebugOutlines`, `showAllSnapTargetCandidates`, `showQuickCommandRankDebug`, `showSemanticTagsOnLayerRows`
  - `stackInsertionDebugMode`, `fplDebug`, `pluginApiDebug`, `canvasSearchDebug`, `accessibilityDomDebug`, `recolorDebugAction`, `dontMergeStrokeOutlines` ("debug-toggle-dont-merge-stroke-outlines"), `cursorHighFiveWiggle`, `disableWhiteboardPdfImportNodeReplacement`
- **Development / staging clusters only:** a "set-commit-sha" action. The JIT toggle `toggle-disable-jit-dst` is behind the flag `eclipse`.
- **`global-debug-*` localStorage keys** hold the user-facing theme, contrast and link-underline choices, despite the "debug" in their names.
- **ResetUserFlagsModal** (internal): resets one-time user flags.

## 10. UI strings

English is given where it is attested. Sources: L = live capture, R = repo i18n (`src/shared/i18n/tr`), D = desktop `main.js` inline English, R17/R16 = help-centre research. Other entries are i18n keys only.

- **Preferences menu (L):** Snap to geometry · Snap to objects · Snap to pixel grid ⇧⌘′ · Keep tool selected after use · Highlight layers on hover · Rename duplicated layers · Show dimensions on objects · Hide canvas UI during changes · Use smart quotes/symbols · Flip objects while resizing · Keyboard zooms into selection · Invert zoom direction · Ctrl+click opens right click menus · Use number keys for opacity · Use old shortcuts for outlines · Use ⌘⌥↑/↓ to rotate layers · Play audio notifications in AI chat · Open links in desktop app · Show text suggestions · Show tool suggestions · Show Agents on canvas · Use scroll wheel zoom · Right-click and drag to pan · Theme · Color profile… · Keyboard layout… · Accessibility settings… · Permissions and helpers… · Nudge amount…
- **Help and account (L):** Help page · Keyboard shortcuts ⌃⇧? · Support forum · Video tutorials · Release notes · Open font settings · Legal summary · Account settings · Log out
- **Nudge (R):** "Nudge amount", "Small nudge", "Big nudge" (`fullscreen.nudge.{nudge_amount, small_nudge, big_nudge}`)
- **Toasts (keys):** `visual_bell.{pixel_preview_enabled, pixel_preview_disabled, render_grid_visible, render_grid_hidden, snap_to_pixel_grid_enabled, snap_to_pixel_grid_disabled, show_masks_visible, show_masks_hidden, snap_to_dot_grid_enabled, snap_to_dot_grid_disabled, snap_to_geometry_enabled, snap_to_geometry_disabled, snap_to_objects_enabled, snap_to_objects_disabled, show_frame_guides_visible, show_frame_guides_hidden, show_frame_grids_hide_button}`
- **Accessibility dialog (keys):** `fullscreen.accessibility_settings.{dialog_title, enable_screenreader_label, enable_screenreader_description, enable_screenreader_description_desktop_auto, underline_links.heading, underline_links.description, quick_action_menu.heading, quick_action_menu.description, enhanced_contrast_label, enhanced_contrast_description, text_input_shortcut_blocking_label, text_input_shortcut_blocking_description, rotation_shortcuts_label, rotation_shortcuts_description}`, `fullscreen.accessibility.{platform_error, dom_error}`, `collaboration.spotlight.auto_follow_{label, description}`. Menu: "Accessibility settings…" (L/R).
- **Settings modal:** tabs Account / Community / Notifications / Security (R17). Account: "Enhance contrast", "When enabled, contrast between text and controls and their backgrounds will be increased", "Closed captions", "Beta", "Your uploaded fonts", "View history", "Delete account" (R). Keys: `settings.account_settings.{name_section_header, change_name_link, email_section_header, change_email_link, managed_by_google, managed_by_your_organization_email, job_title_section_header, change_job_title_link, job_title_missing, add_job_title, upgrade_figma_plan_header, upgrade_figma_plan_reason, view_plans, language, change_languages, theme_section_header, new_features, closed_captions, enable_closed_captioning_when_using_audio, learn_more_about_captioning, fonts, local_fonts_*, uploaded_fonts.*, library_section_header, enable_libraries_for_drafts(_clickable), file_view_history(.*), account_section_header, delete_account, password_section_header, change_password_link, leave, more_info_button_label}`; `settings.account_setting.{account, community, notifications, security, purchases, inactive, change_password_*, change_email_*, forgot_password, submit_button}`; `settings.delete_user_account.*`; `settings.require_password.*`; `settings.language_selector.{modal.description, cancel, save}`.
- **Security (keys):** `auth.two-factor-setup.{enable_two_factor_authentication, two_factor_authentication_is_enabled, authenticator_apps_are_enabled, disable-authenticator-app, disable-two-factor-blocked, connected_cell_phone_number_tfa_phone_number, configure-sms, connect_authenticator_app, connect_cell_phone_number, show_recovery_codes}`, `sessions.*`, `tokens.settings.*` ("Generate new token", "Revoke access", R).
- **Notifications (R16 verbatim; keys):** `notification_settings_modal.{browser_notifications, browser_notifications.enable, desktop_notifications, email_notifications, send_me_browser_push_notifications, send_me_desktop_push_notifications, send_me_notifications_by_email, product_tips_and_news, send_me_occasional_emails_with_updates_and_promotions, unsubscribe_from_figma_emails_disclaimer, privacy_policy, error_loading_settings, error_changing_setting}`.
- **Languages (C, endonyms):** English, 日本語, Français, Deutsch, Español (España), Español (Latinoamérica), 한국어, Português (Brasil).
- **Desktop (D):** Interface Scale · {n}% · Reset to Default · Make Larger · Make Smaller · Show Figma in Menu Bar / Show Figma in System Tray · Enable Trackpad Haptic Feedback · Always Show Tabs When Presenting · Color Management › Color Space › Managed / sRGB / Unmanaged · Troubleshooting › Save Debug Info…, Save Network Log…, Save Performance Log…, Stop Performance Logging…, Restart and Save Performance Log…, Disable Hardware Acceleration, Prefer High-Performance GPU, Graphics Backend › Default / WebGL1 / WebGL2 / WebGPU, Reload All Tabs, Reset Figma and Restart, Debug Figma Agent · "Reset {appName} and Restart?" · "Saving a network log" · "Update Available" / "Install now" / "Install on next launch" · "No Update Available".

## 11. DesignerV2 today

The comparison is against `src/renderer/src/editor/preferences.ts`, `menus.ts`, `commands.ts`, `canvas/CanvasTools.tsx`, `src/renderer/src/settings/*`, `src/main/locale.ts`, `src/main/menu.ts` and `src/renderer/src/ds/theme.ts`.

**Matches**
- The Preferences submenu has Figma's items in Figma's order, with live checks as defaults (`PREFERENCES`), and they are kept per machine in localStorage. This matches Figma's per-machine scope for the C++ preferences.
- Nudge amount dialog with Small nudge / Big nudge. Keyboard layout… opens the shortcuts panel's Layout tab.
- The Settings modal has Account / Notifications / Security plus our own tabs. The Account tab has Name / Email / Language / Theme with Enhance contrast / Closed captions (Beta) / Your uploaded fonts / Library / View history / Delete account.
- Theme light / dark / system follows `prefers-color-scheme`.
- Locale is kept in main's settings.json and pushed to every view (Figma reloads instead).
- Trackpad haptics on macOS.

**Differs**
- Storage granularity. Ours is one JSON blob, `designer.preferences`. Figma uses one key per preference (`snap-to-pixel-grid` …), plus three that roam with the account: number keys for opacity, scroll-wheel zoom and right-click pan go to the user record. Ours never roam.
- `rightDragPan` defaults **on** in ours, copied from the owner's live state. Figma's code default is **off**. "Open links in desktop app" is server-stored in Figma.
- Nudge dialog. Ours has an apply flow. Figma writes on every change, closes on Enter, is 180 px wide at (centre, 1/3 height), has small min 0.1 and big min 1, and no max.
- Enhanced contrast. Figma's default is **unset → follows `prefers-contrast: more`**. Ours does not read `prefers-contrast`.
- Settings modal height. The width matches (650 in both; ours is `--ds-size-settings-modal: 650px`). Figma's height is `full` (the window's height), while ours is fixed at `--ds-size-settings-modal-height: 730px`.
- Language. Figma ships 8 languages and reloads on Save, with a `product_locale` cookie. Ours ships en and tr and switches live. This is intentional: tr is not a Figma locale.

**Missing**
- The **Accessibility settings…** dialog (`later(...)` in `commands.ts`):
  - screen-reader DOM, underline links, Tab-to-Quick-actions, text-input shortcut blocking, rotation shortcuts and spotlight auto-follow;
  - the `data-underline-links` body attribute;
  - **reduced motion** for viewport navigation (Figma jumps instead of its 200 ms cubic in-out).
- **Color profile…** (user display profile, `later`).
- Desktop **Interface Scale** (stops 25–500 %, ⇧⌘⌥0/=/-).
- Troubleshooting (Disable Hardware Acceleration with relaunch, Graphics Backend, Save logs, Reset and Restart).
- "Show in Menu Bar" toggle.
- "Always Show Tabs When Presenting".
- Security tab parity: the sessions table columns, token expirations 1 / 7 / 30 / 90 days with default 1, the 2FA rows.
- Spell-check first-activation rule (en / ru only).
- Toggle toasts for the snapping and view preferences.

**As built (2026-10-18, wave 8)** — branch `worktree-agent-acb68332c8af21571`, the "settings and accessibility" branch.

- **Where each preference lives** (`editor/preferences.ts`): still one blob per machine (`designer.preferences`), now versioned (`v: 2`) and written one key at a time. Use number keys for opacity, Use scroll wheel zoom, Right-click and drag to pan and the screen reader also go with the account (`AccountPrefs.numberKeysOpacity / scrollWheelZoom / rightDragPan / screenReader`; the server keeps them, `server/src/account.ts`): Figma's two layers at each editor start (this machine's value, else the account's, else the default; the account told when it differs — number keys for opacity is the account's alone once it has one), and each change of one of them sent at once. Other tabs follow a change through the `storage` event (Figma's `sendToOtherTabs`).
- **Right-click and drag to pan** defaults **off** (Figma's code). **Data safety:** a version-1 store, or (without a store) a machine where the app ran before (another `designer.` / `designer-` key; not the browser build's `designer.devStore.*`), has it written down as **on**, the old default, so nobody's canvas changes; values a store already holds are never rewritten.
- **Accessibility settings…** (`editor/AccessibilityDialog.tsx`): Figma's seven switches in its order — Screen reader (kept and roaming; the canvas's accessible DOM mirror isn't built), Underline links (`data-underline-links` on every view's `<body>`, kept in settings.json `underlineLinks` / localStorage `designer-underline-links`, every view told like the theme; `global.css` underlines `a[href]`, `[role=link]`, link Buttons and Settings' links), Actions menu focus (Tab / ⇧Tab go through the Actions results as ↓ / ↑, the focus staying in the search field), Enhanced contrast (Settings' switch), Shortcuts in text fields (the menu bar's accelerators and ⇧⌘U are dropped while text is edited on the canvas; DOM fields dropped them already), Rotation shortcuts (= Preferences' "Use ⌘⌥↑/↓ to rotate layers"; Ctrl+Alt on Windows), Follow spotlight automatically (kept for Phase 6). The labels are ours from the keys; the descriptions are help.figma.com's (35063862380311), Settings' and the Preferences item's.
- **Enhanced contrast** unset follows the system (`prefers-contrast: more` in a browser and boot.js, `nativeTheme.shouldUseHighContrastColors` in main); once set it is kept, off too (`"off"` / `contrast: false`). **Data safety:** a kept "on" stays on; an absent value, which meant off before, now follows the system (Figma's default).
- **Reduced motion:** a Layers row's camera glide jumps (`ds/util/motion.ts glideMs`); the fade / reveal durations go to 0 with the fast / medium ones; the comment pin's grow, the libraries' skeleton pulse, the colour picker's and the timeline chevron's transitions stop; the new-tab page scrolls without smoothing. Spinners keep turning (slower, as before); the easing editor's preview keeps playing (it is the content).
- **Nudge amount…** (`canvas/CanvasTools.tsx`): Figma's draggable window, 180 wide (`--ds-size-nudge-window`) at (window width / 2 − 90, height / 3); Small nudge min 0.1, Big nudge min 1, no max, ↑↓ by 1 (⇧ 10), each committed value kept at once (no Save), Enter closes. Kept values below the new minimums (possible before) are still read as they are.
- **Desktop:** View › Interface Scale ▸ "{n}%", Reset to Default ⇧⌘⌥0, Make Larger ⇧⌘⌥=, Make Smaller ⇧⌘⌥- over Figma's 18 stops (`src/shared/interfaceScale.ts`, `src/main/interfaceScale.ts`; settings.json `zoomStop`, absent = 100): every web view's zoom factor — the tab bar too, its height and the traffic lights / caption buttons following, native menus placed at scaled coordinates. Help › Troubleshooting ▸ Disable Hardware Acceleration (checked from settings.json, "Restart required" → Restart relaunches through the usual flushed quit; `app.disableHardwareAcceleration()` before ready), Graphics Backend ▸ Default / WebGL2 / WebGPU (session only; file tabs reload with `?force-webgl2=1` / `?force-webgpu=1`, new ones open with it), Reload All Tabs (each tab flushed first) — `src/main/troubleshooting.ts`. settings.json is read through `sanitizeSettings` (unknown or invalid values left out; everything an older file holds kept).
- **Security:** Generate new token's expiration defaults to **1 day** (was 30).

**Not done:** the screen-reader DOM mirror and its announcements; ⌘⌥↑/↓ rotation itself (its step is unknown, chapter 04 open question 7); spotlight (multiplayer); Color profile… (the user's display profile); per-key localStorage names (Figma's kebab keys are only partly known, §12 #3); Save Debug Info / Network Log / Performance Log; Reset and Restart (left out on purpose: the app's local data holds the workspace's files, unlike Figma's); Prefer High-Performance GPU (Windows); WebGL1 (no such renderer path); Show in Menu Bar (no tray); Always Show Tabs When Presenting; the sessions table's columns and the 2FA rows; the spell-check first-activation rule (Figma applies it in the browser only, where this app has no spell checker); the Settings modal's height (`full` in the build, 730 in the owner's captures — kept); the spare editor view keeps the graphics backend it was made with until it is used.

**Sweep (2026-10-18)** — branch `worktree-agent-a44e0af86efbcac0b`.

- **The screen-reader DOM mirror, its basics** (`editor/canvas/ScreenReaderMirror.tsx`): with Screen reader on, a visually hidden `role="tree"` of the page's layers (top-level ones and their children, 500 at most) named and kinded as the Layers panel reads them, the selected ones `aria-selected`, Enter / Space / a click selecting one, and a polite live region saying the selection ("{name}, {kind}, selected", "{n} layers selected", "Nothing selected" — ours; Figma's `chit_*` announcements have no English in the build). It stays with the UI hidden.
- **Help › Troubleshooting's logs** (`src/main/diagnostics.ts`): **Save Debug Info…** (the app, the system, the GPU, the processes' memory, each window's tabs counted by kind and state — no file's name — and settings.json without the shortcuts; ours in content), **Save Network Log…** (Chromium's net log of every view for 30 s with Figma's "You'll get a prompt after 30 seconds to save the network log file.", then the save prompt), **Save Performance Log…** / **Stop Performance Logging…** (a Chromium trace of the timeline, V8, Blink, cc and GPU categories). Each file goes only where it is saved.

**Still not done:** Restart and Save Performance Log…; the mirror's deeper levels, its focus moving with the canvas and Figma's announcements; the rest of the list above (rotation itself, spotlight, Color profile…, per-key storage, Reset and Restart on purpose, Windows-only items, tray, tabs while presenting, Security tab rows).

**New open questions** (live Figma probe): (9) the English labels and descriptions of the Accessibility dialog's rows (the help centre has five of the descriptions only) and its layout; (10) spotlight auto-follow's default; (11) what "Tab focuses Quick actions" does exactly (ours: Tab / ⇧Tab move through the results); (12) whether the Nudge amount window closes on a click outside it (ours does, as every popover); (13) whether Interface Scale scales Figma's tab bar (ours does).

## 12. Open questions

| # | Question | Live probe that settles it |
|---|---|---|
| 1 | Fresh-install defaults of the boolean C++ preferences (sticky tools, hover highlight, smart quotes, flip while resizing, hide canvas UI …). The C++ default initialisers were not decoded. | Fresh browser profile, logged-in test account: open Preferences and record the checks. Or, in DevTools, `localStorage.clear()` on figma.com, reload, and read the menu. |
| 2 | Does a key appear in localStorage only after a change? (The `snap-*` keys are absent in the owner's profile.) | Toggle Snap to objects twice and watch `localStorage` in DevTools for `snap-to-objects`. Check its value format (`"true"` / `"1"`?). |
| 3 | The exact stored key for each C++ property whose kebab form is not in the wasm (`sticky-tools`, `layer-hover`, `invert-zoom`, `copy-renaming` …); they may be suffix-merged strings | The same DevTools probe after toggling each item |
| 4 | English text of the Accessibility dialog rows and the Nudge dialog (keys only in the build) | Open both dialogs in the desktop app and capture them (`live/menus`-style dump) |
| 5 | The Community tab's full row list, and whether it is hidden for org members | Settings › Community on a personal account and on an org account |
| 6 | The gate behind View history (`inStudentPlusPlan` sounds narrower than it behaves) | Open Settings › Account on Starter, Professional and Education accounts |
| 7 | Screen-reader "auto" on desktop (`screenReaderDetection`): when does it switch on? | Turn on VoiceOver with the desktop app open and watch the Accessibility dialog row |
| 8 | Interface Scale keyboard shortcut on Windows and its persistence across restarts | Change the scale, quit, relaunch, and read `settings.json → zoomStop` |
