/**
 * The engine's canvas: `<canvas id="engine-canvas">` filling its parent, an
 * Engine drawing into it, and a CanvasController feeding it input. `onReady`
 * hands the Engine to the caller once the document is loaded.
 */
import { useEffect, useRef, type CSSProperties } from "react";
import { CanvasController } from "./CanvasController";
import type { Message } from "./codec";
import { Engine, type EngineOptions } from "./Engine";

export interface EngineCanvasProps {
  document: Message;
  options?: EngineOptions;
  /** Zoom to fit once the canvas has its size (⇧1). */
  fit?: boolean;
  onReady?: (engine: Engine) => void;
  onError?: (error: Error) => void;
  style?: CSSProperties;
}

export function EngineCanvas({ document, options, fit = true, onReady, onError, style }: EngineCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let disposed = false;
    let engine: Engine | null = null;
    let detach: (() => void) | null = null;
    Engine.create(canvas, options)
      .then((created) => {
        if (disposed) return created.destroy();
        engine = created;
        engine.load(document);
        detach = new CanvasController(canvas, engine).attach();
        if (fit) engine.command("ZOOM_TO_FIT");
        canvas.focus({ preventScroll: true });
        onReady?.(engine);
      })
      .catch((error: unknown) => onError?.(error instanceof Error ? error : new Error(String(error))));
    return () => {
      disposed = true;
      detach?.();
      engine?.destroy();
    };
  }, [document, options, fit, onReady, onError]);

  return <canvas id="engine-canvas" ref={ref} style={{ display: "block", width: "100%", height: "100%", ...style }} />;
}
