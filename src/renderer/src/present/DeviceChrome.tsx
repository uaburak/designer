/**
 * The device's own interface drawn over the prototype's screen (deviceUi.ts says what and how tall): laid out in
 * the device's points and scaled onto the screen, under the device's picture. Nothing here takes a click — the
 * prototype under it does.
 */
import type { CSSProperties, ReactNode } from "react";
import { cx } from "@/ds";
import { isDark, type ChromeLayout } from "./deviceUi";
import styles from "./DeviceChrome.module.css";

export interface DeviceChromeProps {
  layout: ChromeLayout;
  /** The whole screen on the canvas (CSS px) and CSS px per point */
  screen: { x: number; y: number; w: number; h: number };
  scale: number;
  /** The screen's corner radius (points) */
  radius: number;
  /** The prototype's own colour ("#rrggbb"): the bars' ink and tint follow it */
  screenColor?: string | null;
  /** What the address bar shows */
  site: string;
  /** Scrolled down (and not back up yet): Safari's tab bar shrinks to the address alone, as iOS 26's does */
  collapsed?: boolean;
}

export function DeviceChrome({ layout, screen, scale, radius, screenColor, site, collapsed = false }: DeviceChromeProps) {
  const w = screen.w / scale;
  const h = screen.h / scale;
  const dark = isDark(screenColor);
  const tint = screenColor ?? (dark ? "#000000" : "#ffffff");
  const { kind, status, toolbar, bottomBar, floatingBar, homeIndicator, top } = layout;
  const style = {
    width: w,
    height: h,
    borderRadius: radius,
    transform: `translate(${screen.x}px, ${screen.y}px) scale(${scale})`,
    "--tint": tint,
  } as CSSProperties;
  // Apple's scroll edge effect (iOS 26, iPadOS 26); Android's bars have none.
  const apple = kind === "iphone" || kind === "iphone-home" || kind === "ipad";
  return (
    <div className={cx(styles.root, dark && styles.dark, styles[kind])} style={style} data-device-chrome={kind} aria-hidden>
      {/* The page's top under the floating status bar (Safari's too): Apple's scroll edge effect (a progressive blur, a
          soft tint). */}
      {apple && status > 0 && toolbar === 0 && <EdgeEffect side="top" height={status + 12} />}
      {/* Opaque browser bars: the page starts under them. */}
      {toolbar > 0 && (
        <div className={styles.topBars} style={{ height: top }}>
          {status > 0 && <StatusBar layout={layout} width={w} />}
          <Toolbar layout={layout} site={site} />
        </div>
      )}
      {toolbar === 0 && status > 0 && <StatusBar layout={layout} width={w} />}
      {floatingBar && <EdgeEffect side="bottom" height={layout.landscape ? 70 : 110} />}
      {floatingBar && <SafariTabBar site={site} landscape={layout.landscape} collapsed={collapsed} />}
      {bottomBar > 0 && <ChromeBottomBar height={bottomBar} />}
      {homeIndicator && <div className={cx(styles.home, kind === "android" && styles.gesture, bottomBar > 0 && styles.homeOnBar)} />}
    </div>
  );
}

/** Apple's scroll edge effect: blur that grows toward the edge, in steps masked into each other, and a tint. */
function EdgeEffect({ side, height }: { side: "top" | "bottom"; height: number }) {
  const steps = [0.5, 1, 2, 4, 8, 16];
  const n = steps.length;
  return (
    <div className={cx(styles.edge, styles[`edge-${side}`])} style={{ height }}>
      {steps.map((blur, i) => {
        // Each step from its start to the edge: the stronger ones nearer it.
        const from = (i / n) * 100;
        const to = ((i + 1) / n) * 100;
        const dir = side === "top" ? "to top" : "to bottom";
        const mask = `linear-gradient(${dir}, transparent ${from}%, black ${to}%)`;
        return <div key={blur} className={styles.edgeStep} style={{ backdropFilter: `blur(${blur}px)`, WebkitMaskImage: mask, maskImage: mask }} />;
      })}
      <div className={styles.edgeTint} />
    </div>
  );
}

// ---- The system's bars -------------------------------------------------------------------------------------------

