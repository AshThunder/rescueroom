// NEAR Wallet Selector (MyNearWallet, Meteor, HERE) for the signing pages. Testnet only.
// The selector is loaded lazily so the dashboard stays light; nothing signs without the wallet's own prompt.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { WalletSelector } from '@near-wallet-selector/core';
import type { WalletSelectorModal } from '@near-wallet-selector/modal-ui';
import { DEPLOY } from './useVault';
import { NEAR_RPC } from './near';

export interface TxCall {
  receiver: string;
  method: string;
  args: Record<string, unknown>;
  deposit: bigint;
  gas: bigint;
}

export interface SendResult {
  hash: string | null; // null when a browser wallet redirected away (result comes back in the URL)
  value?: unknown;
  failure?: string;
}

interface WalletCtx {
  ready: boolean;
  accountId: string | null;
  walletName: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  send: (c: TxCall) => Promise<SendResult>;
  error: string | null;
}

const Ctx = createContext<WalletCtx | null>(null);

export function useWallet() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useWallet outside WalletProvider');
  return c;
}

async function init(): Promise<{ selector: WalletSelector; modal: WalletSelectorModal }> {
  // Node globals some wallet packages touch at import time; set them before loading those packages.
  const { Buffer } = await import('buffer');
  const g = globalThis as unknown as { Buffer?: typeof Buffer; process?: { env: Record<string, string>; browser: boolean; version: string } };
  g.Buffer ||= Buffer;
  g.process ||= { env: {}, browser: true, version: '' };
  const [core, modalUi, mnw, meteor, here] = await Promise.all([
    import('@near-wallet-selector/core'),
    import('@near-wallet-selector/modal-ui'),
    import('@near-wallet-selector/my-near-wallet'),
    import('@near-wallet-selector/meteor-wallet'),
    import('@near-wallet-selector/here-wallet'),
    import('@near-wallet-selector/modal-ui/styles.css'),
  ]);
  const selector = await core.setupWalletSelector({
    network: { networkId: 'testnet', nodeUrl: NEAR_RPC, helperUrl: 'https://helper.testnet.near.org', explorerUrl: 'https://testnet.nearblocks.io', indexerUrl: 'https://testnet-api.kitwallet.app' },
    modules: [mnw.setupMyNearWallet({ walletUrl: 'https://testnet.mynearwallet.com' }), meteor.setupMeteorWallet(), here.setupHereWallet()],
  });
  const modal = modalUi.setupModal(selector, { contractId: DEPLOY.vault, theme: 'dark', description: 'Connect a NEAR testnet account to sign Rescue Room actions. Each action still asks your wallet to approve it.' });
  return { selector, modal };
}

function outcomeOf(o: unknown): SendResult {
  const x = o as { transaction?: { hash?: string }; transaction_outcome?: { id?: string }; status?: Record<string, unknown> } | undefined;
  const hash = x?.transaction?.hash || x?.transaction_outcome?.id || null;
  const st = x?.status || {};
  if ('Failure' in st) return { hash, failure: JSON.stringify(st.Failure).slice(0, 300) };
  let value: unknown;
  if (typeof st.SuccessValue === 'string' && st.SuccessValue) {
    try {
      value = JSON.parse(atob(st.SuccessValue));
    } catch {
      value = st.SuccessValue;
    }
  }
  return { hash, value };
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const ref = useRef<Promise<{ selector: WalletSelector; modal: WalletSelectorModal }> | null>(null);
  const [ready, setReady] = useState(false);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [walletName, setWalletName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const get = useCallback(() => {
    if (!ref.current) {
      ref.current = init();
      ref.current
        .then(({ selector }) => {
          const sync = async () => {
            const s = selector.store.getState();
            setAccountId(s.accounts.find((a) => a.active)?.accountId ?? null);
            const id = s.selectedWalletId;
            setWalletName(id ? s.modules.find((m) => m.id === id)?.metadata.name ?? id : null);
          };
          sync();
          selector.store.observable.subscribe(sync);
          setReady(true);
        })
        .catch((e) => {
          setError(e instanceof Error ? e.message : String(e));
          ref.current = null;
        });
    }
    return ref.current;
  }, []);

  // Restore an existing session without blocking first paint.
  useEffect(() => {
    const had = Object.keys(localStorage).some((k) => k.startsWith('near-wallet-selector'));
    if (had) get();
  }, [get]);

  const connect = useCallback(async () => {
    const { modal } = await get();
    modal.show();
  }, [get]);

  const disconnect = useCallback(async () => {
    const { selector } = await get();
    const w = await selector.wallet();
    await w.signOut();
  }, [get]);

  const send = useCallback(
    async (c: TxCall): Promise<SendResult> => {
      const { selector } = await get();
      const core = await import('@near-wallet-selector/core');
      const w = await selector.wallet();
      const out = await w.signAndSendTransaction({
        receiverId: c.receiver,
        actions: [core.actionCreators.functionCall(c.method, c.args, c.gas, c.deposit)],
        callbackUrl: window.location.href.split('?')[0],
      } as Parameters<typeof w.signAndSendTransaction>[0]);
      return out ? outcomeOf(out) : { hash: null };
    },
    [get],
  );

  const v = useMemo(() => ({ ready, accountId, walletName, connect, disconnect, send, error }), [ready, accountId, walletName, connect, disconnect, send, error]);
  return <Ctx.Provider value={v}>{children}</Ctx.Provider>;
}
