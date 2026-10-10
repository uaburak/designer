/**
 * A haptic tick on the Mac's trackpad, as Figma's desktop app gives one on each step of a scrub (round 16): the
 * desktop app's preload hands `window.designer.haptics.tick`, which asks main (`haptics:tick`) to play macOS's
 * NSHapticFeedbackManager "alignment" pattern (docs/desktop.md §10.2 "Haptics"). Main throttles it; elsewhere (a
 * browser, another OS) nothing happens.
 */
type HapticsHost = { designer?: { haptics?: { tick(): void } } };

export function hapticTick(): void {
  if (typeof window === "undefined") return;
  try {
    (window as unknown as HapticsHost).designer?.haptics?.tick();
  } catch {
    // No desktop bridge, or it went away (the view is closing): no tick.
  }
}
