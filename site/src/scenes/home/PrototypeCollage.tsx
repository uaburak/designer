// Prototype, in three steps (docs/site.md §2.1): a product in the Shop frame is dragged onto the Product frame (the
// blue connection grows with the cursor, on the drag's own curve; the frame it lands on lights); the interaction opens
// where it was dropped (On tap › Navigate to › Product, Smart animate: the app's Select fields); then the flow's Play
// button above the Shop frame is pressed and the preview window opens right under it, over the Shop frame, and plays
// the flow once: the picture grows from the list into the product page. Then the scene rests.
import { useState } from "react";
import { IconButton } from "@/ds/components/Button";
import { PanelSection } from "@/ds/components/PanelSection";
import { PropertyGrid, PropertyRow } from "@/ds/components/PropertyGrid";
import { Select } from "@/ds/components/Select";
import { Icon } from "@/ds/icons/Icon";
import { Collage, CURSOR, Cursor, FrameName, Piece, Selection, usePointer } from "../collage/kit";
import { noop, PanelColumn } from "../collage/ui";
import { BEZIER, css } from "../runtime/easing";
import type { Run } from "../runtime/motion";
import { cubicPoint, evenPoints } from "../runtime/path";
import { Plant } from "./art";
import styles from "./home.module.css";

const PHONE = { w: 220, h: 440 };
const SHOP = { x: 380, y: 136 };
const PRODUCT = { x: 700, y: 136 };
/** The preview window (a device), opened by Play right under it, its screen over the Shop frame. */
const DEVICE = { x: SHOP.x - 10, y: SHOP.y - 10 };
/** The product tile in the list (in the screen's px). */
const TILE = { x: 116, y: 100, w: 84 };
/** The flow's starting point over the Shop frame: its Play button (stage px). */
const FLOW = { x: SHOP.x, y: SHOP.y - 54 };
const PLAY: [number, number] = [FLOW.x + 14, FLOW.y + 12];

const PRODUCTS: [string, string, string][] = [
  ["Monstera", "$34", "#DCEFD9"],
  ["Fern", "$18", "#F3E6CF"],
  ["Pilea", "$22", "#E3E8F7"],
  ["Olive", "$46", "#F4DCD6"],
];

