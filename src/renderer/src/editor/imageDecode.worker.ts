/**
 * The image worker (editor/imageDecode.ts): bytes in, a straight, unmanaged ImageBitmap out (transferred) with its
 * colour profile tag and the multi-frame GIF flag — Figma's image_io_worker.
 */
import { decodeStraight, type DecodeReply, type DecodeRequest } from "./imageDecode";

const scope = self as unknown as { onmessage: ((e: MessageEvent<DecodeRequest>) => void) | null; postMessage(m: DecodeReply, transfer?: Transferable[]): void };

scope.onmessage = async (e) => {
  const { id, bytes } = e.data;
  try {
    const d = await decodeStraight(bytes);
    scope.postMessage({ id, bitmap: d.bitmap, colorProfile: d.colorProfile, isMultiFrameGIF: d.isMultiFrameGIF }, [d.bitmap]);
  } catch (err) {
    scope.postMessage({ id, error: String(err) });
  }
};
