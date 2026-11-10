// Public "Run attacker": sends the scripted drain with the sandbox agent key and streams each step
// (Server-Sent Events in the POST response). Limits: one run at a time and a global cooldown and daily
// cap, all checked against the sandbox vault on chain, plus a per-IP limit on each warm instance.
import { runAttack, admission, Busy } from '../../lib/sandbox-attack.js';
import { SANDBOX, call, view, balance, sandboxAgent, json, clientIp } from '../_lib.js';

const hits = new Map();
const PER_IP = Number(process.env.SANDBOX_PER_CLIENT || 2);
const WINDOW = Number(process.env.SANDBOX_WINDOW_MIN || 10) * 60_000;
const lim = { cooldownS: Number(process.env.SANDBOX_COOLDOWN_S || 90), perDay: Number(process.env.SANDBOX_PER_DAY || 40) };

export const config = { maxDuration: 150 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  const sa = sandboxAgent();
  if (!sa) return json(res, 503, { error: 'sandbox not configured' });
  const ip = clientIp(req);
  const mine = (hits.get(ip) || []).filter((t) => Date.now() - t < WINDOW);
  if (mine.length >= PER_IP) {
    const retry = Math.ceil((WINDOW - (Date.now() - mine[0])) / 1000);
    return json(res, 429, { error: `limit ${PER_IP} runs per ${WINDOW / 60000} min`, retry_after_s: retry }, { 'retry-after': String(retry) });
  }
  try {
    await admission({ view, V: SANDBOX.vault, agentPk: sa.agentPk, ...lim });
  } catch (e) {
    if (e instanceof Busy) return json(res, e.message.includes('daily') || e.message.includes('moments') ? 429 : 409, { error: e.message, retry_after_s: e.retry_after_s }, { 'retry-after': String(e.retry_after_s) });
    return json(res, 502, { error: 'chain read failed' });
  }
  hits.set(ip, [...mine, Date.now()]);
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-accel-buffering', 'no');
  let seq = 0;
  const emit = (e) => res.write(`id: ${seq}\nevent: ${e.type}\ndata: ${JSON.stringify({ ...e, seq: seq++ })}\n\n`);
  emit({ type: 'queued', id: 'hosted' });
  try {
    await runAttack({ emit, call, view, balance, ...sa, V: SANDBOX.vault, safe: SANDBOX.safe, attacker: SANDBOX.attacker, ...lim, cooldownS: 0 });
  } catch (e) {
    emit({ type: 'error', message: e instanceof Busy ? e.message : 'the run stopped: ' + String(e.message).slice(0, 160) });
  }
  emit({ type: 'end' });
  res.end();
}
