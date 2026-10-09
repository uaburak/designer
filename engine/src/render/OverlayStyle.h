// How the engine's canvas overlays look, per theme (docs/engine.md §6.11). Colours and metrics come from the design
// system's canvas chrome (src/renderer/src/ds/tokens.ts canvasChrome / canvasChromeMetrics, generated into
// ChromePalette.generated.h), calibrated against live Figma (docs/research/figma/live/img, 2026-10-08).
#pragma once

#include "render/ChromePalette.generated.h"
#include "scene/Node.h"

namespace eng {

enum class Theme : uint8_t { Light = 0, Dark = 1 };

struct OverlayStyle {
  Color canvas;          // the page background when the page has none
  Color selection;       // selection, hover, handles' border, badge, marquee
  Color component;       // the same for components, component sets and instances (Figma's purple)
  Color handleFill, handleStroke;
  Color badgeText;
  double selectionWidth = 1;
  double hoverWidth = 2;
  double handleSize = 7;
  double handlesMinBox = 24;  // handles hidden when the box is smaller on screen
  double badgeHeight = 17;  // the size badge and auto layout's value badges (live Figma round 10: 17)
  double badgeRadius = 2;
  double badgeGap = 6;
  double badgePadding = 4;  // the badge's and pills' text inset
  double labelSize = 11;    // badge and pill text: Inter Medium 11, white
  // Frame titles: Inter Regular 11, the baseline 10 px above the frame. Their colour follows the page's background
  // (light / dark), not the UI theme: grey, the selection's text colour when selected, purple for components.
  double titleSize = 11;
  double titleBaselineGap = 10;
  double titleIconSize = 10;
  double titleIconGap = 3;
  Color titleOnLight, titleOnDark;
  Color titleSelectedOnLight, titleSelectedOnDark;
  Color titleComponentOnLight, titleComponentOnDark;
  // The page under the overlays is dark (set by Renderer::render from the canvas colour), and the grey title colour
  // on it (Dev Mode's status chips use it too).
  bool darkCanvas = false;
  Color title;
  double titleAlpha = 1;
  // Sections: their name in a pill above the top-left corner (live Figma), in the section's own fill colour.
  double sectionPillHeight = 22;
  double sectionPillPadding = 6;
  double sectionPillGap = 5;
  double sectionTitleSize = 11;
  double sectionTitleWeight = 550;  // Inter's weight axis (live Figma: the section's name is semibold, 550)
  // Corner radius handles: rings `radiusHandleSize` across, `radiusHandleInset` in from each corner.
  Color radiusHandleFill, radiusHandleStroke;
  double radiusHandleSize = 9;
  double radiusHandleInset = 12;
  // Text editing: the selection highlight over the text.
  double textSelectionAlpha = 0.3;
  double marqueeFill = 0.1;
  // Smart guides and ⌥ measurement: 1 px lines and number pills (red); equal spacing (pink).
  Color measure;
  Color spacing;
  double pillHeight = 16;
  double pillRadius = 2;
  double tick = 6;  // the end ticks of a measured distance
  // Round 11 (live Figma, canvas-component-set-selected at 1.07 px per CSS px): a selected component set's "+" (Add
  // variant) — a square of the component purple `addVariantSize` across, `addVariantGap` under the variants pill, a
  // white plus `addVariantGlyph` across in `addVariantStroke` bars.
  double addVariantSize = 16;
  double addVariantGap = 4;
  double addVariantGlyph = 10;
  double addVariantStroke = 1.5;
  // Smart selection's centre marks (live Figma: canvas-multi-select-two-shapes, canvas-group-selected,
  // menu-context-multi-and-smart-selection at 1.08×): off the selection a dot — pink `dotCore` across in a white
  // `dotSize` disc; on it a ring — a 1 px pink circle `ringSize` across (its middle) between two 1 px white ones,
  // hollow; the one under the pointer filled pink, `ringSize` + 1 across, in a 1 px white ring.
  double dotSize = 3.5;
  double dotCore = 1.5;
  double ringSize = 8;
  // Auto layout: the padding / gap bands and the insertion indicator.
  Color autoLayoutBand;
  double bandAlpha = 0.15;
  double insertionWidth = 2;
  // The pixel grid (zoom ≥ 400%).
  Color pixelGrid;

