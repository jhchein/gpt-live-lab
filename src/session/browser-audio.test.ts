import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserAudio, type AudioPlatform, type AudioPeer } from "./browser-audio.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(options: { delayedMicrophone?: boolean; delayedDevices?: boolean; gathering?: boolean } = {}) {
  let stopped = 0;
  const microphone = deferred<MediaStream>();
  const devices = deferred<MediaDeviceInfo[]>();
  const track = { label: "Synthetic microphone", kind: "audio", enabled: true, readyState: "live", stop() { stopped++; } };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] } as MediaStream;
  const peers: FakePeer[] = [];
  class FakePeer extends EventTarget implements AudioPeer {
    connectionState: RTCPeerConnectionState = "new";
    iceGatheringState: RTCIceGatheringState = options.gathering ? "gathering" : "complete";
    signalingState: RTCSignalingState = "stable";
    localDescription: RTCSessionDescriptionInit | null = null;
    onconnectionstatechange: ((event: Event) => void) | null = null;
    ontrack: RTCPeerConnection["ontrack"] = null;
    addTrack() {}
    createDataChannel(): Pick<RTCDataChannel, "label" | "onopen"> { return { label: "oai-events", onopen: null }; }
    async createOffer() { return { type: "offer" as const, sdp: "v=0\r\nfixture" }; }
    async setLocalDescription(offer: RTCSessionDescriptionInit) { this.localDescription = offer; }
    async setRemoteDescription() { this.connectionState = "connected"; this.onconnectionstatechange?.(new Event("connectionstatechange")); }
    async getStats() { return new Map(); }
    close() { this.connectionState = "closed"; this.signalingState = "closed"; }
  }
  const player = { srcObject: null, pause() {}, async play() {}, muted: false, paused: false, volume: 1 } as HTMLAudioElement;
  const platform: AudioPlatform = {
    mediaDevices: {
      getUserMedia: async () => options.delayedMicrophone ? microphone.promise : stream,
      enumerateDevices: async () => options.delayedDevices ? devices.promise : [],
    } as MediaDevices,
    createPeer: () => {
      const peer = new FakePeer(); peers.push(peer);
      return peer;
    },
    frame: () => 1, cancelFrame: () => {},
  };
  const trace: string[] = [], errors: string[] = [];
  const audio = new BrowserAudio({
    platform, player: () => player, changed: () => {}, connection: () => {},
    error: (message) => errors.push(message), trace: (type) => trace.push(type),
  });
  return { audio, peers, stream, microphone, devices, trace, errors, platform, get stopped() { return stopped; } };
}

test("closing during microphone permission releases a late stream instead of creating a peer", async () => {
  const f = fixture({ delayedMicrophone: true });
  const preparation = f.audio.prepareSession();
  f.audio.close();
  f.microphone.resolve(f.stream);
  await assert.rejects(preparation, { name: "AbortError" });
  assert.equal(f.stopped, 1);
  assert.equal(f.peers.length, 0);
});

test("slow microphone enumeration never delays the audio offer", async () => {
  const f = fixture({ delayedDevices: true });
  const { ready } = await f.audio.prepareSession();
  assert.equal(await ready, "v=0\r\nfixture");
  assert.equal(f.peers.length, 1);
  f.devices.resolve([]);
  f.audio.close();
});

test("Stop releases recording immediately but keeps the peer alive for graceful Azure closure", async () => {
  const f = fixture();
  const { ready } = await f.audio.prepareSession();
  await ready;
  await f.audio.answer("v=0\r\nanswer");
  assert.equal(f.peers[0].connectionState, "connected");
  f.audio.stopCapture();
  assert.equal(f.stopped, 1);
  assert.equal(f.audio.snapshot.outputStatus, "Playback stopped");
  assert.equal(f.peers[0].connectionState, "connected");
  f.audio.close();
  assert.equal(f.peers[0].connectionState, "closed");
  assert.equal(f.stopped, 1);
});

test("closing during ICE cancels listeners and the pending offer; the next start is independent", async () => {
  const f = fixture({ gathering: true });
  const first = await f.audio.prepareSession();
  f.audio.close();
  await assert.rejects(first.ready, { name: "AbortError" });
  const second = await f.audio.prepareSession();
  f.peers[1].iceGatheringState = "complete";
  f.peers[1].dispatchEvent(new Event("icegatheringstatechange"));
  assert.equal(await second.ready, "v=0\r\nfixture");
  assert.equal(f.peers[0].connectionState, "closed");
  f.audio.close();
});

test("microphone testing owns and releases the same recording resources without a peer", async () => {
  const f = fixture();
  await f.audio.testMicrophone();
  assert.equal(f.audio.snapshot.micTestActive, true);
  assert.equal(f.peers.length, 0);
  await f.audio.testMicrophone();
  assert.equal(f.audio.snapshot.micTestActive, false);
  assert.equal(f.stopped, 1);
  assert.deepEqual(f.errors, []);
});

test("a microphone-test initialization failure releases the acquired track", async () => {
  const f = fixture();
  f.platform.createContext = () => { throw new Error("Fixture audio context initialization failed"); };
  await f.audio.testMicrophone();
  assert.equal(f.stopped, 1);
  assert.equal(f.audio.snapshot.micTestActive, false);
  assert.match(f.errors[0], /Fixture audio context/);
});
