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
import { Collage, CURSOR, Cursor, FrameName, Piece, Selection } from "../collage/kit";
import { noop, PanelColumn } from "../collage/ui";
import { mix, type Run } from "../runtime/motion";
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

export default function PrototypeCollage() {
  const [noodle, setNoodle] = useState(0);
  const [popover, setPopover] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [select, setSelect] = useState(false);
  const [me, setMe] = useState<[number, number, boolean?]>([660, 600]);

  const from = { x: SHOP.x + TILE.x + TILE.w, y: SHOP.y + TILE.y + 40 };
  const to = { x: PRODUCT.x, y: PRODUCT.y + 120 };

  const script = async (run: Run) => {
    await run.wait(1200);
    setMe([from.x - 30, from.y]);
    await run.wait(1000);
    setSelect(true);
    setMe([from.x, from.y, true]);
    await run.wait(400);
    await run.tween(1100, (t) => {
      setNoodle(t);
      setMe([mix(from.x, to.x, t), mix(from.y, to.y, t) - Math.sin(t * Math.PI) * 40, true]);
    });
    setMe([to.x + 6, to.y + 4]);
    await run.wait(300);
    setPopover(true);
    await run.wait(1400);
    setMe([200, 590]);
    await run.wait(1100);
    setMe([200, 590, true]);
    await run.wait(160);
    setMe([200, 590]);
    setPlaying(true);
    for (let i = 0; !run.reduced; i++) {
      await run.wait(3600);
      setPlaying((p) => !p);
    }
  };

  // The connection: from the product's right edge to the Product frame, a soft S
  const dx = (to.x - from.x) / 2;
  const path = `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x - 6} ${to.y}`;

  return (
    <Collage size={[1312, 640]} focus={[0.54, 0.5]} safe={600} script={script}>
      {/* The preview, playing the flow */}
      <Piece x={64} y={72} w={PHONE.w + 20} h={PHONE.h + 20} d={350} from="left" className={styles.device}>
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
      <Piece x={64 + (PHONE.w + 20) / 2 - 44} y={572} w={88} d={450}>
        <span className={styles.playChip}>
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
      <Piece x={PRODUCT.x} y={PRODUCT.y} w={PHONE.w} h={PHONE.h} d={120} from="fade" className={styles.phoneFrame}>
        <Product />
      </Piece>
      <Selection box={{ x: SHOP.x + TILE.x - 4, y: SHOP.y + TILE.y - 4, w: TILE.w + 8, h: 132 }} show={select} handles={false} />
      <svg className={styles.noodle} width="1312" height="640" viewBox="0 0 1312 640" aria-hidden="true">
        <path d={path} pathLength={1} strokeDasharray="1" strokeDashoffset={1 - noodle} />
        {noodle > 0 && <circle cx={from.x} cy={from.y} r="4" />}
        {noodle >= 1 && <path className={styles.noodleHead} d={`M ${to.x - 9} ${to.y - 5} L ${to.x - 1} ${to.y} L ${to.x - 9} ${to.y + 5} Z`} />}
      </svg>

      <Piece surface x={1012} y={150} w={240} show={popover} from="scale">
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
      <Cursor x={me[0]} y={me[1]} press={me[2]} instant={noodle > 0 && noodle < 1} color={CURSOR.ink} d={400} z={30} />
    </Collage>
  );
}
