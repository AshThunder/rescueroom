// Per-vault Telegram linking for the hosted defender. A vault owner opens
//   https://t.me/<bot>?start=<slug>
// where <slug> is the vault name (the part before .<factory>), "demo" (main demo vault) or "sandbox".
// The bot saves that chat id for that vault in <dataDir>/telegram-chats.json (mode 600) and confirms.
// "/stop <slug>" unlinks. Alerts carry only public chain data, so linking needs no wallet signature.
import fs from 'node:fs';
import path from 'node:path';

const base = () => process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
const SLUG = /^[a-z0-9-]{2,64}$/;

export function chatStore(dataDir) {
  const file = path.join(dataDir, 'telegram-chats.json');
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    data = {};
  }
  const save = () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  };
  return {
    chats: (vault) => data[vault] || [],
    link(vault, chat) {
      const l = new Set(data[vault] || []);
      l.add(chat);
      data[vault] = [...l].slice(-10);
      save();
    },
    unlink(vault, chat) {
      data[vault] = (data[vault] || []).filter((c) => c !== chat);
      save();
    },
    count: () => Object.values(data).reduce((a, l) => a + l.length, 0),
    vaults: () => Object.keys(data).filter((v) => data[v].length).length,
  };
}

async function tg(method, body) {
  const r = await fetch(`${base()}/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(40000) });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.description || r.status}`);
  return j.result;
}

/** Handle one message. Returns the reply text (exported for tests). */
export async function handleMessage(m, { resolve, store, app }) {
  const text = (m.text || '').trim();
  const [cmd, arg = ''] = text.split(/\s+/, 2);
  const chat = m.chat?.id;
  if (!chat || m.chat?.type !== 'private') return null;
  if (cmd === '/start' || cmd === '/stop') {
    if (!arg) return `Open the alerts link from your vault page in Rescue Room (${app}/app/alerts) to link this chat to a vault.`;
    if (!SLUG.test(arg)) return 'That link is not a Rescue Room vault.';
    const vault = await resolve(arg);
    if (!vault) return `No Rescue Room vault called "${arg}" was found.`;
    if (cmd === '/stop') {
      store.unlink(vault, chat);
      return `Alerts for ${vault} are off in this chat.`;
    }
    store.link(vault, chat);
    return `Linked. Holds, rescues and unfreezes on ${vault} will be sent here. Buttons only open pages; nothing signs from Telegram. Send /stop ${arg} to unlink.`;
  }
  return null;
}

export function startTelegramBot({ resolve, store, app = process.env.APP_URL || 'https://rescueroom.vercel.app', signal, log = console.log }) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return null;
  const state = { running: true, last_poll: null, last_error: null, linked: 0 };
  (async () => {
    let offset = 0;
    while (!signal?.aborted) {
      let updates = [];
      try {
        updates = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
        state.last_poll = Date.now();
        state.last_error = null;
      } catch (e) {
        state.last_error = e.message.replace(/bot[0-9]+:[A-Za-z0-9_-]+/g, 'bot<redacted>');
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      for (const u of updates) {
        offset = u.update_id + 1;
        try {
          const reply = await handleMessage(u.message || {}, { resolve, store, app });
          if (reply) {
            await tg('sendMessage', { chat_id: u.message.chat.id, text: reply, disable_web_page_preview: true });
            if (reply.startsWith('Linked')) state.linked++;
            log(`telegram: ${reply.split('.')[0]}`);
          }
        } catch (e) {
          log(`telegram: ${e.message.replace(/bot[0-9]+:[A-Za-z0-9_-]+/g, 'bot<redacted>')}`);
        }
      }
    }
  })();
  return state;
}
