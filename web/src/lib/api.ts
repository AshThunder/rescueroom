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
