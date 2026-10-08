// How the engine's canvas overlays look, per theme (docs/engine.md §6.11).
#pragma once

#include "scene/Node.h"

namespace eng {

enum class Theme : uint8_t { Light = 0, Dark = 1 };

struct OverlayStyle {
  Color canvas;          // the page background when the page has none
  Color selection;       // selection, hover, handles' border, badge, marquee
  Color component;       // the same for components, component sets and instances (Figma's purple)
  double hoverWidth = 2;
  double handleSize = 8;
  double handlesMinBox = 24;  // handles hidden when the box is smaller on screen
  double badgeHeight = 16;
  double badgeRadius = 2;
  double badgeGap = 6;
  double badgePadding = 4;  // the badge's and pills' text inset
  double labelSize = 11;    // badge and pill text: Inter Medium 11, white
  // Frame titles: Inter Regular 11, the baseline 10 px above the frame.
  double titleSize = 11;
  double titleBaselineGap = 10;
  Color title;
  double titleAlpha = 1;
  // Text editing: the selection highlight over the text.
  double textSelectionAlpha = 0.3;
  double marqueeFill = 0.1;
  // Smart guides, spacing and ⌥ measurement: 1 px lines and number pills.
  Color measure = Color::hex(0xF24822);
  double pillHeight = 16;
  double pillRadius = 2;
  double tick = 6;  // the end ticks of a measured distance
  // Auto layout: the padding / gap bands and the insertion indicator.
  Color autoLayoutBand = Color::hex(0xFF24BD);
  double bandAlpha = 0.15;
  double insertionWidth = 2;

  // Dev Mode: annotation labels (cards), saved measurements, status chips (unverified colours, R9 "Round 6").
  Color cardFill, cardText, cardMuted, cardBorder;
  double cardWidth = 240;
  double cardGap = 32;       // between the design's edge and its labels
  Color statusReady = Color::hex(0x14AE5C);
  Color statusChanged = Color::hex(0xFFCD29);  // --figma-color-bg-warning
  Color statusCompleted = Color::hex(0x8C8C8C);

  static OverlayStyle of(Theme t) {
    OverlayStyle s;
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
    if (t == Theme::Dark) {
      s.canvas = Color::hex(0x1E1E1E);
      s.selection = Color::hex(0x0C8CE9);
      s.component = Color::hex(0x8A38F5);
      s.title = Color::hex(0x898989);
    } else {
      s.canvas = Color::hex(0xF5F5F5);
      s.selection = Color::hex(0x0D99FF);
      s.component = Color::hex(0x9747FF);
      s.title = Color::hex(0x000000);
      s.titleAlpha = 0.5;
    }
    return s;
  }
};

}  // namespace eng
