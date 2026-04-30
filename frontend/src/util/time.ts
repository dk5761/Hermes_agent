// Backend timestamps come as either unix seconds or ISO strings; both supported.

export function toDate(value: number | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return new Date(value < 1e12 ? value * 1000 : value);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatRelative(value: number | string | null | undefined): string {
  const d = toDate(value);
  if (!d) return "";
  const diff = Date.now() - d.getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString();
}
