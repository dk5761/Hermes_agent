import sharp from "sharp";

export interface ProcessedDerivative {
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
}

const HERMES_TARGET_BYTES = 900 * 1024;

// Build a 256px max-edge JPEG thumbnail. Strips metadata implicitly via sharp.
export async function buildThumbnail(input: Buffer): Promise<ProcessedDerivative> {
  const pipeline = sharp(input, { failOn: "error" })
    .rotate()
    .resize({ fit: "inside", width: 256, height: 256, withoutEnlargement: true })
    .jpeg({ quality: 80, mozjpeg: true });
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return {
    buffer: data,
    mimeType: "image/jpeg",
    width: info.width,
    height: info.height,
  };
}

// Build a Hermes-ready compressed JPEG, retrying with stricter parameters until
// it fits HERMES_TARGET_BYTES (~900KB). Loop is bounded to three passes; if all
// passes still exceed the cap we return the smallest output rather than fail.
// Hermes itself doesn't enforce a hard cap, but smaller payloads are cheaper to
// upload over the loopback WS and faster for the model to ingest.
export async function buildHermesReady(input: Buffer): Promise<ProcessedDerivative> {
  const passes: Array<{ width: number; quality: number }> = [
    { width: 1568, quality: 78 },
    { width: 1568, quality: 65 },
    { width: 1280, quality: 65 },
  ];
  let best: ProcessedDerivative | null = null;
  for (const pass of passes) {
    const out = await sharp(input, { failOn: "error" })
      .rotate()
      .resize({ fit: "inside", width: pass.width, height: pass.width, withoutEnlargement: true })
      .jpeg({ quality: pass.quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    const candidate: ProcessedDerivative = {
      buffer: out.data,
      mimeType: "image/jpeg",
      width: out.info.width,
      height: out.info.height,
    };
    if (candidate.buffer.byteLength <= HERMES_TARGET_BYTES) return candidate;
    if (!best || candidate.buffer.byteLength < best.buffer.byteLength) best = candidate;
  }
  // All passes overshot the budget — pick the smallest. Hermes can still ingest
  // it; the cap is advisory.
  if (!best) throw new Error("hermes_ready_build_produced_nothing");
  return best;
}
