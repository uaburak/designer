// Libraries and multiplayer: two screens built from a library's components (Button, Tag, Card instances). The
// library changed: the app's toast offers Review, the Libraries dialog's Updates tab lists what changed with each
// one's review (Current / Updated, side by side or overlaid), and "Update all" or "Update" moves every instance to the
// new version. Two collaborators work in the file — Figma's coloured cursors and name pills, one with a selection —
// and they talk in cursor chat.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button, IconButton } from "@/ds/components/Button";
import { Dialog } from "@/ds/components/Dialog";
import { Avatar, EmptyState } from "@/ds/components/Misc";
import { SegmentedControl } from "@/ds/components/SegmentedControl";
import { Tabs } from "@/ds/components/Tabs";
import { Toast } from "@/ds/components/Toast";
import { Icon } from "@/ds/icons/Icon";
import libs from "@/editor/panels/libraries/Libraries.module.css";
import { FrameLabel, SceneBody, SceneCanvas, SceneWindow, type Box } from "../kit/kit";
import { DemoCursor, useDemo, type SceneRun } from "../runtime/useDemo";
import { clamp, useSize } from "./shared";
import styles from "./together.module.css";

type Asset = "button" | "tag" | "card";
type Versions = Record<Asset, 1 | 2>;
const OLD: Versions = { button: 1, tag: 1, card: 1 };

const ASSETS: { id: Asset; name: string; instances: number }[] = [
  { id: "button", name: "Button", instances: 2 },
  { id: "tag", name: "Tag", instances: 3 },
  { id: "card", name: "Card", instances: 4 },
];

// ---- The library's components (design content), each in its two versions ----------------------------------------

function LibButton({ v, children, style }: { v: 1 | 2; children: ReactNode; style?: CSSProperties }) {
  return (
    <span className={styles.btn} data-v={v} style={style}>
      {children}
    </span>
  );
}
function LibTag({ v, children }: { v: 1 | 2; children: ReactNode }) {
  return (
    <span className={styles.tag} data-v={v}>
      {children}
    </span>
  );
}
function LibCard({ v, children, style }: { v: 1 | 2; children: ReactNode; style?: CSSProperties }) {
  return (
    <div className={styles.card} data-v={v} style={style}>
      {children}
    </div>
  );
}

function Thumb({ asset, v, size }: { asset: Asset; v: 1 | 2; size: number }) {
  return (
    <span className={styles.thumb} style={{ width: size, height: size }} aria-hidden="true">
      <span className={styles.thumbInner} style={{ transform: `scale(${size / 120})` }}>
        {asset === "button" ? (
          <LibButton v={v} style={{ width: 96 }}>
            Button
          </LibButton>
        ) : asset === "tag" ? (
          <LibTag v={v}>In stock</LibTag>
        ) : (
          <LibCard v={v} style={{ width: 100, height: 64 }}>
            <span className={styles.thumbLine} />
            <span className={styles.thumbLine} style={{ width: "50%" }} />
          </LibCard>
        )}
      </span>
    </span>
  );
}

// ---- The two screens -----------------------------------------------------------------------------------------

const FRAME_W = 250;
const FRAME_H = 500;
const GAP = 56;
const WORLD_W = FRAME_W * 2 + GAP;

function Row({ v, tagV, name, price, tint }: { v: 1 | 2; tagV: 1 | 2; name: string; price: string; tint: string }) {
  return (
    <LibCard v={v}>
      <span className={styles.rowThumb} style={{ background: tint }} />
      <span className={styles.rowText}>
        <span className={styles.rowName}>{name}</span>
        <LibTag v={tagV}>In stock</LibTag>
      </span>
      <span className={styles.rowPrice}>{price}</span>
    </LibCard>
  );
}

