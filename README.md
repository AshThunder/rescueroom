# Rescue Room

A hold-and-rescue safety layer for DAO treasuries and AI agents on NEAR, with Sepolia ETH controlled through NEAR chain signatures.

When a stolen key or a confused agent starts moving money, the vault holds the withdrawal, a watcher explains why it looks risky, and guardians from your Sputnik DAO can rescue the funds to a pre-set safe address. Small everyday spends still go through instantly.

> Status: phase 1, NEAR testnet + Ethereum Sepolia only. Not audited. Do not use with real funds.

## How it works

| Piece | What it does |
| --- | --- |
| Hot allowance | Spends up to a limit per rolling window execute instantly (NEAR and Sepolia ETH tracked separately). |
| Risk-scored holds | Anything beyond the allowance waits. Hold length comes from a 0-100 risk score: 0-29 none, 30-59 1h, 60-79 3h, 80+ 6h. Tiers, floor and unscored hold are configurable; a demo divisor turns hours into minutes. |
| Watcher (off-chain) | Deterministic rules score each held request (new destination, chunked drain, unusual size, share of reserve, off-rhythm time, signing-pattern change, agent paying an unlisted address, fresh whitelist). It hashes an evidence bundle, signs `rescueroom-score:v1:<vault>:<id>:<score>:<confidence>:<sha256>` with an ed25519 key, and the contract verifies that signature before storing the score. Optional LLM explainer (NEAR AI Cloud) writes the plain-English text; it never changes the score. The watcher only recommends; it has no way to move funds. |
| Owner cancel | The owner can cancel any held request instantly. |
| Guardians | Members of a role (default `council`) in an existing Sputnik DAO, synced on-chain from `get_policy`. Rescue needs `quorum_pct` of guardians and at least `min_distinct` approvers. No staking, no slashing. The DAO can also rescue directly with a FunctionCall proposal to `dao_rescue`. |
| Rescue | Blocks the request, cancels every other held request, revokes the agent key that made it, sweeps the NEAR reserve (or signs the ETH amount) to the safe address, and freezes the vault until a DAO proposal calls `dao_unfreeze`. |
| Chain signatures | For Sepolia ETH the vault builds the EIP-1559 transaction itself (RLP + keccak in the contract), asks `v1.signer-prod.testnet` to sign it, and stores the signature. The relayer only broadcasts; destination and amount are fixed inside the signed payload. |
| Cover pool | Underwriters deposit NEAR. Premiums are priced from the vault's own risk posture (guardian count, distinct floor, max hold, recent scores, past rescues). Payouts are capped per incident, need the same guardian quorum, and solvency (pool / active exposure) is a live view. Cover is for what holds cannot stop: losses inside the hot allowance. |
| Agent keys | `add_agent_key` puts a function-call key on the vault that can only call `request_withdraw`, with a gas allowance. The agent's requests are attributed to the key's label. |
| Audit log | Every request, score, vote, cancel, rescue, signature, cover and config change is emitted as a NEP-297 event (`standard: "rescueroom"`). |
| Alerts | On-chain events, plus Telegram, webhook and email (outbox for now). Alert buttons only open signing pages that show the exact call; they never sign. |

## Live on NEAR testnet

See [`deploy/testnet.json`](deploy/testnet.json) for current account ids. Phase 1 deployment:

- Vault: `vault.rescueroom-j60ox4.testnet`
- Guardian DAO: `rescueroom-j60ox4-guardians.sputnik-v2.testnet` (council g1, g2, g3)
- Vault's Sepolia address (MPC-derived, path `rescueroom-eth-1`): `0x89250Ea451fE4141aE4C31584E41841f53179B74`
- Sepolia safe address (MPC-derived from the DAO account, so only the DAO can move it): `0xf55b4654d6761e1F3EdEDD2f1c480FB4fD97911F`

Runs of every scenario with explorer links are in `deploy/e2e-*.json` and on the app's "Try to drain it" page.

## Repository

