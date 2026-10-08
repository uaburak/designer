/**
 * The presentation's videos (help.figma.com 8878274530455 "Use videos in prototypes"): the engine's player decides
 * what each video does — Prototype › Video's autoplay, loop and sound, the video actions, state kept, shared and reset
 * (engine/src/proto/Player "Video") — and the browser plays them: one <video> per video layer shown, its file from the
 * file's image store (videos are stored as images are, by SHA-1). Each new frame goes back to the engine with the
 * video's time (engine_present_media_frame): the engine draws it in place of the poster (uploaded from the <video>
 * straight into a texture, on WebGL2 and WebGPU alike) and fires "When video hits" / "When video ends".
 */
import type { Engine, ImageSource, PresentVideo } from "@/engine/Engine";

interface Playing {
  el: HTMLVideoElement;
  hash: string;
  url: string | null;
  /** The last seek made (the engine's serial) */
  seekSerial: number;
  /** A seek waiting for the video's metadata */
  pendingSeek: number | null;
  lastTime: number;
  lastReport: number;
  frames: number;
  /** requestVideoFrameCallback said a new frame is there */
  fresh: boolean;
  callback: number;
}

/** The MIME type of a video file from its first bytes (MP4 / MOV / WebM), or "" (the browser sniffs). */
export function sniffVideoMime(bytes: Uint8Array): string {
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    return brand === "qt  " ? "video/quicktime" : "video/mp4";
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
  return "";
}

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (id: number) => void;
};

export class PresentationVideos {
  private readonly playing = new Map<string, Playing>();
  private readonly urls = new Map<string, Promise<string | null>>();
  private raf = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly engine: Engine,
    private readonly load: ImageSource | undefined,
    /** Where the <video> elements live (hidden; a detached video may not decode frames in every browser) */
    private readonly host: HTMLElement | null,
  ) {
    this.loop();
  }

  /** The videos playing now (scripts, tests). */
  get elements(): ReadonlyMap<string, HTMLVideoElement> {
    return new Map([...this.playing].map(([id, p]) => [id, p.el]));
  }

  dispose(): void {
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.timer) clearTimeout(this.timer);
    for (const p of this.playing.values()) this.drop(p);
    this.playing.clear();
    for (const u of this.urls.values()) void u.then((url) => url && URL.revokeObjectURL(url));
    this.urls.clear();
  }

  private readonly loop = (): void => {
    this.raf = 0;
    this.timer = null;
    if (this.disposed || this.engine.destroyed) return;
    let list: PresentVideo[] = [];
    try {
      list = this.engine.presentMedia();
    } catch {
      list = [];
    }
    this.sync(list);
    // Every frame while videos are shown; a few times a second otherwise (a screen with a video may come).
    if (list.length) this.raf = requestAnimationFrame(this.loop);
    else this.timer = setTimeout(this.loop, 200);
  };

  private url(hash: string): Promise<string | null> {
    let u = this.urls.get(hash);
    if (!u) {
      const load = this.load;
      u = (load ? load(hash) : Promise.resolve(null))
        .then((bytes) => (bytes ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: sniffVideoMime(bytes) || "video/mp4" })) : null))
        .catch(() => null);
      this.urls.set(hash, u);
    }
    return u;
  }

  private create(v: PresentVideo): Playing {
    const el = document.createElement("video") as FrameCallbackVideo;
    el.playsInline = true;
    el.preload = "auto";
    el.muted = v.muted;
    el.loop = v.loop;
    el.setAttribute("aria-hidden", "true");
    el.dataset.video = v.id;
    // Off screen but in the document: it decodes frames as a visible one does.
    Object.assign(el.style, { position: "absolute", left: "0", top: "0", width: "2px", height: "2px", opacity: "0.01", pointerEvents: "none" });
    this.host?.appendChild(el);
    const p: Playing = { el, hash: v.hash, url: null, seekSerial: 0, pendingSeek: null, lastTime: -1, lastReport: 0, frames: 0, fresh: true, callback: 0 };
    const watch = () => {
      if (this.disposed || !el.requestVideoFrameCallback) return;
      p.callback = el.requestVideoFrameCallback(() => {
        p.fresh = true;
        watch();
      });
    };
    watch();
    el.addEventListener("loadeddata", () => (p.fresh = true));
    el.addEventListener("seeked", () => (p.fresh = true));
    el.addEventListener("loadedmetadata", () => {
      if (p.pendingSeek !== null) {
        el.currentTime = p.pendingSeek;
        p.pendingSeek = null;
      }
    });
    void this.url(v.hash).then((url) => {
      if (this.disposed || !url) return;
      p.url = url;
      el.src = url;
    });
    return p;
  }

  private drop(p: Playing): void {
    const el = p.el as FrameCallbackVideo;
    if (p.callback && el.cancelVideoFrameCallback) el.cancelVideoFrameCallback(p.callback);
    el.pause();
    el.removeAttribute("src");
    el.load();
    el.remove();
    this.engine.forgetVideo(el);
  }

  private sync(list: PresentVideo[]): void {
    const shown = new Set<string>();
    for (const v of list) {
      shown.add(v.id);
      let p = this.playing.get(v.id);
      if (p && p.hash !== v.hash) {
        this.drop(p);
        this.playing.delete(v.id);
        p = undefined;
      }
      if (!p) {
        p = this.create(v);
        this.playing.set(v.id, p);
      }
      const el = p.el;
      if (el.loop !== v.loop) el.loop = v.loop;
      if (el.muted !== v.muted) el.muted = v.muted;
      // A jump the engine asked for (Set to specific time, Jump forward / backward, a shared or reset state).
      if (v.seek !== null && v.seekSerial > p.seekSerial) {
        p.seekSerial = v.seekSerial;
        if (el.readyState >= HTMLMediaElement.HAVE_METADATA) el.currentTime = v.seek;
        else p.pendingSeek = v.seek;
        p.fresh = true;
      } else if (v.seekSerial > p.seekSerial) {
        p.seekSerial = v.seekSerial;
      }
      if (v.playing && el.paused && !(el.ended && !v.loop && v.ended)) {
        el.play().catch(() => {
          // The browser won't start it with sound before the viewer interacts: muted, as browsers allow.
          if (!el.muted && !this.disposed) {
            el.muted = true;
            el.play().catch(() => {});
          }
        });
      } else if (!v.playing && !el.paused) {
        el.pause();
      }
      // What the engine hears: each new frame (or, without frame callbacks, every frame while it plays), and the time.
      const ready = el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && el.videoWidth > 0;
      const moved = el.currentTime !== p.lastTime;
      const fresh = p.fresh || (!("requestVideoFrameCallback" in el) && moved);
      if (ready && (fresh || moved || el.ended !== v.ended)) {
        p.fresh = false;
        p.lastTime = el.currentTime;
        p.frames++;
        this.engine.presentMediaFrame(v.id, {
          element: fresh || p.frames === 1 ? el : null,
          time: el.currentTime,
          duration: Number.isFinite(el.duration) ? el.duration : 0,
          ended: el.ended,
          seekSerial: p.pendingSeek === null ? p.seekSerial : p.seekSerial - 1,
        });
      }
    }
    // Off screen: paused (the engine keeps their state; shown again, they go on from where they were).
    for (const [id, p] of this.playing)
      if (!shown.has(id) && !p.el.paused) p.el.pause();
  }
}
