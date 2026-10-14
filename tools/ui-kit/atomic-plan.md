# Wecra UI — atomic restructure plan (2026-10-15)

The file was built per capture: one variant per Gallery cell and per distinct screen occurrence ("State=screen 6"),
so the same control exists many times (Button 44 variants, IconButton 11, ToggleIconButton 6, ToolButton 7,
MenuButton 23, HelpButton 1 …) and buttons inside menus, popovers and the colour picker are plain frames. The
target: one component per atom covering every condition, content through component properties, molecules and
organisms made of instances, variables in tiers. The file leads; `token-map.json` tells the code how its tokens
map.

## Inventory → target (current sets, 63)

| Level | Target set | Variant properties | Content properties | Replaces |
| --- | --- | --- | --- | --- |
| Atom | **Icon / name** (135) | Set = Figma · Wecra, Style = Default · Outline | — | (done) |
| Atom | **Button** | Variant = Primary · Secondary · Destructive · Destructive secondary · Ghost · Ghost secondary · Link · Tinted; Size = Default · Large; State = Default · Hover · Pressed · Focused · Selected · Disabled; Icon only = False · True | Start content (bool) + Start icon (swap: 24 px icons), Label (text), End content (bool) + End icon (swap: 16 px icons) | Button, IconButton, ToggleIconButton, HelpButton, ToolButton, MenuButton (label + chevron), the menus' / popovers' / colour picker's own buttons |
| Atom | **Badge** | Tone = Default · Brand · Component · Success · Warning · Danger; Kind = Label · Count | Label (text) | Badge, Tabs' count badge |
| Atom | Avatar, Checkbox, Radio, Switch, Swatch, Divider, Skeleton, KeyCap, Slider, Spinner | as the app's props | Label where it has one | their sets (already one each; screen variants merged) |
| Atom | **Field** (input base) | Variant = Filled · Outlined · Ghost; State = Default · Hover · Focused · Disabled | Start content + Start icon / prefix text, Value (text), End content + End icon / suffix text | TextInput, NumericInput, SearchField, ColorInput's parts, Select's field |
| Molecule | Select, NumericInput, ColorInput, SearchField, TextArea, InlineEdit | — | made of Field + Icon + Swatch instances | |
| Molecule | **Menu item**, Tab, SegmentedControl, ListRow, LayerRow, PageRow, SidebarItem, PropertyRow, Breadcrumb, Banner, Toast, Tooltip, EmptyState, Kbd | state variants | startContent – Label – endContent | the menus' row frames |
| Organism | Menu, Popover, Dialog, ColorPicker, PanelSection, PropertyGrid, Toolbar, EditorToolbar, Rail, TabBar, CollectionView, VirtualList, FileCard, FolderCard, FileRow | — | built of the atoms' instances | |

## Variables (done first — everything else binds to them)

- **Primitives** (one mode, hidden from publishing): every distinct colour once — `color/gray/850`, `color/blue/450`,
  `color/black/a90`, `color/white/a40` … (118) — and the number scale `scale/0 … scale/64`, `scale/full`, `border/1`,
  `border/2`.
- **Semantic** (the former "Wecra colors", Light / Dark): Figma's role tokens `bg/…`, `text/…`, `icon/…`, `border/…`,
  every value an alias of a primitive. Same value, different role (bg-hover, bg-pressed, bg-secondary) stay
  separate tokens aliasing the same primitive. The app's component-level tokens (`app/…`) alias the semantic token
  with the same Light/Dark pair (tabbar-text → text/text-secondary, folder-blue → bg/bg-brand, menu-text →
  text/text-onbrand …), else primitives.
- **Semantic sizes** (the former "Wecra sizes"): radius/ and space/ alias the scale; size/ (component dimensions)
  alias it where the value is on it.
- Ids stay: the variables bound across the file only change their values to aliases — nothing is rebound.
- Code: `token-map.json` maps every `--figma-color-*` / `--ds-color-*` / `--ds-*` to its semantic variable and its
  primitives. The code keeps its names; to follow the file it would add the primitive layer (`--wecra-color-blue-450`)
  and define its role tokens as `var()`s of it.

## Order

1. Variables in tiers (`variables.mjs`). 2. Button atom (`atoms.mjs button`): 192 variants, grid, properties,
colours and sizes bound. 3. Badge atom. 4. Migration: every Button / IconButton / ToggleIconButton / HelpButton
instance — in the screens and inside other components — swapped to Button with its Variant / State / Icon only and
Label / Start icon set; checked against the captures (shots.mjs, diff.mjs); old sets deleted once nothing uses them.
5. Sizes: padding, gap, radius, stroke weight, heights bound to Semantic sizes on every main. 6. The menus' rows as
Menu item, then the other molecules. 7. Components page by level: Atoms, Molecules, Organisms, Icons.
