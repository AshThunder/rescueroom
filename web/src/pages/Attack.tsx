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

interface SEv { type: string; seq: number; at?: number; label?: string; hash?: string; explorer?: string; outcome?: string; note?: string; message?: string; hot_lost?: string; reserve_kept?: string; attempted?: string; reserve?: string; hot_allowance?: string; vault?: string; ms?: number }

function Sandbox() {
  const toast = useToast();
  const [evs, setEvs] = useState<SEv[]>([]);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<{ vault: string | null; limits?: { perClient: number; windowMin: number } } | null>(null);
  const [down, setDown] = useState(false);
  const es = useRef<EventSource | null>(null);

  const follow = useCallback((run: string) => {
    es.current?.close();
    setEvs([]);
    setBusy(true);
    const src = new EventSource(`/api/sandbox/stream/${run}`);
    es.current = src;
    const on = (m: MessageEvent) => {
      const e = JSON.parse(m.data) as SEv;
      setEvs((l) => (l.some((x) => x.seq === e.seq) ? l : [...l, e]));
      if (e.type === 'result') toast.push({ tone: 'ok', title: 'Rescue complete', body: `Hot allowance lost ${nearAmt(e.hot_lost!, 2)} NEAR, reserve kept ${nearAmt(e.reserve_kept!, 2)} NEAR` });
      if (e.type === 'error') toast.push({ tone: 'err', title: 'Sandbox run failed', body: e.message });
      if (e.type === 'end') {
        setBusy(false);
        src.close();
      }
    };
    ['queued', 'start', 'step', 'result', 'error', 'done', 'end'].forEach((t) => src.addEventListener(t, on as EventListener));
    src.onerror = () => {
      if (src.readyState === EventSource.CLOSED) setBusy(false);
    };
  }, [toast]);

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

  async function run() {
    try {
      const r = await api<{ run: string }>('/sandbox/run', { method: 'POST' });
      toast.push({ title: 'Attacker started', body: 'Streaming each step from NEAR testnet.' });
      follow(r.run);
    } catch (e) {
      const x = e as Error & { status?: number; retry?: number };
      if (x.status === 429) toast.push({ tone: 'err', title: 'Rate limited', body: `${x.message}. Try again in ${Math.ceil((x.retry || 60) / 60)} min.` });
      else if (x.status === 409) toast.push({ title: 'A run is already in progress', body: 'Showing it now.' });
      else toast.push({ tone: 'err', title: 'Could not start the sandbox', body: x.message });
      if (x.status === 409) api<{ active: string }>('/sandbox/last').then((r) => r.active && follow(r.active));
    }
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
        {down && <div className="banner a small" role="status"><CircleAlert className="ic amber" aria-hidden /><span>The local API is not running. Start it with <span className="mono">npm run api</span>, then reload.</span></div>}
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
