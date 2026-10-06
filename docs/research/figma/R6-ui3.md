# R6-ui3: Figma UI3 visual system (verified 2026-10-06)

## Sources opened
- https://developers.figma.com/docs/plugins/css-variables/ (official token list; light values are in the static HTML, see light.txt next to this file: 174 tokens)
- https://figblocks.mohanvadivel.com/guidelines/color (third-party table of light and dark values)
- https://www.figma.com/blog/figma-2024-we-shipped-it-you-shaped-it/ (Dec 4 2024): floating panels dropped, panels docked and resizable, toolbar at the bottom, Actions menu
- https://www.figma.com/blog/making-the-move-to-ui3-a-guide-to-figmas-next-chapter/ (Mar 25 2025): Shift+\ minimizes the UI, Cmd+\ hides all UI, zoom % dropdown in the properties panel holds "property labels"
- https://forum.figma.com/suggest-a-feature-11/sharing-new-figma-ui3-ui-kit-in-the-community-14074 : no official UI3 kit; only the UI2 kit is official
- create-figma-plugin base.css (UI2-era plugin kit): Inter 11px/16px, weights 400/600, radii 2/4/6/12, menu/modal shadows, 24px textbox

## Tokens (light / dark)
bg #ffffff/#2c2c2c; bg-secondary #f5f5f5/#383838; bg-tertiary #e6e6e6/#444444; bg-hover #f5f5f5/#383838;
bg-selected #e5f4ff/#4a5878; bg-selected-secondary #f2f9ff/#394360; bg-brand #0d99ff/#0c8ce9 (hover #007be5 light);
bg-component #9747ff/#8a38f5; bg-component-tertiary #f1e5ff (light); bg-inverse #2c2c2c/#ffffff;
text #000000e5/#ffffff; text-secondary #00000080/#ffffffb2; text-tertiary #0000004d/#ffffff66; text-brand #007be5/#7cc4f8;
text-component #8638e5/#d1a8ff; border #e6e6e6/#444444; border-strong #2c2c2c/#ffffffe5; border-selected #0d99ff;
border-component #e4ccff (light); icon #000000e5/#ffffff; icon-secondary #00000080/#ffffffb2; icon-tertiary #0000004d/#ffffff66; icon-component #8638e5 (light).
Danger/warn/success light: bg #f24822/#ffcd29/#14ae5c; text #dc3412/#b86200/#009951. Menu bg #1e1e1e (create-figma-plugin).

## Mismatches vs src/renderer/src/figma/tokens.ts
- --f-text-component dark #c9a5ff; Figma #d1a8ff.
- --f-icon-component light #b49ee0; Figma icon-component #8638e5 (dark #9d82cf unverified).
- --edit-component dark #c9a5ff; same issue.
- Layer/page rows selected grey #f0f0f0 / #1e1e1e (owner's choice); Figma uses bg-selected #e5f4ff / #4a5878.
- --f-bg-toggle-hover, the app.css tab-bar colours (#e6e6e6/#585858 …) and the home-* colours have no Figma token source I could verify.
- The rest match (bg, secondary, tertiary, selected, brand, text*, border, text-brand).

## Unverified (no primary source found)
Panel widths (240 is the commonly cited default), 24px input/row heights in UI3, the toolbar size, radii in UI3 (more rounded than UI2), the desktop tab-bar colours, motion.
Figma MCP: whoami works (user burak.koc); search_design_system needs a fileKey, and there is no official UI3 kit to point it at, so it was not run.
