/**
 * Where "Bring images from Figma" opens from code that isn't React (a paste, clipboardIO.ts): `askForFigmaImages`
 * shows the dialog; `FigmaImagesHost` (mounted once in the editor) draws it.
 */
import { useSyncExternalStore } from "react";
import type { FigmaApiError } from "@shared/figmaApi";
import type { FigmaClient } from "./connection";
import { FigmaConnectDialog, type PendingImages } from "./FigmaConnectDialog";

type Prompt = { client: FigmaClient; pending: PendingImages | null; reason: FigmaApiError | null } | null;

let prompt: Prompt = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Opens the dialog (replacing one already open). */
export function askForFigmaImages(client: FigmaClient, pending: PendingImages | null, reason: FigmaApiError | null = null): void {
  prompt = { client, pending, reason };
  emit();
}

export function closeFigmaImages(): void {
  prompt = null;
  emit();
}

export const figmaImagesPrompt = (): Prompt => prompt;

export function FigmaImagesHost() {
  const p = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => prompt
  );
  if (!p) return null;
  return <FigmaConnectDialog client={p.client} pending={p.pending} reason={p.reason} onClose={closeFigmaImages} />;
}
