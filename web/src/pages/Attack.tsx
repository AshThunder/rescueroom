import { Play, SquareTerminal } from 'lucide-react';
import { Card, ExtLink, Mock, Tag } from '../components/ui';
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
        <button className="btn" disabled title="Public attack sandbox lands next phase"><Play className="ic" />Run attacker</button>
      </div>
      <div className="banner mt24 small"><SquareTerminal className="ic t3" aria-hidden /><span>Each run below happened on NEAR testnet against the live vault. Run it yourself with <span className="mono">node scripts/e2e.mjs attack</span>. The in-browser sandbox is <Mock>next phase</Mock></span></div>
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
