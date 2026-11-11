import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, ExternalLink, Hourglass, LoaderCircle, Play, RotateCcw, ShieldCheck, SquareTerminal, Zap } from 'lucide-react';
import { Bar, Card, ExtLink, Tag, PageHeader } from '../components/ui';
import { useToast } from '../components/Toast';
import { api, defender, DEFENDER_URL, postStream } from '../lib/api';
import { Link } from 'react-router-dom';
import { useVault } from '../components/Shell';
import { useWallet } from '../lib/wallet';
import { isFactoryVault, useActiveVault } from '../lib/active';
import { Sparkles, Snowflake, KeyRound } from 'lucide-react';
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
  const vault = useActiveVault();
  if (isFactoryVault(vault)) return <SimulateMine />;
  return (
    <>
      <PageHeader title="Try to drain it" sub={<>A scripted attacker holding a stolen agent key tries to empty the vault in chunks. No real-money bounty; testnet only.</>} />
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

interface Prep { sim: string; vault: string; public_key: string; ttl_secs: number; call: { receiver: string; method: string; args: Record<string, unknown>; deposit: string; gas: string } }
interface MEv { type: string; title?: string; evidence?: string; suggestion?: string; mode?: string; patterns?: number; seq: number; at?: number; label?: string; note?: string; explorer?: string; outcome?: string; message?: string; text?: string; provider?: string; rescued?: boolean; status?: string; drain?: string; frozen?: boolean; key_revoked?: boolean; links?: { hold: string; rescue: string; cancel: string }; ms?: number; reserve?: string; hot_allowance?: string; score?: number }
const PENDING_SIM = 'rr.sim';
const local = (u: string) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };

