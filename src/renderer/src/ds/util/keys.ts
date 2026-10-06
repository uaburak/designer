/** Is this a Mac (⌘ shortcuts)? */
export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * An action's keys as Figma writes them: on a Mac in Apple's order ⌃⌥⇧⌘
 * ("⇧⌘H"), elsewhere "Ctrl+Alt+Shift+H". `mod` is ⌘ / Ctrl.
 */
export function keys(parts: string[], mac = IS_MAC): string {
  // Apple's order ⌃⌥⇧⌘; elsewhere mod is Ctrl, so Ctrl+Alt+Shift.
  const order = mac ? ["ctrl", "alt", "shift", "mod"] : ["mod", "ctrl", "alt", "shift"];
  const rank = (p: string) => (order.includes(p) ? order.indexOf(p) : 9);
  const sorted = [...new Set(mac ? parts : parts.map((p) => (p === "mod" ? "ctrl" : p)))].sort((a, b) => rank(a) - rank(b));
  const macMap: Record<string, string> = { mod: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃", backspace: "⌫", delete: "⌦", enter: "↵", escape: "Esc", tab: "⇥", up: "↑", down: "↓", left: "←", right: "→" };
  const other: Record<string, string> = { mod: "Ctrl", shift: "Shift", alt: "Alt", ctrl: "Ctrl", backspace: "Backspace", delete: "Del", enter: "Enter", escape: "Esc", tab: "Tab", up: "Up", down: "Down", left: "Left", right: "Right" };
  const map = mac ? macMap : other;
  const label = (p: string) => map[p] ?? (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1));
  return mac ? sorted.map(label).join("") : sorted.map(label).join("+");
}