function CartScreen({ ver }: { ver: Versions }) {
  return (
    <div className={styles.screen}>
      <span className={styles.h1}>Your cart</span>
      <span className={styles.sub}>2 items</span>
      <div className={styles.stack}>
        <Row v={ver.card} tagV={ver.tag} name="Lounge Chair" price="$420" tint="#f1dccb" />
        <Row v={ver.card} tagV={ver.tag} name="Floor Lamp" price="$140" tint="#f4ead0" />
      </div>
      <div className={styles.summary}>
        <span>Subtotal</span>
        <span>$560</span>
        <span>Shipping</span>
        <span>$38</span>
        <strong>Total</strong>
        <strong>$598</strong>
      </div>
      <LibButton v={ver.button} style={{ marginTop: "auto" }}>
        Checkout
      </LibButton>
    </div>
  );
}

function PaymentScreen({ ver, minaSelected }: { ver: Versions; minaSelected: boolean }) {
  return (
    <div className={styles.screen}>
      <span className={styles.h1}>Payment</span>
      <span className={styles.sub}>Choose how to pay</span>
      <div className={styles.stack}>
        <LibCard v={ver.card}>
          <span className={styles.payIcon} />
          <span className={styles.rowText}>
            <span className={styles.rowName}>Wallet</span>
            <span className={styles.rowMeta}>Pay in one tap</span>
          </span>
          <LibTag v={ver.tag}>Default</LibTag>
        </LibCard>
        <LibCard v={ver.card}>
          <span className={styles.payIcon} data-kind="card" />
          <span className={styles.rowText}>
            <span className={styles.rowName}>Card</span>
            <span className={styles.rowMeta}>Visa or Mastercard</span>
          </span>
        </LibCard>
        <LibCard v={ver.card}>
          <span className={styles.rowText}>
            <span className={styles.rowName}>Ship to</span>
            <span className={styles.rowMeta}>12 Harbour Street, Leeds</span>
          </span>
        </LibCard>
      </div>
      <LibButton v={ver.button} style={{ marginTop: "auto" }}>
        <span data-mina-target={minaSelected || undefined}>Pay $598</span>
      </LibButton>
    </div>
  );
}

// ---- Multiplayer -----------------------------------------------------------------------------------------------

interface Peer {
  id: "mina" | "jon";
  name: string;
  full: string;
  color: string;
}
const PEERS: Peer[] = [
  { id: "mina", name: "Mina", full: "Mina Park", color: "#9747ff" },
  { id: "jon", name: "Jon", full: "Jon Reyes", color: "#14ae5c" },
];
// Where each one goes (world px), and what Mina selects when she's there
const PATHS: Record<Peer["id"], { x: number; y: number; select?: boolean }[]> = {
  mina: [
    { x: 420, y: 470, select: true },
    { x: 470, y: 160 },
    { x: 380, y: 300 },
    { x: 450, y: 468, select: true },
    { x: 330, y: 120 },
  ],
  jon: [
    { x: 120, y: 200 },
    { x: 200, y: 330 },
    { x: 60, y: 120 },
    { x: 170, y: 460 },
    { x: 220, y: 90 },
  ],
};

function Cursor({ color, name, x, y, chat, flip, ms = 1600 }: { color: string; name: string; x: number; y: number; chat?: string | null; flip?: boolean; ms?: number }) {
  return (
    <div className={styles.cursor} data-flip={flip || undefined} style={{ transform: `translate3d(${x}px, ${y}px, 0)`, transitionDuration: `${ms}ms`, ["--c" as string]: color }} aria-hidden="true">
      <svg width="18" height="20" viewBox="0 0 18 20">
        <path d="M1.5 1.5 15.5 9.6l-6.2 1.6-3.3 6.3L1.5 1.5Z" fill={color} stroke="#fff" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
      {chat != null ? <span className={styles.bubble}>{chat || " "}</span> : <span className={styles.pill}>{name}</span>}
    </div>
  );
}

// ---- The scene --------------------------------------------------------------------------------------------------

interface Lib {
  banner: boolean;
  open: boolean;
  view: "libraries" | "updates";
  review: Asset | null;
  compare: "side" | "overlay";
  pending: Asset[];
  toast: string | null;
}
const LIB_FIRST: Lib = { banner: true, open: false, view: "updates", review: null, compare: "side", pending: ["button", "tag", "card"], toast: null };

