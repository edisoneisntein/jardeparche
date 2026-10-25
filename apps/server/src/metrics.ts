/**
 * Minimal, in-process metrics. Counters and latency summaries are exposed over
 * /api/metrics so the HUD can show real numbers instead of invented ones.
 */
export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly timings = new Map<string, number[]>();

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  observe(name: string, ms: number): void {
    const samples = this.timings.get(name) ?? [];
    samples.push(ms);
    if (samples.length > 500) samples.shift();
    this.timings.set(name, samples);
  }

  snapshot() {
    const timings: Record<string, { count: number; avgMs: number; p95Ms: number; maxMs: number }> = {};
    for (const [name, samples] of this.timings) {
      const sorted = [...samples].sort((a, b) => a - b);
      const sum = sorted.reduce((total, value) => total + value, 0);
      timings[name] = {
        count: sorted.length,
        avgMs: sorted.length ? Math.round(sum / sorted.length) : 0,
        p95Ms: sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] as number) : 0,
        maxMs: sorted.length ? Math.round(sorted[sorted.length - 1] as number) : 0,
      };
    }
    return { counters: Object.fromEntries(this.counters), timings, collectedAt: new Date().toISOString() };
  }
}
