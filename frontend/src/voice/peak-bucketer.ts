/**
 * PeakBucketer — dual-track waveform accumulator.
 *
 * Two independent representations of the same audio stream:
 *
 *   1. **Live sliding window** (`snapshot()`) — fixed-size ring buffer of the
 *      last `targetBucketCount` RAW samples. Used by the recording overlay
 *      so bars flow continuously to the left as new samples land on the right
 *      (WhatsApp/Telegram style). No halving, no resets — older samples
 *      simply drop off the left edge.
 *
 *   2. **Compressed full recording** (`finalize()`) — compress-on-fill
 *      strategy that yields exactly `targetBucketCount` values representing
 *      the ENTIRE recording, regardless of duration. Used for the audio
 *      bubble's static waveform.
 *
 * Both are populated by every `push()` call. Normalization differs: live
 * uses window-local max so visible bars stay "alive" even at quiet volumes;
 * finalize uses the recording's global max so the loudest moment maps to 1.0.
 */

export class PeakBucketer {
  private readonly targetBucketCount: number;

  // ─── Compressed-on-fill state (used by finalize) ─────────────────────────
  /** Compressed buckets representing the full recording. */
  private buckets: number[] = [];
  private currentBucketSamples = 0;
  private samplesPerBucket = 1;
  /** Running max across all received raw amplitudes — for finalize() normalization. */
  private globalMax = 0;

  // ─── Sliding-window state (used by snapshot — live overlay) ──────────────
  /** Ring buffer of the last `targetBucketCount` raw amplitudes. */
  private liveBuffer: number[] = [];

  constructor(targetBucketCount = 80) {
    this.targetBucketCount = targetBucketCount;
  }

  /**
   * Push one linear-amplitude sample in the range [0, 1].
   *
   * Samples outside [0, 1] are clamped. Calls with NaN are ignored.
   */
  push(amplitude: number): void {
    if (!isFinite(amplitude)) return;
    const clamped = Math.max(0, Math.min(1, amplitude));

    if (clamped > this.globalMax) this.globalMax = clamped;

    // ─── Live sliding window: append + drop oldest if over capacity ─────────
    this.liveBuffer.push(clamped);
    if (this.liveBuffer.length > this.targetBucketCount) {
      this.liveBuffer.shift();
    }

    // ─── Compressed-on-fill (full recording) ────────────────────────────────
    if (this.currentBucketSamples === 0) {
      // Start a new bucket.
      this.buckets.push(clamped);
    } else {
      // Fold into the last bucket via running max.
      const last = this.buckets.length - 1;
      if (clamped > this.buckets[last]) this.buckets[last] = clamped;
    }

    this.currentBucketSamples++;

    if (this.currentBucketSamples >= this.samplesPerBucket) {
      this.currentBucketSamples = 0;
      if (this.buckets.length >= this.targetBucketCount) {
        this._compress();
      }
    }
  }

  /**
   * Compress: pair up neighbouring buckets and replace each pair with their
   * max value. Halves the bucket count and doubles samplesPerBucket.
   */
  private _compress(): void {
    const compressed: number[] = [];
    for (let i = 0; i + 1 < this.buckets.length; i += 2) {
      compressed.push(Math.max(this.buckets[i], this.buckets[i + 1]));
    }
    // If the original had an odd length the last bucket is dropped; this is
    // acceptable — the next incoming sample will re-open a fresh bucket.
    this.buckets = compressed;
    this.samplesPerBucket *= 2;
    this.currentBucketSamples = 0;
  }

  /**
   * Live snapshot for the recording overlay — sliding window of the last
   * `targetBucketCount` raw samples, normalized against the window's local
   * max so quiet sections still show visible bars.
   *
   * Grows from 1 sample up to targetBucketCount as recording starts. After
   * that, every new sample shifts the visible content left by one slot —
   * smooth flow, no halving, no reset.
   */
  snapshot(): number[] {
    if (this.liveBuffer.length === 0) return [];
    let windowMax = 0;
    for (let i = 0; i < this.liveBuffer.length; i++) {
      if (this.liveBuffer[i] > windowMax) windowMax = this.liveBuffer[i];
    }
    if (windowMax === 0) return this.liveBuffer.map(() => 0);
    return this.liveBuffer.map((v) => Math.round((v / windowMax) * 1000) / 1000);
  }

  /**
   * Final snapshot — exactly targetBucketCount normalized values.
   *
   * Pads with zeros on the right if the recording was shorter than
   * targetBucketCount samples; truncates if somehow longer (shouldn't happen
   * with compress-on-fill, but guarded defensively).
   */
  finalize(): number[] {
    let raw = this.buckets.slice();
    if (raw.length < this.targetBucketCount) {
      const padding = new Array<number>(this.targetBucketCount - raw.length).fill(0);
      raw = raw.concat(padding);
    } else if (raw.length > this.targetBucketCount) {
      raw = raw.slice(0, this.targetBucketCount);
    }
    return this._normalize(raw);
  }

  /** Reset all accumulated state. */
  reset(): void {
    this.buckets = [];
    this.liveBuffer = [];
    this.currentBucketSamples = 0;
    this.samplesPerBucket = 1;
    this.globalMax = 0;
  }

  /**
   * Normalize an array to [0, 1] using the recorded global max, then round
   * to 3 decimal places. Returns zeros if the global max is 0 (silent).
   */
  private _normalize(values: number[]): number[] {
    if (this.globalMax === 0) {
      return values.map(() => 0);
    }
    return values.map((v) => Math.round((v / this.globalMax) * 1000) / 1000);
  }
}
