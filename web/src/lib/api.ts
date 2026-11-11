// Local Rescue Room API (server/src/index.js), proxied by Vite at /api. Optional: pages fall back when it is down.
export interface IndexedEvent {
  key: string; account: string; event: string; data: Record<string, unknown>; tx_hash: string; receipt_id: string;
  signer: string; predecessor?: string; block_height: number; ts_ms: number; explorer: string;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(body.error || `HTTP ${r.status}`) as Error & { status: number; retry?: number };
    e.status = r.status;
    e.retry = body.retry_after_s;
    throw e;
  }
  return body as T;
}

/** The defender (Fly.io): per-vault alerts and "simulate an attack on my vault". */
export const DEFENDER_URL: string = (import.meta.env.VITE_DEFENDER_URL as string | undefined) || 'https://rescueroom-defender.fly.dev';

export async function defender<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${DEFENDER_URL}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(body.error || `HTTP ${r.status}`) as Error & { status: number; retry?: number };
    e.status = r.status;
    e.retry = body.retry_after_s;
    throw e;
  }
  return body as T;
}

/** POST that answers with Server-Sent Events; calls onEvent for each `data:` payload. */
export async function postStream(url: string, body: unknown, onEvent: (e: Record<string, unknown>) => void): Promise<void> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body) });
  if (!r.ok || !r.body) {
    const b = await r.json().catch(() => ({}));
    throw new Error(b.error || `HTTP ${r.status}`);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (data) onEvent(JSON.parse(data.slice(6)));
    }
  }
}
