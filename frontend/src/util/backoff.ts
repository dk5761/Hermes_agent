// Capped exponential backoff with full jitter — predictable bounds, smoother
// thundering-herd behavior than pure exponential.

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  factor?: number;
}

export class Backoff {
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly factor: number;
  private attempt = 0;

  constructor(opts: BackoffOptions) {
    this.baseMs = opts.baseMs;
    this.maxMs = opts.maxMs;
    this.factor = opts.factor ?? 2;
  }

  next(): number {
    const exp = Math.min(this.maxMs, this.baseMs * Math.pow(this.factor, this.attempt));
    this.attempt += 1;
    return Math.floor(Math.random() * exp);
  }

  reset(): void {
    this.attempt = 0;
  }
}
