/**
 * Audio in a shared file (Figma's "Start conversation" / "Join conversation": one conversation per file; help.figma.com
 * 1500004414622; live README "Audio"). Peer to peer: everyone in the conversation holds one WebRTC connection to each
 * other person in it (a few people — Figma's own limit is small too), signalled through the file's room (`signal`
 * messages, never stored); who is in it is presence (`audio: {muted}`). The session with the lower number offers, so two
 * people never offer to each other at once. STUN only: people behind strict NATs may not hear each other (no TURN).
 *
 * Without a microphone (refused, or none) one still joins and listens; the mic button says so, as Figma's does.
 */

type Signal = { kind: "rtc"; type: "offer" | "answer"; sdp: string } | { kind: "rtc"; type: "ice"; candidate: RTCIceCandidateInit } | { kind: "rtc"; type: "bye" };

const ICE: RTCIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }, { urls: "stun:stun.l.google.com:19302" }];

export interface AudioState {
  inCall: boolean;
  muted: boolean;
  /** The microphone couldn't be opened: listening only */
  noMic: boolean;
  /** Sessions heard speaking now */
  speaking: number[];
}

export class AudioCall {
  state: AudioState = { inCall: false, muted: false, noMic: false, speaking: [] };
  private stream: MediaStream | null = null;
  private conns = new Map<number, RTCPeerConnection>();
  private players = new Map<number, HTMLAudioElement>();
  private meters = new Map<number, { analyser: AnalyserNode; data: Uint8Array<ArrayBuffer> }>();
  private ctx: AudioContext | null = null;
  private meterTimer: ReturnType<typeof setInterval> | null = null;
  private me = 0;

  constructor(
    private send: (to: number, data: Signal) => void,
    private changed: () => void,
  ) {}

  async join(): Promise<void> {
    if (this.state.inCall) return;
    let noMic = false;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch {
      this.stream = null;
      noMic = true;
    }
    this.state = { inCall: true, muted: noMic, noMic, speaking: [] };
    this.meterTimer = setInterval(() => this.measure(), 200);
    this.changed();
  }

  leave(): void {
    if (!this.state.inCall) return;
    for (const id of [...this.conns.keys()]) {
      this.send(id, { kind: "rtc", type: "bye" });
      this.drop(id);
    }
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    if (this.meterTimer) clearInterval(this.meterTimer);
    this.meterTimer = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.state = { inCall: false, muted: false, noMic: false, speaking: [] };
    this.changed();
  }

  setMuted(muted: boolean): void {
    if (!this.state.inCall || this.state.noMic) return;
    for (const t of this.stream?.getAudioTracks() ?? []) t.enabled = !muted;
    this.state = { ...this.state, muted };
    this.changed();
  }

  /** Who is in the conversation now (from presence): connections to new people (offered by the lower session), the
   *  ones who left dropped. */
  sync(me: number, inCall: number[]): void {
    this.me = me;
    if (!this.state.inCall || !me) return;
    const want = new Set(inCall.filter((id) => id !== me));
    for (const id of [...this.conns.keys()]) if (!want.has(id)) this.drop(id);
    for (const id of want) if (!this.conns.has(id) && me < id) void this.offer(id);
  }

  async signal(from: number, data: unknown): Promise<void> {
    const s = data as Signal;
    if (s?.kind !== "rtc") return;
    if (s.type === "bye") return this.drop(from);
    if (!this.state.inCall) return;
    try {
      if (s.type === "offer") {
        const pc = this.conns.get(from) ?? this.connect(from);
        await pc.setRemoteDescription({ type: "offer", sdp: s.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.send(from, { kind: "rtc", type: "answer", sdp: answer.sdp ?? "" });
      } else if (s.type === "answer") await this.conns.get(from)?.setRemoteDescription({ type: "answer", sdp: s.sdp });
      else if (s.type === "ice") await this.conns.get(from)?.addIceCandidate(s.candidate);
    } catch (e) {
      console.warn("[audio] signalling failed", e);
    }
  }

  private async offer(id: number): Promise<void> {
    const pc = this.connect(id);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.send(id, { kind: "rtc", type: "offer", sdp: offer.sdp ?? "" });
  }

  private connect(id: number): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    this.conns.set(id, pc);
    const track = this.stream?.getAudioTracks()[0];
    if (track && this.stream) pc.addTrack(track, this.stream);
    else pc.addTransceiver("audio", { direction: "recvonly" });
    pc.onicecandidate = (e) => e.candidate && this.send(id, { kind: "rtc", type: "ice", candidate: e.candidate.toJSON() });
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      let el = this.players.get(id);
      if (!el) {
        el = new Audio();
        el.autoplay = true;
        this.players.set(id, el);
      }
      el.srcObject = stream;
      void el.play().catch(() => {});
      this.meter(id, stream);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        this.drop(id);
        // The lower session tries again; the other waits for its offer.
        if (this.state.inCall && this.me && this.me < id) setTimeout(() => this.state.inCall && !this.conns.has(id) && void this.offer(id), 2000);
      }
    };
    return pc;
  }

  private drop(id: number): void {
    this.conns.get(id)?.close();
    this.conns.delete(id);
    const el = this.players.get(id);
    if (el) {
      el.srcObject = null;
      this.players.delete(id);
    }
    this.meters.delete(id);
  }

  /** A level meter per person, for the speaking ring */
  private meter(id: number, stream: MediaStream): void {
    try {
      this.ctx ??= new AudioContext();
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 256;
      this.ctx.createMediaStreamSource(stream).connect(analyser);
      this.meters.set(id, { analyser, data: new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount)) });
    } catch {
      // No meter: no speaking ring.
    }
  }

  private measure(): void {
    const speaking: number[] = [];
    for (const [id, m] of this.meters) {
      m.analyser.getByteFrequencyData(m.data);
      let sum = 0;
      for (const v of m.data) sum += v;
      if (sum / m.data.length > 18) speaking.push(id);
    }
    if (speaking.join() !== this.state.speaking.join()) {
      this.state = { ...this.state, speaking };
      this.changed();
    }
  }
}
