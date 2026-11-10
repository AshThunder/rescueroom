import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, ExternalLink, Hourglass, LoaderCircle, Play, RotateCcw, ShieldCheck, SquareTerminal, Zap } from 'lucide-react';
import { Bar, Card, ExtLink, Tag } from '../components/ui';
import { useToast } from '../components/Toast';
import { api } from '../lib/api';
import { nearAmt } from '../lib/format';
import attack from '@deploy/e2e-attack.json';
import falseAlarm from '@deploy/e2e-falsealarm.json';
import eth from '@deploy/e2e-eth.json';
import cover from '@deploy/e2e-cover.json';
import ethRescue from '@deploy/e2e-ethrescue.json';
import sepoliaLive from '@deploy/sepolia-live.json';
import { dateTime } from '../lib/format';

interface Step { at: string; name: string; hash?: string; note?: string; explorer?: string }
const RUNS: { key: string; title: string; steps: Step[] }[] = [
  { key: 'attack', title: 'Scenario 1 · Rescue: stolen agent key drains in chunks', steps: attack as Step[] },
  { key: 'false', title: 'Scenario 2 · False alarm: owner cancels own flagged vendor payment', steps: falseAlarm as Step[] },
  { key: 'cover', title: 'Scenario 3 · Cover payout for the hot-allowance loss', steps: cover as Step[] },
  { key: 'ethrescue', title: 'Sepolia rescue via chain signatures', steps: ethRescue as Step[] },
  { key: 'eth', title: 'Chain-signature check', steps: eth as Step[] },
];

export function Attack() {
  return (
    <>
      <div className="phead">
        <div>
          <h1 className="ptitle">Try to drain it</h1>
          <p className="psub">A scripted attacker holding a stolen agent key tries to empty the vault in chunks. No real-money bounty; testnet only.</p>
        </div>
      </div>
      <Sandbox />
      <SepoliaLive />
      <h2 className="h3 mt32">Recorded scenario runs</h2>
      <div className="banner mt16 small"><SquareTerminal className="ic t3" aria-hidden /><span>Each run below happened on NEAR testnet against the demo treasury. Re-run with <span className="mono">npm run e2e</span>.</span></div>
      <div className="stack g16 mt16">
        {RUNS.map((run) => (
          <Card key={run.key} title={run.title} aside={run.steps[0] ? `last run ${dateTime(run.steps[0].at)}` : 'not run'}>
            <ol className="list" style={{ listStyle: 'none' }}>
              {run.steps.map((s, i) => (
                <li key={i} className="li" style={{ alignItems: 'flex-start' }}>
                  <span className="mono small t3" style={{ width: 24, flex: 'none', paddingTop: 2 }}>{i + 1}</span>
                  <div className="grow">
                    <div>{s.name}</div>
                    {s.note && <div className="small t3 break">{s.note}</div>}
                  </div>
                  {s.explorer ? <ExtLink href={s.explorer}><span className="mono small">tx</span></ExtLink> : <Tag>check</Tag>}
                </li>
              ))}
            </ol>
          </Card>
        ))}
      </div>
    </>
  );
}

interface SEv { type: string; seq: number; at?: number; label?: string; hash?: string; explorer?: string; outcome?: string; note?: string; message?: string; hot_lost?: string; reserve_kept?: string; attempted?: string; reserve?: string; hot_allowance?: string; vault?: string; ms?: number; rescued?: boolean }

