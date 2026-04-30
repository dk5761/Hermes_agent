import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AppLogger } from "../logger.js";

const execFileP = promisify(execFile);

// TODO Phase X: support OCR_PROVIDER=vision via aux model — current impl is
// system tesseract only.

export interface OcrOptions {
  pdftoppmBin: string;
  tesseractBin: string;
  maxPages: number;
  dpi: number;
  // Hard wallclock cap across the whole rasterize+OCR pipeline; on overflow
  // we return whatever pages were processed and set truncated:true.
  timeoutMs: number;
  languages: string;
  logger: AppLogger;
}

export interface OcrResult {
  text: string;
  pageCount: number;
  pagesProcessed: number;
  truncated: boolean;
  durationMs: number;
}

export class OcrToolError extends Error {
  constructor(
    public readonly tool: "pdftoppm" | "tesseract",
    public readonly code: number | string | null,
    public readonly stderr: string,
  ) {
    super(`ocr_tool_failed:${tool}:${code ?? "?"}`);
    this.name = "OcrToolError";
  }
}

interface CachedToolchain {
  available: boolean;
  pdftoppmBin: string;
  tesseractBin: string;
}

let toolchainCache: CachedToolchain | null = null;
let toolchainCheckInFlight: Promise<CachedToolchain> | null = null;

// Probe the OCR toolchain once per process (per binary path pair). Re-probe
// only if the configured binaries change. We log success/failure exactly once.
export async function hasOcrToolchain(opts: {
  pdftoppmBin: string;
  tesseractBin: string;
  logger: AppLogger;
}): Promise<boolean> {
  if (
    toolchainCache &&
    toolchainCache.pdftoppmBin === opts.pdftoppmBin &&
    toolchainCache.tesseractBin === opts.tesseractBin
  ) {
    return toolchainCache.available;
  }
  if (toolchainCheckInFlight) {
    const r = await toolchainCheckInFlight;
    return r.available;
  }
  toolchainCheckInFlight = probeToolchain(opts).finally(() => {
    toolchainCheckInFlight = null;
  });
  const result = await toolchainCheckInFlight;
  toolchainCache = result;
  return result.available;
}

async function probeToolchain(opts: {
  pdftoppmBin: string;
  tesseractBin: string;
  logger: AppLogger;
}): Promise<CachedToolchain> {
  const log = opts.logger;
  const probeOne = async (bin: string, args: readonly string[]): Promise<string | null> => {
    try {
      // pdftoppm exits non-zero on -h on some builds; capture both stdout and
      // stderr and don't trust the exit code as the only signal.
      await execFileP(bin, [...args], { timeout: 5000 });
      return null;
    } catch (err) {
      const e = err as { code?: string | number; stderr?: string; message?: string };
      // pdftoppm prints usage to stderr on -h and exits 99 on some builds, but
      // the binary IS available. Treat ENOENT/EACCES as missing; anything else
      // means the binary ran.
      if (e.code === "ENOENT" || e.code === "EACCES") return e.message ?? String(e.code);
      return null;
    }
  };

  const pdftoppmErr = await probeOne(opts.pdftoppmBin, ["-h"]);
  const tesseractErr = await probeOne(opts.tesseractBin, ["-v"]);
  const ok = pdftoppmErr === null && tesseractErr === null;
  if (ok) {
    log.info(
      { pdftoppmBin: opts.pdftoppmBin, tesseractBin: opts.tesseractBin },
      "ocr_toolchain_ok",
    );
  } else {
    log.warn(
      {
        pdftoppmBin: opts.pdftoppmBin,
        tesseractBin: opts.tesseractBin,
        pdftoppmErr,
        tesseractErr,
      },
      "ocr_toolchain_missing",
    );
  }
  return {
    available: ok,
    pdftoppmBin: opts.pdftoppmBin,
    tesseractBin: opts.tesseractBin,
  };
}

