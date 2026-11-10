// Map vault events (NEP-297) to alerts. Pure function apart from the optional request lookup.
// Buttons are links to signing pages in the app. Nothing here signs or moves funds.
const fmtNear = (y) => (Number(BigInt(y) / 10n ** 20n) / 10000).toFixed(4).replace(/\.?0+$/, '');
const amountOf = (r) => (r.asset === 'Near' ? `${fmtNear(r.amount)} NEAR` : `${Number(BigInt(r.amount)) / 1e18} ETH`);
const hid = (id) => `H-${String(id).padStart(4, '0')}`;

export const ALERT_EVENTS = ['risk_scored', 'rescue_executed', 'claim_filed', 'upgrade_started', 'vault_unfrozen', 'sign_failed', 'transfer_failed'];

export function alertFor(ev, { app, req, minScore = 30, mainVault }) {
  const d = ev.data || {};
  const base = { event: ev.event, vault: ev.account, vault_label: ev.account.split('.')[0], tx_hash: ev.tx_hash, explorer: ev.explorer, at: new Date(ev.ts_ms || Date.now()).toISOString(), key: ev.key };
  const link = (text, p) => ({ text, url: `${app}${p}` });
  const a = build(ev, d, base, link, req, minScore);
  // The signing pages act on the main vault. Alerts from any other vault (the public attacker
  // sandbox) link to the sandbox page instead, so a button can never point at the wrong request.
  if (a && mainVault && ev.account !== mainVault) a.buttons = [link('Open attacker sandbox', '/app/attack')];
  return a;
}

function build(ev, d, base, link, req, minScore) {
  switch (ev.event) {
    case 'risk_scored': {
      if (d.status !== 'Held' || d.score < minScore) return null;
      const sigs = (d.signals || []).map((s) => (s.code || s).replace(/_/g, ' ')).join(', ');
      const mins = Math.round(d.hold_secs / 60);
      return {
        ...base,
        kind: 'held',
        severity: d.score >= 80 ? 'critical' : d.score >= 60 ? 'high' : 'medium',
        request_id: d.id,
        title: `Held ${hid(d.id)}: ${req ? `${amountOf(req)} to ${req.to}` : 'withdrawal'}`,
        body: `Risk ${d.score}/100 (confidence ${d.confidence}%). ${sigs || 'no signals'}. Hold ${mins >= 1 ? `${mins} min` : `${d.hold_secs}s`} (demo clock). Evidence ${String(d.evidence_hash).slice(0, 12)}.`,
        buttons: [link('Review and vote', `/app/sign/rescue/${d.id}`), link('Owner: cancel', `/app/sign/cancel/${d.id}`), link('Open hold', `/app/holds/${d.id}`)],
      };
    }
    case 'rescue_executed':
      return {
        ...base,
        kind: 'rescued',
        severity: 'critical',
        request_id: d.id,
        title: d.asset && d.asset !== 'Near' ? `Rescued ${hid(d.id)}: transfer to the safe address signed by MPC` : `Rescued ${hid(d.id)}: ${fmtNear(d.amount || '0')} NEAR reserve moved to the safe account`,
        body: `Guardians reached quorum. Open requests were cancelled, the agent key was revoked and the vault is frozen until the DAO unfreezes it.`,
        buttons: [link('Open incident', `/app/holds/${d.id}`), link('Guardians', '/app/guardians')],
      };
    case 'claim_filed':
      return {
        ...base,
        kind: 'claim',
        severity: 'medium',
        title: `Cover claim #${d.claim ?? d.id} filed${d.amount ? ` for ${fmtNear(d.amount)} NEAR` : ''}`,
        body: 'Guardians need to review and vote on the claim.',
        buttons: [link('Review claim', `/app/sign/claim/${d.claim ?? d.id}`), link('Cover', '/app/cover')],
      };
    case 'upgrade_started':
      return { ...base, kind: 'upgrade', severity: 'high', title: 'Vault code upgrade executed by the guardian DAO', body: `New code sha256 ${String(d.code_sha256).slice(0, 16)}.`, buttons: [link('Activity', '/app/activity')] };
    case 'vault_unfrozen':
      return { ...base, kind: 'unfrozen', severity: 'medium', title: 'Vault unfrozen by DAO proposal', body: 'Withdrawals are open again.', buttons: [link('Overview', '/app')] };
    case 'sign_failed':
    case 'transfer_failed':
      return { ...base, kind: 'failed', severity: 'high', request_id: d.id, title: `${ev.event === 'sign_failed' ? 'Signing' : 'Transfer'} failed for ${hid(d.id)}`, body: 'Retry from the hold page.', buttons: [link('Open hold', `/app/holds/${d.id}`)] };
    default:
      return null;
  }
}