function Sandbox() {
  const toast = useToast();
  const [evs, setEvs] = useState<SEv[]>([]);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<{ vault: string | null; limits?: { perClient: number; windowMin: number } } | null>(null);
  const [down, setDown] = useState(false);
  const es = useRef<EventSource | null>(null);

  const handle = useCallback((e: SEv) => {
    setEvs((l) => (l.some((x) => x.seq === e.seq) ? l : [...l, e]));
    if (e.type === 'result') toast.push(e.rescued === false
      ? { title: 'Drain held', body: `Hot allowance lost ${nearAmt(e.hot_lost!, 2)} NEAR; the rest stays held in the vault` }
      : { tone: 'ok', title: 'Rescue complete', body: `Hot allowance lost ${nearAmt(e.hot_lost!, 2)} NEAR, reserve kept ${nearAmt(e.reserve_kept!, 2)} NEAR` });
    if (e.type === 'error') toast.push({ tone: 'err', title: 'Sandbox run failed', body: e.message });
  }, [toast]);

  const follow = useCallback((run: string) => {
    es.current?.close();
    setEvs([]);
    setBusy(true);
    const src = new EventSource(`/api/sandbox/stream/${run}`);
    es.current = src;
    const on = (m: MessageEvent) => {
      const e = JSON.parse(m.data) as SEv;
      handle(e);
      if (e.type === 'end') {
        setBusy(false);
        src.close();
      }
    };
    ['queued', 'start', 'step', 'result', 'error', 'done', 'end'].forEach((t) => src.addEventListener(t, on as EventListener));
    src.onerror = () => {
      if (src.readyState === EventSource.CLOSED) setBusy(false);
    };
  }, [handle]);

  useEffect(() => {
    api<{ busy: boolean; active: string | null; last: { id: string; events: SEv[] } | null; vault: string | null; limits: { perClient: number; windowMin: number } }>('/sandbox/last')
      .then((r) => {
        setInfo({ vault: r.vault, limits: r.limits });
        if (r.active) follow(r.active);
        else if (r.last) setEvs(r.last.events);
      })
      .catch(() => setDown(true));
    return () => es.current?.close();
  }, [follow]);

  // Local API: POST returns 202 and the run streams from /api/sandbox/stream/:id.
  // Hosted API: the POST response itself is the event stream.
  async function run() {
    let r: Response;
    try {
      r = await fetch('/api/sandbox/run', { method: 'POST', headers: { accept: 'text/event-stream, application/json' } });
    } catch (e) {
      toast.push({ tone: 'err', title: 'Could not start the sandbox', body: (e as Error).message });
      return;
    }
    if ((r.headers.get('content-type') || '').includes('text/event-stream') && r.body) {
      toast.push({ title: 'Attacker started', body: 'Streaming each step from NEAR testnet.' });
      es.current?.close();
      setEvs([]);
      setBusy(true);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = chunk.split('\n').find((l) => l.startsWith('data: '));
            if (data) handle(JSON.parse(data.slice(6)) as SEv);
          }
        }
      } finally {
        setBusy(false);
      }
      return;
    }
    const body = await r.json().catch(() => ({}));
    if (r.ok) {
      toast.push({ title: 'Attacker started', body: 'Streaming each step from NEAR testnet.' });
      follow(body.run);
      return;
    }
    if (r.status === 429) toast.push({ tone: 'err', title: 'Rate limited', body: `${body.error || 'Too many runs'}. Try again in ${Math.max(1, Math.ceil((body.retry_after_s || 60) / 60))} min.` });
    else if (r.status === 409) toast.push({ title: 'Sandbox busy', body: `${body.error || 'A run is in progress'}. Try again in about ${body.retry_after_s || 30}s.` });
    else toast.push({ tone: 'err', title: 'Could not start the sandbox', body: body.error || `HTTP ${r.status}` });
    if (r.status === 409) api<{ active: string | null }>('/sandbox/last').then((x) => x.active && follow(x.active)).catch(() => {});
  }

  const result = evs.find((e) => e.type === 'result');
  const start = evs.find((e) => e.type === 'start');
  const steps = evs.filter((e) => e.type === 'step' || e.type === 'error');
  const lost = result ? BigInt(result.hot_lost!) : 0n;
  const kept = result ? BigInt(result.reserve_kept!) : 0n;
  const total = lost + kept || 1n;
  return (
    <Card className="mt24" title="Attacker sandbox" aside={info?.vault ? <span className="mono">{info.vault}</span> : 'testnet'}>
      <div className="pad stack g16">
        <div className="row gap16 wrap">
          <div className="grow small t2" style={{ minWidth: 240 }}>Runs the scripted attacker with a stolen agent key against a separate sandbox vault: one hot-allowance spend, then a chunked drain. The watcher scores it, two guardians vote, and the reserve moves to the safe account. The vault is reset after each run.{info?.limits ? ` Limit ${info.limits.perClient} runs per ${info.limits.windowMin} min.` : ''}</div>
          <button className="btn amb lg" onClick={run} disabled={busy || down} aria-busy={busy}>{busy ? <LoaderCircle className="ic spin" /> : evs.length ? <RotateCcw className="ic" /> : <Play className="ic" />}{busy ? 'Running…' : evs.length ? 'Run again' : 'Run attacker'}</button>
        </div>
        {down && <div className="banner a small" role="status"><CircleAlert className="ic amber" aria-hidden /><span>The sandbox API is not reachable. Locally, start it with <span className="mono">npm run api</span>, then reload.</span></div>}
        {(result || busy) && (
          <div className="versus">
            <div className="card pad stack g8" style={{ background: 'var(--bg0)' }}>
              <span className="lbl row gap8"><Zap className="ic amber" aria-hidden />Hot allowance lost</span>
              <span className="fig">{result ? nearAmt(lost, 2) : '…'}<span className="u">NEAR</span></span>
              <Bar frac={result ? Number(lost) / Number(total) : 0} tone="var(--amber)" />
              <span className="small t3">Paid instantly by design; this is what cover pays back.</span>
            </div>
            <div className="card pad stack g8" style={{ background: 'var(--bg0)' }}>
              <span className="lbl row gap8"><ShieldCheck className="ic green" aria-hidden />Reserve kept</span>
              <span className="fig">{result ? nearAmt(kept, 2) : '…'}<span className="u">NEAR</span></span>
              <Bar frac={result ? Number(kept) / Number(total) : 0} tone="var(--green)" />
              <span className="small t3">{start ? `Of ${nearAmt(start.reserve!, 2)} NEAR available when the attack began.` : 'Moved to the safe account by guardian rescue.'}</span>
            </div>
          </div>
        )}
      </div>
      {steps.length > 0 && (
        <ol className="stream" aria-live="polite" aria-label="Attacker run steps">
          {steps.map((e) => {
            const Icon = e.type === 'error' ? CircleAlert : e.outcome === 'paid' ? Zap : e.outcome === 'held' ? Hourglass : CircleCheck;
            return (
              <li key={e.seq}>
                <span className="t">{((e.at ?? 0) / 1000).toFixed(1)}s</span>
                <Icon className={`ic ${e.type === 'error' ? 'red' : e.outcome === 'paid' ? 'amber' : e.outcome === 'held' ? 'amber' : 'green'}`} aria-hidden />
                <div className="grow"><div>{e.label || e.message}</div>{e.note && <div className="small t3 break">{e.note}</div>}</div>
                {e.explorer ? <a className="link small row gap4" style={{ display: 'inline-flex' }} href={e.explorer} target="_blank" rel="noreferrer" aria-label={`Open transaction on NearBlocks`}><span className="mono">tx</span><ExternalLink className="ic" style={{ width: 12, height: 12 }} aria-hidden /></a> : <span />}
              </li>
            );
          })}
          {busy && <li><span className="t">…</span><LoaderCircle className="ic t3 spin" aria-hidden /><div className="grow t3">Waiting for the next block</div><span /></li>}
        </ol>
      )}
    </Card>
  );
}

