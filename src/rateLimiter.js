/**
 * Simpler Sliding-Window Rate Limiter.
 * Haelt Timestamps der letzten Requests und wartet, falls das Limit
 * innerhalb der letzten 60 Sekunden erreicht ist, bis wieder Platz ist.
 *
 * Das ist bewusst clientseitig und pessimistisch: lieber der Bot wartet
 * intern kurz, als dass er staendig 429 von der LLM-API kassiert.
 */
export class RateLimiter {
  constructor(maxPerMinute) {
    this.maxPerMinute = maxPerMinute;
    this.timestamps = [];
  }

  /**
   * Blockiert (async) bis ein Request-Slot frei ist, reserviert ihn dann.
   */
  async acquire() {
    for (;;) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((t) => now - t < 60_000);

      if (this.timestamps.length < this.maxPerMinute) {
        this.timestamps.push(now);
        return;
      }

      const oldest = this.timestamps[0];
      const waitMs = 60_000 - (now - oldest) + 100; // kleiner Puffer
      await sleep(waitMs);
    }
  }

  /** Wie viele Requests aktuell noch in den 60s-Fenster passen wuerden. */
  remaining() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 60_000);
    return Math.max(0, this.maxPerMinute - this.timestamps.length);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
