import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronRight, Fingerprint, LifeBuoy, RotateCcw, Copy, Check } from 'lucide-react';
import { useVault } from '../components/Shell';
import { Bar, Card, Empty, ErrorState, ExtLink, Kv, LoadingCards, Tag, PageHeader } from '../components/ui';
import { Ring } from '../components/Ring';
import { StatusTag, who } from '../components/vault';
import { isOpen, useNow } from '../lib/useVault';
import { SIGNAL_LABEL, acct, amt, assetLabel, countdown, dateTime, duration, reqId, short, tierOf } from '../lib/format';
import { etherscanTx } from '../lib/near';
import { getVault } from '../lib/active';
import { api, type IndexedEvent } from '../lib/api';
import { describeEvent } from '../lib/events';
import { ExternalLink } from 'lucide-react';

interface Evidence { hash: string; source?: 'chain' | 'file'; bundle: { explanation: { provider: string; text: string }; model: string; signals: { code: string; weight: number; detail: string }[]; scored_at: string } }

export function HoldDetail() {
  const { id } = useParams();
  const { data, error, loading, refresh } = useVault();
  const now = useNow();
  const [ev, setEv] = useState<Evidence | null>(null);
  const [copied, setCopied] = useState(false);
  const r = data?.requests.find((x) => String(x.id) === id);
  useEffect(() => {
    const want = r?.score?.evidence_hash;
    if (r === undefined || !want) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const e = await loadEvidence(data!.vault, r.id, want);
      if (stop) return;
      if (e) setEv(e);
      // The event reaches the indexer a few seconds after the score; keep looking until it does.
      if (!e || e.source !== 'chain') timer = setTimeout(load, 10_000);
    };
    load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [r?.id, r?.score?.evidence_hash]);

  if (loading && !data) return <LoadingCards n={2} />;
  if (!data) return <Card><ErrorState error={error || 'unknown'} onRetry={refresh} /></Card>;
  if (!r) return <Card><Empty title={`No request ${id}`}>It may not exist on this vault. <Link className="link" to="/app/holds">Back to holds</Link></Empty></Card>;

  const { config: c, status: s } = data;
  const open = isOpen(r);
  const created = Number(r.created_ms), release = Number(r.release_ms);
  const total = Math.max(1, release - created);
  const left = release - now;
  const frac = open ? Math.min(1, Math.max(0, (now - created) / total)) : 1;
  const score = r.score?.score;
  const tier = score !== undefined ? tierOf(score) : null;
  const tone = r.status === 'Rescued' ? 'green' : r.status === 'Cancelled' ? 'muted' : tier?.tone === 'red' ? 'red' : 'amber';
  const isOwnerRequest = r.requester === c.owner;
  const evmTo = r.evm_tx?.to;
  const hashMatch = ev && r.score ? ev.hash === r.score.evidence_hash : null; // ev.hash is recomputed in the browser for chain evidence

  return (
    <>
      <PageHeader
        crumb={<><Link className="link" to="/app/holds">Holds</Link><ChevronRight className="ic" aria-hidden /><span className="mono">{reqId(r.id)}</span></>}
        eyebrow={<><StatusTag r={r} />{tier && <Tag tone={tier.tone === 'red' ? 'r' : tier.tone === 'amber' ? 'a' : undefined}>{tier.label} risk</Tag>}<span className="mono">{reqId(r.id)} · {dateTime(r.created_ms)}</span></>}
        title={<>{amt(r.asset, r.amount)} to {r.asset === 'Near' ? r.to : short(r.to, 8, 6)}</>}
        sub={<>Requested by <span className="mono">{who(r)}</span>{r.hot ? ' within the hot allowance' : ' from the cold reserve'}{r.memo ? ` · “${r.memo}”` : ''}</>}
        actions={
          <button className="btn" onClick={() => { navigator.clipboard?.writeText(location.href); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
            {copied ? <Check className="ic" /> : <Copy className="ic" />}{copied ? 'Copied' : 'Copy link'}
          </button>
        }
      />

      <div className="split mt24">
        <div className="stack g16">
          <Card title="What this request does" aside="Read from the vault contract">
            <dl>
              <Kv k="Chain">{r.asset === 'Near' ? 'NEAR testnet' : <>Ethereum Sepolia <span className="t3">via NEAR chain signatures</span></>}</Kv>
              <Kv k="From"><span className="mono small">{r.asset === 'Near' ? data.vault : <>{data.evmAddress} <span className="t3">path {c.evm.path}</span></>}</span></Kv>
              <Kv k="To"><span className="mono small">{r.to}</span></Kv>
              <Kv k="Amount"><span className="mono">{amt(r.asset, r.amount, r.asset === 'Near' ? 4 : 6)}</span> <span className="t3">on {assetLabel(r.asset) === 'NEAR' ? 'NEAR' : 'Sepolia'}</span></Kv>
              <Kv k="Signed by"><span className="mono small">{r.agent ? `function-call key “${r.agent}” (can only call request_withdraw)` : r.requester}</span></Kv>
              {r.evm_tx && <Kv k={r.status === 'Rescued' ? 'Rescue tx' : 'Signed tx'}>{r.status === 'Rescued' && <div className="small green">Redirected to the DAO-controlled safe address {short(evmTo || '', 6, 4)}</div>}<span className="mono small t2">EIP-1559 · nonce {r.evm_tx.nonce} · gas {r.evm_tx.gas_limit.toLocaleString()} · to {short(evmTo || '', 6, 4)} · keccak {short(r.evm_tx.payload_hex, 6, 4)}</span></Kv>}
              {r.signature && <Kv k="MPC signature"><span className="mono small green">signed by {c.evm.mpc_contract}</span>{r.broadcast_hash ? <> · <ExtLink href={etherscanTx(r.broadcast_hash)}>broadcast</ExtLink></> : <span className="t3 small"> · waiting for relayer (needs Sepolia gas)</span>}</Kv>}
            </dl>
          </Card>

          <Card title="Risk score" aside={r.score ? <Tag><Fingerprint className="ic" style={{ width: 12, height: 12 }} />evidence {short(r.score.evidence_hash, 4, 4)}</Tag> : undefined}>
            {!r.score ? (
              <Empty title={r.hot ? 'Not scored: within hot allowance' : 'Waiting for the watcher'}>{r.hot ? 'Hot spends go through instantly. The cover pool backs losses here.' : `Until scored, the longest hold (${duration(c.unscored_hold_secs / c.demo_time_divisor)}) applies.`}</Empty>
            ) : (
              <>
                <div className="pad row gap24 wrap">
                  <div className="stack">
                    <span className={`fig ${tier?.tone === 'red' ? 'red' : 'amber'}`} style={{ fontSize: 56, lineHeight: '56px' }}>{score}</span>
                    <span className="small t3">of 100 · confidence {r.score.confidence}%</span>
                  </div>
                  <div className="grow stack g8" style={{ minWidth: 240 }}>
                    <span className="small t2">{tier?.label} tier: {holdSecs(c, score!) ? `${duration(holdSecs(c, score!))} hold` : 'no hold'}{c.demo_time_divisor > 1 && holdSecs(c, score!) ? ` (demo ${duration(holdSecs(c, score!) / c.demo_time_divisor)})` : ''}</span>
                    <TierScale score={score!} tiers={c.hold_tiers.map((t) => t.min_score)} />
                  </div>
                </div>
                {r.score.signals.length === 0 && <div className="pad small t3" style={{ borderTop: '1px solid var(--line)' }}>No risk signals fired.</div>}
                {r.score.signals.map((sg) => (
                  <div className="sig" key={sg.code}>
                    <div><div className="h3">{SIGNAL_LABEL[sg.code] || sg.code}</div><div className="small t2">{sg.detail}</div></div>
                    <Bar frac={sg.weight / 40} tone="var(--amber)" />
                    <span className="p">{sg.weight > 0 ? `+${sg.weight}` : sg.weight}</span>
                  </div>
                ))}
              </>
            )}
          </Card>

          {r.score && (
            <Card title="Watcher recommendation" aside={hashMatch === null ? 'bundle not published' : hashMatch ? <Tag tone="g">{ev?.source === 'chain' ? 'published on-chain, hash verified' : 'hash matches on-chain'}</Tag> : <Tag tone="r">hash mismatch</Tag>}>
              <div className="pad stack g12">
                <div className="row gap8 wrap">
                  <Tag tone={score! >= 60 ? 'g' : undefined}>{score! >= 60 ? 'Rescue unless planned' : score! >= 30 ? 'Review before release' : 'Release'}</Tag>
                  <span className="small t3">Recommends only. Guardians and the owner decide.</span>
                </div>
                <p>{ev?.bundle.explanation.text || 'The evidence bundle is stored by the watcher; its sha256 is logged on-chain with an ed25519 signature the contract verifies.'}</p>
                <div className="code">
                  {`Signed by   ${c.watcher}\nKey         ${short(c.watcher_pk, 14, 6)}\nBundle      sha256 ${r.score.evidence_hash}\nModel       ${ev?.bundle.model || 'rules-v1'}${ev ? ` · explainer ${ev.bundle.explanation.provider}` : ''}\nScored      ${dateTime(r.score.scored_at_ms)}${ev ? `\nSource      ${ev.source === 'chain' ? 'evidence_published event' : 'watcher evidence file'}` : ''}`}
                </div>
              </div>
            </Card>
          )}
          <RequestEvents id={r.id} />
        </div>

        <div className="stack g16 first-m">
          <Card>
            <div className="pad stack g16" style={{ alignItems: 'center' }}>
              <Ring size={220} frac={frac} tone={tone}>
                {open ? (
                  <>
                    <span className="fig" style={{ fontSize: 30, lineHeight: '36px' }}>{left > 0 ? countdown(left) : 'Ready'}</span>
                    <span className="small t3">{left > 0 ? `left of ${duration(total / 1000)} hold` : 'anyone can execute'}</span>
                  </>
                ) : (
                  <>
                    <span className="fig sm">{r.status === 'Rescued' ? 'Rescued' : r.status === 'Cancelled' ? 'Cancelled' : r.status === 'Executed' ? 'Sent' : r.status}</span>
                    <span className="small t3">{r.resolved_by ? `by ${acct(r.resolved_by)}` : ''}</span>
                  </>
                )}
              </Ring>
              {open && <p className="small t2" style={{ textAlign: 'center' }}>Executes at {dateTime(release)} unless the owner cancels or guardians rescue.{c.demo_time_divisor > 1 && <span className="t3"> Demo clock: 1 h = {60 / c.demo_time_divisor} min.</span>}</p>}
            </div>
            <div className="pad stack g12" style={{ borderTop: '1px solid var(--line)' }}>
              <div className="row sp"><span className="h3">Guardian votes to rescue</span><span className="mono">{r.approvals.length} / {s.approvals_needed}</span></div>
              <div className="tally" style={{ gridTemplateColumns: `repeat(${s.approvals_needed},1fr)` }}>
                {Array.from({ length: s.approvals_needed }).map((_, i) => <i key={i} className={i < r.approvals.length ? 'y' : ''} />)}
              </div>
              <div className="small t3">{c.quorum_pct}% of {s.guardians.length} guardians, at least {c.min_distinct} distinct approvers</div>
              <ul className="list" style={{ listStyle: 'none' }}>
                {s.guardians.map((g) => {
                  const voted = r.approvals.includes(g);
                  return (
                    <li key={g} className="row gap12" style={{ minHeight: 40 }}>
                      <span className={`avatar ${voted ? 'ok' : ''}`} aria-hidden>{g.slice(0, 2).toUpperCase()}</span>
                      <span className="mono small grow ellip">{g}</span>
                      <span className={`small ${voted ? 'green' : 't3'}`}>{voted ? 'rescue' : 'no vote'}</span>
                    </li>
                  );
                })}
              </ul>
              {open && (
                <>
                  <Link className="btn amb full lg" to={`/app/sign/rescue/${r.id}`}><LifeBuoy className="ic" />Vote to rescue</Link>
                  <div className="small t3">Moves {r.asset === 'Near' ? 'the NEAR reserve' : amt(r.asset, r.amount)} to the safe address <span className="mono">{r.asset === 'Near' ? c.safe_near : short(c.safe_evm)}</span> and freezes the vault once quorum is reached.</div>
                  {isOwnerRequest && <Link className="btn full" to={`/app/sign/cancel/${r.id}`}><RotateCcw className="ic" />Owner: cancel this withdrawal</Link>}
                </>
              )}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

function holdSecs(c: { hold_tiers: { min_score: number; hold_secs: number }[]; hold_floor_secs: number }, score: number) {
  const t = [...c.hold_tiers].reverse().find((x) => score >= x.min_score);
  return Math.max(t?.hold_secs ?? 0, c.hold_floor_secs);
}

function TierScale({ score, tiers }: { score: number; tiers: number[] }) {
  const bounds = [...tiers, 101];
  return (
    <div className="stack g4">
      <div className="row gap4" style={{ height: 8 }}>
        {tiers.map((t, i) => {
          const w = bounds[i + 1] - t;
          const active = score >= t && score < bounds[i + 1];
          return <div key={t} style={{ flex: w, height: 6, borderRadius: 3, background: active ? 'var(--amber)' : 'var(--raised2)' }} />;
        })}
      </div>
      <div className="row gap4 small t3 mono">
        {tiers.map((t, i) => <span key={t} style={{ flex: bounds[i + 1] - t }}>{t}+</span>)}
      </div>
    </div>
  );
}

function RequestEvents({ id }: { id: number }) {
  const [evs, setEvs] = useState<IndexedEvent[] | null>(null);
  const [down, setDown] = useState(false);
  useEffect(() => {
    const load = () => api<{ events: IndexedEvent[] }>(`/events?account=${encodeURIComponent(getVault())}&request=${id}`).then((r) => { setEvs(r.events); setDown(false); }).catch(() => setDown(true));
    load();
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [id]);
  if (down && !evs) return null;
  return (
    <Card title="On-chain events" aside="NEP-297, indexed">
      {!evs ? <div className="pad small t3">Loading…</div> : evs.length === 0 ? <Empty title="No events indexed yet">They appear a few seconds after each transaction.</Empty> : (
        <ul className="list" style={{ listStyle: 'none' }}>
          {evs.map((e) => {
            const d = describeEvent(e);
            return (
              <li key={e.key} className="li">
                <d.icon className={`ic ${d.tone === 'g' ? 'green' : d.tone === 'a' ? 'amber' : d.tone === 'r' ? 'red' : 't3'}`} aria-hidden />
                <div className="grow"><div>{d.text}</div><div className="small t3 mono">{e.event} · {dateTime(e.ts_ms)}</div></div>
                <a className="link small row gap4" style={{ display: 'inline-flex' }} href={e.explorer} target="_blank" rel="noreferrer" aria-label="Open transaction on NearBlocks"><span className="mono">{e.tx_hash.slice(0, 8)}</span><ExternalLink className="ic" style={{ width: 12, height: 12 }} aria-hidden /></a>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

async function sha256Hex(text: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Evidence for a scored request. First choice: the evidence_published event (v1.3+ vaults), whose bundle the
 * contract already checked against the signed hash; the browser re-hashes it too. Fallback: the watcher's file.
 */
async function loadEvidence(vault: string, id: number, want: string): Promise<Evidence | null> {
  try {
    const r = await fetch(`/api/events?account=${encodeURIComponent(vault)}&request=${id}&event=evidence_published&limit=5`);
    if (r.ok) {
      const { events } = (await r.json()) as { events: { data: { evidence_hash?: string; evidence?: string } }[] };
      for (const e of events) {
        if (e.data.evidence_hash !== want || typeof e.data.evidence !== 'string') continue;
        const hash = await sha256Hex(e.data.evidence);
        return { hash, source: 'chain', bundle: JSON.parse(e.data.evidence) };
      }
    }
  } catch {
    /* fall through */
  }
  try {
    const f = await fetch(`/evidence/${vault}-${id}.json`);
    if (f.ok) return { ...(await f.json()), source: 'file' } as Evidence;
  } catch {
    /* none */
  }
  return null;
}
