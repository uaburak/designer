// gifenc 1.0.3 (mattdesl, MIT) ships no types: what docs/motion.md §7.4 uses.
declare module "gifenc" {
  export type GifFormat = "rgb565" | "rgb444" | "rgba4444";
  export interface GifEncoderOptions {
    auto?: boolean;
    initialCapacity?: number;
  }
  export interface GifFrameOptions {
    palette?: number[][];
    first?: boolean;
    transparent?: boolean;
    transparentIndex?: number;
    delay?: number;
    repeat?: number;
    dispose?: number;
  }
  export interface GifEncoderInstance {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: GifFrameOptions): void;
    writeHeader(): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    reset(): void;
  }
  export function GIFEncoder(opts?: GifEncoderOptions): GifEncoderInstance;
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, opts?: { format?: GifFormat; oneBitAlpha?: boolean | number; clearAlpha?: boolean; clearAlphaThreshold?: number; clearAlphaColor?: number }): number[][];
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: number[][], format?: GifFormat): Uint8Array;
  export function prepalette(rgba: Uint8Array, format?: GifFormat): Uint8Array;
  export function nearestColorIndex(palette: number[][], pixel: number[]): number;
  export function nearestColor(palette: number[][], pixel: number[]): number[];
  export function snapColorsToPalette(palette: number[][], knownColors: number[][], threshold?: number): void;
}
