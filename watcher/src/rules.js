// Deterministic rules scorer. Pure function: same inputs -> same score.
// Each signal carries a weight; the score is the clamped sum. The watcher only recommends.

const median = (xs) => {
  if (!xs.length) return 0n;
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s[Math.floor(s.length / 2)];
};

/**
 * @param {object} req       the request being scored (contract JSON)
 * @param {object[]} history  all other requests (contract JSON), any status
 * @param {object} ctx        { whitelist: Map<dest, addedMs>, availableNear: bigint, allowance: bigint,
 *                              windowMs: number, nowMs: number, usualHoursUtc: [from,to], freshWhitelistMs }
 */
export function scoreRequest(req, history, ctx) {
  const signals = [];
  const add = (code, weight, detail) => signals.push({ code, weight, detail });
  const amount = BigInt(req.amount);
  const created = Number(req.created_ms);
  const prior = history.filter((h) => h.id < req.id);
  const paid = prior.filter((h) => h.status === 'Executed' && h.asset === req.asset);
  const sameDest = paid.filter((h) => h.to === req.to);
  const wlAt = ctx.whitelist.get(req.to);

  // 1. New destination: never paid before the current day (scaled in demo mode), and not whitelisted
  const established = sameDest.some((h) => created - Number(h.created_ms) >= ctx.freshWhitelistMs);
  if (!established && wlAt === undefined) {
    add('new_destination', 30, sameDest.length ? `${req.to} was first paid only moments ago` : `First payment to ${req.to}`);
  }

  // 2. Whitelisted, but only just
  if (wlAt !== undefined && created - wlAt < ctx.freshWhitelistMs) {
    add('fresh_whitelist', 15, 'Destination was whitelisted moments before this request');
  }

  // 3. Chunked drain: several requests in one window that together exceed the allowance
  const live = (h) => !['Cancelled', 'Rescued', 'Failed'].includes(h.status);
  const recent = prior.filter((h) => live(h) && h.asset === req.asset && created - Number(h.created_ms) < ctx.windowMs);
  const recentSum = recent.reduce((s, h) => s + BigInt(h.amount), 0n) + amount;
  if (recent.length >= 2 && recentSum > ctx.allowance) {
    add('chunked_drain', 25, `${recent.length + 1} requests in one window total more than the hot allowance`);
  }

  // 4. Size vs history
  const med = median(paid.map((h) => BigInt(h.amount)));
  if (med > 0n && amount > med * 3n) add('unusual_size', 20, 'More than 3x the median past payment');

  // 5. Share of reserve
  if (req.asset === 'Near' && ctx.availableNear > 0n && amount * 2n > ctx.availableNear) {
    add('large_share_of_reserve', 20, 'More than half of the available reserve');
  }

  // 6. Off-rhythm time (UTC hours outside the usual window)
  const hour = new Date(created).getUTCHours();
  const [from, to] = ctx.usualHoursUtc;
  if (hour < from || hour >= to) add('off_rhythm_time', 10, `Requested at ${hour}:00 UTC, outside the usual ${from}:00-${to}:00`);

  // 7. Signing pattern change: requester type differs from the last few requests
  const baseline = prior.filter((h) => created - Number(h.created_ms) >= ctx.windowMs).slice(-5);
  const lastSigners = baseline.map((h) => (h.agent ? `agent:${h.agent}` : h.requester));
  const me = req.agent ? `agent:${req.agent}` : req.requester;
  if (lastSigners.length >= 3 && !lastSigners.includes(me)) {
    add('signing_pattern_change', 15, `Signed by ${me}, unlike the last ${lastSigners.length} requests`);
  }

  // 8. Agent keys should pay known counterparties
  if (req.agent && wlAt === undefined) add('agent_unlisted_destination', 20, `Agent key "${req.agent}" paying a destination that is not whitelisted`);

  // Trust signal: long-standing whitelisted destination
  if (wlAt !== undefined && created - wlAt >= ctx.freshWhitelistMs) add('trusted_destination', -20, 'Long-standing whitelisted destination');

  const raw = signals.reduce((s, x) => s + x.weight, 0);
  const score = Math.max(0, Math.min(100, raw));
  // Confidence grows with history; capped. Low history -> say so.
  const confidence = Math.min(95, 45 + Math.min(40, paid.length * 5) + (signals.length >= 2 ? 10 : 0));
  return {
    score,
    confidence,
    // Contract stores weight as u8, so negative trust weights are recorded as 0 with the detail kept.
    signals: signals.map((s) => ({ code: s.code, weight: Math.max(0, s.weight), detail: s.detail })),
    rawSignals: signals,
  };
}

export function tierFor(score) {
  if (score >= 80) return { label: 'Critical', hold: '6h' };
  if (score >= 60) return { label: 'High', hold: '3h' };
  if (score >= 30) return { label: 'Elevated', hold: '1h' };
  return { label: 'Low', hold: 'none' };
}
