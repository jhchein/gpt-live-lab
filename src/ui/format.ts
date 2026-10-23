// Display helpers. Missing values are always spelled out, never shown as 0.
export const UNKNOWN = "unknown";
export const NOT_REPORTED = "not reported";
export const NOT_MEASURED = "not measured";

const integer = new Intl.NumberFormat("en-US");
const decimal2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const decimal1 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const finite = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value);

export function formatCount(value: number | undefined, fallback = NOT_REPORTED) {
  return finite(value) ? integer.format(value) : fallback;
}

export function formatBytes(value: number | undefined, fallback = NOT_MEASURED) {
  if (!finite(value)) return fallback;
  if (value < 1024) return `${integer.format(value)} B`;
  if (value < 1024 * 1024) return `${decimal1.format(value / 1024)} KiB`;
  return `${decimal1.format(value / 1024 / 1024)} MiB`;
}

export function formatDuration(ms: number | undefined, fallback = UNKNOWN) {
  if (!finite(ms)) return fallback;
  if (ms < 1000) return `${integer.format(Math.round(ms))} ms`;
  return `${(ms < 10_000 ? decimal2 : decimal1).format(ms / 1000)} s`;
}

export function formatOffset(ms: number) {
  return `+${formatDuration(Math.max(0, ms))}`;
}

export function formatSeconds(seconds: number | undefined, fallback = NOT_REPORTED) {
  return finite(seconds) ? `${(Number.isInteger(seconds) ? integer : decimal2).format(seconds)} s` : fallback;
}

export function formatClock(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function formatTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "invalid time";
  return date.toLocaleTimeString("en-GB", {
    hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3,
  });
}

export function shortId(id: string) {
  return id.length > 8 ? id.slice(-8) : id;
}

export function byteLength(text: string) {
  return new TextEncoder().encode(text).length;
}
