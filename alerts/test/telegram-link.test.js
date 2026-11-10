import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('first private /start links the chat, saves it 600 and sends a test alert', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-tg-'));
  const calls = [];
  const s = await new Promise((res) => {
    const srv = http.createServer((req, rsp) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        const m = req.url.split('/').pop();
        calls.push({ m, body: JSON.parse(b || '{}') });
        rsp.setHeader('content-type', 'application/json');
        if (m === 'getUpdates' && calls.filter((c) => c.m === 'getUpdates').length === 1)
          return rsp.end(JSON.stringify({ ok: true, result: [
            { update_id: 5, message: { chat: { id: -100, type: 'group' }, text: '/start', from: { username: 'x' } } },
            { update_id: 6, message: { chat: { id: 4242, type: 'private' }, text: '/start', from: { username: 'chris' } } },
          ] }));
        rsp.end(JSON.stringify({ ok: true, result: [] }));
      });
    }).listen(0, '127.0.0.1', () => res(srv));
  });
  process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${s.address().port}`;
  process.env.TELEGRAM_BOT_TOKEN = 'T';
  delete process.env.TELEGRAM_CHAT_ID;
  process.env.RR_TELEGRAM_STORE = path.join(dir, 'telegram.json');
  process.env.RR_ENV_FILE = path.join(dir, '.env');
  fs.writeFileSync(process.env.RR_ENV_FILE, 'TELEGRAM_CHAT_ID=\n');
  const { waitForStart } = await import('../src/telegram-link.js');
  const id = await waitForStart();
  s.close();
  assert.equal(id, 4242, 'group /start ignored, private one linked');
  assert.equal((fs.statSync(process.env.RR_TELEGRAM_STORE).mode & 0o777).toString(8), '600');
  assert.match(fs.readFileSync(process.env.RR_ENV_FILE, 'utf8'), /^TELEGRAM_CHAT_ID=4242$/m);
  const sends = calls.filter((c) => c.m === 'sendMessage');
  assert.equal(sends.length, 2);
  assert.equal(sends[1].body.chat_id, '4242');
  assert.match(sends[1].body.text, /test alert/);
});
