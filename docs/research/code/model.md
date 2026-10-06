# Subsystem map: Document model and node rendering

Repo: `/Users/burak/Desktop/Burak/Code/DesignerV2` (read-only pass). All paths below are relative to `src/renderer/src/` unless they start with `docs/` or `/`.

Files read in full: `figma/model.ts` (1447 lines), `figma/NodeView.tsx` (552), `figma/css.ts` (291), `figma/vectorSvg.ts` (669), `figma/page.ts` (153), `figma/PageView.tsx` (130), `figma/inline.ts` (105), `figma/exportNode.ts` (79), `figma/dom.ts` (37), `figma/picking.ts` (75), `figma/view.ts` (69), `figma/useView.ts` (5), `figma/draft.ts` (26), `figma/EmbedView.tsx` (67), `figma/embeds/{types.ts,Media.tsx,Compare.tsx}`, `figma/__tests__/model.test.ts`, `figma/__tests__/instances.test.ts`, `types/design.ts` (115). Read in part for context: `figma/Canvas.tsx` (world/zoom/picking/measure loop, lines 1–1145, 1300–1400), `figma/FigmaEditor.tsx` (doc/page plumbing 280–380, group/ungroup/align/auto-layout 680–940, export/lock 1190–1215, resize/draw/text edit 1330–1410, mask 1728–1744), `figma/systemLibrary.ts` 1–95, `figma/publish.ts` 1–40, `components/project/designVariables.tsx` 92–122, `components/project/textStyles.ts` 91–113.

---

## 1. Summary

The document is a **plain immutable JSON tree** (`FigmaDocument`, `figma/model.ts:569-591`). There are exactly **8 node types** (`model.ts:16`): `frame | rectangle | ellipse | line | text | component | componentSet | instance`, in three TS interfaces: `FrameNode` (frame/component/componentSet/instance, `model.ts:328-389`), `ShapeNode` (rectangle/ellipse/line, `model.ts:291-294`) and `TextNode` (`model.ts:296-326`), all extending `BaseNode` (`model.ts:226-277`). Children are nested arrays (`FrameNode.children`), not a flat id map with parent pointers. Ids are opaque strings from `nid()` (`model.ts:634-638`: prefix + `Date.now()` base36 + counter + 3 random chars).

**Pages are asymmetric.** The *first* page is the document itself: `doc.nodes` / `doc.background` / `doc.pageName` (`model.ts:571-578`). Other pages are `doc.pages: DocumentPage[]` (`model.ts:424-429, 580`), with `doc.currentPage` saying which is open. The site's project page is **one top-level frame on the first page**, named by `doc.pageId` (`model.ts:5-9, 573-574`); `newDocument` makes it a 1440×1024 vertical auto-layout frame (`model.ts:695-701`). The editor additionally injects the site-wide component library as a synthetic `p-components` page (`systemLibrary.ts:62-65`, `library.ts:28`), and `libraryOf()` (`model.ts:603-607`) concatenates every page's nodes so instances can find their main component anywhere. Because the first page is special, helpers special-case it (`pageOfNode` `model.ts:610-613`, `updateAnywhere` `616-627`, editor `FigmaEditor.tsx:289-294, 362-371`).

**Tree operations** are pure functions with structural sharing: `updateNode` (`model.ts:761-779`) rebuilds only the path to the changed node; `insertNode` (`798-807`) forces a unique sibling name; `removeNodes` (`786-790`) rebuilds every frame. Lookups go through a `WeakMap<array, Map<id,{node,parent,index}>>` index rebuilt whenever a tree array is new (`model.ts:730-758`).

**Components/instances**: a component is a frame of type `component`; a set is a `componentSet` frame whose `component` children carry `variant: {property,value}[]` (`model.ts:122-126, 366-367`). Component properties (`boolean | text | instanceSwap`, `model.ts:168-180`) live on the component (or its set — `propertyHolder` `913-917`) and layers bind via `visibleProp` / `charactersProp` / `mainProp` (`model.ts:269-270, 315-316, 380-381`). An instance is a frame with `mainId`, `props`, and **`overrides: Record<namePath, NodeOverride>`** keyed by the overridden layer's *name path* (`"Card›Title"`, `""` = the instance's own frame), nested instances via `NodeOverride.overrides` (`model.ts:382-416`). `resolveInstance` (`model.ts:1008-1102`) materialises an instance on every draw: clone main's subtree, apply property bindings then overrides, keep the instance's own place/size/sizing. Layers inside instances have **no ids of their own**: they are addressed by composite ids `instanceId/Name›Path[/Nested›Path]` (`model.ts:1142-1165`; produced in `NodeView.tsx:395`). The Reset/Push-to-main machinery is `OVERRIDE_GROUPS`, `withResetAt`, `withPushedOverrides`, `changesAt`, `withoutChange` (`model.ts:1271-1396`).

**Rendering is DOM.** Every node is a React element (`NodeView`, `NodeView.tsx:515-522`) styled by `nodeCss` (`css.ts:207-255`): a frame with auto layout is literally a CSS flex box (`frameLayoutCss` `css.ts:171-204`) or CSS grid; a frame without it positions children with `position:absolute; left:x; top:y` (`css.ts:118-125`). Fills become `background-*` layers (`css.ts:29-54`), strokes become `box-shadow` rings (`css.ts:56-67`) or CSS borders when dashed / per-side (`css.ts:222-235`), corners `border-radius` (`css.ts:93-97`), shadows `box-shadow`, layer blur `filter`, background blur `backdrop-filter` (`css.ts:69-83`), blend modes `mix-blend-mode` / `isolation` (`css.ts:211-212`), rotation/flip a CSS transform around the centre (`css.ts:213-217`), ellipse `border-radius:50%`, line a 0-height box with `border-top` (`css.ts:239-245`). Text is a `div` with browser text layout (`textCss` `css.ts:261-285`) — **no font family in the model**; a text style is applied by a global CSS rule on `[data-text-style=id]` (`textStyles.ts:91-108`). Variables are CSS custom properties: a bound value renders as `var(--name)` (`designVariables.tsx:101-108`), resolved by the browser, light/dark by a `[data-theme=dark]` rule (`designVariables.tsx:111-122`).

