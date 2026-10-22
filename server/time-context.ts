export function timeContext(now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  const utc = now.toISOString();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const local = `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}`;
  return [
    `Trusted current time snapshot from the application clock: UTC ${utc}; local ${local}, time zone ${timeZone}.`,
    "Resolve today, now, yesterday and other relative dates from this local calendar, not your training data or an earlier assistant message.",
    "Preserve explicit historical dates requested by the user. Never invent a year for a current-news search.",
    "This is a request-time snapshot, not a continuously ticking clock.",
  ].join(" ");
}
