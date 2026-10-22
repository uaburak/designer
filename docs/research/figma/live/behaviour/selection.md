# Selection — measured live in Figma (2026-10-22)

Measured in figma.com (Chrome, the owner's account) on a throwaway file "Selection test (Wecra)". Real mouse and key
events through the browser; the selection read after each step from Figma's own Plugin API (`figma.currentPage.selection`)
in the page. Clicks on the same spot were spaced ≥ 1 s apart (two quick clicks are a double-click).

Scene (page children, back to front): **FrameA** (top-level frame 600×400; children back→front: R1, G1 = group(R2, E1),
F2 = frame(R3), T1 text, L1 locked rect, H1 hidden rect, "Button inst A" = instance of Button), **Button** (main
component: Label text, Icon rect), "Button inst top" (top-level instance), **Chip** (component set: State=Default,
State=Hover), "Chip inst", **Section1** (section; child frame F3(R4)), **AL** (top-level auto layout frame; A0..A2).

## Click (left)
| # | Before | Action | Selection after |
|---|---|---|---|
| 1 | none | click R1 (child of top-level frame) | R1 |
| 2 | none | click R2 (inside group G1) | G1 |
| 3 | G1 | click R2 | **G1 (unchanged)** |
| 4 | none | click R3 (inside nested frame F2) | F2 |
| 5 | none | click Label inside instance in FrameA | the instance |
| 6 | that instance | click its Label | **instance (unchanged)** |
| 7 | none | click top-level instance | the instance |
| 8 | top-level instance | click on it (its Label) | **instance (unchanged)** |
| 9 | FrameA | click R1 | R1 (a top-level frame's child is always picked) |
| 10 | F2 | click R3 | **F2 (unchanged)** |
| 11 | none | click FrameA's empty background (it has children) | nothing |
| 12 | none | click locked L1 | nothing |
| 13 | none | click where hidden H1 is | nothing |
| K7 | none | click Section1's empty area | Section1 |
| K8 | none | click R4 (in F3, a frame inside the section) | R4 (frames directly in a section behave as top-level) |
| K11 | none | click F3's empty area (F3 has children) | nothing |
| K9 | none | click A0 (child of top-level auto layout frame) | A0 |
| AL-bg | none | click AL's padding or the gap between its children | **AL** — an auto layout frame's own background selects it (a plain frame's doesn't, #11) |
| BTN-bg | none | click the main component Button's background (not on Label / Icon) | **Button** |
| SET-bg | none | click the component set Chip's background between its variants | nothing (like a plain frame) |
| K10 | none | click variant State=Default (on its fill) | State=Default (the variant) |
| S1 | R2 (deep, in G1) | click E1 (R2's sibling) | E1 (same depth as the selection) |
| S2 | Label (deep, in instance) | click Icon (its sibling) | Icon |
| S3 | R2 (deep) | click R1 (outside the group) | R1 |

Rule: a click inside the bounds of an already-selected layer keeps it selected (it never goes one level down on a single
click). Going down takes a double-click or ⌘. Clicking a sibling of a deep selection picks that sibling at the same depth.

## Double-click
| K5 | none | double-click R2 | R2 |
| K12 | none | double-click R3 (in F2) | R3 |
| K6 | none | double-click top-level instance (on Label) | Label |

## Modifiers
| K1 | none | ⌘-click R2 | R2 |
| K2 | none | ⌘-click Label in instance | Label |
| K3 | G1 | ⇧-click R2 (G1's child) | **G1 (unchanged; the child is not added)** |
| K4 | R1 | ⇧-click R3 (in F2) | R1 + F2 (added at the depth a plain click picks) |

## Right-click (context menu)
| R1 | none | right-click R2 | G1 (what a left click picks); menu has "Select layer" |
| R2 | top-level instance | right-click on it | instance (unchanged) |
| R3 | FrameA | right-click R1 | **FrameA (unchanged)** — unlike a left click (#9), a right-click inside the selection keeps it |
| R4 | none | right-click FrameA's empty background | **FrameA** — unlike a left click (#11), which selects nothing |
| R5 | G1 | right-click R2 | G1 (unchanged) |
| R6 | R1 + F2 | right-click R3 (inside F2) | R1 + F2 (unchanged) |

## Marquee (drag on empty canvas)
| M1 | none | from outside over part of FrameA (crossing R1) | R1 (a partly covered top-level frame gives its children) |
| M2 | none | starting on FrameA's empty background, over R1 and part of G1 | R1, G1 (children of the frame it starts in) |
| M3 | none | from outside over part of the top-level instance | the instance (whole) |
| M5 | none | from outside over part of Section1, F3 and R4 | R4 |
| M6 | none | from outside over part of the main component Button | Button (the component, whole) |

## Dragging inside a selection
| MS | R1 + F2 | press on empty space inside their bounding box and drag | both move (the selection is dragged; no marquee) |

## Keyboard
| E1 | FrameA | Enter | all its children — R1, G1, F2, T1, **L1 (locked)**, **H1 (hidden)**, the instance |
| E11 | G1 | Enter | R2, E1 |
| E5 | top-level instance | Enter | its children (Label, Icon) |
| E2 | R1 | ⇧Enter | FrameA |
| E3 | R1 | Esc | **nothing (Esc clears; it does not go to the parent)** |
| E6 | Label inside instance | Esc | nothing |
| E7 | G1 | Esc | nothing |
| E8 | FrameA | Esc | nothing |
| E4 | R1 (first child) | Tab | "Button inst A" — Tab goes to the next layer DOWN the Layers panel (lower index), wrapping from the bottom to the top |
| E9 | R1 | Tab ×6 | G1 — order inst A, H1, L1, T1, F2, G1: **locked and hidden layers are not skipped** |
| E10 | R1 | ⇧Tab | G1 (next layer UP the panel, higher index) |
