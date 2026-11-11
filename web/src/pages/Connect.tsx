// Fund the vault (NEAR and its derived Sepolia address) and connect an agent with a key that can only
// call request_withdraw. The agent key is generated in this browser; only its public key goes on chain.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Copy, KeyRound, LoaderCircle, Plus, Trash2, Wallet } from 'lucide-react';
import { ed25519 } from '@noble/curves/ed25519';
import { useVault } from '../components/Shell';
import { Card, Empty, ErrorState, ExtLink, Kv, LoadingCards, PageHeader, Tag } from '../components/ui';
import { useToast } from '../components/Toast';
import { useWallet } from '../lib/wallet';
import { b58encode } from '../lib/b58';
import { etherscanAddr, view } from '../lib/near';
import { ago, ethAmt, nearAmt, parseNear, time } from '../lib/format';

const TGAS = 10n ** 12n;

export function CopyBtn({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button type="button" className="btn ghost sm" aria-label={label} onClick={() => navigator.clipboard.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1500); })}>
      {ok ? <Check className="ic green" /> : <Copy className="ic" />}{ok ? 'Copied' : label}
    </button>
  );
}

function newAgentKey() {
  const secret = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(secret);
  const full = new Uint8Array(64);
  full.set(secret);
  full.set(pub, 32);
  return { publicKey: `ed25519:${b58encode(pub)}`, secretKey: `ed25519:${b58encode(full)}` };
}

export const agentSnippet = (vault: string) => `// npm i near-api-js   (AGENT_KEY = the ed25519:... secret shown once in Rescue Room)
import { Account, JsonRpcProvider, KeyPairSigner } from 'near-api-js';

const provider = new JsonRpcProvider({ url: 'https://test.rpc.fastnear.com' });
const signer = KeyPairSigner.fromSecretKey(process.env.AGENT_KEY);
const vault = new Account('${vault}', provider, signer);

// The key can only call request_withdraw. Inside the hot allowance it pays at once;
// anything bigger is held, scored by the watcher and can be rescued by guardians.
const id = await vault.callFunction({
  contractId: '${vault}',
  methodName: 'request_withdraw',
  args: { asset: 'Near', to: 'vendor.testnet', amount: '100000000000000000000000', memo: 'invoice 42' }, // 0.1 NEAR
  gas: 100_000_000_000_000n,
});
console.log('request', id);`;

