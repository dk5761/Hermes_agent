import { spawn } from "node:child_process";

/**
 * Extract a fixed-length array of normalized audio peak values from an audio
 * file using ffmpeg. Suitable for waveform visualization.
 *
 * The file is decoded to 8 kHz mono PCM float32 via ffmpeg's f32le format.
 * Samples are bucketed into `bucketCount` groups; each bucket's peak is
 * `max(abs(sample))`. The result is normalized so the loudest bucket = 1.0.
 *
 * Returns `null` when:
 * - ffmpeg exits non-zero (malformed or unreadable audio)
 * - ffmpeg does not complete within 5 seconds
 * - The decoded audio has 0 samples (silent or empty file)
 *
 * @param blobAbsolutePath  Absolute path to the audio file on disk.
 * @param bucketCount       Number of peaks to return (default 80).
 * @returns Array of `bucketCount` floats in [0, 1], or null on failure.
 */
export async function extractAudioPeaks(
  blobAbsolutePath: string,
  bucketCount: number = 80,
): Promise<number[] | null> {
  const chunks: Buffer[] = [];

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5_000);

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        "ffmpeg",
        [
          "-i", blobAbsolutePath,
          "-ac", "1",
          "-ar", "8000",
          "-f", "f32le",
          "-",
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );

      // Kill ffmpeg when the AbortController fires.
      ac.signal.addEventListener("abort", () => {
        proc.kill("SIGKILL");
        reject(new Error("ffmpeg timeout"));
      });

      proc.stdout.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });

      proc.on("error", reject);

      proc.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg exited with code ${code}`));
        }
      });
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }

  const buf = Buffer.concat(chunks);
  if (buf.byteLength === 0) return null;

  // Byteoffset-aligned slice so Float32Array constructor sees a clean
  // ArrayBuffer regardless of how Buffer.concat lays out memory.
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const samples = new Float32Array(arrayBuffer);

  if (samples.length === 0) return null;

  // Guard against very short clips producing a zero bucket size.
  const bucketSize = Math.max(1, Math.floor(samples.length / bucketCount));

  const peaks: number[] = [];
  for (let b = 0; b < bucketCount; b++) {
    const start = b * bucketSize;
    const end = Math.min(start + bucketSize, samples.length);

    if (start >= samples.length) {
      // Clip shorter than bucketCount buckets — pad with 0.
      peaks.push(0);
      continue;
    }

    let bucketPeak = 0;
    for (let i = start; i < end; i++) {
      const s = samples[i];
      if (s === undefined) break;
      const abs = Math.abs(s);
      if (abs > bucketPeak) bucketPeak = abs;
    }
    peaks.push(bucketPeak);
  }

  // Normalize to [0, 1].
  let globalMax = 0;
  for (let i = 0; i < peaks.length; i++) {
    const p = peaks[i] ?? 0;
    if (p > globalMax) globalMax = p;
  }

  if (globalMax === 0) {
    // Silent audio — return flat zeros.
    return new Array(bucketCount).fill(0);
  }

  for (let i = 0; i < peaks.length; i++) {
    const p = peaks[i] ?? 0;
    peaks[i] = Math.round((p / globalMax) * 1000) / 1000;
  }

  return peaks;
}