export default function TogetherScene() {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [ver, setVer] = useState<Versions>(OLD);
  const [lib, setLib] = useState<Lib>(LIB_FIRST);
  const setL = useCallback((patch: Partial<Lib>) => setLib((s) => ({ ...s, ...patch })), []);
  const [at, setAt] = useState<Record<Peer["id"], number>>({ mina: 0, jon: 0 });
  const [chats, setChats] = useState<Record<string, string | null>>({ mina: null, jon: null });
  const timers = useRef<number[]>([]);
  const later = (fn: () => void, ms: number) => timers.current.push(window.setTimeout(fn, ms));
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // Accepting updates: every instance of each asset moves to the library's version, one asset after the other
  const accept = useCallback(
    (assets: Asset[]) => {
      assets.forEach((a, i) => later(() => setVer((v) => ({ ...v, [a]: 2 })), 120 + i * 160));
      setLib((s) => {
        const pending = s.pending.filter((p) => !assets.includes(p));
        return { ...s, pending, banner: pending.length > 0 && s.banner, review: null, open: pending.length > 0 && s.open, toast: assets.length === 1 ? "Updated" : `Updated ${assets.length} assets` };
      });
      later(() => setL({ toast: null }), 2600);
    },
    [setL],
  );

  // The collaborators move on their own while the scene is on screen (not with reduced motion)
  useEffect(() => {
    const root = rootRef.current;
    if (!root || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let visible = false;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
    io.observe(root);
    const step = (id: Peer["id"]) => {
      if (visible) setAt((s) => ({ ...s, [id]: (s[id] + 1) % PATHS[id].length }));
      tick[id] = window.setTimeout(() => step(id), 2200 + Math.random() * 1800);
    };
    const tick: Record<string, number> = {};
    tick.mina = window.setTimeout(() => step("mina"), 2600);
    tick.jon = window.setTimeout(() => step("jon"), 1400);
    return () => {
      io.disconnect();
      clearTimeout(tick.mina);
      clearTimeout(tick.jon);
    };
  }, []);

  // Fit the two screens in the canvas
  const size = useSize(canvasRef);
  const ws = clamp(Math.min((size.w - 48) / WORLD_W, (size.h - 72) / FRAME_H), 0.3, 1.15);
  const wx = Math.round((size.w - WORLD_W * ws) / 2);
  const wy = Math.round((size.h - FRAME_H * ws) / 2) + 10;
  const map = (p: { x: number; y: number }) => ({ x: wx + p.x * ws, y: wy + p.y * ws });

  // Mina's selection: the Pay button, while she is on it
  const minaAt = PATHS.mina[at.mina];
  const minaSelecting = !!minaAt.select;
  const [minaBox, setMinaBox] = useState<Box | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const el = canvas?.querySelector("[data-mina-target]")?.parentElement;
    if (!canvas || !el) return setMinaBox(null);
    const c = canvas.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    setMinaBox({ x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height });
  }, [minaSelecting, size, ver.button]);

  const say = useCallback((id: string, text: string | null, ms = 2600) => {
    setChats((c) => ({ ...c, [id]: text }));
    if (text !== null) timers.current.push(window.setTimeout(() => setChats((c) => ({ ...c, [id]: c[id] === text ? null : c[id] })), ms));
  }, []);

  const { cursor } = useDemo(rootRef, (run) => demo(run, setL, accept, say), {
    onStart: () => {
      setVer(OLD);
      setLib({ ...LIB_FIRST, banner: false });
      setChats({ mina: null, jon: null });
    },
  });

  const pendingCount = lib.pending.length;

  return (
    <SceneWindow ref={rootRef} title="Checkout — Wecra UI" className={styles.root}>
      <div className={styles.header}>
        <span className={styles.file}>
          <span className={styles.fileName}>Checkout</span>
          <span className={styles.fileMeta}>Wecra UI · 3 updates</span>
        </span>
        <span className={styles.faces}>
          {PEERS.map((p) => (
            <span key={p.id} className={styles.face} style={{ ["--c" as string]: p.color }} title={p.full}>
              <Avatar name={p.full} size={24} />
            </span>
          ))}
        </span>
        <IconButton icon="24.comment" label="Cursor chat" shortcut="/" />
        <Button variant="primary">Share</Button>
      </div>
      <SceneBody>
        <SceneCanvas ref={canvasRef} className={styles.canvas}>
          {size.w > 0 && (
            <>
              <FrameLabel x={wx} y={wy}>
                Cart
              </FrameLabel>
              <FrameLabel x={wx + (FRAME_W + GAP) * ws} y={wy}>
                Payment
              </FrameLabel>
              <div className={styles.world} style={{ transform: `translate(${wx}px, ${wy}px) scale(${ws})` }}>
                <div className={styles.frame} style={{ left: 0 }}>
                  <CartScreen ver={ver} />
                </div>
                <div className={styles.frame} style={{ left: FRAME_W + GAP }}>
                  <PaymentScreen ver={ver} minaSelected={minaSelecting} />
                </div>
              </div>
              {minaSelecting && minaBox && <div className={styles.peerSelection} style={{ left: minaBox.x - 2, top: minaBox.y - 2, width: minaBox.w + 4, height: minaBox.h + 4, ["--c" as string]: PEERS[0].color }} />}
              {PEERS.map((p) => {
                const q = map(PATHS[p.id][at[p.id]]);
                return <Cursor key={p.id} color={p.color} name={p.name} x={q.x} y={q.y} chat={chats[p.id]} flip={q.x > size.w - 150} />;
              })}
            </>
          )}
          {(lib.banner || lib.toast) && (
            <div className={styles.toastSpot} data-demo="toast">
              {lib.toast ? (
                <Toast static kind="success" message={lib.toast} />
              ) : (
                <Toast
                  static
                  message={pendingCount === 1 ? "1 library update available" : `${pendingCount} library updates available`}
                  action={{ label: "Review", onAction: () => setL({ open: true, view: "updates", review: null, banner: false }) }}
                  onClose={() => setL({ banner: false })}
                />
              )}
            </div>
          )}
          {lib.open && (
            <div className={styles.scrim} onPointerDown={(e) => e.target === e.currentTarget && setL({ open: false })}>
              <Dialog title="Libraries" size="medium" open static onClose={() => setL({ open: false })}>
                <div className={styles.dialogBody}>
                  <Tabs
                    label="Libraries"
                    value={lib.view}
                    tabs={[
                      { value: "libraries", label: "Libraries" },
                      { value: "updates", label: "Updates", badge: pendingCount || undefined },
                    ]}
                    onChange={(v) => setL({ view: v as Lib["view"], review: null })}
                  />
                  {lib.view === "libraries" ? (
                    <LibraryList />
                  ) : lib.review ? (
                    <Review asset={lib.review} compare={lib.compare} onCompare={(compare) => setL({ compare })} onBack={() => setL({ review: null })} onUpdate={() => accept([lib.review!])} />
                  ) : (
                    <Updates pending={lib.pending} onOpen={(review) => setL({ review })} onAll={() => accept(lib.pending)} />
                  )}
                </div>
              </Dialog>
            </div>
          )}
          <DemoCursor cursor={cursor} />
        </SceneCanvas>
      </SceneBody>
    </SceneWindow>
  );
}