**Layout = the browser.** Auto layout, Hug (`max-content` / `auto`), Fill (`flex-grow` / `align-self:stretch`), wrap, min/max, grid tracks, text auto-resize are all computed by Chromium's CSS engine. **Nothing writes the laid-out geometry back to the model**: an auto-layout child's `x/y` are ignored and stale (`model.ts:10-13`), a Hug/Fill node's `width/height` are whatever they were last set to (acknowledged in `FigmaEditor.tsx:1209-1211`). Every operation that needs real geometry (group, ungroup, align across parents, remove auto layout, lock proportions, insert into an isolated component, export) reads it back from the DOM via `getBoundingClientRect` (`dom.ts:6-26`, `FigmaEditor.tsx:686-729, 875-929, 1210, 1360`).

**Coordinates**: three spaces. (1) Model: `x,y` relative to the parent's top-left (top-level: canvas origin), unrotated box, rotation about the centre. (2) World/canvas px: a `div` with `translate(view.x,view.y)` wrapping a `div[data-design-scope]` with `scale(view.zoom)` (`Canvas.tsx:1358-1359`); top-level nodes are absolutely positioned in it. (3) Screen px. Conversions: `toCanvas` (`Canvas.tsx:254-258`), `canvasRect` (`260-265`), `worldRect` using a 1000px "zoom probe" span (`Canvas.tsx:152-153, 272-279, 1360`; also `dom.ts:12-15`, `vectorSvg.ts:636-637`). View math is in `view.ts` (`zoomAround` 28-33, `fitView` 36-40, zoom clamped 0.02–256, 23-25) and a tiny external store so panning never re-renders the editor (`view.ts:47-69`, `useView.ts:5`). Pan/zoom never re-render nodes (`World` is memoised, `Canvas.tsx:160-169`); Chromium scales the composited layer and re-rasterises 150ms after the zoom stops (`Canvas.tsx:281-297`).

**Picking = the browser's hit-testing.** A press's `event.target` is walked up through `[data-node-id]` ancestors to get the layer path (`picking.ts:34-46`), then Figma's "innermost open level" rule picks one (`picking.ts:54-68`). Texts are only hit on their glyph line boxes (`picking.ts:10-31`, via `Range.getClientRects`), locked layers and their descendants are cut (`picking.ts:43-45`). Drop targets use `document.elementsFromPoint` (`Canvas.tsx:675-697`). Selection/hover overlays are DOM boxes measured every frame in a rAF loop that re-measures on every pointermove (`Canvas.tsx:300-423`).

**Export** is a DOM scrape: `vectorSvg` (`vectorSvg.ts:613-669`) temporarily strips CSS transforms, walks the element's computed styles and writes SVG rect/path/ellipse/text/gradient/filter/mask/clipPath; PNG/JPG are that SVG drawn into a canvas (`exportNode.ts:52-79`); fonts and pictures are inlined as data URLs (`inline.ts:7-105`).

The same `NodeView` doubles as the **published site's renderer** (`site: true` mode: links, zoomable pictures, embeds, i18n, responsive container-query CSS, GSAP scroll reveals in `PageView.tsx`), and per `AGENTS.md`/`docs/architecture.md:75` every model/render change must be mirrored into the portfolio repo's copy.

---

## 2. The node model in detail

### 2.1 Node types (`model.ts:16`) vs Figma

| Figma type | Here | Notes |
|---|---|---|
| DOCUMENT | `FigmaDocument` (`model.ts:569-591`) | implicit root; `version: 1` |
| CANVAS (page) | first page = `doc.nodes`; others `DocumentPage` (`424-429`) | asymmetric; page = `{id,name,nodes,background}`; no guides, no flow list, no page-level export/prototype settings (flows live on frames: `flowStart`, `model.ts:368-369`) |
| FRAME | `frame` | also used for groups and masks |
| GROUP | **none** — ⌘G makes a fill-less `frame` named "Group N" (`FigmaEditor.tsx:694-697`) | bounds frozen at creation; no auto-fit to children |
| SECTION | **none** | |
| COMPONENT | `component` | |
| COMPONENT_SET | `componentSet` | variants = `component` children with `variant[]` |
| INSTANCE | `instance` | `mainId` + `props` + name-path `overrides` |
| RECTANGLE | `rectangle` | |
| ELLIPSE | `ellipse` | `border-radius:50%`; no arcData (no pies/donuts) |
| LINE | `line` | `height:0` + `border-top`; no caps/arrows |
| POLYGON / STAR | **none** | |
| VECTOR (vector networks, pen) | **none** | |
| TEXT | `text` | single-style, no font family, markdown-ish rich text |
| BOOLEAN_OPERATION | **none** | |
| SLICE | **none** | |
| Mask (`isMask`) | **none** — "Use as mask" wraps in a clipping frame with the mask hidden (`FigmaEditor.tsx:1728-1744`) | only rect/rounded/ellipse clipping, no alpha/vector/luminance masks |

### 2.2 `BaseNode` (`model.ts:226-277`) — every node

