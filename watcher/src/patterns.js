// Pattern rules over small instant (hot-allowance) withdrawals. The watcher only scores held requests;
// an attacker who stays inside the allowance never gets held. These rules look at the recent hot spends
// of one vault and flag two shapes:
//   burst: many hot spends in a short time (>= 5 within 10 min) or >= 60% of the allowance within 1 hour
//   drip:  allowance >= 80% used in several consecutive windows, or repeated spends to a new recipient
// They only recommend (tighten the allowance or pause the agent key). They never act on the vault.

const MIN = 60_000;
export const PATTERN_DEFAULTS = { burstCount: 5, burstMs: 10 * MIN, burstFrac: 0.6, burstFracMs: 60 * MIN, dripFrac: 0.8, dripWindows: 3, repeatCount: 3, newMs: 24 * 60 * MIN, freshMs: 15 * MIN };

const paid = (r) => r.hot && r.asset === 'Near' && !['Cancelled', 'Rescued'].includes(r.status);
const near = (y) => (Number(BigInt(y) / 10n ** 20n) / 1e4).toFixed(4);

/**
 * @param {object} p
 * @param {object[]} p.requests  vault requests (list_requests), any order
 * @param {object} p.config      get_config (near_allowance, demo_time_divisor, safe_near)
 * @param {string[]} [p.whitelist] known destinations
 * @param {number} [p.now]
 * @returns {{rule:string, key:string, title:string, evidence:string, ids:number[], suggestion:string, latest_ms:number}[]}
 */
export function detectPatterns({ requests, config, whitelist = [], now = Date.now(), opts = {} }) {
  const o = { ...PATTERN_DEFAULTS, ...opts };
  const limit = BigInt(config.near_allowance.limit);
  const windowMs = Math.max(MIN, (Number(config.near_allowance.window_secs) * 1000) / Math.max(1, Number(config.demo_time_divisor || 1)));
  const hot = requests.filter(paid).map((r) => ({ id: r.id, to: r.to, amount: BigInt(r.amount), t: Number(r.created_ms) })).sort((a, b) => a.t - b.t);
  const out = [];
  const suggestion = 'Tighten the hot allowance (Policy) or remove the agent key (Fund and agents) if you do not recognise these. Rescue Room only recommends; nothing was changed.';
  if (!hot.length || limit === 0n) return out;

  // burst (count)
  const inBurst = hot.filter((h) => now - h.t <= o.burstMs);
  if (inBurst.length >= o.burstCount) {
    const sum = inBurst.reduce((a, h) => a + h.amount, 0n);
    out.push({ rule: 'burst', title: `Burst: ${inBurst.length} instant withdrawals in ${Math.round(o.burstMs / MIN)} min`, evidence: `${inBurst.length} hot spends totalling ${near(sum)} NEAR (requests ${inBurst.map((h) => '#' + h.id).join(', ')})`, ids: inBurst.map((h) => h.id), latest_ms: inBurst.at(-1).t });
  } else {
    // burst (share of allowance)
    const span = Math.min(o.burstFracMs, windowMs);
    const recent = hot.filter((h) => now - h.t <= span);
    const sum = recent.reduce((a, h) => a + h.amount, 0n);
    if (recent.length >= 2 && Number((sum * 1000n) / limit) / 1000 >= o.burstFrac)
      out.push({ rule: 'burst', title: `Burst: ${Math.round((Number(sum) / Number(limit)) * 100)}% of the allowance in ${Math.round(span / MIN)} min`, evidence: `${recent.length} hot spends totalling ${near(sum)} of ${near(limit)} NEAR (requests ${recent.map((h) => '#' + h.id).join(', ')})`, ids: recent.map((h) => h.id), latest_ms: recent.at(-1).t });
  }

  // drip (consecutive windows near the cap), windows aligned back from now
  let streak = 0;
  const ids = [];
  for (let k = 0; k < 30; k++) {
    const hi = now - k * windowMs, lo = hi - windowMs;
    const w = hot.filter((h) => h.t > lo && h.t <= hi);
    const sum = w.reduce((a, h) => a + h.amount, 0n);
    if (Number((sum * 1000n) / limit) / 1000 >= o.dripFrac) {
      streak++;
      ids.push(...w.map((h) => h.id));
    } else break;
  }
  if (streak >= o.dripWindows)
    out.push({ rule: 'drip', title: `Slow drip: allowance at least ${Math.round(o.dripFrac * 100)}% used in ${streak} windows in a row`, evidence: `${ids.length} hot spends across ${streak} consecutive allowance windows of ${Math.round(windowMs / MIN)} min`, ids, latest_ms: Math.max(...hot.filter((h) => ids.includes(h.id)).map((h) => h.t)) });

  // drip (repeated spends to a new, unknown recipient)
  const known = new Set([...whitelist, config.safe_near].filter(Boolean));
  const byTo = new Map();
  for (const h of hot) byTo.set(h.to, [...(byTo.get(h.to) || []), h]);
  for (const [to, list] of byTo) {
    if (known.has(to)) continue;
    const firstSeen = requests.filter((r) => r.to === to).reduce((m, r) => Math.min(m, Number(r.created_ms)), Infinity);
    const recent = list.filter((h) => now - h.t <= o.newMs);
    if (now - firstSeen <= o.newMs && recent.length >= o.repeatCount)
      out.push({ rule: 'repeat_recipient', title: `Drip: ${recent.length} instant withdrawals to a new recipient`, evidence: `${recent.length} hot spends totalling ${near(recent.reduce((a, h) => a + h.amount, 0n))} NEAR to ${to}, first seen ${Math.round((now - firstSeen) / MIN)} min ago and not on the whitelist`, ids: recent.map((h) => h.id), latest_ms: recent.at(-1).t, to });
  }
  return out.map((f) => ({ ...f, suggestion, key: `${f.rule}:${f.to || ''}:${Math.max(...f.ids)}` }));
}

/** Findings worth paging about: fresh activity, not already alerted for the same rule/recipient recently. */
export function freshFindings(findings, { now = Date.now(), freshMs = PATTERN_DEFAULTS.freshMs } = {}) {
  return findings.filter((f) => now - f.latest_ms <= freshMs);
}
