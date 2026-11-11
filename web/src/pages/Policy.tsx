import { useVault } from '../components/Shell';
import { Card, ErrorState, ExtLink, Kv, LoadingCards, Tag, PageHeader } from '../components/ui';
import { duration, ethAmt, nearAmt, short } from '../lib/format';
import { etherscanAddr, nearblocksAcct } from '../lib/near';

export function PolicyPage() {
  const { data, error, loading, refresh } = useVault();
  if (loading && !data) return <LoadingCards n={2} />;
  if (!data) return <Card><ErrorState error={error || 'unknown'} onRetry={refresh} /></Card>;
  const c = data.config;
  const div = c.demo_time_divisor;
  const t = (secs: number) => (secs ? `${duration(secs)}${div > 1 ? ` (demo ${duration(secs / div)})` : ''}` : 'none');
  return (
    <>
      <PageHeader title="Policy" sub={<>Read live from the vault. The owner can only tighten limits; anything that loosens safety goes through a DAO proposal.</>} actions={<>{div > 1 && <Tag tone="a">Demo clock: 1 h = {60 / div} min</Tag>}</>} />
      <div className="grid g2 mt24">
        <Card title="Hold tiers">
          <div className="tblwrap">
            <table className="tbl">
              <thead><tr><th>Risk score</th><th>Hold</th></tr></thead>
              <tbody>
                {c.hold_tiers.map((h, i) => (
                  <tr key={h.min_score}><td className="mono">{h.min_score}–{c.hold_tiers[i + 1] ? c.hold_tiers[i + 1].min_score - 1 : 100}</td><td>{t(Math.max(h.hold_secs, c.hold_floor_secs))}</td></tr>
                ))}
                <tr><td className="t2">Unscored</td><td>{t(c.unscored_hold_secs)}</td></tr>
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="Hot allowance">
          <dl>
            <Kv k="NEAR"><span className="mono">{nearAmt(c.near_allowance.limit)}</span> per {t(c.near_allowance.window_secs)}</Kv>
            <Kv k="Sepolia ETH"><span className="mono">{ethAmt(c.eth_allowance.limit)}</span> per {t(c.eth_allowance.window_secs)}</Kv>
            <Kv k="Hold floor">{t(c.hold_floor_secs)} minimum beyond allowance</Kv>
          </dl>
        </Card>
        <Card title="Roles">
          <dl>
            <Kv k="Owner"><ExtLink href={nearblocksAcct(c.owner)}><span className="mono small">{c.owner}</span></ExtLink></Kv>
            <Kv k="Watcher"><span className="mono small">{c.watcher}</span></Kv>
            <Kv k="Evidence key"><span className="mono small">{short(c.watcher_pk, 14, 6)}</span></Kv>
            <Kv k="Relayer"><span className="mono small">{c.relayer}</span></Kv>
          </dl>
        </Card>
        <Card title="Chain signatures and safe addresses">
          <dl>
            <Kv k="MPC signer"><span className="mono small">{c.evm.mpc_contract}</span></Kv>
            <Kv k="Path"><span className="mono small">{c.evm.path}</span></Kv>
            <Kv k="Vault on Sepolia"><ExtLink href={etherscanAddr(data.evmAddress)}><span className="mono small">{data.evmAddress}</span></ExtLink></Kv>
            <Kv k="Fee cap"><span className="mono small">{Number(BigInt(c.evm.max_fee_per_gas) / 10n ** 9n)} gwei max · {Number(BigInt(c.evm.max_priority_fee_per_gas) / 10n ** 9n)} gwei tip</span></Kv>
            <Kv k="Safe (NEAR)"><span className="mono small">{c.safe_near}</span></Kv>
            <Kv k="Safe (Sepolia)"><span className="mono small">{c.safe_evm}</span></Kv>
          </dl>
        </Card>
      </div>
    </>
  );
}