function StatusBar({ layout, width }: { layout: ChromeLayout; width: number }) {
  const { kind, status } = layout;
  if (kind === "mac") return <MacMenuBar height={status} browser={layout.toolbar > 0} />;
  if (kind === "android")
    return (
      <div className={cx(styles.status, styles.androidStatus)} style={{ height: status }}>
        <span className={styles.androidTime}>9:30</span>
        <span className={styles.icons}>
          <WifiIcon />
          <SignalIcon android />
          <BatteryIcon android />
        </span>
      </div>
    );
  if (kind === "ipad")
    return (
      <div className={cx(styles.status, styles.ipadStatus)} style={{ height: status }}>
        <span className={styles.ipadTime}>
          9:41 <span className={styles.ipadDate}>Mon Jun 10</span>
        </span>
        <span className={styles.icons}>
          <WifiIcon />
          <span className={styles.percent}>100%</span>
          <BatteryIcon />
        </span>
      </div>
    );
  // An iPhone: the time and the icons each centred in the room beside the Dynamic Island (125 pt), on its middle.
  const island = kind === "iphone";
  const side = island ? (width - 125) / 2 : width / 3;
  return (
    <div className={cx(styles.status, styles.iphoneStatus, !island && styles.homeStatus)} style={{ height: status }}>
      <span className={styles.side} style={{ width: side }}>
        <span className={styles.time}>9:41</span>
      </span>
      <span className={styles.side} style={{ width: side }}>
        <span className={styles.icons}>
          <SignalIcon />
          <WifiIcon />
          <BatteryIcon />
        </span>
      </span>
    </div>
  );
}

function MacMenuBar({ height, browser }: { height: number; browser: boolean }) {
  return (
    <div className={cx(styles.status, styles.macMenu)} style={{ height }}>
      <span className={styles.macLeft}>
        <AppleLogo />
        <b>{browser ? "Safari" : "Finder"}</b>
        {["File", "Edit", "View", "History", "Window", "Help"].map((m) => (
          <span key={m}>{m}</span>
        ))}
      </span>
      <span className={styles.macRight}>
        <WifiIcon />
        <BatteryIcon />
        <ControlCenterIcon />
        <span>Mon Jun 10 9:41 AM</span>
      </span>
    </div>
  );
}

// ---- Browsers ------------------------------------------------------------------------------------------------------

function Toolbar({ layout, site }: { layout: ChromeLayout; site: string }) {
  const { kind, toolbar } = layout;
  const browser = layout.browser;
  if (kind === "mac" || kind === "desktop") return browser === "safari" ? <SafariMacToolbar height={toolbar} site={site} /> : <ChromeDesktopToolbar height={toolbar} site={site} />;
  if (kind === "ipad")
    return browser === "safari" ? (
      <div className={cx(styles.toolbar, styles.safariPad)} style={{ height: toolbar }}>
        <Glyph d={SIDEBAR} />
        <Glyph d={BACK} />
        <Glyph d={FORWARD} dim />
        <span className={styles.padAddress}>
          <span className={styles.aa}>
            A<small>A</small>
          </span>
          <span className={styles.domain}>{site}</span>
          <Glyph d={RELOAD} small />
        </span>
        <Glyph d={SHARE} />
        <Glyph d={PLUS} />
        <Glyph d={TABS} />
      </div>
    ) : (
      <div className={cx(styles.toolbar, styles.chromeBar)} style={{ height: toolbar }}>
        <Glyph d={BACK} />
        <Glyph d={FORWARD} dim />
        <Glyph d={RELOAD} />
        <span className={styles.omnibox}>
          <Glyph d={TUNE} small />
          <span className={styles.domain}>{site}</span>
        </span>
        <Glyph d={PLUS} />
        <TabCount />
        <Glyph d={MORE_V} />
      </div>
    );
  if (kind === "android")
    return (
      <div className={cx(styles.toolbar, styles.chromeBar, styles.androidChrome)} style={{ height: toolbar }}>
        <Glyph d={HOME} />
        <span className={styles.omnibox}>
          <Glyph d={TUNE} small />
          <span className={styles.domain}>{site}</span>
        </span>
        <TabCount />
        <Glyph d={MORE_V} />
      </div>
    );
  // Chrome on an iPhone: the address bar at the top, the toolbar at the bottom.
  return (
    <div className={cx(styles.toolbar, styles.chromeBar, styles.chromePhone)} style={{ height: toolbar }}>
      <span className={styles.omnibox}>
        <Glyph d={TUNE} small />
        <span className={styles.domain}>{site}</span>
      </span>
    </div>
  );
}