// Run pdftoppm + tesseract over a scanned PDF. Inline, capped, best-effort.
// Cleans temp dir on every exit path. Returns truncated:true if we ran out of
// time, or if the PDF had more pages than maxPages.
export async function runScannedPdfOcr(
  pdfBuffer: Buffer,
  opts: OcrOptions,
): Promise<OcrResult> {
  const started = Date.now();
  const log = opts.logger;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-ocr-"));
  const inputPath = path.join(tmpDir, "input.pdf");
  const outBase = path.join(tmpDir, "page");
  try {
    await fs.writeFile(inputPath, pdfBuffer);
    log.info(
      { dpi: opts.dpi, maxPages: opts.maxPages, timeoutMs: opts.timeoutMs },
      "pdf_ocr_started",
    );

    const remaining = (): number => Math.max(0, opts.timeoutMs - (Date.now() - started));

    // -r dpi, -png raster, -f 1 first page, -l N last page. We don't ask for
    // the page count up front; pdftoppm will simply produce fewer files if the
    // PDF has fewer pages than maxPages.
    await runWithTimeout(
      opts.pdftoppmBin,
      ["-r", String(opts.dpi), "-png", "-f", "1", "-l", String(opts.maxPages), inputPath, outBase],
      remaining(),
      "pdftoppm",
    );

    const pages = await listRasterizedPages(tmpDir);
    if (pages.length === 0) {
      const durationMs = Date.now() - started;
      log.warn({ durationMs }, "pdf_ocr_completed");
      return {
        text: "",
        pageCount: 0,
        pagesProcessed: 0,
        truncated: false,
        durationMs,
      };
    }

    const blocks: string[] = [];
    let truncated = false;
    let processed = 0;
    for (const page of pages) {
      if (remaining() <= 0) {
        truncated = true;
        break;
      }
      const text = await runTesseract(page.fullPath, opts, remaining());
      const trimmed = text.trim();
      if (trimmed.length > 0) {
        blocks.push(`--- page ${page.index} ---\n\n${trimmed}`);
      }
      processed += 1;
    }

    // pdftoppm capped at maxPages; if we hit the cap there might be more pages
    // beyond. We surface that as truncated:true so callers can decide whether
    // to surface a hint. We don't probe the true page count — pdfinfo is yet
    // another binary.
    if (pages.length === opts.maxPages) truncated = true;

    const text = blocks.join("\n\n");
    const durationMs = Date.now() - started;
    log.info(
      {
        pagesProcessed: processed,
        chars: text.length,
        durationMs,
        truncated,
      },
      "pdf_ocr_completed",
    );
    return {
      text,
      pageCount: pages.length,
      pagesProcessed: processed,
      truncated,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - started;
    log.warn(
      { err, errorClass: errorClass(err), durationMs },
      "pdf_ocr_failed",
    );
    throw err;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

interface RasterPage {
  index: number;
  fullPath: string;
}

async function listRasterizedPages(dir: string): Promise<RasterPage[]> {
  const entries = await fs.readdir(dir);
  const matched: RasterPage[] = [];
  for (const e of entries) {
    // pdftoppm with base "page" produces page-1.png … page-N.png (single
    // digits) or page-01.png style depending on the -frontpad/-bgcolor flags.
    // We don't pass pad flags so the format is page-N.png with N unpadded.
    const m = /^page-(\d+)\.png$/i.exec(e);
    if (!m || m[1] === undefined) continue;
    const idx = Number.parseInt(m[1], 10);
    if (!Number.isFinite(idx)) continue;
    matched.push({ index: idx, fullPath: path.join(dir, e) });
  }
  matched.sort((a, b) => a.index - b.index);
  return matched;
}

async function runTesseract(
  pngPath: string,
  opts: OcrOptions,
  timeoutMs: number,
): Promise<string> {
  // --psm 3 = fully automatic page segmentation, no OSD. Default in tesseract;
  // we set explicitly so behavior doesn't drift across distros. -l controls
  // language packs (eng, fra, eng+fra, …). stdout streams text on stdout.
  const { stdout } = await runWithTimeout(
    opts.tesseractBin,
    [pngPath, "stdout", "-l", opts.languages, "--psm", "3"],
    timeoutMs,
    "tesseract",
  );
  return stdout;
}

async function runWithTimeout(
  bin: string,
  args: readonly string[],
  timeoutMs: number,
  toolName: "pdftoppm" | "tesseract",
): Promise<{ stdout: string; stderr: string }> {
  // execFile already supports a timeout option, but we also pass a signal so
  // we can plumb in an outer cancel later if needed. No shell — args are not
  // interpolated through /bin/sh.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const { stdout, stderr } = await execFileP(bin, [...args], {
      signal: controller.signal,
      // Cap output buffer at 32 MiB — generous for tesseract page text.
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as {
      code?: number | string | null;
      stderr?: string | Buffer;
      killed?: boolean;
      signal?: string;
      message?: string;
    };
    const stderr =
      typeof e.stderr === "string"
        ? e.stderr
        : Buffer.isBuffer(e.stderr)
          ? e.stderr.toString("utf8")
          : "";
    throw new OcrToolError(toolName, e.code ?? null, stderr || (e.message ?? ""));
  } finally {
    clearTimeout(timer);
  }
}

function errorClass(err: unknown): string {
  if (err instanceof OcrToolError) return `OcrToolError:${err.tool}`;
  if (err instanceof Error) return err.name;
  return "Unknown";
}

// Test-only hook: reset the toolchain detection cache. Safe to call from
// production code as a no-op when nothing is cached yet.
export function _resetToolchainCacheForTests(): void {
  toolchainCache = null;
  toolchainCheckInFlight = null;
}
