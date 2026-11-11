import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chatStore, handleMessage } from '../src/telegram-bot.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-tg-'));
const store = chatStore(dir);
const resolve = async (slug) => (slug === 'alice' ? 'alice.factory.testnet' : null);
const msg = (text, chat = 42, type = 'private') => ({ text, chat: { id: chat, type } });

test('start <slug> links a chat to that vault only', async () => {
  const r = await handleMessage(msg('/start alice'), { resolve, store, app: 'https://x' });
  assert.match(r, /^Linked/);
  assert.deepEqual(store.chats('alice.factory.testnet'), [42]);
  assert.equal(fs.statSync(path.join(dir, 'telegram-chats.json')).mode & 0o777, 0o600);
});

test('unknown vaults, bad slugs and group chats are refused', async () => {
  assert.match(await handleMessage(msg('/start bob'), { resolve, store, app: 'https://x' }), /No Rescue Room vault/);
  assert.match(await handleMessage(msg('/start ../etc'), { resolve, store, app: 'https://x' }), /not a Rescue Room vault/);
  assert.equal(await handleMessage(msg('/start alice', 7, 'group'), { resolve, store, app: 'https://x' }), null);
  assert.deepEqual(store.chats('alice.factory.testnet'), [42]);
});

test('stop unlinks', async () => {
  await handleMessage(msg('/stop alice'), { resolve, store, app: 'https://x' });
  assert.deepEqual(store.chats('alice.factory.testnet'), []);
});
