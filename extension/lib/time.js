// Date helpers for the dashboard. Inputs from the server are epoch seconds; `now` is ms.

function at8(base, addDays) {
  const d = new Date(base);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + addDays, 8, 0, 0, 0).getTime();
}

export function snoozePresets(now) {
  const dow = new Date(now).getDay(); // 0 = Sunday, 1 = Monday
  const toMonday = ((8 - dow) % 7) || 7;
  return { tomorrow: at8(now, 1), nextMonday: at8(now, toMonday), week: at8(now, 7) };
}

export function ago(seconds, now) {
  if (seconds == null) return "—";
  const s = Math.max(0, now / 1000 - seconds);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 14 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return `${Math.floor(s / (7 * 86400))}w ago`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const startOfDay = (ms) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

export function dayLabel(seconds, now) {
  const days = Math.round((startOfDay(now) - startOfDay(seconds * 1000)) / 86400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const d = new Date(seconds * 1000);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

const pad = (n) => String(n).padStart(2, "0");

// YYYY-MM-DD in local time (Date.toISOString is UTC, which is already "tomorrow" in the evening).
export function localISODate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Local YYYY-MM-DD-HHMM, for export file names.
export function fileStamp(ms) {
  const d = new Date(ms);
  return `${localISODate(ms)}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