/** "Simulate an attack on my vault": the owner grants a temporary request_withdraw-only key, the defender attacks with it. */
function SimulateMine() {
  const { data, error, loading, refresh } = useVault();
  const w = useWallet();
  const toast = useToast();
  const [evs, setEvs] = useState<MEv[]>([]);
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'signing' | 'running' | 'done'>('idle');
  const [mode, setMode] = useState<'drain' | 'batch'>('drain');
  const started = useRef(false);

  const stream = useCallback(async (sim: string) => {
    setPhase('running');
    setEvs([]);
    try {
      await postStream(`${DEFENDER_URL}/sim/start`, { sim }, (e) => {
        const m = e as unknown as MEv;
        setEvs((l) => [...l, m]);
        if (m.type === 'result' && m.mode === 'batch') toast.push({ title: m.patterns ? 'Pattern alert raised' : 'No pattern fired', body: m.patterns ? 'The burst of small withdrawals was flagged. Nothing was changed on chain.' : 'Try again when the allowance resets.' });
        else if (m.type === 'result') toast.push(m.rescued ? { tone: 'ok', title: 'Rescued', body: 'The drain was held and the guardians moved the reserve to your safe account.' } : { title: `Drain ${m.status?.toLowerCase()}`, body: 'Nothing left the vault beyond the allowance.' });
        if (m.type === 'error') toast.push({ tone: 'err', title: 'Simulation stopped', body: m.message });
      });
    } catch (e) {
      toast.push({ tone: 'err', title: 'Lost the simulation stream', body: (e as Error).message });
    }
    sessionStorage.removeItem(PENDING_SIM);
    started.current = false;
    setPhase('done');
    refresh();
  }, [toast, refresh]);

  // Back from a redirect wallet with the key granted: start the run.
  useEffect(() => {
    const p = sessionStorage.getItem(PENDING_SIM);
    if (p && !started.current && data) {
      const x = JSON.parse(p) as { sim: string; vault: string };
      if (x.vault === data.vault) {
        started.current = true;
        stream(x.sim);
      }
    }
  }, [data, stream]);

  if (loading && !data) return <LoadingCardsLite />;
  if (!data) return <Card><div className="pad">{error}</div></Card>;
  const isOwner = w.accountId === data.config.owner;
  const demo = !!data.info?.demo;
  const available = BigInt(data.status.near_available);
  const ready = !data.status.frozen && available >= 3n * 10n ** 23n;

  async function go() {
    if (!w.accountId) return w.connect();
    setPhase('preparing');
    let p: Prep;
    try {
      p = await defender<Prep>('/sim/prepare', { method: 'POST', body: JSON.stringify({ vault: data!.vault, mode }) });
    } catch (e) {
      const x = e as Error & { retry?: number };
      toast.push({ tone: 'err', title: 'Cannot simulate yet', body: x.message + (x.retry ? ` Try again in ${Math.ceil(x.retry / 60)} min.` : '') });
      return setPhase('idle');
    }
    setPhase('signing');
    started.current = true;
    sessionStorage.setItem(PENDING_SIM, JSON.stringify({ sim: p.sim, vault: p.vault }));
    try {
      await w.send({ receiver: p.call.receiver, method: p.call.method, args: p.call.args, deposit: BigInt(p.call.deposit), gas: BigInt(p.call.gas) });
    } catch (e) {
      sessionStorage.removeItem(PENDING_SIM);
      started.current = false;
      toast.push({ tone: 'err', title: 'Key not granted', body: (e as Error).message.slice(0, 200) });
      return setPhase('idle');
    }
    stream(p.sim);
  }

  const steps = evs.filter((e) => e.type === 'step' || e.type === 'error');
  const expl = evs.find((e) => e.type === 'explanation');
  const decide = evs.find((e) => e.type === 'decide');
  const result = evs.find((e) => e.type === 'result');
  const patterns = evs.filter((e) => e.type === 'pattern');
  const busy = phase === 'preparing' || phase === 'signing' || phase === 'running';
  return (
    <>
      <PageHeader title="Simulate an attack" sub={<>A scripted attacker gets a temporary key to <span className="mono">{data.vault}</span>, spends inside the allowance, then tries to drain the rest. Testnet only.</>} />
      <Card className="mt24" title="Attack on my vault" aside={demo ? <Tag tone="a">demo guardians auto-vote</Tag> : <Tag>your guardians decide</Tag>}>
        <div className="pad stack g16">
          <ol className="steps3 small t2" style={{ margin: 0, paddingLeft: 18 }}>
            <li>You sign once to grant an attacker key: function-call only, <span className="mono">request_withdraw</span> only, revoked automatically within 10 minutes.</li>
            <li>The attacker spends inside the hot allowance (paid at once, then returned to you by Rescue Room), then tries to drain 90% of the reserve.</li>
            <li>The drain is held, the watcher scores and explains it, and {demo ? 'the demo guardians run by Rescue Room vote to rescue it to your account.' : 'your guardians can rescue or you can cancel.'}</li>
          </ol>
          {data.status.frozen && <div className="banner a small" role="status"><Snowflake className="ic amber" aria-hidden /><span>The vault is frozen after a rescue. {demo ? 'The demo guardians unfreeze it about 2 minutes after a rescue.' : data.council ? <>Guardians unfreeze it with <Link className="link" to="/app/sign/unfreeze/0">a vote</Link>.</> : <>The DAO unfreezes it with <Link className="link" to="/app/sign/unfreeze/0">a proposal</Link>.</>}</span></div>}
          {!data.status.frozen && available < 3n * 10n ** 23n && <div className="banner a small" role="status"><span>The vault needs at least 0.3 NEAR available (has {nearAmt(available, 3)}). <Link className="link" to="/app/connect">Fund it</Link>.</span></div>}
          {!isOwner && <div className="banner small">{w.accountId ? <>Only the owner <span className="mono">{data.config.owner}</span> can grant the attacker key.</> : 'Connect the owner wallet to start.'}</div>}
          <div className="seg" style={{ alignSelf: 'flex-start' }} role="radiogroup" aria-label="Attack type">
            <button type="button" role="radio" aria-checked={mode === 'drain'} className={mode === 'drain' ? 'on' : ''} onClick={() => setMode('drain')} disabled={busy}>Drain the reserve</button>
            <button type="button" role="radio" aria-checked={mode === 'batch'} className={mode === 'batch' ? 'on' : ''} onClick={() => setMode('batch')} disabled={busy}>Small batch drain</button>
          </div>
          {mode === 'batch' && <p className="small t2" style={{ margin: 0 }}>Five small instant withdrawals that stay inside the hot allowance, so none is held. The watcher's pattern rules flag the burst and recommend tightening the allowance or removing the key. They never act on their own.</p>}
          <div className="row gap12 wrap">
            <button className="btn amb lg" onClick={go} disabled={busy || (!!w.accountId && (!isOwner || !ready))} aria-busy={busy}>
              {busy ? <LoaderCircle className="ic spin" /> : result ? <RotateCcw className="ic" /> : <Play className="ic" />}
              {phase === 'preparing' ? 'Preparing…' : phase === 'signing' ? 'Sign in your wallet…' : phase === 'running' ? 'Attack running…' : !w.accountId ? 'Connect wallet' : result ? 'Simulate again' : mode === 'batch' ? 'Run small batch drain' : 'Simulate an attack'}
            </button>
            <span className="small t3">Limit: one run per vault every 3 minutes.</span>
          </div>
        </div>
        {steps.length > 0 && (
          <ol className="stream" aria-live="polite" aria-label="Simulation steps">
            {steps.map((e) => {
              const Icon = e.type === 'error' ? CircleAlert : e.outcome === 'paid' ? Zap : e.outcome === 'held' || e.outcome === 'flagged' ? Hourglass : /key/i.test(e.label || '') ? KeyRound : CircleCheck;
              return (
                <li key={e.seq}>
                  <span className="t">{((e.at ?? 0) / 1000).toFixed(1)}s</span>
                  <Icon className={`ic ${e.type === 'error' ? 'red' : e.outcome ? 'amber' : 'green'}`} aria-hidden />
                  <div className="grow"><div>{e.label || e.message}</div>{e.note && <div className="small t3 break">{e.note}</div>}</div>
                  {e.explorer ? <a className="link small row gap4" style={{ display: 'inline-flex' }} href={e.explorer} target="_blank" rel="noreferrer" aria-label="Open transaction on NearBlocks"><span className="mono">tx</span><ExternalLink className="ic" style={{ width: 12, height: 12 }} aria-hidden /></a> : <span />}
                </li>
              );
            })}
            {phase === 'running' && <li><span className="t">…</span><LoaderCircle className="ic t3 spin" aria-hidden /><div className="grow t3">Waiting for the next block</div><span /></li>}
          </ol>
        )}
      </Card>
      {expl?.text && (
        <Card className="mt16" title={<span className="row gap8"><Sparkles className="ic t3" aria-hidden />Why the watcher held it</span>} aside={<span className="mono small">{expl.provider}</span>}>
          <p className="pad small t2" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{expl.text}</p>
        </Card>
      )}
      {decide?.links && !result?.rescued && (
        <Card className="mt16" title="Your move">
          <div className="pad row gap8 wrap">
            <Link className="btn amb" to={local(decide.links.rescue)}><ShieldCheck className="ic" />Guardian: rescue</Link>
            <Link className="btn" to={local(decide.links.cancel)}>Owner: cancel</Link>
            <Link className="btn ghost" to={local(decide.links.hold)}>Open the hold</Link>
          </div>
        </Card>
      )}
      {patterns.length > 0 && (
        <Card className="mt16" title="Pattern alert" aside={<Tag tone="a">recommend only</Tag>}>
          <ul className="list" style={{ listStyle: 'none' }}>
            {patterns.map((p) => (
              <li key={p.seq} className="li" style={{ alignItems: 'flex-start' }}>
                <div className="grow stack g4"><div>{p.title}</div><div className="small t3 break">{p.evidence}</div><div className="small t2">{p.suggestion}</div></div>
              </li>
            ))}
          </ul>
          <div className="pad row gap8 wrap"><Link className="btn" to="/app/policy">Tighten allowance</Link><Link className="btn ghost" to="/app/connect">Agent keys</Link></div>
        </Card>
      )}
      {result && result.mode !== 'batch' && (
        <Card className="mt16" title={result.rescued ? 'Rescued' : `Result: ${result.status}`} aside={result.key_revoked ? <Tag tone="g" dot>attacker key revoked</Tag> : <Tag tone="a">key revokes at expiry</Tag>}>
          <div className="pad row gap8 wrap">
            <span className="grow small t2">{result.rescued ? <>The {nearAmt(result.drain || '0', 3)} NEAR drain never paid out; the reserve went to <span className="mono">{data.config.safe_near}</span>.</> : 'The drain is still held; it cannot pay out before its release time.'}</span>
            {result.links && <Link className="btn" to={local(result.links.hold)}>Open the hold</Link>}
            <Link className="btn ghost" to="/app/activity">Audit log</Link>
          </div>
        </Card>
      )}
    </>
  );
}

function LoadingCardsLite() {
  return <div className="card mt24 pad small t3">Loading the vault…</div>;
}
