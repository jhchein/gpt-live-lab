import { errorMessage, type Category, type TraceEvent } from "../../shared/protocol";

export interface AudioInputDevice { deviceId: string; label: string }
export interface AudioTransportStats {
  bytesSent?: number; bytesReceived?: number; inputEnergy?: number; outputEnergy?: number; inputDuration?: number;
}
export type RtcState = RTCPeerConnectionState | "none";
export interface AudioSnapshot {
  inputDevices: AudioInputDevice[];
  selectedInputId: string;
  activeMicLabel: string;
  inputLevel: number;
  micSignal: boolean;
  micTestActive: boolean;
  outputStatus: string;
  remoteAudio: boolean;
  audioBlocked: boolean;
  audioStats?: AudioTransportStats;
  audioStatsError: string;
}
export interface AudioPeer extends EventTarget {
  connectionState: RTCPeerConnectionState;
  iceGatheringState: RTCIceGatheringState;
  signalingState: RTCSignalingState;
  localDescription: RTCSessionDescriptionInit | null;
  onconnectionstatechange: ((event: Event) => void) | null;
  ontrack: RTCPeerConnection["ontrack"];
  addTrack: (track: MediaStreamTrack, stream: MediaStream) => unknown;
  createDataChannel: (label: string) => Pick<RTCDataChannel, "label" | "onopen">;
  createOffer: () => Promise<RTCSessionDescriptionInit>;
  setLocalDescription: (offer: RTCSessionDescriptionInit) => Promise<void>;
  setRemoteDescription: (answer: RTCSessionDescriptionInit) => Promise<void>;
  getStats: () => Promise<Pick<RTCStatsReport, "forEach">>;
  close: () => void;
}
export interface AudioPlatform {
  mediaDevices: MediaDevices;
  createPeer: () => AudioPeer;
  createContext?: () => AudioContext;
  frame: (callback: FrameRequestCallback) => number;
  cancelFrame: (id: number) => void;
}
interface Dependencies {
  player: () => HTMLAudioElement | null;
  changed: (state: AudioSnapshot) => void;
  connection: (state: RtcState) => void;
  error: (message: string) => void;
  trace: (type: string, label: string, payload: unknown, category?: Category,
    severity?: TraceEvent["severity"], durationMs?: number) => void;
  platform?: AudioPlatform;
}

const nativePlatform = (): AudioPlatform => ({
  mediaDevices: navigator.mediaDevices,
  createPeer: () => new RTCPeerConnection(),
  createContext: globalThis.AudioContext ? () => new AudioContext() : undefined,
  frame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (id) => cancelAnimationFrame(id),
});

export class BrowserAudio {
  private state: AudioSnapshot = {
    inputDevices: [], selectedInputId: "", activeMicLabel: "", inputLevel: 0, micSignal: false,
    micTestActive: false, outputStatus: "Waiting for audio", remoteAudio: false, audioBlocked: false, audioStatsError: "",
  };
  private peer?: AudioPeer;
  private stream?: MediaStream;
  private context?: AudioContext;
  private analyser?: AnalyserNode;
  private frame?: number;
  private statsTimer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private statsRun = 0;
  private iceCancel?: () => void;
  private capturing = false;

  constructor(private readonly deps: Dependencies) {}
  get snapshot() { return this.state; }
  private get platform() { return this.deps.platform ?? nativePlatform(); }
  private patch(patch: Partial<AudioSnapshot>) {
    this.state = { ...this.state, ...patch };
    this.deps.changed(this.state);
  }
  selectInputId(value: string) { this.patch({ selectedInputId: value }); }

  async refreshDevices() {
    const media = this.platform.mediaDevices;
    if (!media?.enumerateDevices) return;
    const devices = (await media.enumerateDevices()).filter((device) => device.kind === "audioinput");
    this.patch({
      inputDevices: devices.map((device, index) => ({
        deviceId: device.deviceId, label: device.label || (device.deviceId === "default" ? "System default microphone" : `Microphone ${index + 1}, name available after permission`),
      })),
      selectedInputId: this.state.selectedInputId && !devices.some((device) => device.deviceId === this.state.selectedInputId)
        ? "" : this.state.selectedInputId,
    });
  }

