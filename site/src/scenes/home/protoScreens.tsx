// The prototype scene's two frames, "Product" and "Detail", as a Figma file holds them: absolutely placed layers named
// as in the layers panel (`data-layer`), so Smart animate can match them by name. Design content (its own colours).
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import styles from "./prototype.module.css";

export const SCREEN_W = 240;
export const SCREEN_H = 480;

/** Card 1 in "Product" (the layer with the interaction), in frame coordinates. */
export const CARD = { x: 16, y: 96, w: 208, h: 196 };

const at = (x: number, y: number, w?: number, h?: number): CSSProperties => ({ left: x, top: y, width: w, height: h });

function Layer({ name, style, children, className, ...rest }: { name: string; style: CSSProperties; children?: ReactNode; className?: string } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div data-layer={name} className={`${styles.layer} ${className ?? ""}`} style={style} {...rest}>
      {children}
    </div>
  );
}

export function Chair() {
  return (
    <svg viewBox="0 0 100 100" width="100%" height="100%" aria-hidden="true">
      <ellipse cx="50" cy="90" rx="34" ry="4" fill="#00000014" />
      <path d="M30 16h40a9 9 0 0 1 9 9v31H21V25a9 9 0 0 1 9-9Z" fill="#d9774a" />
      <rect x="14" y="50" width="72" height="18" rx="9" fill="#c25f33" />
      <path d="M28 68 23 88M72 68l5 20" stroke="#5b3a29" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

function Table() {
  return (
    <svg viewBox="0 0 100 100" width="100%" height="100%" aria-hidden="true">
      <ellipse cx="50" cy="30" rx="34" ry="9" fill="#8a9a7b" />
      <path d="M50 38v44M34 86h32" stroke="#4d5a43" strokeWidth="5" strokeLinecap="round" />
    </svg>
  );
}

function Lamp() {
  return (
    <svg viewBox="0 0 100 100" width="100%" height="100%" aria-hidden="true">
      <path d="M34 14h32l10 30H24Z" fill="#e9b949" />
      <path d="M50 44v40M36 86h28" stroke="#5c4a24" strokeWidth="5" strokeLinecap="round" />
    </svg>
  );
}

function StatusBar({ dark }: { dark?: boolean }) {
  return (
    <Layer name="Status bar" style={at(0, 0, SCREEN_W, 28)} className={styles.status} data-dark={dark || undefined}>
      <span>9:41</span>
      <span className={styles.statusIcons} />
    </Layer>
  );
}

/** "Product": a list of furniture, the first card the hotspot. */
export function ProductScreen({ demo }: { demo?: string }) {
  return (
    <>
      <div className={styles.bg} style={{ background: "#f6f3ef" }} />
      <StatusBar />
      <Layer name="Title" style={at(16, 40)} className={styles.title}>
        Shop
      </Layer>
      <Layer name="Subtitle" style={at(16, 70)} className={styles.subtitle}>
        New arrivals
      </Layer>
      <Layer
        name="Card"
        style={at(CARD.x, CARD.y, CARD.w, CARD.h)}
        className={styles.card}
        data-demo={demo}
      >
        <Layer name="Image" style={{ ...at(0, 0, CARD.w, 128), background: "linear-gradient(160deg,#f3e2d3,#e7cdb6)", borderRadius: "12px 12px 4px 4px" }} />
        <Layer name="Chair" style={at(CARD.w / 2 - 40, 22, 80, 80)}>
          <Chair />
        </Layer>
        <Layer name="Name" style={at(12, 140)} className={styles.name}>
          Lounge Chair
        </Layer>
        <Layer name="Price" style={at(12, 160)} className={styles.price}>
          $420
        </Layer>
        <Layer name="Rating" style={at(CARD.w - 54, 142)} className={styles.rating}>
          ★ 4.9
        </Layer>
      </Layer>
      <Layer name="Small card" style={at(16, 304, 100, 120)} className={styles.small}>
        <span className={styles.smallImage} style={{ background: "#e3e8dc" }}>
          <Table />
        </span>
        <span className={styles.smallName}>Side Table</span>
        <span className={styles.smallPrice}>$180</span>
      </Layer>
      <Layer name="Small card" style={at(124, 304, 100, 120)} className={styles.small}>
        <span className={styles.smallImage} style={{ background: "#f4ead0" }}>
          <Lamp />
        </span>
        <span className={styles.smallName}>Floor Lamp</span>
        <span className={styles.smallPrice}>$140</span>
      </Layer>
      <Layer name="Tab bar" style={at(0, SCREEN_H - 48, SCREEN_W, 48)} className={styles.tabbar}>
        <span data-on="" />
        <span />
        <span />
        <span />
      </Layer>
    </>
  );
}

/** "Detail": the chair large, its name and price, Add to cart; Back on the arrow. */
export function DetailScreen({ demo }: { demo?: string }) {
  return (
    <>
      <div className={styles.bg} style={{ background: "#ffffff" }} />
      <Layer name="Image" style={{ ...at(0, 0, SCREEN_W, 224), background: "linear-gradient(160deg,#f3e2d3,#e7cdb6)", borderRadius: 0 }} />
      <Layer name="Chair" style={at(SCREEN_W / 2 - 72, 50, 144, 144)}>
        <Chair />
      </Layer>
      <StatusBar />
      <Layer name="Back" style={at(12, 34, 28, 28)} className={styles.back} data-demo={demo}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M10 3 5 8l5 5" fill="none" stroke="#1e1e1e" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Layer>
      <Layer name="Name" style={at(20, 240)} className={styles.detailName}>
        Lounge Chair
      </Layer>
      <Layer name="Price" style={at(20, 268)} className={styles.detailPrice}>
        $420
      </Layer>
      <Layer name="Rating" style={at(SCREEN_W - 70, 244)} className={styles.rating}>
        ★ 4.9
      </Layer>
      <Layer name="Description" style={at(20, 300, SCREEN_W - 40)} className={styles.description}>
        Solid oak frame and a deep, wool-covered seat. Made to order in four weeks.
      </Layer>
      <Layer name="Colors" style={at(20, 352)} className={styles.swatches}>
        <span style={{ background: "#c25f33" }} data-on="" />
        <span style={{ background: "#5b6b4e" }} />
        <span style={{ background: "#2f3b52" }} />
      </Layer>
      <Layer name="Button" style={at(20, SCREEN_H - 72, SCREEN_W - 40, 44)} className={styles.cta}>
        Add to cart
      </Layer>
    </>
  );
}
