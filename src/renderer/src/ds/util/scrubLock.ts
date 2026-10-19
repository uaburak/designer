/**
 * Figma's scrub pointer (docs/research/atlas/02-editor-chrome.md §4.5, `3187` ScrubManager): once a scrub starts the
 * pointer is locked, so a drag never stops at the screen's edge, and a 24 × 24 cursor of its own follows the movement,
 * wrapping around the window's edges. Where the pointer can't be locked (a test's DOM, a browser that refuses) the
 * scrub reads the pointer as before and the system cursor stays.
 */

/** The scrub cursor: a horizontal double arrow, black with a white edge, as the canvas cursors (engine/cursors.ts). */
const CURSOR_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">` +
  `<path d="M3 12 L7.5 7.5 V10.5 H16.5 V7.5 L21 12 L16.5 16.5 V13.5 H7.5 V16.5 Z" fill="#000" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
/** The cursor's hot spot (its middle) */
const HOT = 12;

/** What a move reads of a pointer event */
export type ScrubMove = { clientX: number; clientY: number; movementX?: number; movementY?: number };

/** Where `v` lands on a 0 … `size` axis, wrapping around (Figma's modulo by the window's width / height). */
export const wrap = (v: number, size: number): number => (size > 0 ? ((v % size) + size) % size : v);

export class ScrubLock {
  /** The pointer's position as if it could leave the window (CSS px; the client position until the lock holds) */
  x: number;
  y: number;
  private cursor: HTMLElement | null = null;
  private ended = false;
  private wasLocked = false;
  private readonly onChange = () => {
    const locked = document.pointerLockElement === this.el;
    if (locked) this.wasLocked = true;
    else if (this.wasLocked && !this.ended) this.onLost();
  };

  /** `onLost`: the lock went before the scrub ended (Esc, which the browser takes to unlock) */
  constructor(
    private readonly el: HTMLElement,
    at: { clientX: number; clientY: number },
    private readonly className: string,
    private readonly onLost: () => void
  ) {
    this.x = at.clientX;
    this.y = at.clientY;
  }

  /** Lock the pointer to the scrub (once it really is a scrub, past the click threshold). */
  lock(): void {
    if (typeof this.el.requestPointerLock !== "function" || document.pointerLockElement) return;
    document.addEventListener("pointerlockchange", this.onChange);
    try {
      const p = this.el.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => {});
    } catch {
      // Refused: the scrub goes on with the pointer as it is.
    }
  }

  /** Follow a pointer move: the movement while locked (the cursor drawn wrapped), else the pointer itself. */
  move(e: ScrubMove): void {
    if (document.pointerLockElement === this.el) {
      this.x += e.movementX ?? 0;
      this.y += e.movementY ?? 0;
      this.draw();
    } else {
      this.x = e.clientX;
      this.y = e.clientY;
    }
  }

  get locked(): boolean {
    return document.pointerLockElement === this.el;
  }

  end(): void {
    this.ended = true;
    document.removeEventListener("pointerlockchange", this.onChange);
    if (document.pointerLockElement === this.el) document.exitPointerLock();
    this.cursor?.remove();
    this.cursor = null;
  }

  private draw(): void {
    if (!this.cursor) {
      const c = document.createElement("div");
      c.className = this.className;
      c.setAttribute("data-ds-scrub-cursor", "");
      c.innerHTML = CURSOR_SVG;
      document.body.appendChild(c);
      this.cursor = c;
    }
    this.cursor.style.transform = `translate(${wrap(this.x, window.innerWidth) - HOT}px, ${wrap(this.y, window.innerHeight) - HOT}px)`;
  }
}