`id, name, type, x, y, width, height` (required); optional `rotation` (deg, clockwise), `visible`, `locked`, `opacity` (0–100), `sizingH/sizingV` (`fixed|hug|fill`, `model.ts:116`), `blendMode` (`design.ts:74-91`), `lockAspect`, `absolute` (absolute position inside auto layout), `grow` (flex share, Figma has only 0/1), `gridCol/gridRow/gridSpan`, `exports: {scale:1|2|3|4, format:png|jpg|svg}[]` (`model.ts:64-67`), `flipH/flipV`, `minWidth/maxWidth/minHeight/maxHeight`, `widthVar/heightVar` (number variables), `visibleProp` (boolean component property binding), **`href`** (site link), **`fixed`** (site Overview part, `model.ts:279-280`), `reactions` (`Reaction[]`, `model.ts:129-153`).

Missing vs Figma: `relativeTransform` matrix (only rotation + flips), `constraints` (no responsive resize of children in non-auto-layout frames), `layoutPositioning` is a boolean, no `isMask`, no `pluginData`, no `componentPropertyReferences` beyond the three bindings, no scroll behaviour (`overflowDirection`, fixed-on-scroll), no per-node `exportSettings` suffix/constraint/contents-only.

### 2.3 `Geometry` (`model.ts:282-289`) — shapes and frames

`fills: Paint[]`, `strokes: StrokeStyle[]`, `cornerRadius?`, `corners?: [tl,tr,br,bl]` (each a `VariableValue`), `effects?: Effect[]`; plus `effectStyle?` on ShapeNode (`293`) and FrameNode (`365`).

- `Paint` (`model.ts:28-36`): `type: solid|gradient|image`, `color: VariableValue` (required even for gradients/images), `opacity`, `visible`, `gradient: {angle, stops:{color: string, position:0–100}[]}` — **linear only**, stops are raw hex strings (not variables); `image: {url, fit: fill|fit|tile, alt, altEn}`. Missing: radial/angular/diamond, gradient transform, per-paint blend mode, image crop/rotation/filters (exposure, contrast…), video fills.
- `StrokeStyle` (`model.ts:91-102`): `color`, `opacity`, `visible`, `weight: VariableValue`, `align: inside|center|outside`, `sides?: {top,right,bottom,left: boolean}`, `dashed?`. Missing: individual stroke weights, dash pattern, cap/join/miter, gradient/image strokes.
- `Effect` (`model.ts:105-107`): drop/inner shadow `{x,y,blur,spread,color(hex),opacity}`, layer/background blur `{radius}`. Missing: "show shadow behind transparent areas", progressive blur, noise/texture, glass.
- Corner smoothing: missing.

### 2.4 `TextNode` (`model.ts:296-326`)

