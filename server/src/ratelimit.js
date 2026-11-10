// Small in-memory limiter: per-client sliding window plus a global daily cap and one run at a time.
export function createLimiter({ perClient = 2, windowMs = 10 * 60_000, perDay = 40 } = {}) {
  const hits = new Map();
  let day = { start: Date.now(), count: 0 };
  return {
    check(client) {
      const now = Date.now();
      if (now - day.start > 86_400_000) day = { start: now, count: 0 };
      const list = (hits.get(client) || []).filter((t) => now - t < windowMs);
      hits.set(client, list);
      if (day.count >= perDay) return { ok: false, reason: 'daily sandbox budget used up', retry_after_s: Math.ceil((day.start + 86_400_000 - now) / 1000) };
      if (list.length >= perClient) return { ok: false, reason: `limit ${perClient} runs per ${windowMs / 60000} min`, retry_after_s: Math.max(1, Math.ceil(((list[0] ?? now) + windowMs - now) / 1000)) };
      return { ok: true };
    },
    take(client) {
      hits.get(client)?.push(Date.now()) ?? hits.set(client, [Date.now()]);
      day.count++;
    },
    stats() {
      return { today: day.count, perDay, perClient, windowMin: windowMs / 60000 };
    },
  };
}
