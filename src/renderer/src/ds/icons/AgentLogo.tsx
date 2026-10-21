import { useId, type CSSProperties, type ReactElement } from "react";

/**
 * The agents' own marks at 16 px (the Agents panel: the answer's name line, the step groups, the pinned progress, the
 * model menu, the settings rows) — drawn small and simple after each brand's mark, in its own colours: Claude Code's
 * orange burst, Codex's OpenAI knot (monochrome, as OpenAI draws it), Gemini's four-pointed star in its blue-violet-rose
 * gradient, Antigravity's arch in Google's, Cursor's cube (monochrome). The chrome's icons are `Icon` (currentColor
 * only); these are not, so they live beside it. Wecra's own manager keeps the sparkle (`16.sparkle`).
 */
export type AgentLogoId = "claude-code" | "codex" | "gemini" | "antigravity" | "cursor-agent";

const CLAUDE_RAYS = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];

const LOGOS: Record<AgentLogoId, (id: string) => ReactElement> = {
  "claude-code": () => (
    <g fill="#D97757">
      {CLAUDE_RAYS.map((r, i) => (
        <rect key={r} x="7.25" y={i % 2 ? 2.4 : 1.2} width="1.5" height={i % 2 ? 5.6 : 6.8} rx="0.75" transform={`rotate(${r} 8 8)`} />
      ))}
    </g>
  ),
  codex: () => (
    <g fill="none" stroke="currentColor" strokeWidth="1.1">
      {[0, 60, 120, 180, 240, 300].map((r) => (
        <ellipse key={r} cx="8" cy="5.1" rx="2.1" ry="3.1" transform={`rotate(${r} 8 8)`} />
      ))}
    </g>
  ),
  gemini: (id) => (
    <>
      <defs>
        <linearGradient id={id} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#1C7DFF" />
          <stop offset=".55" stopColor="#8A6BF5" />
          <stop offset="1" stopColor="#E9758C" />
        </linearGradient>
      </defs>
      <path fill={`url(#${id})`} d="M8 1c.5 3.6 2.6 6.1 7 7-4.4.9-6.5 3.4-7 7-.5-3.6-2.6-6.1-7-7 4.4-.9 6.5-3.4 7-7z" />
    </>
  ),
  antigravity: (id) => (
    <>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#4285F4" />
          <stop offset=".35" stopColor="#34A853" />
          <stop offset=".65" stopColor="#FBBC04" />
          <stop offset="1" stopColor="#EA4335" />
        </linearGradient>
      </defs>
      <path fill="none" stroke={`url(#${id})`} strokeWidth="2.2" strokeLinecap="round" d="M2.6 13.4C3.9 7.3 5.7 3 8 3s4.1 4.3 5.4 10.4" />
    </>
  ),
  "cursor-agent": () => (
    <g fill="currentColor">
      <path fillOpacity=".9" d="M8 1.5l5.6 3.25v6.5L8 14.5l-5.6-3.25v-6.5z" />
      <path fill="var(--figma-color-bg, #fff)" fillOpacity=".55" d="M8 8l5.6-3.25L8 1.5 2.4 4.75z" />
      <path fill="var(--figma-color-bg, #fff)" fillOpacity=".25" d="M8 8v6.5l5.6-3.25v-6.5z" />
    </g>
  ),
};

/** Whether an agent (a provider id) has a mark of its own. */
export const hasAgentLogo = (id: string | null | undefined): id is AgentLogoId => !!id && id in LOGOS;

export interface AgentLogoProps {
  /** A provider id ("claude-code", "codex", "antigravity", "cursor-agent") */
  id: AgentLogoId;
  size?: number;
  className?: string;
  style?: CSSProperties;
  /** An accessible name; without it the mark is decorative */
  label?: string;
}

export function AgentLogo({ id, size = 16, className, style, label }: AgentLogoProps) {
  const gradient = `agent-logo-${useId().replace(/:/g, "")}`;
  const draw = LOGOS[id];
  if (!draw) return null;
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true as const };
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} style={{ flexShrink: 0, ...style }} data-ds="AgentLogo" data-agent-logo={id} {...a11y}>
      {draw(gradient)}
    </svg>
  );
}