`characters`, `charactersEn`, `translations` (site i18n), `fontSize`, `fontWeight`, `lineHeight?` (px or `normal`), `letterSpacing?` (px), `textAlign: left|center|right` (no justified), `textAutoResize: widthHeight|height|none` (no truncate/maxLines), `fills`, `textStyle?` (id of a site-wide style), `charactersProp?`, `textCase`, `textDecoration`, `verticalAlign`, **`tag`** (site's h1–p), `paragraphSpacing`.

Missing vs Figma: **font family / style** (inherits the site's font — `textCss` never sets `fontFamily`, `css.ts:261-285`), per-character style runs (`renderRichText` parses `**bold**` and `[link](url)` instead, `components/project/RichText.tsx:13-23`), lists, paragraph indent, OpenType features, %/auto line height, % letter spacing, leading trim, truncation, hyperlinks as ranges, **strokes and effects on text** (TextNode does not extend `Geometry`), and only the **first** visible fill is used (`css.ts:274-275`).

### 2.5 `FrameNode` (`model.ts:328-389`) — frame, component, componentSet, instance

Layout: `layoutMode: none|horizontal|vertical|grid` (`115`), `itemSpacing`, `paddingTop/Right/Bottom/Left` (VariableValues), `primaryAlign: min|center|max|spaceBetween`, `counterAlign: min|center|max`, `layoutWrap`, `counterSpacing`, `gridColumns/gridRows`, `gridTracks/gridRowTracks` (**raw CSS track strings** like `"minmax(0,2fr)"`, `345-347`), `strokesInLayout` (stored but **not rendered** — only the Inspector toggles it, `Inspector.tsx:668`), `firstOnTop` (reverse z), `baselineAlign`, `clipsContent`, `layoutGrids` (`41-51`: columns/rows/grid, count/gutter/margin/size/color/opacity — no alignment/section size).

Components: `variant`, `properties`, `flowStart`; instances: `mainId`, `props`, `propsEn`, `propsI18n`, `mainProp`, `overrides`.

Site-only: `narrow` (`348-353`), `embed` (`387-388`, see §6).

### 2.6 Instances and overrides

- `makeInstance` (`model.ts:1235-1247`) copies size, sizing and layoutMode, empty fills.
- `resolveInstance(nodes, instance, shownId?)` (`model.ts:1008-1102`): finds main by `shownId ?? mainId`; computes property values (defaults + instance's, `propertyValues` `923-928`); walks main's children applying (a) property bindings (`applyProps` `1016-1033`: visibility, text words incl. translation fallbacks, instance swap), then (b) the override at that name path (`applyOverride` `1034-1057`). Nested instances are not expanded here: their own overrides are merged (`mergeOverrides` `1105-1112`) and they resolve themselves when drawn. The result is a new `FrameNode` whose `id` is the instance's and whose children are main's (with main's ids!) — the renderer re-addresses them with composite ids.
- `NodeOverride` (`model.ts:392-416`) can carry only: text words (+ translations), `fills`, `strokes`, `visible`, `opacity`, `cornerRadius/corners`, `effects`, and for frames `clipsContent`, spacing/padding/alignment/wrap (`OVERRIDABLE`, `model.ts:419`), plus nested `overrides`. For texts only words/fills/visible/opacity apply (`1040-1045`). **No overrides of size, text style, font size/weight, sizing mode, layout mode, or names.**
- Keys are **name paths** (`namePath` `986-1001`, `PATH_SEP = "›"`), so: sibling names must be unique (`insertNode` + `freeName`, `798-807, 852-856`); names may not contain `/` or `›` (`layerName` `849`); renaming a layer inside a main component must migrate every instance's override keys (`withRenamedLayer` `1173-1221`) — and this only runs over the **open file** (`FigmaEditor.tsx:1463`), while the components are a site-wide library shared by every project (`systemLibrary.ts:7-12`).
- Composite ids: `layerAt(nodes, "inst/Card›Title/Label")` (`model.ts:1147-1165`) re-resolves the chain of instances to find a drawn layer.
- Reset menu: `OVERRIDE_GROUPS` (`1274-1284`), `overriddenGroups` (`1287-1295`), `withResetAt` (`1317-1332`), `changesAt` (`1366-1379`, property values appear as rows `prop:<id>`), `withoutChange` (`1382-1396`); Push to main: `withPushedOverrides` (`1340-1359`). Tests: `__tests__/instances.test.ts`, `__tests__/model.test.ts:79-118`.
- Variants: `variantsOf` (`892`), `variantProperties` (`897-910`), `pickVariant` (closest variant when one property changes, `977-984`), `variantName`/`variantLabel`/`parseVariantName`/`withVariantName` (`974, 1398-1447`).
- Prototype "Change to" swaps the shown variant in React state, not the model (`useReactions`, `NodeView.tsx:319-362`); Smart animate = keep DOM elements keyed by layer name (`NodeView.tsx:396`) and let CSS `transition: all` animate (`MOTION_CSS`, `components/project/interactions.ts:162-166`).
- Cycle guard at draw time: `MAX_INSTANCE_DEPTH = 16` (`NodeView.tsx:364-384`); at edit time `createsCycle` (`FigmaEditor.tsx:318-353`).

### 2.7 Variables and styles as the model sees them (`types/design.ts`)

`VariableValue = {value: string|number} | {alias: id}` (`design.ts:14`) is used for every bindable number/colour. `DesignVariable` (`16-29`) has `kind: color|number|weight`, `light`, `dark?` (exactly two modes), `token?` (the site CSS token it drives), `collection?` (a label). `TextStyle` (`54-64`) = typography + `description`, `small` (phone breakpoint), `tag`. Effect styles are `EffectStyle {id,name,effects}` on the document (`model.ts:56-61, 583-584`), but in practice injected from the site library (`systemLibrary.ts:62-65`). No paint styles, no grid styles; variables/text styles are site-wide, not per-file (AGENTS.md). `numberOf` resolves aliases for editor arithmetic in the **light** mode only (`model.ts:1253-1269`).

---

## 3. How a node is drawn

Entry points: editor canvas `World` (`Canvas.tsx:160-169`) maps `doc.nodes` to `<NodeView parentLayout="none">`; site `PageView` (`PageView.tsx:38-130`) draws the page frame only. `RenderProvider` (`NodeView.tsx:543-552`) splits context into `LibraryCtx` (all nodes — read only by instances, `NodeView.tsx:121-131`) and `RenderContextCtx` (`byId`, `lang`, `play`, `editing`, `site`, `onAction`).

- `NodeView` (`NodeView.tsx:515-522`, `memo`) dispatches: `TextView` (`187-205`), `InstanceView` (`368-400`), `FrameBox` (`402-450`), `ShapeView` (`525-536`).
- `FrameBox` → `Children` (`485-503`) → `NodeView` per child; inside an instance, nested frames are `NestedFrame` (`505-512`) that carry the name path; ids are `${instanceId}/${namePath}`; React keys are layer names (`keyOf`, `396`).
- Each element carries `data-node-id` and `data-node-type` — the only link between pixels and the model (used by picking, overlays, export, `domRect`).
- Editor-only decorations are drawn as DOM in the frame: component-set dashed outline (`416`), layout grids (`464-483`), grid cells (`452-462`, shown via CSS only when selected).
- Text editing = the same element becomes `contentEditable="plaintext-only"` (`EditableTextNode`, `137-185`); every keystroke writes `characters` to the model (`FigmaEditor.tsx:1388-1408`).
- Prototype triggers are wired as DOM listeners on each node (`useTriggers`, `NodeView.tsx:220-303`), active only when `play`.

`nodeCss` (`css.ts:207-255`) = `placement` (`css.ts:100-165`) + visibility/opacity/blend/transform + text or geometry CSS + `frameLayoutCss` (`css.ts:171-204`).

### 3.1 Auto layout = CSS flexbox / grid

- `horizontal/vertical`: `display:flex; flex-direction; gap: itemSpacing; justify-content: JUSTIFY[primaryAlign]; align-items: ALIGN[counterAlign]` (`css.ts:193-197`), `baseline` when `baselineAlign` (`197`), wrap → `flex-wrap: wrap; align-content: counterAlign; row-gap: counterSpacing` (`198-202`).
- `grid`: `display:grid`, `grid-template-columns` = `gridTracks` (CSS) or `repeat(n, minmax(0,1fr))` (`180-191`).
- Child sizing (`placement`): Fixed → `width/height` px; Hug → `max-content` / `auto` (`102-103, 143-144, 163`); Fill along the flow → `flex-grow: grow ?? 1; flex-basis: 0; min-*: 0` (`147-162`); Fill across → `align-self: stretch` (or `100%` when a max caps it); grid Fill → `justify-self/align-self: stretch` (`136-137`); `lockAspect` + Fill → `aspect-ratio` (`106-109`); min/max/size variables (`110-115`).
- Absolute children and children of `layoutMode:none` frames: `position:absolute; left:x; top:y` (`118-125`) — relative to the parent's **padding box**, so padding does not move them but a CSS border (dashed or per-side stroke) does.
- Every child of a flex parent gets `flex-shrink: 0` (`127`) except on the site's phone width (`NodeView.tsx:80`).

Consequence: the true size/position of anything in an auto layout (and of any Hug/Fill/auto-width text) exists **only in the DOM**. Inspector W/H show the stored, possibly stale `node.width/height` (`Inspector.tsx:731, 736`).

### 3.2 Paint / effects mapping (and where it diverges from Figma)

| Figma | Here | Divergence |
|---|---|---|
| fills stack | `background-color` / layered `background-image` (`css.ts:44-54`) | linear gradients only; image `fill|fit|tile` only |
| stroke inside/center/outside | `box-shadow` inset / both / outset (`css.ts:56-67`) | never affects layout (correct) |
| stroke per side / dashed | CSS `border` with `box-sizing:border-box` (`css.ts:222-235`) | **takes layout space and offsets absolutely-positioned children** by the stroke weight; dash pattern fixed |
| strokes in layout | ignored by renderer | `strokesInLayout` dead field |
| drop/inner shadow | `box-shadow` (`css.ts:69-73`) | box-shaped, not alpha-shaped (no shadow of a fill-less frame's children, no shadows on text) |
| layer / background blur | `filter` / `backdrop-filter` (`css.ts:76-83`) | only the last one of each kind applies |
| blend mode | `mix-blend-mode`; `normal` → `isolation:isolate` (`css.ts:211-212`) | no linear burn/dodge; CSS opacity/filters always create an isolated group |
| rotation | CSS `rotate()` about the centre (`css.ts:213-217`) | model `x,y` = unrotated box; Figma's `x,y` = rotated origin of `relativeTransform` |
| corner radius | `border-radius` (`css.ts:93-97`) | no smoothing |
| ellipse / line | `50%` radius / `border-top` (`css.ts:94, 239-245`) | no arcs, no caps |
| variables | `var(--…)` resolved by the browser (`designVariables.tsx:101-122`) | 2 modes (light/dark) |
| text | browser text layout; text style via global CSS rule (`textStyles.ts:91-108`) | no font family; editor line metrics are Chromium's, not Figma's |

### 3.3 Hit-testing / picking (`picking.ts`, `Canvas.tsx`)

1. `onPointerDown` (`Canvas.tsx:1041-1063`) takes `e.target` (Chromium already did the geometric hit test, honouring clips, rotation, `display:none` for hidden layers, `pointer-events:none` for embeds in the editor `EmbedView.tsx:63`).
2. `pathAt` (`picking.ts:34-46`) collects `[data-node-id]` ancestors → `[{id, el}]` from top-level down; pops a text if the point is not over its glyph lines (`picking.ts:28-31, 42`); truncates at the first locked node (`44-45`, composite ids skipped).
3. `pickFrom` (`picking.ts:54-68`): ⌘ → innermost; otherwise the deepest layer whose parent is "open" (selected or an ancestor of the selection, found by walking the DOM from each selected element); default = a top-level frame's direct child.
4. Hover does the same on every pointermove (`Canvas.tsx:1322-1327`); marquee tests each candidate's `getBoundingClientRect` (`Canvas.tsx:990-1039`); drop targets use `elementsFromPoint` + repeated `pathAt` (`Canvas.tsx:675-697`); reorder index by comparing child midpoints (`700-714`).
5. Overlays (selection boxes, hover outline, text underlines, frame labels, parent outline, gap handles, prototype noodles) are recomputed in a rAF loop (`Canvas.tsx:322-423`) whenever `remeasure` is set — which every `pointermove`, wheel and keydown does (`306-320`) — using `querySelector('[data-node-id=…]')` per selected id, per top-level frame (labels, `374-378`), per reaction source/target (`397-413`), then `JSON.stringify` diffing (`416`). Selection boxes are axis-aligned `getBoundingClientRect` boxes (`336, 1119-1124`), so a rotated layer is outlined by its AABB, not its own rotated box as in Figma.

### 3.4 Export (`exportNode.ts`, `vectorSvg.ts`, `inline.ts`)

- `exportElement` / `copyElementAs` / `renderElement` (`exportNode.ts:36-79`) need the layer's live element; the editor refuses if it is not drawn on the open page (`FigmaEditor.tsx:1196-1203`).
- `vectorSvg(root)` (`vectorSvg.ts:613-669`): records and removes every CSS transform under `root` (`616-629`), walks elements (`element`, `555-600`) turning computed `box-shadow` into masked/blurred shapes (`224-254`), backgrounds into rect/gradient/pattern/image (`322-355`), borders into strokes/lines (`357-381`), `<img>/<canvas>/<video>` into images, iframes/embeds into grey boxes (`383-420`), text into one `<text>` per laid-out line using `Range` rects (`451-508`), inline SVG icons cloned (`517-545`); restores transforms (`641-645`); inlines pictures and @font-face subsets (`650-668`, `inline.ts:59-105`).
- PNG/JPG: the SVG blob decoded into an `<img>` and drawn into a canvas at scale (`exportNode.ts:55-78`) — a foreignObject approach was rejected because Chrome taints the canvas (`exportNode.ts:4-6`).
- Limits: text is live `<text>` (no outlines), background blur dropped, iframes/videos grey, formats png/jpg/svg at 1–4× only (`model.ts:64-67`), no PDF, no suffixes/constraints, pictures without CORS left blank/linked (`exportNode.ts:8-11`).

---

## 4. Performance ceiling of the DOM renderer (measured)

I bundled the repo's real `model.ts` + `NodeView.tsx` (with `EmbedView`/`ZoomableImage` stubbed) with esbuild into the scratchpad and ran it in the Claude browser pane (Chromium) on this Mac; nothing in the repo was touched. Each row = top-level frames × children; each child = a frame holding a text, a rectangle with a stroke and a drop shadow, and an ellipse (auto layout on). The variable map and render context were stable (as in `FigmaEditor.tsx:286, 1409`). These numbers exclude raster/paint, the editor's overlay loop, Layers/Inspector re-renders, images and text styles — the real editor is slower.

| model nodes | DOM elements | React mount | style + layout | edit 1 leaf (`updateNode`) | remove 1 leaf (`removeNodes`) | one `querySelector([data-node-id])` |
|---|---|---|---|---|---|---|
| 4,010 | 4,011 | 26–42 ms | 7–11 ms | 2–4 ms | 7–12 ms | 0.02 ms |
| 40,040 | 40,041 | ~260 ms | ~73 ms | 6.5 ms | **70 ms** | 0.27 ms |
| 10,044 (10k instances of a 4-layer component) | 40,045 | ~270 ms | ~71 ms | **85 ms** | 132 ms | 0.27 ms |
| 120,100 | 120,101 | ~730 ms | ~280 ms | 20 ms | **192 ms** | 2.3 ms |

JS heap at 120k nodes: ~314 MB. Model-only timings in Node (`model-bench`): `updateNode` 12.6 ms and the id index rebuild 81 ms at 150k nodes; `removeNodes` keeps **0 of N** untouched top-level frames referentially equal (every frame is recreated, `model.ts:786-790`), which is why deletes re-render the whole page; editing one instance re-renders every instance because each `InstanceView` reads `LibraryCtx` (`NodeView.tsx:370`), which changes on every edit.

What this means:
- Comfortable: up to ~5–10k nodes per page. Sluggish: ~40k (⅓ s to open a page, 70–130 ms per delete/instance edit). Not usable: 100k+ (Figma pages of that size are routine; Figma keeps them interactive with culling, tiling and a GPU scene graph).
- **No viewport culling / virtualization**: every node of the page is in the DOM whatever is on screen (`Canvas.tsx:161-169`).
- **Overlay loop cost is O(top-level frames × DOM size)** per pointermove-triggered frame: at 120k DOM nodes one lookup costs 2.3 ms, so 100 top-level frames → ~230 ms per measured frame (`Canvas.tsx:374-378`).
- **Index rebuilds**: each edit makes a new top-level array and `libraryOf(file)` a new combined array (`FigmaEditor.tsx:311`), so the id index is rebuilt (O(N)) at least twice per edit (`model.ts:730-747`).
- **Zoom**: pan/zoom are compositor transforms (cheap), but at rest Chromium re-rasterises the whole visible world at the new scale 150 ms later (`Canvas.tsx:281-297`): blurry while zooming, re-raster cost grows with shadows/blurs/backdrop filters/images and with zoom up to 256× (`view.ts:24`). At 2% zoom every node of the page is painted, no level of detail.
- Per-node overhead even when not prototyping: each text/shape/frame runs `useTriggers` with a dependency-less `useLayoutEffect` (`NodeView.tsx:224-226`) and 2 effects; `TextView` does a linear `textStyles.find` per render (`197`); `firstOnTop` uses `indexOf` per child (O(n²), `499`).

### What a canvas/WebGL (C++/Wasm) renderer would replace

| Today (DOM) | Replaced by |
|---|---|
| `NodeView.tsx` + `css.ts` (node → CSS) | scene-graph renderer (fills, strokes, effects, masks, blend modes) on one WebGL canvas, with tiling and culling |
| Chromium flexbox/grid + `max-content` (`css.ts:100-204`) | own auto-layout engine (Fixed/Hug/Fill, wrap, min/max, absolute, grid) that **writes computed sizes/positions into the model** |
| Chromium text layout + global text-style CSS (`css.ts:261-285`, `textStyles.ts:91-108`) | own text shaping/line breaking (font loading, styled runs, OpenType) with glyph metrics in the engine |
| CSS custom properties for variables (`designVariables.tsx:101-122`) | variable resolver in the engine (modes, aliases) |
| `getBoundingClientRect` geometry (`dom.ts`, `Canvas.tsx:254-279`, FigmaEditor group/align/ungroup) | model-computed `absoluteTransform` / `absoluteBoundingBox` / render bounds |
| `event.target` + `[data-node-id]` walk + `elementsFromPoint` (`picking.ts`, `Canvas.tsx:675-714`) | engine hit-test (spatial index, path/glyph tests, clip-aware) returning a node path; `pickFrom` logic reused on it |
| rAF + `querySelector` overlay measuring (`Canvas.tsx:300-423`) | overlays drawn from engine bounds (in the same WebGL pass or a thin DOM/SVG layer fed by the engine) |
| DOM-scrape export (`vectorSvg.ts`, `exportNode.ts`) | scene-graph → SVG/PDF/PNG exporters (offscreen render at scale, text outlines option) |
| CSS `transition: all` Smart animate (`interactions.ts:162-166`) | engine-driven prototype player interpolation |
| `contentEditable` text editing (`NodeView.tsx:137-185`) | engine text editor with caret/selection drawn on canvas (or a hidden input proxy) |

---

## 5. Problems (bugs, ceilings, debt) — with locations

1. **Geometry is not in the model.** Auto-layout children's `x/y`, Hug/Fill sizes and auto-width text sizes are never written back (`model.ts:10-13`; `FigmaEditor.tsx:1209-1211` admits stored sizes "may be an old one"); the Inspector shows stale W/H (`Inspector.tsx:731, 736`); geometry ops depend on the DOM (`dom.ts:6-26`, `FigmaEditor.tsx:686-729, 875-929, 1360`); export requires the node to be drawn on the open page (`FigmaEditor.tsx:1196-1199`). A headless engine, plugins API, or cross-page operations are impossible as is.
2. **Overrides keyed by layer names** (`model.ts:382-386, 986-1001`): forces unique sibling names (`798-807`), forbids `/` and `›` in names (`849`), needs key migration on rename (`1173-1221`) which only covers the open file (`FigmaEditor.tsx:1463`) although components are shared by all projects (`systemLibrary.ts:7-12`) → renaming a library layer silently drops overrides in every other project. React keys inside instances are names (`NodeView.tsx:396`).
3. **`removeNodes` recreates every frame** (`model.ts:786-790`) → defeats `NodeView` memo (measured: 70 ms at 40k vs 6.5 ms for `updateNode`).
4. **`updateNode` is a full tree scan** (`model.ts:761-779`) ignoring the id index; `updateNodes` is O(k·N) (`782-784`).
5. **Index rebuilt per edit** (`model.ts:730-747`) and `libraryOf` allocates a new array per file change (`model.ts:603-607`, `FigmaEditor.tsx:311`) — 81 ms at 150k nodes.
6. **All instances re-render on any edit** (`NodeView.tsx:370` reads `LibraryCtx`): 85 ms for one edit with 10k instances.
7. **Overlay measure loop** O(F·N) per pointermove (`Canvas.tsx:306-320, 374-378, 397-413`).
8. **No culling/virtualization**; 120k nodes = ~730 ms mount + ~280 ms style/layout + ~314 MB heap.
9. **Rotated selection boxes are axis-aligned** (`Canvas.tsx:336, 1119-1124`); model rotation semantics differ from Figma's transform (`css.ts:213-217`).
10. **Dashed/per-side strokes are CSS borders** that consume layout space and shift children (`css.ts:222-235`); `strokesInLayout` is not implemented (`model.ts:357`, only `Inspector.tsx:668`).
11. **Text model too thin**: no font family, single style, no effects/strokes, first fill only (`model.ts:296-326`, `css.ts:261-285`).
12. **Effects**: one layer blur/background blur max (`css.ts:78-81`); shadows are box-shaped (`css.ts:69-73`).
13. **Paint model**: linear gradients only, hex-only stops, `colorWithAlpha` only parses `#rrggbb` (`model.ts:18-36`, `css.ts:30-34, 86-91`); `Paint.color` required even when meaningless.
14. **Missing node types**: GROUP, SECTION, VECTOR, BOOLEAN_OPERATION, POLYGON, STAR, SLICE, real masks (`model.ts:16`; group/mask emulations `FigmaEditor.tsx:694-697, 1728-1744`); no constraints.
15. **Grid tracks stored as CSS strings** (`model.ts:345-347`, `css.ts:184-185`) — format owned by CSS, not by the model.
16. **Page asymmetry** (`model.ts:569-591` vs `424-429`) and the injected library page (`systemLibrary.ts:62-65`) complicate every page-aware function.
17. **Ids** are time+counter+3 random base36 chars (`model.ts:634-638`); the index silently keeps the first of duplicate ids (`model.ts:740`). Fine single-user; not a sync-safe GUID.
18. **Per-node hook overhead** and small O(n²)s (`NodeView.tsx:224-226, 197, 499`).
19. **Instance override coverage** is narrow (`model.ts:419, 1040-1057`): no size, text-style, font or layout-mode overrides.
20. **Two copies to keep in step**: model/render must be mirrored in the portfolio repo (`docs/architecture.md:75`, AGENTS.md).
21. **Export fidelity** tied to DOM (`vectorSvg.ts:383-420` grey boxes for iframes/videos; no backdrop blur; `<text>` instead of outlines) and transforms are stripped from the live DOM during export (`vectorSvg.ts:616-645`).
22. **Persistence shape**: the whole document is one nested JSON text (`docs/architecture.md:44`) — nothing like a flat `{guid → {parent, position, props}}` map that per-property LWW sync would need.

---

## 6. Coupling to burakkoc.net / Firebase / the site (to drop or replace in a Figma clone)

- **Project page concept**: `FigmaDocument.pageId/pageName/libraryVersion/fromLegacy` (`model.ts:569-591`), `newDocument` = a 1440-wide site page (`model.ts:695-701`), all of `page.ts` (`PAGE_COLUMN/PAGE_WIDTH/OVERVIEW_*`, `overviewContent` from `ProjectData`, `sitePageFrame`, `inPageColumn`; `page.ts:12-153`).
- **Overview / fixed parts**: `fixed?: FixedPart` (`model.ts:273-280`), `cloneNode(keepParts)` (`814-830`), cover image eager-loading (`NodeView.tsx:109-114`), `overview.ts`.
- **Embeds**: `Embed`/`EmbedKind`/`EMBED_LABEL` (`model.ts:182-224`), `FrameNode.embed` (`387-388`), `EmbedView.tsx`, `embeds/*` (YouTube/Vimeo, DOMPurify code previews, `ComponentRegistry` demos, `ZoomableFigma/ZoomableIframe`, "burakkoc.net" in the browser device frame `embeds/Compare.tsx:123`), `NodeView.tsx:421-428`.
- **Links and site behaviour**: `href` (`model.ts:271-272`), `<a>` rendering and `InLinkCtx` (`NodeView.tsx:83-84, 436-444`), markdown links/bold (`RichText.tsx`), `site` flag paths: zoomable pictures (`NodeView.tsx:86-119, 524-535`), hidden layers dropped (`490-491`), missing instances drawn as nothing (`380`), heading tags (`195-198`).
- **i18n**: `charactersEn/translations` (`model.ts:299-302`), `propsEn/propsI18n` (`376-379`), embed captions (`198-201`), languages API (`431-567`: `languagesOf`, `writtenLanguages`, `wordsIn/wordsPatch`, `propsIn/propsPatch`, `captionIn/captionPatch`, `withoutLanguage`), `BASE_LANGUAGE = "tr"`; `textOf` (`NodeView.tsx:134`); translation fallbacks in `resolveInstance` (`model.ts:1013-1027`); `NodeOverride.charactersEn/translations` (`393-395`).
- **SEO tag**: `TextNode.tag` (`model.ts:322-323`), `TextStyle.tag` (`design.ts:62-63`).
- **Responsive site CSS**: `FrameNode.narrow` (`model.ts:348-353`), `PAGE_CSS` container queries, `PAGE_TOP_NARROW`, `--page-lift` (`NodeView.tsx:46-81`), `PageView.tsx:118-127`, Canvas page-editor mode (`Canvas.tsx:96-115, 1363-1372`).
- **Published-page renderer**: `PageView.tsx` (GSAP ScrollTrigger/SplitText reveals `PageView.tsx:2-5, 28, 56-111`, `revealPlan` from `site.ts`, `siteAction` link/scroll handling `18-25`).
- **Firestore drafts/publishing**: `draft.ts` (`loadDesign`, `loadProjectForEdit`, `publishedPage`, `withOverview`, `withLibrary`, `detachDeleted`), `publish.ts`.
- **Site-wide design system instead of file-local**: library injected as `p-components` page (`systemLibrary.ts:62-65`, `library.ts:28`), `libraryOf` (`model.ts:603-607`), `withoutLanguage(keepPage)` (`model.ts:524-525`); variables with site `token`s and exactly light/dark (`design.ts:16-29`), CSS variable scope `[data-design-scope]` (`designVariables.tsx:111-122`); text styles' phone breakpoint `small` (`design.ts:60-61`, `textStyles.ts:104`); factories hard-code site token aliases (`bg-1`, `bg-5`, `text-title`: `model.ts:651-652, 675-676, 692`; `page.ts:97, 148`).
- **Storage/CORS wording** in export (`exportNode.ts:8-11`, `FigmaEditor.tsx:1201`).
- **Mirroring rule**: AGENTS.md and `docs/architecture.md:75` (portfolio `src/figma` copy).

---

## 7. What is worth keeping

- **Instance/override semantics** (`model.ts:913-1102, 1271-1396`, `instances.test.ts`): property values, bindings (`visibleProp/charactersProp/mainProp`), nested override merging, Reset groups, Push to main, variant picking/naming. Keep as the behavioural spec (and port), but re-key overrides by stable layer ids (Figma's `I<instance>;<child>` guid paths) instead of names.
- **Pure, structurally-shared tree helpers** (`walk`, `findNode` path, `topmost`, `freeName/nextName`, `cloneNode` with reaction retargeting: `model.ts:713-867`) — as TypeScript-side helpers or as a reference for the C++ scene graph's API; fix `removeNodes` sharing and use the index in `updateNode`.
- **View math and view store** (`view.ts:28-69`, `useView.ts`) — camera for a WebGL canvas as is.
- **Figma's picking rule** (`pickFrom`, `picking.ts:54-68`) and text-glyph-only hit idea — reusable over engine node paths.
- **`css.ts` as a CSS generator** — becomes Dev Mode's "Copy as CSS"/inspect output rather than the renderer.
- **SVG writing helpers** in `vectorSvg.ts` (`shape`, `roundedPath`, gradient line math, shadow/inner-shadow masks: `109-142, 224-320`) and font subsetting/inlining (`inline.ts`) — reusable for a scene-graph SVG exporter.
- **Prototype trigger semantics** (`useTriggers`, `NodeView.tsx:220-303`; `Reaction` type `model.ts:129-153`; interaction enums `design.ts:107-115`) — a good map of Figma's triggers/actions/animations for the prototype player.
- **Tests** (`__tests__/model.test.ts`, `instances.test.ts`) as regression specs.

---

## 8. Data shapes index

- `SceneNode = FrameNode | ShapeNode | TextNode` — `model.ts:421`
- `BaseNode` — `model.ts:226-277`; `Geometry` — `282-289`; `ShapeNode` — `291-294`; `TextNode` — `296-326`; `FrameNode` — `328-389`
- `Paint` — `28-36`; `GradientStop` — `19-22`; `StrokeStyle` — `91-102`; `Effect` — `105-107`; `EffectStyle` — `57-61`; `LayoutGrid` — `41-51`; `ExportSetting` — `64-67`; `Corners` — `158`
- `LayoutMode/SizingMode/PrimaryAlign/CounterAlign/TextAlign/TextAutoResize` — `115-120`
- `VariantValue` — `123-126`; `Reaction` — `129-153`; `ComponentProperty`/`PropertyType`/`PropertyValues` — `168-180`
- `NodeOverride` — `392-416`; `OVERRIDABLE` — `419`; `OVERRIDE_GROUPS` — `1274-1284`
- `Embed`/`EmbedKind` — `190-222`; `embeds/types.ts:7-44`
- `DocumentPage` — `424-429`; `FigmaDocument` — `569-591`; `Language` — `443-447`; `Found` — `705-711`
- `VariableValue` — `types/design.ts:14`; `DesignVariable` — `16-29`; `Typography`/`TextStyle` — `41-64`; `TextTag` — `67`; `BlendMode` — `74-91`; interaction enums — `107-115`
- `RenderContext` — `NodeView.tsx:28-44`; `CanvasView`/`ViewStore`/`CanvasTool` — `view.ts:7-51`; `ExportResult` — `exportNode.ts:18-22`; `FontUse` — `inline.ts:28-33`