function LibraryList() {
  return (
    <div className={libs.listBody}>
      <div className={libs.sectionTitle}>Enabled in this file</div>
      <div className={libs.libRow}>
        <span className={libs.libIcon}>
          <Icon name="24.library" />
        </span>
        <span className={libs.libText}>
          <span className={libs.libName}>Wecra UI</span>
          <span className={libs.meta}>24 components · 12 styles · 40 variables</span>
        </span>
      </div>
    </div>
  );
}

function Updates({ pending, onOpen, onAll }: { pending: Asset[]; onOpen: (a: Asset) => void; onAll: () => void }) {
  if (!pending.length) return <EmptyState icon="24.library" title="You're up to date" body="Updates to the libraries this file uses show up here." />;
  return (
    <div className={libs.listBody} data-updates="">
      <div className={libs.updatesHeader}>
        <span className={libs.meta}>{pending.length === 1 ? "1 update available" : `${pending.length} updates available`}</span>
        <Button variant="primary" onClick={onAll} data-demo="update-all">
          Update all
        </Button>
      </div>
      <section aria-label="Wecra UI">
        <div className={libs.sectionTitle}>Wecra UI</div>
        {ASSETS.filter((a) => pending.includes(a.id)).map((a) => (
          <button key={a.id} type="button" className={libs.updateRow} onClick={() => onOpen(a.id)} data-demo={`update-${a.id}`}>
            <Thumb asset={a.id} v={2} size={32} />
            <span className={libs.libText}>
              <span className={libs.libName}>{a.name}</span>
              <span className={libs.meta}>Modified · {a.instances} instances</span>
            </span>
            <Icon name="16.chevron.right" className={libs.caret} />
          </button>
        ))}
      </section>
    </div>
  );
}