function ChromeBottomBar({ height }: { height: number }) {
  return (
    <div className={styles.chromeBottom} style={{ height }}>
      <div className={styles.chromeBottomRow}>
        <Glyph d={BACK} />
        <Glyph d={FORWARD} dim />
        <Glyph d={PLUS} />
        <TabCount />
        <Glyph d={MORE_H} />
      </div>
    </div>
  );
}

/** Safari on iOS 26: a floating Liquid Glass bar — back, the address capsule, more. */
/** Scrolled down it shrinks to the address alone (smaller, lower, the buttons gone); scrolled up it comes back. */
function SafariTabBar({ site, landscape, collapsed }: { site: string; landscape: boolean; collapsed: boolean }) {
  return (
    <div className={cx(styles.safariBar, landscape && styles.safariBarLandscape, collapsed && styles.safariCollapsed)} data-collapsed={collapsed || undefined}>
      <span className={cx(styles.glass, styles.glassCircle)}>
        <Glyph d={BACK} />
      </span>
      <span className={cx(styles.glass, styles.glassAddress)}>
        <span className={styles.domain}>{site}</span>
        <Glyph d={RELOAD} small />
      </span>
      <span className={cx(styles.glass, styles.glassCircle)}>
        <Glyph d={MORE_H} />
      </span>
    </div>
  );
}

function SafariMacToolbar({ height, site }: { height: number; site: string }) {
  return (
    <div className={cx(styles.toolbar, styles.safariMac)} style={{ height }}>
      <TrafficLights />
      <Glyph d={SIDEBAR} />
      <Glyph d={BACK} />
      <Glyph d={FORWARD} dim />
      <span className={styles.macAddress}>
        <Glyph d={SHIELD} small />
        <span className={styles.domain}>{site}</span>
        <Glyph d={RELOAD} small />
      </span>
      <Glyph d={SHARE} />
      <Glyph d={PLUS} />
      <Glyph d={TABS} />
    </div>
  );
}

function ChromeDesktopToolbar({ height, site }: { height: number; site: string }) {
  return (
    <div className={styles.chromeDesktop} style={{ height }}>
      <div className={styles.tabStrip}>
        <TrafficLights />
        <span className={styles.tab}>
          <span className={styles.favicon} />
          <span className={styles.tabTitle}>{site}</span>
          <Glyph d={CLOSE} small />
        </span>
        <Glyph d={PLUS} small />
      </div>
      <div className={cx(styles.toolbar, styles.chromeDesktopBar)}>
        <Glyph d={BACK} />
        <Glyph d={FORWARD} dim />
        <Glyph d={RELOAD} />
        <span className={styles.omnibox}>
          <Glyph d={TUNE} small />
          <span className={styles.domain}>{site}</span>
        </span>
        <span className={styles.avatar} />
        <Glyph d={MORE_V} />
      </div>
    </div>
  );
}

// ---- Glyphs (drawn for these bars; 24-unit boxes, strokes) ----------------------------------------------------------

const BACK = "M15 5l-7 7 7 7";
const FORWARD = "M9 5l7 7-7 7";
const RELOAD = "M19 12a7 7 0 1 1-2.05-4.95M19 4v4h-4";
const PLUS = "M12 5v14M5 12h14";
const SHARE = "M12 3v12M8 7l4-4 4 4M6 11v9h12v-9";
const TABS = "M8 8h11v11H8zM5 16V5h11";
const SIDEBAR = "M4 5h16v14H4zM10 5v14";
const MORE_H = "M6 12h.01M12 12h.01M18 12h.01";
const MORE_V = "M12 6h.01M12 12h.01M12 18h.01";
const HOME = "M4 11l8-7 8 7M6 10v10h12V10";
const TUNE = "M4 8h10M18 8h2M4 16h2M10 16h10M14 6v4M6 14v4";
const SHIELD = "M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z";
const CLOSE = "M7 7l10 10M17 7L7 17";