  private async capture(test: boolean) {
    this.close();
    const run = this.generation;
    const requested = performance.now();
    const media = this.platform.mediaDevices;
    if (!media?.getUserMedia) throw new Error("Microphone or WebRTC is unavailable. Open the app on localhost or 127.0.0.1 in Edge or Chrome.");
    const audio = {
      ...(this.state.selectedInputId ? { deviceId: { exact: this.state.selectedInputId } } : {}),
      echoCancellation: true, noiseSuppression: true,
    };
    let stream: MediaStream;
    try { stream = await media.getUserMedia({ audio }); }
    catch (error) {
      if (run !== this.generation) throw new DOMException("Microphone acquisition cancelled.", "AbortError");
      throw error;
    }
    if (run !== this.generation) {
      stream.getTracks().forEach((track) => track.stop());
      throw new DOMException("Microphone acquisition cancelled.", "AbortError");
    }
    this.stream = stream;
    this.capturing = true;
    const track = stream.getAudioTracks()[0];
    this.patch({ activeMicLabel: track?.label || "Unnamed microphone", micTestActive: test });
    this.deps.trace(test ? "browser.microphone.test.start" : "browser.microphone.ready",
      test ? "Microphone test started" : "Microphone access granted",
      { label: track?.label || "Unnamed microphone", enabled: track?.enabled, readyState: track?.readyState },
      "session", undefined, Math.round(performance.now() - requested));
    this.monitorMicrophone();
    void this.refreshDevices().catch((error: unknown) => this.deps.trace(
      "browser.devices.refresh.failed", "Could not refresh microphone list", { message: errorMessage(error) }, "error", "warning"));
    return { stream, run };
  }

