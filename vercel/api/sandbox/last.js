import { SANDBOX, json } from '../_lib.js';

export default function handler(req, res) {
  json(res, 200, { busy: false, active: null, last: null, vault: SANDBOX.vault || null, limits: { perClient: Number(process.env.SANDBOX_PER_CLIENT || 2), windowMin: Number(process.env.SANDBOX_WINDOW_MIN || 10) }, stream: 'inline' });
}
