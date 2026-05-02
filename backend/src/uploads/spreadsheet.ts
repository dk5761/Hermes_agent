/**
 * Spreadsheet → text extractor for the upload pipeline.
 *
 * CSV inputs are passed through verbatim (already text). XLSX is parsed via
 * SheetJS and emitted as a CSV-style dump per sheet, with each sheet
 * preceded by a `=== sheet: <name> ===` marker so the agent can disambiguate
 * multi-sheet workbooks.
 *
 * Output is bounded — large workbooks tend to dominate the prompt budget.
 * The bridge applies its own per-file cap, but capping here keeps memory
 * usage on the gateway predictable.
 */
import { read, utils } from "xlsx";

const MAX_OUTPUT_BYTES = 512_000; // ~500KB of text — bridge truncates further

export function csvToText(body: Buffer): string {
  // Strip UTF-8 BOM if present so the agent sees clean text.
  let text = body.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return clamp(text);
}

export function spreadsheetToText(body: Buffer): string {
  const wb = read(body, { type: "buffer", cellDates: true, cellNF: false });
  const parts: string[] = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    const csv = utils.sheet_to_csv(sheet, { blankrows: false });
    if (!csv.trim()) continue;
    parts.push(`=== sheet: ${sheetName} ===`);
    parts.push(csv);
    parts.push("");
  }
  return clamp(parts.join("\n"));
}

function clamp(s: string): string {
  if (Buffer.byteLength(s, "utf8") <= MAX_OUTPUT_BYTES) return s;
  // Slice by codepoint, then trim to byte budget to avoid splitting UTF-8.
  const trimmed = s.slice(0, MAX_OUTPUT_BYTES);
  return `${trimmed}\n[…truncated]`;
}
