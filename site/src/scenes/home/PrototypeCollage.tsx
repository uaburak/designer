// Prototype: a product in the Shop frame is connected to the Product frame with a drag (the blue connection), the
// interaction is set (On tap › Navigate to › Smart animate, the app's Select fields), and the preview plays it: the
// picture grows from the list into the product page.
import { useState } from "react";
import { IconButton } from "@/ds/components/Button";
import { NumericInput } from "@/ds/components/NumericInput";
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

const SHOP = { x: 420, y: 112 };
const PRODUCT = { x: 760, y: 112 };
const PHONE = { w: 220, h: 440 };
const TILE = { x: 116, y: 100, w: 84 };

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
  const [noodle, setNoodle] = useState(false);
  const [popover, setPopover] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [select, setSelect] = useState(false);
  const me = usePointer([660, 600]);

  const from = { x: SHOP.x + TILE.x + TILE.w, y: SHOP.y + TILE.y + 40 };
  const to = { x: PRODUCT.x, y: PRODUCT.y + 120 };
  // The connection: from the product's right edge to the Product frame, a soft S
  const dx = (to.x - from.x) / 2;
  const c1: [number, number] = [from.x + dx, from.y];
  const c2: [number, number] = [to.x - dx, to.y];
  const end: [number, number] = [to.x - 6, to.y];
  const path = `M ${from.x} ${from.y} C ${c1[0]} ${c1[1]}, ${c2[0]} ${c2[1]}, ${end[0]} ${end[1]}`;
  const chip: [number, number] = [196, 588];

  const script = async (run: Run) => {
    await run.wait(1100);
    await me.click(run, [from.x - 40, from.y + 10]);
    setSelect(true);
    await run.wait(380);
    await me.to(run, [from.x, from.y], { ms: 420 });
    await run.wait(120);
    await me.drag(run, end, CONNECT, {
      ease: CONNECT_EASE,
      path: evenPoints((u) => cubicPoint([from.x, from.y], c1, c2, end, u), 32),
      start: () => setNoodle(true),
    });
    await run.wait(160);
    setPopover(true);
    await me.to(run, [end[0] + 24, end[1] + 30], { ms: 600, ease: BEZIER.standard });
    await run.wait(1200);
    await me.click(run, chip);
    setPlaying(true);
    // Idle: the preview replays now and then, cross-fading back to the list before each run
    for (let i = 0; !run.reduced; i++) {
      await run.wait(3400);
      setResetting(true);
      await run.wait(300);
      setPlaying(false);
      await run.wait(80);
      setResetting(false);
      await run.wait(900);
      await me.click(run, [chip[0] + (i % 2 ? 6 : -4), chip[1] + (i % 2 ? 2 : -2)], { ms: 700, ease: BEZIER.standard });
      setPlaying(true);
    }
  };

  return (
    <Collage size={[1312, 640]} focus={[0.54, 0.5]} safe={600} script={script}>
      {/* The preview, playing the flow */}
      <Piece x={64} y={72} w={PHONE.w + 20} h={PHONE.h + 20} d={160} from="left" className={styles.device}>
        <div className={styles.deviceScreen} data-resetting={resetting || undefined}>
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
      <Piece x={64 + (PHONE.w + 20) / 2 - 44} y={572} w={88} d={240}>
        <span className={styles.playChip} data-pressable="">
          <Icon name="16.play" /> Flow 1
        </span>
      </Piece>

      {/* The canvas */}
      <FrameName x={SHOP.x} y={SHOP.y}>
        Shop
      </FrameName>
      <Piece x={SHOP.x} y={SHOP.y} w={PHONE.w} h={PHONE.h} d={0} from="fade" className={styles.phoneFrame}>
        <Shop />
      </Piece>
      <FrameName x={PRODUCT.x} y={PRODUCT.y}>
        Product
      </FrameName>
      <Piece x={PRODUCT.x} y={PRODUCT.y} w={PHONE.w} h={PHONE.h} d={80} from="fade" className={styles.phoneFrame}>
        <Product />
      </Piece>
      <Selection box={{ x: SHOP.x + TILE.x - 4, y: SHOP.y + TILE.y - 4, w: TILE.w + 8, h: 132 }} show={select} handles={false} />
      <svg className={styles.noodle} data-on={noodle || undefined} width="1312" height="640" viewBox="0 0 1312 640" aria-hidden="true">
        <path d={path} pathLength={1} strokeDasharray="1 1" style={{ transition: `stroke-dashoffset ${CONNECT}ms ${css(CONNECT_EASE)}` }} />
        <circle cx={from.x} cy={from.y} r="4" />
        <path className={styles.noodleHead} style={{ transformOrigin: `${to.x - 1}px ${to.y}px` }} d={`M ${to.x - 9} ${to.y - 5} L ${to.x - 1} ${to.y} L ${to.x - 9} ${to.y + 5} Z`} />
      </svg>

      <Piece surface x={1012} y={150} w={240} show={popover} from="scale" origin="0 40px">
        <PanelColumn>
          <PanelSection title="Interaction" actions={<IconButton icon="24.close.small" label="Close" tone="secondary" />}>
            <PropertyGrid>
              <PropertyRow span={2}>
                <Select label="Trigger" prefix="24.proto.click" value="tap" options={[{ value: "tap", label: "On tap" }]} onChange={noop} />
              </PropertyRow>
              <PropertyRow span={2}>
                <Select label="Action" prefix="24.proto.navigate" value="nav" options={[{ value: "nav", label: "Navigate to" }]} onChange={noop} />
              </PropertyRow>
              <PropertyRow span={2}>
                <Select label="Destination" value="product" options={[{ value: "product", label: "Product" }]} onChange={noop} />
              </PropertyRow>
            </PropertyGrid>
          </PanelSection>
          <PanelSection title="Animation">
            <PropertyGrid>
              <PropertyRow span={2}>
                <Select label="Animation" value="smart" options={[{ value: "smart", label: "Smart animate" }]} onChange={noop} />
              </PropertyRow>
              <PropertyRow>
                <Select label="Easing" value="out" options={[{ value: "out", label: "Ease out" }]} onChange={noop} />
                <NumericInput label="Duration" value={300} unit="ms" onChange={noop} />
              </PropertyRow>
            </PropertyGrid>
          </PanelSection>
        </PanelColumn>
      </Piece>
      <Cursor {...me.state} color={CURSOR.ink} d={300} z={30} />
    </Collage>
  );
}
