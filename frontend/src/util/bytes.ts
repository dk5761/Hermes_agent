/**
 * Human-readable byte formatting.
 * Returns short forms like "342 MB", "2.4 GB", "892 KB".
 */
const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "0 B";
  if (bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  // 1 decimal for sub-100 GB, integer otherwise — matches design spec ("2.4 GB", "342 MB").
  const formatted = value >= 100 ? value.toFixed(0) : value.toFixed(1);
  // Strip trailing ".0" so "342.0 MB" reads "342 MB".
  return `${formatted.replace(/\.0$/, "")} ${UNITS[unitIndex]}`;
}