function Review({ asset, compare, onCompare, onBack, onUpdate }: { asset: Asset; compare: "side" | "overlay"; onCompare: (c: "side" | "overlay") => void; onBack: () => void; onUpdate: () => void }) {
  const a = ASSETS.find((x) => x.id === asset)!;
  return (
    <div className={libs.listBody} data-review-update={a.name}>
      <div className={libs.previewHeader}>
        <IconButton icon="24.arrow.left" label="Back to updates" onClick={onBack} />
        <div className={libs.libText}>
          <span className={libs.libName}>{a.name}</span>
          <span className={libs.meta}>Wecra UI · Modified · {a.instances} instances in this file</span>
        </div>
        <SegmentedControl
          label="Compare"
          value={compare}
          options={[
            { value: "side", label: "Side by side" },
            { value: "overlay", label: "Overlay" },
          ]}
          onChange={(v) => onCompare(v as "side" | "overlay")}
        />
      </div>
      <div className={`${libs.compare} ${compare === "overlay" ? libs.compareOverlay : ""}`} data-compare={compare}>
        <figure className={libs.compareSide}>
          <Thumb asset={asset} v={1} size={120} />
          <figcaption className={libs.meta}>Current</figcaption>
        </figure>
        <figure className={libs.compareSide}>
          <Thumb asset={asset} v={2} size={120} />
          <figcaption className={libs.meta}>Updated</figcaption>
        </figure>
      </div>
      <div className={libs.reviewActions}>
        <Button variant="primary" onClick={onUpdate}>
          Update
        </Button>
      </div>
    </div>
  );
}

async function demo(run: SceneRun, setL: (p: Partial<Lib>) => void, accept: (a: Asset[]) => void, say: (id: string, text: string | null, ms?: number) => void) {
  await run.wait(1400);
  // The library changed: the toast offers Review
  setL({ banner: true });
  await run.wait(1200);
  const review = run.$('[data-demo="toast"] [data-ds="Button"]');
  await run.click(review);
  setL({ open: true, view: "updates", review: null, banner: false });
  await run.wait(900);
  // Look at the button's change, then update everything
  await run.click(run.$('[data-demo="update-button"]'));
  setL({ review: "button" });
  await run.wait(1500);
  await run.click(run.$('[aria-label="Back to updates"]'));
  setL({ review: null });
  await run.wait(600);
  await run.click(run.$('[data-demo="update-all"]'));
  accept(["button", "tag", "card"]);
  run.hide();
  await run.wait(1400);
  // Mina likes it
  const text = "Looks great!";
  for (let i = 1; i <= text.length; i++) {
    say("mina", text.slice(0, i), 4000);
    await run.wait(70);
  }
  await run.wait(1200);
  const reply = "Shipping it 🚀";
  for (let i = 1; i <= reply.length; i++) {
    say("jon", reply.slice(0, i), 3600);
    await run.wait(70);
  }
  await run.wait(3000);
}
