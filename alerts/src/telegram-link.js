// Telegram chat linking: when TELEGRAM_BOT_TOKEN is set but TELEGRAM_CHAT_ID is not, wait for the first
// private "/start" to the bot, save that chat id (~/.rescueroom/telegram.json, mode 600, and the gitignored
// .env), confirm in the chat and send a test alert. Later /start messages from other chats are ignored.
// Usage: node --env-file-if-exists=.env alerts/src/telegram-link.js   (or runs inside the API server)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { telegram } from './channels.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE = process.env.RR_TELEGRAM_STORE || path.join(os.homedir(), '.rescueroom', 'telegram.json');
const ENV_FILE = process.env.RR_ENV_FILE || path.resolve(HERE, '../../.env');
const base = () => process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';

export function storedChatId() {
  try {
    return JSON.parse(fs.readFileSync(STORE, 'utf8')).chat_id || null;
  } catch {
    return null;
  }
}

// Make a saved chat id visible to the delivery code without restarting.
export function loadChatId() {
  if (!process.env.TELEGRAM_CHAT_ID) {
    const id = storedChatId();
    if (id) process.env.TELEGRAM_CHAT_ID = String(id);
  }
  return process.env.TELEGRAM_CHAT_ID || null;
}

function save(chatId, who) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(STORE, JSON.stringify({ chat_id: chatId, linked_at: new Date().toISOString(), by: who }), { mode: 0o600 });
  fs.chmodSync(STORE, 0o600);
  if (fs.existsSync(ENV_FILE)) {
    let s = fs.readFileSync(ENV_FILE, 'utf8');
    s = /^TELEGRAM_CHAT_ID=.*$/m.test(s) ? s.replace(/^TELEGRAM_CHAT_ID=.*$/m, `TELEGRAM_CHAT_ID=${chatId}`) : `${s.trimEnd()}\nTELEGRAM_CHAT_ID=${chatId}\n`;
    fs.writeFileSync(ENV_FILE, s, { mode: 0o600 });
  }
  process.env.TELEGRAM_CHAT_ID = String(chatId);
}

async function tg(method, body) {
  const r = await fetch(`${base()}/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(40000) });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.description || r.status}`);
  return j.result;
}

export function testAlert(app = process.env.APP_URL || 'http://127.0.0.1:5173') {
  return {
    event: 'test', kind: 'test', severity: 'medium', key: `test-${Date.now()}`, vault: 'vault-v2.rescueroom-j60ox4.testnet',
    title: 'Rescue Room test alert',
    body: 'Alerts are connected. Holds, rescues, cover claims and upgrades on the vault will arrive here. Buttons only open signing pages.',
    buttons: [{ text: 'Open dashboard', url: `${app}/app` }, { text: 'Audit log', url: `${app}/app/activity` }],
  };
}

export async function waitForStart({ onLinked, signal } = {}) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return null;
  if (loadChatId()) return process.env.TELEGRAM_CHAT_ID;
  let offset = 0;
  console.log('telegram: waiting for /start to link a chat');
  while (!signal?.aborted) {
    let updates = [];
    try {
      updates = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
    } catch (e) {
      console.error('telegram link:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      const m = u.message;
      if (!m || m.chat?.type !== 'private' || !/^\/start\b/.test(m.text || '')) continue;
      save(m.chat.id, m.from?.username || m.from?.first_name || 'unknown');
      await tg('getUpdates', { offset, timeout: 0 }); // acknowledge
      await tg('sendMessage', { chat_id: m.chat.id, text: 'Rescue Room alerts are linked to this chat. A test alert follows.' });
      const res = await telegram(testAlert());
      console.log(`telegram: linked a chat; test alert ${res}`);
      onLinked?.(m.chat.id);
      return m.chat.id;
    }
  }
  return null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const id = await waitForStart();
  if (id && process.argv.includes('--test')) console.log('telegram test alert:', await telegram(testAlert()));
}
