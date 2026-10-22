import { NOT_MEASURED, formatBytes } from "./format";
import type { LiveSession } from "./useLiveSession";
import { Dot } from "./ui";

const energy = (value: number | undefined) => (value === undefined ? NOT_MEASURED : value.toFixed(5));

export function AudioPanel({ session }: { session: LiveSession }) {
  const { audio, phase } = session;
  const active = phase === "starting" || phase === "live" || phase === "stopping";
  const named = audio.devices.filter((device) => device.deviceId && device.deviceId !== "default");
  const canCapture = Boolean(navigator.mediaDevices?.getUserMedia);
  const level = audio.signal ? "Signal detected" : audio.testActive || active ? "Waiting for sound" : "Microphone off";

  return <section className="panel audio-panel" aria-labelledby="audio-title">
    <div className="panel-head"><h2 id="audio-title">Audio</h2></div>

    <div className="audio-block">
      <label htmlFor="microphone-select">Microphone</label>
      <div className="mic-row">
        <select id="microphone-select" disabled={active || audio.testActive} value={audio.selectedInputId}
          onChange={(event) => audio.setSelectedInputId(event.target.value)}>
          <option value="">System default</option>
          {named.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label}</option>)}
        </select>
        <button type="button" className="btn" onClick={() => void session.testMicrophone()} disabled={active || !canCapture}>
          {audio.testActive ? "Stop test" : "Test microphone"}
        </button>
      </div>
      <div className="meter-row">
        <div className="level-track" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={audio.level} aria-valuetext={`${audio.level} percent`}>
          <span style={{ width: `${audio.level}%` }} />
        </div>
        <output className="level-value" aria-hidden="true">{audio.level} %</output>
        <span className={`level-state ${audio.signal ? "is-signal" : ""}`}><Dot tone={audio.signal ? "ok" : "idle"} />{level}</span>
      </div>
      <p className="hint">
        {audio.activeMicLabel ? <>Using <strong>{audio.activeMicLabel}</strong>. </> : null}
        {active ? "Stop to change devices." : "The microphone test stays local."}
      </p>
    </div>

    <div className="audio-block">
      <div className="block-head">
        <span className="block-title">GPT-Live audio</span>
        <span className="block-state">{audio.outputStatus}</span>
      </div>
      <audio controls autoPlay aria-label="GPT-Live audio playback" {...audio.props} />
      {audio.blocked && <div className="callout tone-warn" role="alert">
        <span>Your browser blocked autoplay.</span>
        <button type="button" className="btn" onClick={audio.unlock}>Enable playback</button>
      </div>}
    </div>

    <details className="disclosure">
      <summary>Audio diagnostics</summary>
      <div className="disclosure-body">
        <dl className="kv">
          <div><dt>Sent</dt><dd><output aria-label="WebRTC audio bytes sent">{formatBytes(audio.stats?.bytesSent)}</output></dd></div>
          <div><dt>Input energy</dt><dd><output aria-label="WebRTC microphone signal energy">{energy(audio.stats?.inputEnergy)}</output></dd></div>
          <div><dt>Received</dt><dd><output aria-label="WebRTC audio bytes received">{formatBytes(audio.stats?.bytesReceived)}</output></dd></div>
          <div><dt>Output energy</dt><dd><output aria-label="WebRTC received signal energy">{energy(audio.stats?.outputEnergy)}</output></dd></div>
        </dl>
        <p className="hint">Sampled every 3 seconds. Energy is cumulative. Bytes may include silence; signal energy does not prove intelligible or audible speech. The last sample remains after Stop.</p>
      </div>
    </details>
  </section>;
}