function Shop() {
  return (
    <div className={styles.screen}>
      <span className={styles.screenBrand}>Bloom</span>
      <span className={styles.screenSearch}>Search plants</span>
      <div className={styles.screenGrid}>
        {PRODUCTS.map(([name, price, ground]) => (
          <div key={name} className={styles.screenItem}>
            <div className={styles.screenThumb}>
              <Plant ground={ground} />
            </div>
            <span>{name}</span>
            <span className={styles.screenPrice}>{price}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Product() {
  return (
    <div className={styles.screen}>
      <div className={styles.screenHero}>
        <Plant ground="#F3E6CF" />
      </div>
      <ProductText />
    </div>
  );
}

function ProductText() {
  return (
    <div className={styles.screenText}>
      <span className={styles.screenTitle}>Fern</span>
      <span className={styles.screenPrice}>$18 · Small pot</span>
      <span className={styles.screenLines} />
      <span className={styles.screenCta}>Add to bag</span>
    </div>
  );
}

/** The connection's drag, ms, and its curve: the noodle draws and the cursor follows it in step. */
const CONNECT = 1100;
const CONNECT_EASE = BEZIER.standard;

export default function PrototypeCollage() {
  const [select, setSelect] = useState(false);
  const [noodle, setNoodle] = useState(false);
  const [target, setTarget] = useState(false);
  const [popover, setPopover] = useState(false);
  const [preview, setPreview] = useState(false);
  const [playing, setPlaying] = useState(false);
  const me = usePointer([560, 600]);

  const from = { x: SHOP.x + TILE.x + TILE.w, y: SHOP.y + TILE.y + 40 };
  const to = { x: PRODUCT.x, y: PRODUCT.y + 110 };
  // The connection: from the product's right edge to the Product frame, a soft S
  const dx = (to.x - from.x) / 2;
  const c1: [number, number] = [from.x + dx, from.y];
  const c2: [number, number] = [to.x - dx, to.y];
  const end: [number, number] = [to.x - 6, to.y];
  const path = `M ${from.x} ${from.y} C ${c1[0]} ${c1[1]}, ${c2[0]} ${c2[1]}, ${end[0]} ${end[1]}`;
  /** Where the drag is let go, on the Product frame; the interaction opens there. */
  const drop: [number, number] = [PRODUCT.x + 50, PRODUCT.y + 120];

  const script = async (run: Run) => {
    await run.wait(1100);
    // 1. The product is selected, and dragged by its connection handle onto the Product frame
    await me.click(run, [from.x - 40, from.y + 10], { beat: 260 });
    setSelect(true);
    await run.wait(500);
    await me.to(run, [from.x, from.y], { ms: 420 });
    await run.wait(200);
    await me.drag(run, end, CONNECT, {
      ease: CONNECT_EASE,
      path: evenPoints((u) => cubicPoint([from.x, from.y], c1, c2, end, u), 32),
      release: false,
      start: () => setNoodle(true),
    });
    setTarget(true);
    await me.drag(run, drop, 420, { ease: BEZIER.out });
    setTarget(false);
    // 2. The interaction opens where it was dropped
    setPopover(true);
    await run.wait(1600);
    // 3. Play: the preview opens under the flow's button and plays the flow once
    await me.click(run, PLAY, { beat: 300 });
    setPopover(false);
    setPreview(true);
    await run.wait(900);
    setPlaying(true);
  };

  return (
    <Collage size={[1312, 640]} focus={[0.525, 0.5]} safe={640} script={script}>
      {/* The canvas */}
      <Piece x={FLOW.x} y={FLOW.y} d={60} from="fade">
        <span className={styles.playChip} data-pressable="">
          <Icon name="16.play" /> Flow 1
        </span>
      </Piece>
      <FrameName x={SHOP.x} y={SHOP.y}>
        Shop
      </FrameName>
      <Piece x={SHOP.x} y={SHOP.y} w={PHONE.w} h={PHONE.h} d={0} from="fade" className={styles.phoneFrame}>
        <Shop />
      </Piece>
      <FrameName x={PRODUCT.x} y={PRODUCT.y} selected={target}>
        Product
      </FrameName>
      <Piece x={PRODUCT.x} y={PRODUCT.y} w={PHONE.w} h={PHONE.h} d={80} from="fade" className={styles.phoneFrame}>
        <Product />
      </Piece>
      <Selection box={{ x: PRODUCT.x, y: PRODUCT.y, w: PHONE.w, h: PHONE.h }} show={target} handles={false} ms={0} />
      <Selection box={{ x: SHOP.x + TILE.x - 4, y: SHOP.y + TILE.y - 4, w: TILE.w + 8, h: 132 }} show={select} handles={false} />
      <svg className={styles.noodle} data-on={noodle || undefined} width="1312" height="640" viewBox="0 0 1312 640" aria-hidden="true">
        <path d={path} pathLength={1} strokeDasharray="1 1" style={{ transition: `stroke-dashoffset ${CONNECT}ms ${css(CONNECT_EASE)}` }} />
        <circle cx={from.x} cy={from.y} r="4" />
        <path className={styles.noodleHead} style={{ transitionDelay: `${CONNECT - 80}ms` }} d={`M ${to.x - 9} ${to.y - 5} L ${to.x - 1} ${to.y} L ${to.x - 9} ${to.y + 5} Z`} />
      </svg>

      <Piece surface x={drop[0] + 8} y={drop[1] - 24} w={240} show={popover} from="scale" origin="0 24px" z={22}>
        <PanelColumn>
          <PanelSection title="Interaction" actions={<IconButton icon="24.close.small" label="Close" tone="secondary" />}>
            <PropertyGrid>
              <PropertyRow span={2}>
                <Select label="Trigger" prefix="24.proto.click" value="tap" options={[{ value: "tap", label: "On tap" }]} onChange={noop} />
              </PropertyRow>
              <PropertyRow>
                <Select label="Action" prefix="24.proto.navigate" value="nav" options={[{ value: "nav", label: "Navigate to" }]} onChange={noop} />
                <Select label="Destination" value="product" options={[{ value: "product", label: "Product" }]} onChange={noop} />
              </PropertyRow>
              <PropertyRow span={2}>
                <Select label="Animation" value="smart" options={[{ value: "smart", label: "Smart animate" }]} onChange={noop} />
              </PropertyRow>
            </PropertyGrid>
          </PanelSection>
        </PanelColumn>
      </Piece>

      {/* The preview window, opened by Play under the flow's button */}
      <Piece x={DEVICE.x} y={DEVICE.y} w={PHONE.w + 20} h={PHONE.h + 20} show={preview} from="scale" origin="24px 0" z={24} className={styles.device}>
        <div className={styles.deviceScreen}>
          <div className={styles.previewShop} data-out={playing || undefined}>
            <Shop />
          </div>
          <div className={styles.previewProduct} data-on={playing || undefined}>
            <ProductText />
          </div>
          {/* Smart animate: the same picture, from its tile in the list to the top of the product page */}
          <div className={styles.previewHero} style={{ transform: playing ? "none" : `translate(${TILE.x}px, ${TILE.y}px) scale(${TILE.w / PHONE.w})` }}>
            <Plant ground="#F3E6CF" />
          </div>
        </div>
      </Piece>
      <Cursor {...me.state} color={CURSOR.ink} d={300} z={30} />
    </Collage>
  );
}