```
contracts/vault   Rust near-sdk 5 contract + unit tests
watcher/          rules scorer, evidence signing, explainer interface (+ node tests)
alerts/           Telegram / webhook / outbox alerts (links only)
attacker/         scripted attacker using a stolen agent key
scripts/          deploy, e2e scenarios, relayer, DAO helpers
web/              Vite + React + TypeScript dashboard (read-only, live from testnet)
deploy/           public deployment ids and scenario logs (no secrets)
```

## Run it

```bash
npm install && (cd web && npm install)
npm test                        # 27 contract tests + watcher rule tests
npm run build:contract
node scripts/deploy.mjs <main-account>.testnet   # needs a funded testnet account key in ~/.rescueroom/keys
npm run e2e                     # eth, hot, falsealarm, attack, cover, ethrescue on testnet
npm run web                     # http://127.0.0.1:5173
```

Keys are generated into `~/.rescueroom/keys/*.json` with mode 600 and are never read by the web app or committed.

## Demo scenarios

1. **Rescue.** A stolen agent key spends the hot allowance, then asks for 0.5 and 2 NEAR. The watcher scores 95 (new destination, chunked drain, large share of reserve, agent paying an unlisted address). Two guardians vote; the reserve moves to the safe address, the sibling request is cancelled, the agent key is revoked, and the vault freezes. A DAO proposal unfreezes it.
2. **False alarm.** The owner pays a new vendor 1.2 NEAR (stand-in for 1,200 NEAR). It is flagged and held. The owner cancels their own request, whitelists the vendor and resends; the resend scores lower (a fresh whitelist still counts) and is paid after a short hold.
3. **Cover payout.** The 0.8 NEAR that went out inside the hot allowance is claimed against a cover policy; guardians approve; the pool pays, capped per incident, and solvency updates.

## Threat model

**Protects:** assets held by the vault contract (NEAR in the vault account, ETH at the vault's MPC-derived Sepolia address).

**Does not protect:** anything held elsewhere. If a key also controls other wallets, Rescue Room cannot see or stop those. It is not a wallet, and it does not make a compromised owner key safe for anything outside the vault.

| Attacker has | What they can do | What stops them |
| --- | --- | --- |
| Agent function-call key | Call `request_withdraw` only | Hot allowance caps instant loss per window; everything else is held and scored; rescue revokes the key. Function-call keys cannot attach deposits, so they cannot call payable methods. |
| Owner key | Request withdrawals, cancel, whitelist, add agent keys, lower allowances | Cannot raise allowances, change tiers, safe addresses, guardians or watcher (DAO-only). Large requests are held; fresh whitelists still score risk. Loss is bounded by the hot allowance per window. |
| Watcher key | Submit low scores | Scores must be signed by the registered evidence key and come from the watcher account. A compromised watcher can shorten holds down to `hold_floor_secs`; set a non-zero floor for production. Guardians can still rescue during any hold, and the owner can cancel. Unscored requests get the longest hold. |
| Relayer | Broadcast or withhold signed Sepolia txs | Cannot change destination, amount, nonce or fees: they are inside the signed payload. Fee caps are DAO config. |
| Minority of guardians | Vote rescue | Needs quorum and the distinct floor. Rescue only ever moves funds to the pre-set safe address. |
| Majority of guardians / DAO | Rescue, unfreeze, change config | This is the trust root. Choose the council accordingly; the DAO's own policy and proposal periods apply. |
| Anyone | Call `execute` after a hold | Intended: releases only what already passed its hold. |

Known limits in phase 1:

- The vault account still has its deployer full-access key, which bypasses everything. Production should delete it after deployment (upgrades then go through the DAO).
- One Sepolia nonce stream. A signed tx that is never broadcast blocks later ones until it is broadcast or re-signed with `retry_sign`.
- ETH rescue moves the requested amount, not the full Sepolia balance (the contract cannot read Sepolia balances).
- The audit timeline in the app is rebuilt from contract state; an event indexer is next.
- Scores are rules-based. The LLM explainer only writes the explanation.

## Hackathon

Built for the NEAR Hackathon. Tracks: Social Money (lead), Open Innovation, AI Security.