interface LiveTx { id: number; nonce: number; to: string; value: string; hash: string; explorer: string; status: number; fee_eth: string; block: number }

/** Real Sepolia transactions: MPC-signed by the vault through NEAR chain signatures, broadcast by the relayer. */
function SepoliaLive() {
  const live = sepoliaLive as unknown as { vault: string; vault_evm: string; sepolia: LiveTx[] };
  if (!live.sepolia?.length) return null;
  const label = (_t: LiveTx, i: number) => (i === 0 ? 'Hot-allowance send' : 'Rescue to the DAO safe address');
  return (
    <Card className="mt24" title="Live Sepolia broadcasts" aside={<span className="mono">{live.vault_evm.slice(0, 6)}…{live.vault_evm.slice(-4)}</span>}>
      <div className="tblwrap">
        <table className="tbl resp">
          <thead><tr><th>Transaction</th><th className="num">ETH</th><th className="c-opt">To</th><th className="num c-opt">Fee ETH</th><th>Result</th><th aria-label="Explorer" /></tr></thead>
          <tbody>
            {live.sepolia.map((t, i) => (
              <tr key={t.hash}>
                <td>{label(t, i)}<div className="small t3 mono">request #{t.id} · nonce {t.nonce}</div></td>
                <td className="num mono">{t.value}</td>
                <td className="mono small c-opt">{t.to.slice(0, 6)}…{t.to.slice(-4)}</td>
                <td className="num mono small c-opt">{Number(t.fee_eth).toFixed(6)}</td>
                <td><Tag tone={t.status === 1 ? 'g' : 'r'} dot>{t.status === 1 ? 'mined' : 'failed'}</Tag></td>
                <td><ExtLink href={t.explorer}><span className="mono small">{t.hash.slice(0, 10)}…</span></ExtLink></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pad small t3">Signed by the vault <span className="mono">{live.vault}</span> through NEAR chain signatures (MPC), broadcast by the relayer. Gas limit 220k because Sepolia charges about 207k gas for a transfer that creates a new account.</div>
    </Card>
  );
}
