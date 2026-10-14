// @vitest-environment happy-dom
// Images from Figma (docs/desktop.md §13 "Images from Figma"): a paste's images ingested with their hash kept (or
// re-pointed when the bytes hash differently), the flow after a paste — the dialog without a token, the images at once
// with one, the dialog again with why when Figma refuses it — and the dialog's states. Fetch and the client are fakes.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { $, $$, click, mount, type, type Mounted } from "@/ds/__tests__/dom";
import type { FigmaApiError, FigmaResult } from "@shared/figmaApi";
import type { FigmaConnection, FigmaImagesResult } from "@shared/ipc";
import { bringImages, bringPastedFigmaImages, ingestFigmaImages, type ImageSink } from "../figmaImages";
import { memoryImageStore, sha1Hex } from "../images";
import type { FigmaClient } from "../../figma/connection";
import { webFigmaClient, WEB_TOKEN_KEY } from "../../figma/connection";
import { FigmaConnectDialog } from "../../figma/FigmaConnectDialog";
import { closeFigmaImages, figmaImagesPrompt } from "../../figma/FigmaImagesHost";

const PNG = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, n]);
const TOKEN = "figd_abcdefghijklmnopqrstuvwxyz0123456789";

function client(o: { connected?: boolean; images?: FigmaImagesResult; connect?: FigmaResult<FigmaConnection> } = {}): FigmaClient & { asked: string[][] } {
  const asked: string[][] = [];
  return {
    kind: "desktop",
    asked,
    status: async () => ({ connected: !!o.connected, user: null }),
    connect: async () => o.connect ?? { ok: true, value: { connected: true, user: { handle: "Ada", email: "ada@example.com" } } },
    disconnect: async () => ({ connected: false, user: null }),
    images: async (_k, hashes) => {
      asked.push(hashes);
      return o.images ?? { ok: true, value: { images: [], missing: hashes } };
    },
  };
}

function sink(): ImageSink & { got: string[]; renames: Map<string, string>[] } {
  const got: string[] = [];
  const renames: Map<string, string>[] = [];
  return { store: memoryImageStore(), arrived: (h) => got.push(...h), repoint: (r) => renames.push(r), got, renames };
}

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  closeFigmaImages();
  document.body.innerHTML = "";
});

describe("images from Figma", () => {
  it("stores each image as it is: same bytes, same hash; a different hash re-points the paints; non-images skipped", async () => {
    const s = sink();
    const a = PNG(1);
    const ha = await sha1Hex(a);
    const wrong = "f".repeat(40);
    const r = await ingestFigmaImages(s, [
      { hash: ha, bytes: a },
      { hash: wrong, bytes: PNG(2) },
      { hash: "e".repeat(40), bytes: new TextEncoder().encode("<html>no</html>") },
    ]);
    const hb = await sha1Hex(PNG(2));
    expect(r.stored).toEqual([ha, hb]);
    expect([...r.renames]).toEqual([[wrong, hb]]);
    expect(s.renames).toHaveLength(1);
    expect(await s.store!.get(ha)).toEqual(a);
    expect(s.got).toEqual([ha, hb, wrong]);
  });

  it("brings the images: brought and missing counted", async () => {
    const a = PNG(3);
    const ha = await sha1Hex(a);
    const c = client({ connected: true, images: { ok: true, value: { images: [{ hash: ha, bytes: a }], missing: ["b".repeat(40)] } } });
    expect(await bringImages(c, sink(), "AbCdEfGh123", [ha, "b".repeat(40)])).toEqual({ ok: true, brought: 1, missing: 1 });
  });

  const editor = (s: ImageSink) => ({ source: { images: s.store }, images: { arrived: s.arrived }, engine: { destroyed: false, encodeDocument: () => ({ nodeChanges: [] }) } }) as never;

  it("after a paste: no token → the dialog (the paste isn't held up); only the images the file lacks are asked for", async () => {
    const s = sink();
    const have = PNG(4);
    const hHave = await s.store!.put(have, "image/png");
    const c = client({ connected: false });
    await bringPastedFigmaImages(editor(s), "AbCdEfGh123", [hHave, "a".repeat(40)], c);
    const p = figmaImagesPrompt();
    expect(p?.pending?.count).toBe(1);
    expect(p?.reason).toBeNull();
    expect(c.asked).toEqual([]);
  });

  it("after a paste with a saved token: fetched at once; Figma refusing it opens the dialog with why", async () => {
    const s = sink();
    const a = PNG(5);
    const ha = await sha1Hex(a);
    const ok = client({ connected: true, images: { ok: true, value: { images: [{ hash: ha, bytes: a }], missing: [] } } });
    await bringPastedFigmaImages(editor(s), "AbCdEfGh123", [ha], ok);
    expect(ok.asked).toEqual([[ha]]);
    expect(s.got).toContain(ha);
    expect(figmaImagesPrompt()).toBeNull();
    for (const error of ["expired", "no-access"] as FigmaApiError[]) {
      const refused = client({ connected: true, images: { ok: false, error } });
      await bringPastedFigmaImages(editor(sink()), "AbCdEfGh123", ["c".repeat(40)], refused);
      expect(figmaImagesPrompt()?.reason).toBe(error);
    }
  });

  it("the web build keeps the token in this tab's session only", async () => {
    const storage = new Map<string, string>();
    const st = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) };
    const fetch = vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ handle: "Ada", email: "a@x.co" }), arrayBuffer: async () => new ArrayBuffer(0) }));
    const web = webFigmaClient(fetch, st);
    expect((await web.connect(TOKEN)).ok).toBe(true);
    expect(JSON.parse(storage.get(WEB_TOKEN_KEY)!).token).toBe(TOKEN);
    expect(await web.status()).toEqual({ connected: true, user: { handle: "Ada", email: "a@x.co" } });
    await web.disconnect();
    expect(storage.has(WEB_TOKEN_KEY)).toBe(false);
  });
});

