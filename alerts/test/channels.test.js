import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SMTPServer } from 'smtp-server';
import { signWebhook, verifyWebhook, webhook, email, telegram, resetEmailTransport } from '../src/channels.js';
import { alertFor } from '../src/rules.js';

const APP = 'https://rescueroom.example';
const ev = (event, data) => ({ key: 'r1:0:0', account: 'vault-v2.x.testnet', event, data, tx_hash: 'TX1', ts_ms: Date.now(), explorer: 'https://testnet.nearblocks.io/txns/TX1' });
const held = alertFor(ev('risk_scored', { id: 6, score: 95, confidence: 70, evidence_hash: 'ab'.repeat(32), signals: [{ code: 'chunked_drain' }], hold_secs: 360, status: 'Held' }), {
  app: APP,
  req: { asset: 'Near', amount: '2000000000000000000000000', to: 'attacker.x.testnet' },
});

function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(s));
  });
}

test('alerts map events and only link to app pages', () => {
  assert.equal(held.kind, 'held');
  assert.equal(held.severity, 'critical');
  assert.match(held.title, /Held H-0006: 2 NEAR to attacker/);
  for (const b of held.buttons) assert.ok(b.url.startsWith(`${APP}/app/`), b.url);
  assert.deepEqual(held.buttons.map((b) => b.url.replace(APP, '')), ['/app/sign/rescue/6', '/app/sign/cancel/6', '/app/holds/6']);
  assert.equal(alertFor(ev('risk_scored', { id: 1, score: 10, status: 'Executing' }), { app: APP }), null, 'low scores do not page');
  assert.equal(alertFor(ev('withdraw_requested', { id: 1 }), { app: APP }), null);
  const r = alertFor(ev('rescue_executed', { id: 6, asset: 'Near', amount: '6108379156637610000000001' }), { app: APP });
  assert.match(r.title, /6\.1083 NEAR reserve/);
  const sb = alertFor({ ...ev('rescue_executed', { id: 2, asset: 'Near', amount: '1' }), account: 'sandbox.x.testnet' }, { app: APP, mainVault: 'vault-v2.x.testnet' });
  assert.deepEqual(sb.buttons.map((b) => b.url), [`${APP}/app/attack`], 'sandbox alerts never link to main-vault signing pages');
});

test('webhook HMAC signs and verifies; tampering and stale timestamps fail', () => {
  const body = JSON.stringify(held);
  const ts = Math.floor(Date.now() / 1000);
  const h = { 'x-rescueroom-timestamp': String(ts), 'x-rescueroom-signature': signWebhook('s3cret', ts, body) };
  assert.ok(verifyWebhook('s3cret', h, body));
  assert.ok(!verifyWebhook('other', h, body));
  assert.ok(!verifyWebhook('s3cret', h, body.replace('95', '15')));
  const old = { 'x-rescueroom-timestamp': String(ts - 3600), 'x-rescueroom-signature': signWebhook('s3cret', ts - 3600, body) };
  assert.ok(!verifyWebhook('s3cret', old, body));
});

test('webhook delivery sends a verifiable signature', async () => {
  let got;
  const s = await listen((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      got = { headers: req.headers, body: b };
      res.end('ok');
    });
  });
  const url = `http://127.0.0.1:${s.address().port}/hook`;
  const out = await webhook(held, { ALERT_WEBHOOK_URL: url, ALERT_WEBHOOK_SECRET: 's3cret' });
  s.close();
  assert.match(out, /sent 200 \(signed\)/);
  assert.equal(got.headers['x-rescueroom-event'], 'risk_scored');
  assert.ok(verifyWebhook('s3cret', got.headers, got.body));
  assert.equal(JSON.parse(got.body).request_id, 6);
});

test('telegram uses URL buttons only (no callback buttons)', async () => {
  let body, path;
  const s = await listen((req, res) => {
    let b = '';
    path = req.url;
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      body = JSON.parse(b);
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });
  });
  const out = await telegram(held, { TELEGRAM_BOT_TOKEN: 'TESTTOKEN', TELEGRAM_CHAT_ID: '42', TELEGRAM_API_BASE: `http://127.0.0.1:${s.address().port}` });
  s.close();
  assert.equal(out, 'sent');
  assert.equal(path, '/botTESTTOKEN/sendMessage');
  assert.equal(body.chat_id, '42');
  const buttons = body.reply_markup.inline_keyboard.flat();
  assert.equal(buttons.length, 3);
  for (const b of buttons) assert.deepEqual(Object.keys(b).sort(), ['text', 'url']);
  // Non-https app URL: links move into the text and no keyboard is sent.
  const local = alertFor(ev('rescue_executed', { id: 6, asset: 'Near', amount: '1' }), { app: 'http://127.0.0.1:5173' });
  const s2 = await listen((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      body = JSON.parse(b);
      res.end('{"ok":true}');
    });
  });
  await telegram(local, { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '1', TELEGRAM_API_BASE: `http://127.0.0.1:${s2.address().port}` });
  s2.close();
  assert.equal(body.reply_markup, undefined);
  assert.match(body.text, /Open incident: http:\/\/127\.0\.0\.1:5173\/app\/holds\/6/);
});

test('email goes out over SMTP with link buttons', async () => {
  const mails = [];
  const smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', (c) => (raw += c));
      stream.on('end', () => {
        mails.push({ raw, to: session.envelope.rcptTo.map((r) => r.address) });
        cb();
      });
    },
  });
  await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
  resetEmailTransport();
  const out = await email(held, { SMTP_URL: `smtp://127.0.0.1:${smtp.server.address().port}?ignoreTLS=true`, ALERT_EMAIL_TO: 'guardians@example.org' });
  await new Promise((r) => smtp.close(r));
  assert.match(out, /^sent/);
  assert.equal(mails.length, 1);
  assert.deepEqual(mails[0].to, ['guardians@example.org']);
  assert.match(mails[0].raw, /Subject: \[Rescue Room\] Held H-0006/);
  assert.match(mails[0].raw, /rescueroom\.example\/app\/sign\/rescue\/6/);
});

test('channels skip cleanly without env', async () => {
  assert.match(await webhook(held, {}), /^skipped/);
  assert.match(await telegram(held, {}), /^skipped/);
  assert.match(await email(held, {}), /^skipped/);
});
