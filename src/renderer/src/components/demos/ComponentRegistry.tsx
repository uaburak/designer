import React, { useState } from "react";
import { PillButton } from "@/components/Button";
import { Segmented } from "@/components/Segmented";
import { Input } from "@/components/Input";

// ── Interactive Component Demos ──────────────────────────────────────────────

function ButtonDemo() {
  const [clicked, setClicked] = useState(false);
  const [count, setCount] = useState(0);

  return (
    <div className="flex flex-wrap items-center justify-center gap-3 p-6 select-none">
      <PillButton onClick={() => setClicked(!clicked)}>
        {clicked ? "✓ Tıklandı!" : "Primary Button"}
      </PillButton>
      <PillButton variant="ghost" onClick={() => setCount((c) => c + 1)}>
        Sayaç: {count}
      </PillButton>
    </div>
  );
}

function SegmentedDemo() {
  const [tab, setTab] = useState("Tasarım");
  return (
    <div className="flex flex-col items-center justify-center gap-4 p-6 select-none w-full">
      <Segmented options={["Tasarım", "Kod", "Önizleme"]} value={tab} onChange={setTab} size="md" />
      <p className="text-xs font-light text-[var(--text-subtitle)]">
        Seçilen Sekme: <span className="font-medium text-[var(--text-title)]">{tab}</span>
      </p>
    </div>
  );
}

function InputDemo() {
  const [val, setVal] = useState("");
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-6 w-full max-w-sm mx-auto">
      <Input
        placeholder="Bir şeyler yazın..."
        value={val}
        onChange={(e) => setVal(e.target.value)}
      />
      {val ? (
        <p className="text-xs font-light text-[var(--text-title)] bg-[var(--bg-1)] px-3 py-1.5 rounded-lg border border-[var(--border)]">
          Canlı Çıktı: <span className="font-medium">{val}</span>
        </p>
      ) : (
        <p className="text-xs font-light text-[var(--text-subtitle)] italic">
          Yazdığınız metin anında burada görünecek
        </p>
      )}
    </div>
  );
}

function CardWidgetDemo() {
  const [liked, setLiked] = useState(false);
  return (
    <div className="flex justify-center p-6 w-full">
      <div className="w-full max-w-xs rounded-2xl border border-[var(--border)] bg-[var(--bg-1)] p-4 flex flex-col gap-3 transition-all duration-200 hover:border-[var(--border-hover)] shadow-sm">
        <div className="h-28 w-full rounded-xl bg-gradient-to-tr from-indigo-500 via-purple-500 to-pink-500 flex items-center justify-center text-white text-xs font-medium">
          UI Component Demo
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-[var(--text-title)]">Kart Etkileşimi</span>
          <button
            type="button"
            onClick={() => setLiked(!liked)}
            className="text-xs px-2.5 py-1 rounded-full border border-[var(--border)] bg-[var(--bg-2)] hover:border-[var(--border-hover)] transition-colors"
          >
            {liked ? "❤️ Beğenildi" : "🤍 Beğen"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Registry Export ─────────────────────────────────────────────────────────

export interface ComponentRegistryItem {
  key: string;
  name: string;
  component: React.ComponentType;
  sampleCode: string;
}

export const COMPONENT_REGISTRY: Record<string, ComponentRegistryItem> = {
  ButtonDemo: {
    key: "ButtonDemo",
    name: "PillButton (Butonlar)",
    component: ButtonDemo,
    sampleCode: `import { useState } from 'react';
import { PillButton } from '@/components/Button';

export function ButtonDemo() {
  const [clicked, setClicked] = useState(false);
  const [count, setCount] = useState(0);

  return (
    <div className="flex items-center gap-3">
      <PillButton onClick={() => setClicked(!clicked)}>
        {clicked ? '✓ Tıklandı!' : 'Primary Button'}
      </PillButton>
      <PillButton variant="ghost" onClick={() => setCount((c) => c + 1)}>
        Sayaç: {count}
      </PillButton>
    </div>
  );
}`,
  },
  SegmentedDemo: {
    key: "SegmentedDemo",
    name: "Segmented Control",
    component: SegmentedDemo,
    sampleCode: `import { useState } from 'react';
import { Segmented } from '@/components/Segmented';

export function SegmentedDemo() {
  const [tab, setTab] = useState('Tasarım');

  return (
    <div className="flex flex-col gap-3">
      <Segmented
        options={['Tasarım', 'Kod', 'Önizleme']}
        value={tab}
        onChange={setTab}
      />
      <p>Seçilen: {tab}</p>
    </div>
  );
}`,
  },
  InputDemo: {
    key: "InputDemo",
    name: "Input Field",
    component: InputDemo,
    sampleCode: `import { useState } from 'react';
import { Input } from '@/components/Input';

export function InputDemo() {
  const [val, setVal] = useState('');

  return (
    <div className="flex flex-col gap-2">
      <Input
        placeholder="Bir şeyler yazın..."
        value={val}
        onChange={(e) => setVal(e.target.value)}
      />
      {val && <p>Canlı Çıktı: {val}</p>}
    </div>
  );
}`,
  },
  CardWidgetDemo: {
    key: "CardWidgetDemo",
    name: "Card Widget",
    component: CardWidgetDemo,
    sampleCode: `import { useState } from 'react';

export function CardWidgetDemo() {
  const [liked, setLiked] = useState(false);

  return (
    <div className="w-full max-w-xs rounded-2xl border p-4 bg-[var(--bg-1)]">
      <div className="h-28 w-full rounded-xl bg-gradient-to-tr from-indigo-500 to-pink-500 flex items-center justify-center text-white text-xs">
        UI Component Demo
      </div>
      <div className="flex justify-between items-center mt-3">
        <span className="text-xs font-medium">Kart Etkileşimi</span>
        <button onClick={() => setLiked(!liked)} className="text-xs px-2 py-1 rounded-full border">
          {liked ? '❤️ Beğenildi' : '🤍 Beğen'}
        </button>
      </div>
    </div>
  );
}`,
  },
};

export function ComponentRenderer({ componentKey }: { componentKey?: string }) {
  if (!componentKey) return null;
  const item = COMPONENT_REGISTRY[componentKey];
  if (!item) return null;
  const Comp = item.component;
  return <Comp />;
}
