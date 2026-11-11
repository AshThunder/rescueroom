import { DEPLOY, SANDBOX, json, view, sandboxAgent } from './_lib.js';

export default async function handler(req, res) {
  let sandbox = null;
  if (SANDBOX.vault) {
    const s = await view(SANDBOX.vault, 'get_status').catch(() => null);
    sandbox = { vault: SANDBOX.vault, configured: !!sandboxAgent(), frozen: s?.frozen ?? null };
  }
  json(res, 200, { ok: true, host: 'vercel', accounts: [DEPLOY.vault, SANDBOX.vault].filter(Boolean), sandbox, defender: 'https://rescueroom-defender.fly.dev/health' });
}
