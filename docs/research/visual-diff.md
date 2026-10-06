# Visual diff vs Figma

I built the app in demo mode into the scratchpad (`--outDir`, so the repo and the user's running dev session were not touched) and ran it with its own user-data folder. I captured Home, an editor with nothing selected, a frame selected, the same frame with auto layout, and light and dark themes, then compared each against the Figma references. The tool refused a separate report.md, so the full comparison is in this result. The fixed structure is already close to Figma: panel widths 48/240/240, border #444, panel #2c2c2c, 11px Inter, 40px section headers, 24px #383838 fields and brand blue #0c8ce9 all match. The biggest gaps:

- **Selection accent is missing.** `--edit-accent` is never defined, so selection outlines, handles and the size badge draw white in dark mode (black in light) instead of Figma's blue.
- **Tab bar.** Ours is the wrong colour and height: #585858 at 40px against Figma's #3b3b3b at 38px.
- **Row colours.** Selected layer and page rows use a dark grey instead of Figma's colours (#3a4360 for layers, #373737 for pages).
- **Site-only UI.** Several rows and controls exist only because the app is a site admin and have no Figma equivalent; they push the panel layout down.
- **Light theme.** The rulers stay dark.

The reference screenshots are not 2x: they were downscaled from a 1512x982pt screen, so 1 CSS px = 1.3228 image px. I confirmed this from the 100% ruler, the 240px panels and the 48px rail. All Figma measurements below are converted on that basis and are accurate to about ±1px.

## Differences

- **Canvas selection colour** (high)
  - ours: --edit-accent is undefined, so the outline and handles are white (black in light mode) and the size badge has no background
  - Figma: #0c8ce9 1px outline; white handles with a blue border; a 16px blue size pill 6px below the frame; the frame title turns blue when selected
  - fix: Define --edit-accent (#0c8ce9 dark, #0d99ff light) in figma/tokens.ts FIGMA_TOKENS
- **Tab bar** (high)
  - ours: 40px tall, background #585858, Home 56px wide, room 78px, no lines next to the active tab, close slot 20px, right padding 6px
  - Figma: 38px including a 1px #4a4a4a bottom line, background #3b3b3b, Home 40px wide, room 80px, full-height #4f4f4f separators including next to the active tab, active tab #2c2c2c, tab width = text + 76px (24px close slot, 8px right padding), active tab icon #7cc4f8, a panel icon at the right edge
  - fix: Set --tabbar-height 38 with a border-bottom, --tabbar-bg #3b3b3b and --tabbar-divider #4f4f4f; Home w-10; show lines around the active tab; close slot w-6; pr-2
- **Selected layer and page rows** (high)
  - ours: Layer row #1e1e1e, 28px tall, flush to the right edge; page row #1e1e1e, 32px
  - Figma: Layer row #3a4360, 24px tall, inset 8px on both sides, radius 5; page row #373737, 24px tall within a 32px pitch
  - fix: Use --f-bg-row-selected #394360 for layers and #383838 for pages; draw a 24px highlight inset 4px and 8px
- **Left rail** (medium)
  - ours: Items 28x28 at a 36px pitch, active #4a5878, logo with a chevron, site-specific icons
  - Figma: Items 32x32 at a 40px pitch, active #3a4360 radius 5, logo with no chevron, 16px #404040 separators; icons: page, 4-point star, plus-in-circle, briefcase, then a hex nut
  - fix: w-8 h-8 items at a 40px pitch; active background #394360; remove the chevron
- **New frame default fill and page colour** (high)
  - ours: A new frame is filled with the black Arka plan/1 variable; the canvas is #1e1e1e while the Page field shows F5F5F5
  - Figma: A new frame is filled with unbound FFFFFF; the canvas is drawn in the page colour
  - fix: Default the fill to #FFFFFF; draw the canvas background from the page colour
- **Site-only UI** (high)
  - ours: Published/Update row (+29px above the tabs), Language row, Narrow screens, Link section, Canvas/Page Editor/Code switcher
  - Figma: None of these; the tabs divider is at 80px
  - fix: Remove these or move them out of the panels for the Figma clone
- **Left panel header and section headers** (medium)
  - ours: Header 56px; the Pages/Layers header text is 32px from the panel edge
  - Figma: Header 64px (name 13px/550 with ink top at 19); header text 16px from the panel edge; header rows 40px
  - fix: h-16 header; pl-4 on the section headers
- **Right panel grid** (medium)
  - ours: Right padding 12px, so the two fields are 85.5px each (179px total); the Frame header text is at x+21
  - Figma: 16px left padding, 8px right padding, a 24px icon column, two 88px fields with an 8px gap; header text at x+16
  - fix: pr-2; field row 184px; remove the header button's extra padding
- **Segmented controls** (medium)
  - ours: 2px padding, a 20px active segment with radius 3 and a shadow; the Home view toggle is inverted
  - Figma: Active segment fills the full 24px, background #2c2c2c with a 1px #444 border, container #383838
  - fix: Restyle the shared segmented control
- **Section header icons and names** (medium)
  - ours: Styles icon shown on empty Stroke and Effects; 'Layout grid'; Appearance icons ordered drop, eye
  - Figma: Only '+' on empty sections; 'Layout guide'; Appearance icons ordered eye, drop
  - fix: Change the icon set and wording
- **Styles list** (medium)
  - ours: Grouped folders at a 28px pitch
  - Figma: A flat list at a 30px pitch with Ag previews plus 'name · size/lh', 16px round swatches and effect squares
  - fix: Render the styles list flat
- **Toolbar** (medium)
  - ours: Centred on the canvas (x 780), 16px from the bottom, no help button
  - Figma: Centred on the window (x 756), 12px from the bottom; Move/Frame/Shape/Pen/Text/Comment/Actions plus a #444 mode group (active segment #2c2c2c); a 32px '?' circle at the bottom right
  - fix: Change the toolbar's position and contents
- **Rulers** (medium)
  - ours: 9px labels drawn to the right of the tick; ticks 6px #444; dark even in the light theme
  - Figma: ~10px labels centred on the tick; ticks 4px #7a7a7a
  - fix: In Rulers.tsx: 10px font, labels centred, tick colour; read the theme tokens
- **Frame title on canvas** (low)
  - ours: #bcbcbc, baseline 6.5px above the frame
  - Figma: #898989, baseline about 10px above the frame
  - fix: Use a tertiary colour and raise the label 4px
- **Home** (medium)
  - ours: Big 24px page heading; 28px dropdowns; Create/View site buttons; cards 278x215 with radius 8 and 32px gaps; first card 88px below the top bar; nav rows 32px with counts
  - Figma: Title only in the top bar (13px); 24px dropdowns; Design/FigJam/Slides/Make/More pills (#383838, 32px); cards 268x213 with radius ~10 and ~36px gaps; first card 67px below the top bar; nav highlight 28px at a 32px pitch; bell icon in the account row
  - fix: Restyle Home

## Measured Figma metrics

- Scale: 1 CSS px = 1.3228 image px
- Tab bar 38px including the line; background #3b3b3b; active tab #2c2c2c; separators #4f4f4f; Home tab 40px wide; room 80px
- Rail 48px; active item 32x32 #3a4360
- Panels 240px, background #2c2c2c, border #444
- Left header 64px; section headers 40px; page rows 32px pitch
- Selected highlights 24px tall, inset 8px
- Right panel top block 80px; Share button 55x32
- Field 88x24 #383838; checkbox 16px
- Toolbar 530x48, radius 13, 12px from the bottom
- Ruler 20px; labels ~10px; ticks #7a7a7a
- Canvas = page colour #232323
- Brand blue #0c8ce9
- Home: top bar 48px; card 268x213 with ~36px gaps; nav pitch 32px