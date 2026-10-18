/**
 * Round 10's pieces for the Figma menu's commands (docs/editor.md "Round 10 — Menus, commands, left side and toolbar"):
 * File › Move to folder… (a dialog of the workspace's places), Cursor chat (/ : a bubble at the pointer), View ›
 * Memory usage (Figma's memory card, with the engine's other health notices: canvas/EngineHealth). Their looks are
 * unverified (no live capture); they use the DS's own parts. (Vector › Simplify vector / Offset vector are Figma's
 * tools since round 17b: canvas/PathToolbar.)
 */
import { t, useT } from "@/i18n";
import { presenceOf } from "../multiplayer/presence";
import { useEffect, useRef, useState } from "react";
import { Button, Dialog, RadioGroup, showToast } from "@/ds";
import { useEditor } from "../controller";
import { useUI } from "../hooks";
import { lastPointer } from "../commands";
import { fileOps } from "../objectCommands";
import { attachSpellcheck } from "../spellcheck";
import { EngineHealth } from "./EngineHealth";
import styles from "./CommandOverlays.module.css";

export function CommandOverlays() {
  const ed = useEditor();
  // The pointer over the canvas, for Cursor chat.
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (e.target === ed.canvas) lastPointer.set(ed, { x: e.clientX, y: e.clientY });
    };
    window.addEventListener("pointermove", move, { passive: true });
    const offSpelling = attachSpellcheck(ed);
    return () => {
      window.removeEventListener("pointermove", move);
      offSpelling();
    };
  }, [ed]);
  const move = useUI((s) => !!s.moveFileDialog);
  const chat = useUI((s) => s.cursorChat ?? null);
  return (
    <>
      {move && <MoveFileDialog />}
      {chat && <CursorChat at={chat} />}
      <EngineHealth />
    </>
  );
}

/** File › Move to folder…: Drafts and the workspace's folders; the file moves to the one picked. */
function MoveFileDialog() {
  useT();
  const ed = useEditor();
  const ops = fileOps(ed);
  const [places, setPlaces] = useState<{ id: string | null; name: string }[] | null>(null);
  const [to, setTo] = useState<string>("");
  useEffect(() => {
    let live = true;
    void ops?.folders().then((list) => live && setPlaces(list));
    return () => {
      live = false;
    };
  }, [ops]);
  const close = () => {
    ed.ui.set({ moveFileDialog: false });
    ed.focusCanvas();
  };
  const value = (id: string | null) => id ?? "drafts";
  return (
    <Dialog
      title={t("Move to folder")}
      open
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            {t("Cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={!to || !ops}
            onClick={() => {
              const place = places?.find((p) => value(p.id) === to);
              if (!ops || !place) return;
              void ops.moveTo(place.id).then(() => showToast({ message: t("Moved to {name}", { name: place.name }) }));
              close();
            }}
          >
            {t("Move")}
          </Button>
        </>
      }
    >
      <div className={styles.places} data-move-file="">
        {places ? <RadioGroup label={t("Folders")} value={to} options={places.map((p) => ({ value: value(p.id), label: p.name }))} onChange={setTo} /> : null}
      </div>
    </Dialog>
  );
}

/** Cursor chat (/): a bubble by the pointer; Enter sends (it stays a moment), Esc closes. */
/** Cursor chat ("/", R13 §1): a bubble at the pointer showing what you type, live for the others (52 characters), gone
 *  5 s after you stop typing; Esc, a click or leaving the field closes it. The engine draws the bubbles (setLocalChat; the
 *  others' through presence). */
function CursorChat({ at }: { at: { x: number; y: number } }) {
  useT();
  const ed = useEditor();
  const engine = ed.engine as unknown as { setLocalChat?(text: string | null, at: { x: number; y: number } | null): void; screenToWorld?(x: number, y: number): { x: number; y: number } };
  const [text, setText] = useState("");
  const pos = useRef(at);
  const [shown, setShown] = useState(at);
  const input = useRef<HTMLInputElement>(null);
  const close = () => {
    ed.ui.set({ cursorChat: null });
    ed.focusCanvas();
  };
  const draw = (t: string | null) => {
    if (ed.engine.destroyed || !engine.setLocalChat || !engine.screenToWorld) return;
    const r = ed.canvas?.getBoundingClientRect();
    const world = r ? engine.screenToWorld(pos.current.x - r.left, pos.current.y - r.top) : null;
    engine.setLocalChat(t, t === null ? null : world);
  };
  useEffect(() => {
    input.current?.focus();
    draw("");
    presenceOf(ed)?.setChat("");
    const move = (e: PointerEvent) => {
      pos.current = { x: e.clientX, y: e.clientY };
      setShown(pos.current);
      draw(input.current?.value ?? "");
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => {
      window.removeEventListener("pointermove", move);
      draw(null);
      presenceOf(ed)?.setChat(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- opened once per chat
  }, [ed]);
  // Gone 5 s after the last keystroke (R13 §1); the first wait is longer so an empty bubble doesn't vanish at once.
  useEffect(() => {
    const t = window.setTimeout(() => ed.ui.set({ cursorChat: null }), text ? 5000 : 8000);
    return () => window.clearTimeout(t);
  }, [text, ed]);
  return (
    <input
      ref={input}
      className={engine.setLocalChat ? styles.chatHidden : styles.chatInput}
      style={{ left: shown.x + 12, top: shown.y + 18 }}
      aria-label={t("Cursor chat")}
      placeholder={t("Say something")}
      value={text}
      maxLength={52}
      data-cursor-chat=""
      onChange={(e) => {
        setText(e.target.value);
        draw(e.target.value);
        presenceOf(ed)?.setChat(e.target.value);
      }}
      onBlur={close}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" || e.key === "Enter") close();
      }}
    />
  );
}
