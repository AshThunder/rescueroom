import type { Asset, Status } from './types';

const YOCTO = 10n ** 24n;
const WEI = 10n ** 18n;

export function units(raw: string | bigint, decimals: bigint, places = 2): string {
  const v = BigInt(raw);
  const whole = v / decimals;
  const frac = v % decimals;
  const f = (Number(frac) / Number(decimals)).toFixed(places).slice(1);
  return `${whole.toLocaleString('en-US')}${places ? f : ''}`;
}
export const nearAmt = (y: string | bigint, p = 2) => units(y, YOCTO, p);
export const ethAmt = (w: string | bigint, p = 4) => units(w, WEI, p);
export const amt = (a: Asset, raw: string, p?: number) => (a === 'Near' ? `${nearAmt(raw, p ?? 2)} NEAR` : `${ethAmt(raw, p ?? 4)} ETH`);
export const assetLabel = (a: Asset) => (a === 'Near' ? 'NEAR' : 'Sepolia ETH');

export const short = (s: string, a = 6, b = 4) => (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);
export const reqId = (id: number) => `H-${String(id).padStart(4, '0')}`;

export function duration(secs: number): string {
  if (secs <= 0) return 'none';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  if (m) return s ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

export function countdown(ms: number): string {
  if (ms <= 0) return '0s';
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

// User-facing times in WAT (Africa/Lagos, UTC+1).
const tf = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit' });
const df = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const toDate = (v: string | number) => new Date(typeof v === 'string' && !/^\d+$/.test(v) ? v : Number(v));
export const time = (ms: string | number) => tf.format(toDate(ms));
export const dateTime = (ms: string | number) => `${df.format(toDate(ms))} WAT`;

export function ago(ms: string | number, now = Date.now()): string {
  const d = Math.max(0, now - Number(ms)) / 1000;
  if (d < 60) return `${Math.floor(d)}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

export function tierOf(score: number): { label: string; tone: 'muted' | 'amber' | 'red' } {
  if (score >= 80) return { label: 'Critical', tone: 'red' };
  if (score >= 60) return { label: 'High', tone: 'amber' };
  if (score >= 30) return { label: 'Elevated', tone: 'amber' };
  return { label: 'Low', tone: 'muted' };
}

export const STATUS_LABEL: Record<Status, string> = {
  PendingScore: 'Awaiting score',
  Held: 'Held',
  Executing: 'Executing',
  Executed: 'Sent',
  Cancelled: 'Cancelled',
  Rescued: 'Rescued',
  Failed: 'Failed',
};

export const SIGNAL_LABEL: Record<string, string> = {
  new_destination: 'New destination',
  fresh_whitelist: 'Freshly whitelisted',
  chunked_drain: 'Chunked drain pattern',
  unusual_size: 'Unusual size',
  large_share_of_reserve: 'Large share of reserve',
  off_rhythm_time: 'Off-rhythm time',
  signing_pattern_change: 'Signing-pattern change',
  agent_unlisted_destination: 'Agent paying unlisted address',
  trusted_destination: 'Trusted destination',
};

/** Compact NEAR account for tables: attacker.rescueroom-j60ox4.testnet -> attacker…testnet */
export const acct = (a: string) => (a.length > 22 && a.includes('.') ? `${a.split('.')[0]}…${a.slice(a.lastIndexOf('.'))}` : a);

/** "1.25" -> yoctoNEAR (up to 6 decimals); null if invalid. */
export function parseNear(s: string): bigint | null {
  if (!/^\d+(\.\d{0,6})?$/.test(s.trim())) return null;
  const [w, f = ''] = s.trim().split('.');
  return BigInt(w) * 10n ** 24n + BigInt((f + '000000').slice(0, 6)) * 10n ** 18n;
}
