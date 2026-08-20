const DAY_MS = 86_400_000;
const MAX_WINDOW_DAYS = 45;
const MAX_GRID_DAYS = 49;

function utcDay(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const date = new Date(parsed);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function dateKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function unavailable(reason = "Reset calendar dates are unavailable.") {
  return {
    available: false,
    timezone: "UTC",
    weekStartsOn: "monday",
    from: null,
    to: null,
    gridFrom: null,
    gridTo: null,
    days: [],
    reason,
  };
}

export function buildResetCalendar(history = {}) {
  if (history?.available !== true) {
    return unavailable(history?.reason || "Codex reset history is unavailable.");
  }

  const from = utcDay(history.from);
  const to = utcDay(history.to);
  if (from === null || to === null || to < from || to - from > MAX_WINDOW_DAYS * DAY_MS) {
    return unavailable();
  }

  const mondayOffset = (new Date(from).getUTCDay() + 6) % 7;
  const endWeekday = (new Date(to).getUTCDay() + 6) % 7;
  const gridFrom = from - mondayOffset * DAY_MS;
  const gridTo = to + (6 - endWeekday) * DAY_MS;
  const gridLength = Math.round((gridTo - gridFrom) / DAY_MS) + 1;
  if (gridLength < 1 || gridLength > MAX_GRID_DAYS) return unavailable();

  const counts = new Map();
  for (const item of Array.isArray(history.items) ? history.items.slice(0, 500) : []) {
    const day = utcDay(item?.announcedAt);
    if (day === null || day < from || day > to) continue;
    const key = dateKey(day);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const days = [];
  for (let timestamp = gridFrom; timestamp <= gridTo; timestamp += DAY_MS) {
    const date = dateKey(timestamp);
    days.push({
      date,
      inWindow: timestamp >= from && timestamp <= to,
      count: counts.get(date) || 0,
    });
  }

  return {
    available: true,
    timezone: "UTC",
    weekStartsOn: "monday",
    from: dateKey(from),
    to: dateKey(to),
    gridFrom: dateKey(gridFrom),
    gridTo: dateKey(gridTo),
    days,
    reason: null,
  };
}