  // Dev Mode: annotation labels (cards), saved measurements, status chips (unverified colours, R9 "Round 6").
  Color cardFill, cardText, cardMuted, cardBorder;
  double cardWidth = 240;
  double cardGap = 32;       // between the design's edge and its labels
  Color statusReady = Color::hex(0x14AE5C);
  Color statusChanged = Color::hex(0xFFCD29);  // --figma-color-bg-warning
  Color statusCompleted = Color::hex(0x8C8C8C);

  static Color chrome(Theme t, ds::ChromeColor c) {
    const float* v = (t == Theme::Dark ? ds::kChromeDark : ds::kChromeLight)[static_cast<size_t>(c)];
    return Color{v[0], v[1], v[2], v[3]};
  }

  static OverlayStyle of(Theme t) {
    using C = ds::ChromeColor;
    const ds::ChromeMetrics& m = ds::kChromeMetrics;
    OverlayStyle s;
    s.canvas = chrome(t, C::CanvasDefault);
    s.selection = chrome(t, C::Selection);
    s.component = chrome(t, C::Component);
    s.handleFill = chrome(t, C::HandleFill);
    s.handleStroke = chrome(t, C::HandleStroke);
    s.badgeText = chrome(t, C::SizeBadgeText);
    s.selectionWidth = m.selectionStroke;
    s.hoverWidth = m.hoverStroke;
    s.handleSize = m.handle;
    s.badgeHeight = m.badgeHeight;
    s.badgePadding = m.badgePadX;
    s.badgeRadius = m.badgeRadius;
    s.badgeGap = m.badgeGap;
    s.titleBaselineGap = m.titleBaseline;
    s.titleSize = m.titleSize;
    s.titleOnLight = chrome(t, C::FrameTitleOnLight);
    s.titleOnDark = chrome(t, C::FrameTitleOnDark);
    s.titleSelectedOnLight = chrome(t, C::FrameTitleSelectedOnLight);
    s.titleSelectedOnDark = chrome(t, C::FrameTitleSelectedOnDark);
    s.titleComponentOnLight = chrome(t, C::FrameTitleComponentOnLight);
    s.titleComponentOnDark = chrome(t, C::FrameTitleComponentOnDark);
    s.sectionPillHeight = m.sectionPillHeight;
    s.sectionPillPadding = m.sectionPillPadX;
    s.sectionPillGap = m.sectionPillGap;
    s.sectionTitleSize = m.sectionPillFontSize;
    s.radiusHandleFill = chrome(t, C::RadiusHandleFill);
    s.radiusHandleStroke = chrome(t, C::RadiusHandleStroke);
    s.radiusHandleSize = m.radiusHandle;
    s.radiusHandleInset = m.radiusHandleInset;
    s.measure = chrome(t, C::Measure);
    s.spacing = chrome(t, C::SpacingGuide);
    Color gap = chrome(t, C::LayoutGapFill);
    s.autoLayoutBand = Color{gap.r, gap.g, gap.b, 1};
    s.bandAlpha = gap.a;
    s.marqueeFill = chrome(t, C::MarqueeFill).a;
    s.textSelectionAlpha = chrome(t, C::TextSelection).a;
    s.pixelGrid = chrome(t, C::PixelGrid);
    // Titles over the theme's own canvas.
    s.darkCanvas = t == Theme::Dark;
    Color title = t == Theme::Dark ? s.titleOnDark : s.titleOnLight;
    s.title = Color{title.r, title.g, title.b, 1};
    s.titleAlpha = title.a;
    if (t == Theme::Dark) {
      s.cardFill = Color::hex(0x2C2C2C);
      s.cardText = Color::hex(0xFFFFFF);
      s.cardMuted = Color::hex(0xB3B3B3);
      s.cardBorder = Color::hex(0x444444);
    } else {
      s.cardFill = Color::hex(0xFFFFFF);
      s.cardText = Color::hex(0x1E1E1E);
      s.cardMuted = Color::hex(0x757575);
      s.cardBorder = Color::hex(0xE6E6E6);
    }
    return s;
  }
};

}  // namespace eng