  async testMicrophone() {
    if (this.state.micTestActive) {
      this.close();
      this.patch({ activeMicLabel: "" });
      this.deps.trace("browser.microphone.test.stop", "Microphone test stopped", {});
      return;
    }
    try { await this.capture(true); }
    catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      this.close();
      const message = errorMessage(error);
      this.deps.error(`Microphone test failed: ${message}`);
      this.deps.trace("browser.microphone.test.error", "Microphone test failed", { message }, "error");
    }
  }

  async prepareSession(startedAt = performance.now()): Promise<{ ready: Promise<string> }> {
    this.patch({ audioBlocked: false, audioStats: undefined, audioStatsError: "" });
    const { stream, run } = await this.capture(false);
    const pc = this.platform.createPeer();
    this.peer = pc;
    this.deps.connection(pc.connectionState);
    stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));
    const channel = pc.createDataChannel("oai-events");
    channel.onopen = () => {
      if (run === this.generation) this.deps.trace("browser.datachannel.open", "WebRTC data channel open", { label: channel.label });
    };
    pc.ontrack = ({ track, streams }) => {
      const player = this.deps.player();
      if (run !== this.generation || !this.capturing || !player) return;
      player.srcObject = streams[0] ?? new MediaStream([track]);
      this.patch({ remoteAudio: true, outputStatus: "Audio track received" });
      this.deps.trace("browser.audio.track", "GPT-Live audio track received", { kind: track.kind, readyState: track.readyState });
      track.addEventListener("ended", () => {
        if (run !== this.generation || !this.capturing) return;
        this.patch({ outputStatus: "Audio track ended" });
        this.deps.trace("browser.audio.track.ended", "GPT-Live audio track ended", {});
      }, { once: true });
      void player.play().then(() => {
        if (run !== this.generation || !this.capturing) return;
        this.patch({ outputStatus: "Playing" });
        this.deps.trace("browser.audio.playing", "Browser audio playback started", { paused: player.paused, muted: player.muted, volume: player.volume });
      }).catch((error: unknown) => {
        if (run !== this.generation || !this.capturing) return;
        this.patch({ audioBlocked: true, outputStatus: "Autoplay blocked" });
        this.deps.trace("browser.audio.blocked", "Start playback manually in the audio player", { message: errorMessage(error) }, "error", "warning");
      });
    };
    pc.onconnectionstatechange = () => {
      if (run !== this.generation) return;
      this.deps.trace("browser.webrtc.state", `WebRTC: ${pc.connectionState}`, { connectionState: pc.connectionState });
      this.deps.connection(pc.connectionState);
      if (pc.connectionState === "connected" && this.capturing) {
        this.deps.trace("browser.webrtc.ready", "WebRTC audio connection ready", {}, "session", undefined, Math.round(performance.now() - startedAt));
        this.monitorTransport(pc);
      }
    };
    const offer = await pc.createOffer();
    if (run !== this.generation) throw new DOMException("Session preparation cancelled.", "AbortError");
    await pc.setLocalDescription(offer);
    if (run !== this.generation) throw new DOMException("Session preparation cancelled.", "AbortError");
    const iceStarted = performance.now();
    this.deps.trace("browser.ice.gathering.started", "Gathering ICE candidates", {});
    const ready = this.waitForIce(pc).then(() => {
      if (run !== this.generation) throw new DOMException("Session preparation cancelled.", "AbortError");
      const sdp = pc.localDescription?.sdp;
      if (!sdp) throw new Error("WebRTC did not produce an SDP offer.");
      this.deps.trace("browser.ice.gathering.completed", "ICE candidates ready", {}, "session", undefined, Math.round(performance.now() - iceStarted));
      return sdp;
    });
    return { ready };
  }

  async answer(sdp: string) {
    const peer = this.peer;
    if (!peer || peer.signalingState === "closed") return;
    await peer.setRemoteDescription({ type: "answer", sdp });
  }

  private waitForIce(pc: AudioPeer): Promise<void> {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", onChange);
        this.iceCancel = undefined;
        error ? reject(error) : resolve();
      };
      const onChange = () => { if (pc.iceGatheringState === "complete") finish(); };
      const timer = setTimeout(() => finish(new Error("WebRTC ICE gathering timed out.")), 10_000);
      this.iceCancel = () => finish(new DOMException("ICE gathering cancelled.", "AbortError"));
      pc.addEventListener("icegatheringstatechange", onChange);
    });
  }

  private monitorMicrophone() {
    const factory = this.platform.createContext;
    if (!factory || !this.stream) {
      this.deps.trace("browser.microphone.meter.unavailable", "This browser does not support the input level meter", {}, "session", "warning");
      return;
    }
    const context = factory();
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    context.createMediaStreamSource(this.stream).connect(analyser);
    this.context = context; this.analyser = analyser;
    const samples = new Float32Array(analyser.fftSize);
    let lastUpdate = 0;
    const sample = (timestamp: number) => {
      if (this.analyser !== analyser) return;
      analyser.getFloatTimeDomainData(samples);
      if (timestamp - lastUpdate >= 80) {
        const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
        const inputLevel = Math.min(100, Math.round(rms * 1200));
        this.patch({ inputLevel, micSignal: inputLevel > 3 });
        lastUpdate = timestamp;
      }
      this.frame = this.platform.frame(sample);
    };
    void context.resume().then(() => {
      if (this.analyser === analyser) this.frame = this.platform.frame(sample);
    }).catch((error: unknown) => {
      if (this.analyser === analyser) this.deps.trace("browser.microphone.meter.error", "Could not read microphone level", { message: errorMessage(error) }, "error");
    });
  }

  private monitorTransport(pc: AudioPeer) {
    clearTimeout(this.statsTimer);
    const run = ++this.statsRun;
    const current = () => run === this.statsRun && pc === this.peer && pc.connectionState === "connected";
    const sample = async () => {
      if (!current()) return;
      try {
        const report = await pc.getStats();
        if (!current()) return;
        const stats: AudioTransportStats = {};
        report.forEach((value: unknown) => {
          if (typeof value !== "object" || value === null || !("kind" in value) || value.kind !== "audio") return;
          if ("type" in value && value.type === "outbound-rtp" && "bytesSent" in value && typeof value.bytesSent === "number") stats.bytesSent = value.bytesSent;
          if ("type" in value && value.type === "inbound-rtp") {
            if ("bytesReceived" in value && typeof value.bytesReceived === "number") stats.bytesReceived = value.bytesReceived;
            if ("totalAudioEnergy" in value && typeof value.totalAudioEnergy === "number") stats.outputEnergy = value.totalAudioEnergy;
          }
          if ("type" in value && value.type === "media-source") {
            if ("totalAudioEnergy" in value && typeof value.totalAudioEnergy === "number") stats.inputEnergy = value.totalAudioEnergy;
            if ("totalSamplesDuration" in value && typeof value.totalSamplesDuration === "number") stats.inputDuration = value.totalSamplesDuration;
          }
        });
        const microphone = this.stream?.getAudioTracks()[0], playback = this.deps.player();
        this.patch({ audioStats: stats, audioStatsError: "" });
        this.deps.trace("browser.webrtc.audio.stats", "WebRTC audio stats", {
          ...stats,
          microphone: microphone ? { label: microphone.label, enabled: microphone.enabled, muted: microphone.muted, readyState: microphone.readyState } : null,
          playback: playback ? { muted: playback.muted, paused: playback.paused, volume: playback.volume } : null,
        });
        this.statsTimer = setTimeout(() => void sample(), 3000);
      } catch (error) {
        if (!current()) return;
        const message = errorMessage(error);
        this.patch({ audioStatsError: message });
        this.deps.trace("browser.webrtc.audio.stats.error", "WebRTC audio stats failed", { message }, "error");
      }
    };
    void sample();
  }

  stopCapture() {
    this.releaseCapture();
    this.patch({ outputStatus: "Playback stopped" });
  }
  private releaseCapture() {
    this.capturing = false;
    this.statsRun++;
    clearTimeout(this.statsTimer);
    if (this.frame !== undefined) this.platform.cancelFrame(this.frame);
    this.frame = undefined;
    this.analyser = undefined;
    const context = this.context;
    this.context = undefined;
    if (context && context.state !== "closed") void context.close().catch((error: unknown) =>
      this.deps.trace("browser.microphone.close.error", "Could not close audio context", { message: errorMessage(error) }, "error"));
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    const player = this.deps.player();
    if (player) { player.pause(); player.srcObject = null; }
    this.patch({ inputLevel: 0, micSignal: false, micTestActive: false, remoteAudio: false, outputStatus: "Waiting for audio" });
  }
  close() {
    this.generation++;
    this.releaseCapture();
    this.iceCancel?.();
    if (this.peer) {
      this.peer.onconnectionstatechange = null;
      this.peer.ontrack = null;
      this.peer.close();
      this.peer = undefined;
      this.deps.connection("closed");
    }
  }
  unlock() {
    const run = this.generation;
    void this.deps.player()?.play().then(() => { if (run === this.generation) this.patch({ audioBlocked: false }); })
      .catch((error: unknown) => { if (run === this.generation) this.deps.error(errorMessage(error)); });
  }
  readonly playerEvents = {
    onPlaying: () => { if (this.capturing) this.patch({ outputStatus: "Playing" }); },
    onPause: () => { if (this.deps.player()?.srcObject) this.patch({ outputStatus: "Paused" }); },
    onError: () => { if (this.capturing) this.patch({ outputStatus: "Audio playback failed", audioBlocked: true }); },
  };
}
