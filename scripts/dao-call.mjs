// Propose, approve and execute one FunctionCall through the guardian DAO (g1 proposes, g1 + g2 approve).
// Usage: node scripts/dao-call.mjs <receiver> <method> '<json args>' [tgas] [description]
import { call, view, loadState, TGAS } from './lib/near.js';

const st = loadState();
const [receiver, method, argsJson = '{}', tgas = '50', desc] = process.argv.slice(2);
const kind = { FunctionCall: { receiver_id: receiver, actions: [{ method_name: method, args: Buffer.from(argsJson).toString('base64'), deposit: '0', gas: (BigInt(tgas) * TGAS).toString() }] } };
const bond = BigInt((await view(st.dao, 'get_policy')).proposal_bond);
const p = await call(st.g1, st.dao, 'add_proposal', { proposal: { description: desc || `${receiver}.${method}`, kind } }, { deposit: bond, gas: 100n * TGAS });
await call(st.g1, st.dao, 'act_proposal', { id: p.value, action: 'VoteApprove', proposal: kind }, { gas: 200n * TGAS });
const a = await call(st.g2, st.dao, 'act_proposal', { id: p.value, action: 'VoteApprove', proposal: kind }, { gas: 250n * TGAS });
const prop = await view(st.dao, 'get_proposal', { id: p.value });
console.log(JSON.stringify({ proposal: p.value, status: prop.status, add_tx: p.hash, approve_execute_tx: a.hash }));