export function Connect() {
  const { data, error, loading, refresh } = useVault();
  const w = useWallet();
  const toast = useToast();
  const [amount, setAmount] = useState('1');
  const [busy, setBusy] = useState<string | null>(null);
  const [label, setLabel] = useState('my-agent');
  const [made, setMade] = useState<{ publicKey: string; secretKey: string } | null>(null);
  const [expiries, setExpiries] = useState<Record<string, string>>({});
  const vault = data?.vault;
  useEffect(() => {
    setMade(null);
    if (vault) view<[string, string][]>(vault, 'get_agent_expiries').then((l) => setExpiries(Object.fromEntries(l))).catch(() => setExpiries({}));
  }, [vault, data?.agents.length]);
  if (loading && !data) return <LoadingCards n={3} />;
  if (!data) return <Card><ErrorState error={error || 'unknown'} onRetry={refresh} /></Card>;
  const isOwner = !!w.accountId && w.accountId === data.config.owner;
  const y = parseNear(amount);

  async function fund() {
    if (!w.accountId) return w.connect();
    if (!y) return;
    setBusy('fund');
    try {
      const r = await w.sendTransfer(data!.vault, y);
      toast.push({ tone: 'ok', title: 'Vault funded', body: `${nearAmt(y, 3)} NEAR sent${r.hash ? ` (${r.hash.slice(0, 8)}…)` : ''}.` });
      refresh();
    } catch (e) {
      toast.push({ tone: 'err', title: 'Deposit failed', body: (e as Error).message.slice(0, 200) });
    } finally {
      setBusy(null);
    }
  }

  async function addKey() {
    if (!isOwner) return;
    const k = newAgentKey();
    setBusy('agent');
    try {
      const r = await w.send({ receiver: data!.vault, method: 'add_agent_key', args: { public_key: k.publicKey, label: label.trim().slice(0, 64) || 'agent', ttl_secs: null }, deposit: 1n, gas: 100n * TGAS });
      setMade(k);
      toast.push({ tone: 'ok', title: 'Agent key added', body: r.hash ? 'Copy the secret now: it is shown once.' : 'Copy the secret now.' });
      refresh();
    } catch (e) {
      toast.push({ tone: 'err', title: 'Could not add the key', body: (e as Error).message.slice(0, 200) });
    } finally {
      setBusy(null);
    }
  }

  async function removeKey(pk: string) {
    setBusy(pk);
    try {
      await w.send({ receiver: data!.vault, method: 'remove_agent_key', args: { public_key: pk }, deposit: 1n, gas: 50n * TGAS });
      toast.push({ tone: 'ok', title: 'Agent key removed' });
      refresh();
    } catch (e) {
      toast.push({ tone: 'err', title: 'Could not remove the key', body: (e as Error).message.slice(0, 200) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader title="Fund and agents" sub={<>Deposit into <span className="mono">{data.vault}</span>, then give your agent a key that can only ask for withdrawals.</>} />
      <div className="split mt24">
        <Card title="Fund with NEAR" aside={<span className="mono">{nearAmt(data.status.near_available, 3)} available</span>}>
          <div className="pad stack g16">
            <p className="small t2">Any account can send testnet NEAR to the vault account. Holds and the hot allowance apply to everything it holds.</p>
            <div className="row gap8">
              <input className="input mono" aria-label="Amount in NEAR" value={amount} onChange={(e) => setAmount(e.target.value)} aria-invalid={!y} />
              <button className="btn amb" onClick={fund} disabled={!y || busy === 'fund'} aria-busy={busy === 'fund'}>{busy === 'fund' ? <LoaderCircle className="ic spin" /> : <Wallet className="ic" />}{w.accountId ? 'Deposit' : 'Connect'}</button>
            </div>
            <dl>
              <Kv k="Vault account"><span className="stack g4" style={{ alignItems: 'flex-start', minWidth: 0 }}><span className="mono small" style={{ wordBreak: 'break-all' }}>{data.vault}</span><CopyBtn text={data.vault} /></span></Kv>
              <Kv k="Hot allowance left"><span className="mono">{nearAmt(data.status.near_hot_remaining, 3)}</span> NEAR</Kv>
            </dl>
          </div>
        </Card>
        <Card title="Fund on Sepolia" aside={data.ethEnabled ? <Tag tone="g" dot>on</Tag> : <Tag>off</Tag>}>
          <div className="pad stack g16">
            <p className="small t2">The vault controls this Sepolia address through NEAR chain signatures (MPC). Nobody holds its private key.</p>
            <dl>
              <Kv k="Vault on Sepolia">{data.evmAddress ? <span className="stack g4" style={{ alignItems: 'flex-start', minWidth: 0 }}><ExtLink href={etherscanAddr(data.evmAddress)}><span className="mono small" style={{ wordBreak: 'break-all' }}>{data.evmAddress}</span></ExtLink><CopyBtn text={data.evmAddress} /></span> : 'deriving…'}</Kv>
              <Kv k="Balance">{data.ethBalance === null ? '—' : `${ethAmt(data.ethBalance)} ETH`}</Kv>
            </dl>
            {!data.ethEnabled && <div className="banner small">Sepolia withdrawals stay off until the vault has a Sepolia safe address. Set one when creating a vault.</div>}
          </div>
        </Card>
      </div>
      <Card className="mt24" title={<span className="row gap8"><KeyRound className="ic t3" aria-hidden />Connect an agent</span>} aside={<span className="mono">{data.agents.length} keys</span>}>
        <div className="pad stack g16">
          <p className="small t2">Creates a function-call access key on the vault account limited to <span className="mono">request_withdraw</span>. The key is generated in this browser and only its public half goes on chain. If it leaks, the attacker gets the hot allowance and nothing more.</p>
          {!isOwner ? (
            <div className="banner small">{w.accountId ? <>Only the owner <span className="mono">{data.config.owner}</span> can add agent keys.</> : 'Connect the owner wallet to add agent keys.'}</div>
          ) : (
            <div className="row gap8 wrap">
              <input className="input" style={{ maxWidth: 240 }} aria-label="Agent label" value={label} maxLength={64} onChange={(e) => setLabel(e.target.value)} />
              <button className="btn amb" onClick={addKey} disabled={busy === 'agent'} aria-busy={busy === 'agent'}>{busy === 'agent' ? <LoaderCircle className="ic spin" /> : <Plus className="ic" />}Create agent key</button>
            </div>
          )}
          {made && (
            <div className="card pad stack g8" style={{ background: 'var(--bg0)', borderColor: 'var(--amber-line, var(--line2))' }}>
              <div className="row gap8"><span className="grow small">Agent secret key. Shown once; store it as <span className="mono">AGENT_KEY</span> where your agent runs.</span><CopyBtn text={made.secretKey} label="Copy secret" /></div>
              <code className="mono small break t2">{made.secretKey.slice(0, 16)}…{made.secretKey.slice(-6)}</code>
              <div className="small t3">Public key <span className="mono">{made.publicKey}</span></div>
            </div>
          )}
          <div className="stack g8">
            <div className="row"><span className="grow small t2">Agent snippet</span><CopyBtn text={agentSnippet(data.vault)} label="Copy snippet" /></div>
            <pre className="code mono small" style={{ margin: 0, padding: 12, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 8, background: 'var(--bg0)', maxHeight: 280 }}>{agentSnippet(data.vault)}</pre>
          </div>
        </div>
        {data.agents.length === 0 ? (
          <Empty title="No agent keys yet">Create one above. Temporary keys from attack simulations show here until they expire.</Empty>
        ) : (
          <ul className="list" style={{ listStyle: 'none' }}>
            {data.agents.map(([pk, a]) => (
              <li key={pk} className="li">
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row gap8">{a.label}{expiries[pk] && <Tag tone="a">expires {time(expiries[pk])}</Tag>}</div>
                  <div className="small t3 mono ellip">{pk}</div>
                </div>
                <span className="small t3 nowrap">added {ago(a.added_ms)}</span>
                {isOwner && <button className="btn ghost sm" aria-label={`Remove key ${a.label}`} disabled={busy === pk} onClick={() => removeKey(pk)}>{busy === pk ? <LoaderCircle className="ic spin" /> : <Trash2 className="ic" />}</button>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <div className="row gap8 mt24 wrap"><Link className="btn" to="/app/alerts">Set up alerts</Link><Link className="btn" to="/app/attack">Simulate an attack</Link></div>
    </>
  );
}
