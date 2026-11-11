# Rescue Room demo video script

Target length: 2 min 40 s. Screen recording of https://rescueroom.vercel.app at 1440×900, plus one Sepolia Etherscan tab and one NearBlocks tab. Calm voiceover, no music bed needed. All on NEAR testnet and Ethereum Sepolia.

Before recording: open the dashboard once so live data is loaded; have the Etherscan rescue tx and a recent hold page open in background tabs; make sure the attacker sandbox is idle (Try to drain it page shows "Run attacker" enabled).

| # | Time | Shot (what is on screen) | Voiceover |
| --- | --- | --- | --- |
| 1 | 0:00–0:12 | Landing page hero. Slow scroll from the headline to "The problem". | "A leaked key or a confused AI agent can empty a treasury in seconds. Rescue Room puts a hold-and-rescue layer between a NEAR vault and whoever holds its keys." |
| 2 | 0:12–0:27 | Scroll to "How it works", pause on the three steps. | "Small spends go straight through. Anything bigger is scored by a watcher and held. During the hold, two of three DAO guardians can rescue the reserve to a safe address. The contract enforces all of it." |
| 3 | 0:27–0:40 | Click "See the live vault". Overview: reserve, hot allowance, open holds, recent requests table. | "This is the live demo treasury on testnet. It has no access keys of its own; only its guardian DAO can upgrade it." |
| 4 | 0:40–1:05 | Scenario 1, rescue. Open "Try to drain it", scroll to "Scenario 1 · Rescue". Highlight: agent key requests 0.8 NEAR (paid), 2 NEAR (held), watcher score, g1 and g2 vote, "Rescued: vault frozen". Click one tx link to show NearBlocks for a second. | "Scenario one. An attacker with a stolen agent key drains in chunks. The first spend fits the hot allowance and goes through. The next ones are held, the watcher flags a chunked drain, two guardians vote, and the reserve moves to the safe account. The agent key is revoked and the vault freezes." |
| 5 | 1:05–1:25 | Scenario 2, false alarm. Scroll to "Scenario 2". Then open a hold page (Holds → a held request) showing the watcher recommendation card with the AI explanation and "published on-chain, hash verified". | "Scenario two, a false alarm. The owner pays a new vendor; the watcher holds it and explains why in plain words. The explanation is published on-chain with the score and its hash is checked. The owner cancels, whitelists the vendor, and the resent payment clears after its hold." |
| 6 | 1:25–1:42 | Scenario 3, cover payout. Cover pool page: solvency, policies, the paid claim. | "Scenario three. Holds protect the reserve, but the hot allowance can still be lost. The owner bought cover, filed a claim for that loss, guardians approved it, and the pool paid out, capped per incident." |
| 7 | 1:42–2:05 | Back on "Try to drain it", the "Live Sepolia broadcasts" table. Click the rescue tx; Etherscan shows Success, to 0xf55b…911F. | "Sepolia ETH works the same way through NEAR chain signatures. Here is a real Sepolia rescue: the vault's MPC-derived address sent the held amount to the DAO's safe address. The relayer only broadcasts; it cannot change where the money goes." |
| 8 | 2:05–2:35 | Click "Run attacker". Let the stream play: requests, "Watcher scored the drain", guardian votes, the result bar "hot allowance lost vs reserve kept". | "Anyone can try it. Run attacker fires the scripted drain at a sandbox vault, live on testnet. About thirty seconds later: the hot allowance is gone, the reserve is safe." |
| 9 | 2:35–2:45 | Signing page (Holds → a hold → Vote to rescue) showing "What you are signing" and the wallet button; then the landing threat-model table. | "Alerts only link here. Every action is signed in your own wallet after the page shows the exact call. Rescue Room: hold the drain, explain it, rescue the rest." |

Notes for the edit
- Keep cursor movement slow; zoom to 125% on the table rows in shots 4–6 if text is small.
- If the sandbox is busy (cooldown), record shot 8 again a minute later; the page shows the reason.
- Do not show the terminal, `.env`, or any key file.