describe("Bring images from Figma (dialog)", () => {
  const input = () => $("[data-figma-token] input") as HTMLInputElement;
  const connectButton = () => $("[data-figma-connect-button]") as HTMLButtonElement;
  const settle = async () => {
    for (let i = 0; i < 5; i++) await act(async () => {});
  };

  it("explains the steps, opens Figma's settings outside the app, connects, shows the account, brings the images", async () => {
    const openExternal = vi.fn();
    (window as unknown as { designer?: unknown }).designer = { openExternal };
    const run = vi.fn(async (progress: (d: number, t: number) => void) => {
      progress(1, 2);
      return { ok: true as const, brought: 2, missing: 0 };
    });
    const onClose = vi.fn();
    m = mount(FigmaConnectDialog, { client: client(), pending: { count: 2, run }, onClose });
    expect($('[role="dialog"]').textContent).toContain("Bring images from Figma");
    expect($$("ol li")).toHaveLength(6);
    expect(document.body.textContent).toContain("File content to Read-only");
    expect(input().type).toBe("password");
    click($("[data-figma-open-settings]"));
    expect(openExternal).toHaveBeenCalledWith("https://www.figma.com/settings");
    expect(connectButton().disabled).toBe(true);
    type(input(), TOKEN);
    expect(connectButton().disabled).toBe(false);
    click(connectButton());
    await settle();
    expect(run).toHaveBeenCalled();
    expect($("[data-figma-account]").textContent).toBe("Connected as Ada (ada@example.com)");
    expect(document.body.textContent).toContain("Brought 2 images from Figma.");
    click($("[data-figma-done]"));
    expect(onClose).toHaveBeenCalled();
    delete (window as unknown as { designer?: unknown }).designer;
  });

  it("says why a token was refused and stays on the form; Not now closes", async () => {
    const onClose = vi.fn();
    m = mount(FigmaConnectDialog, { client: client({ connect: { ok: false, error: "expired" } }), pending: { count: 1, run: async () => ({ ok: true, brought: 1, missing: 0 }) }, onClose });
    type(input(), TOKEN);
    click(connectButton());
    await settle();
    expect($('[data-figma-error="expired"]').textContent).toContain("This token has expired");
    expect($("[data-figma-connect]").getAttribute("data-figma-connect")).toBe("form");
    click($("[data-figma-not-now]"));
    expect(onClose).toHaveBeenCalled();
  });

  it("opened again after Figma refused the saved token: the reason first; no access to the file sends it back to the form", async () => {
    m = mount(FigmaConnectDialog, { client: client(), pending: { count: 1, run: async () => ({ ok: false as const, error: "no-access" as const }) }, reason: "invalid-token", onClose: () => {} });
    expect($('[data-figma-error="invalid-token"]')).toBeTruthy();
    type(input(), TOKEN);
    click(connectButton());
    await settle();
    expect($('[data-figma-error="no-access"]').textContent).toContain("Make sure you can open that file in Figma");
  });
});