function Glyph({ d, small, dim }: { d: string; small?: boolean; dim?: boolean }) {
  return (
    <svg className={cx(styles.glyph, small && styles.glyphSmall, dim && styles.dim)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={small ? 2 : 1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

function TabCount() {
  return <span className={styles.tabCount}>1</span>;
}

function TrafficLights() {
  return (
    <span className={styles.lights}>
      <i />
      <i />
      <i />
    </span>
  );
}

function SignalIcon({ android }: { android?: boolean }) {
  if (android)
    return (
      <svg className={styles.icon} viewBox="0 0 14 14" width={14} height={14}>
        <path d="M14 0v14H0z" fill="currentColor" />
      </svg>
    );
  return (
    <svg className={styles.icon} viewBox="0 0 18 12" width={18} height={12}>
      {[4, 6.5, 9, 12].map((bar, i) => (
        <rect key={bar} x={i * 5} y={12 - bar} width={3.2} height={bar} rx={1} fill="currentColor" />
      ))}
    </svg>
  );
}

/** Three wedges from one point, opening 90° upward. */
const WIFI = (() => {
  const cx0 = 8.5;
  const cy0 = 11.6;
  const at = (r: number, a: number) => `${(cx0 + r * Math.cos(a)).toFixed(2)} ${(cy0 + r * Math.sin(a)).toFixed(2)}`;
  const l = (-3 * Math.PI) / 4;
  const rt = -Math.PI / 4;
  const ring = (ri: number, ro: number) => `M${at(ro, l)}A${ro} ${ro} 0 0 1 ${at(ro, rt)}L${at(ri, rt)}A${ri} ${ri} 0 0 0 ${at(ri, l)}Z`;
  return [`M${cx0} ${cy0}L${at(3.9, l)}A3.9 3.9 0 0 1 ${at(3.9, rt)}Z`, ring(5.6, 8), ring(9.7, 12)].join("");
})();

function WifiIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 17 12" width={17} height={12}>
      <path d={WIFI} fill="currentColor" />
    </svg>
  );
}

function BatteryIcon({ android }: { android?: boolean }) {
  if (android)
    return (
      <svg className={styles.icon} viewBox="0 0 9 15" width={9} height={15}>
        <rect x={0} y={1.5} width={9} height={13.5} rx={1.5} fill="currentColor" />
        <rect x={2.8} y={0} width={3.4} height={2} rx={0.6} fill="currentColor" />
      </svg>
    );
  return (
    <svg className={styles.icon} viewBox="0 0 28 13" width={28} height={13}>
      <rect x={0.5} y={0.5} width={24} height={12} rx={3.8} fill="none" stroke="currentColor" strokeOpacity={0.35} />
      <rect x={2} y={2} width={21} height={9} rx={2.5} fill="currentColor" />
      <path d="M26 4.5v4c.8-.3 1.4-1.1 1.4-2s-.6-1.7-1.4-2z" fill="currentColor" fillOpacity={0.4} />
    </svg>
  );
}

function ControlCenterIcon() {
  return (
    <svg className={styles.icon} viewBox="0 0 16 14" width={16} height={14}>
      <rect x={0.75} y={0.75} width={14.5} height={5} rx={2.5} fill="none" stroke="currentColor" strokeWidth={1.3} />
      <circle cx={12.7} cy={3.25} r={1.4} fill="currentColor" />
      <rect x={0.75} y={8.25} width={14.5} height={5} rx={2.5} fill="none" stroke="currentColor" strokeWidth={1.3} />
      <circle cx={3.3} cy={10.75} r={1.4} fill="currentColor" />
    </svg>
  );
}

function AppleLogo(): ReactNode {
  return (
    <svg className={styles.icon} viewBox="0 0 14 17" width={13} height={16}>
      <path
        fill="currentColor"
        d="M11.6 9c0-2 1.7-3 1.8-3-1-1.4-2.5-1.6-3-1.7-1.3-.1-2.5.8-3.1.8-.7 0-1.7-.8-2.8-.7C3 4.4 1.7 5.2 1 6.5c-1.5 2.6-.4 6.4 1 8.5.7 1 1.5 2.1 2.6 2.1 1 0 1.4-.7 2.7-.7 1.2 0 1.6.7 2.7.7 1.1 0 1.8-1 2.5-2 .8-1.2 1.1-2.3 1.1-2.4 0 0-2-.8-2-3.7zM9.6 3c.6-.7 1-1.7.9-2.7-.9 0-1.9.6-2.5 1.3-.6.6-1 1.6-.9 2.6 1 .1 1.9-.5 2.5-1.2z"
      />
    </svg>
  );
}
