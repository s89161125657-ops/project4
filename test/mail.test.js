'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { once } = require('events');
const { createServer, USER, PASSWORD } = require('./fake-imap');
const { ImapClient, ResponseReader, decodeFolderName, parseInternalDate, arg } = require('../lib/imap');
const { parseEml, fileToMail } = require('../public/mailfile');

let imap;
let port;

test.before(async () => {
  imap = createServer();
  imap.listen(0, '127.0.0.1');
  await once(imap, 'listening');
  port = imap.address().port;
  process.env.IMAP_HOST = '127.0.0.1';
  process.env.IMAP_PORT = String(port);
  process.env.IMAP_TLS = '0';
});

test.after(() => imap.close());

function client() {
  return new ImapClient({ host: '127.0.0.1', port, secure: false });
}

test('arg: ASCII в кавычках, кириллица — литералом', () => {
  assert.strictEqual(arg('a"b\\c'), '"a\\"b\\\\c"');
  assert.deepStrictEqual(arg('пароль').literal, Buffer.from('пароль'));
});

test('decodeFolderName и parseInternalDate', () => {
  assert.strictEqual(decodeFolderName('&BCEEPwQwBDw-'), 'Спам');
  assert.strictEqual(decodeFolderName('A&-B'), 'A&B');
  assert.strictEqual(parseInternalDate('24-Sep-2026 09:15:00 +0800'), '2026-09-24T01:15:00.000Z');
});

test('ResponseReader собирает литералы, пришедшие по частям', () => {
  const got = [];
  const r = new ResponseReader((x) => got.push(x));
  r.push(Buffer.from('* 1 FETCH (BODY[] {5}\r\nhe'));
  r.push(Buffer.from('llo)\r\nA1 OK\r\n'));
  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[0].text, '* 1 FETCH (BODY[] \u00000\u0000)');
  assert.strictEqual(got[0].literals[0].toString(), 'hello');
});

test('IMAP: вход с паролем на кириллице, папки, поиск, письма', async () => {
  const c = client();
  await c.connect();
  await c.login(USER, PASSWORD);
  const folders = await c.listFolders();
  assert.deepStrictEqual(folders.map((f) => f.name), ['INBOX', 'Sent', '&BCEEPwQwBDw-']);
  await c.examine('INBOX');
  assert.deepStrictEqual(await c.searchUids(''), [11, 12, 15]);
  assert.deepStrictEqual(await c.searchUids('счёт'), [12]);
  const sums = await c.fetchSummaries([11, 15]);
  assert.deepStrictEqual(sums.map((s) => s.uid), [11, 15]);
  assert.match(sums[0].header.toString(), /^From: Cui Wei/);
  const raw = await c.fetchRaw(12);
  assert.match(raw.toString(), /Content-Disposition: attachment/);
  await c.logout();
});

test('IMAP: неверный пароль', async () => {
  const c = client();
  await c.connect();
  await assert.rejects(c.login(USER, 'wrong'), { code: 'AUTH' });
  await c.logout();
});

// ---------- HTTP API ----------

async function withApp(fn) {
  delete require.cache[require.resolve('../server')];
  const { server } = require('../server');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = async (path, body) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  try { await fn(post); } finally { server.close(); }
}

const creds = { user: USER, password: PASSWORD };

test('API: папки и список писем (новые сверху, заголовки раскодированы)', async () => {
  await withApp(async (post) => {
    const f = await post('/api/mail/folders', creds);
    assert.strictEqual(f.status, 200);
    assert.deepStrictEqual(f.data.folders.map((x) => x.name), ['INBOX', 'Sent', 'Спам']);

    const l = await post('/api/mail/list', { ...creds, folder: 'INBOX' });
    assert.strictEqual(l.status, 200);
    assert.deepStrictEqual(l.data.messages.map((m) => m.uid), [15, 12, 11]);
    const petrov = l.data.messages[1];
    assert.strictEqual(petrov.fromName, 'Иван Петров');
    assert.strictEqual(petrov.fromEmail, 'petrov@example.ru');
    assert.strictEqual(petrov.subject, 'Счёт на оплату');
    assert.strictEqual(petrov.date, '2026-09-24T14:40:00.000Z');
    assert.strictEqual(l.data.more, false);

    const page = await post('/api/mail/list', { ...creds, limit: 2 });
    assert.deepStrictEqual(page.data.messages.map((m) => m.uid), [15, 12]);
    assert.strictEqual(page.data.more, true);
    const next = await post('/api/mail/list', { ...creds, limit: 2, before: 12 });
    assert.deepStrictEqual(next.data.messages.map((m) => m.uid), [11]);

    const s = await post('/api/mail/list', { ...creds, query: 'board' });
    assert.deepStrictEqual(s.data.messages.map((m) => m.uid), [15, 11]);
  });
});

test('API: письмо целиком разбирается как перетащенный .eml', async () => {
  await withApp(async (post) => {
    const r = await post('/api/mail/message', { ...creds, folder: 'INBOX', uid: 12 });
    assert.strictEqual(r.status, 200);
    const bytes = new Uint8Array(Buffer.from(r.data.raw, 'base64'));
    const mail = fileToMail('message.eml', bytes);
    assert.match(mail.text, /Счёт во вложении/);
    assert.strictEqual(mail.images.length, 1);
    assert.strictEqual(mail.images[0].name, 'photo.png');
    assert.strictEqual(parseEml(bytes).fromName, 'Иван Петров');
  });
});

test('API: ошибки входа и неверные запросы', async () => {
  await withApp(async (post) => {
    const bad = await post('/api/mail/folders', { user: USER, password: 'wrong' });
    assert.strictEqual(bad.status, 401);
    assert.strictEqual(bad.data.error, 'Неверный адрес почты или пароль');
    assert.strictEqual((await post('/api/mail/folders', { user: USER })).status, 400);
    assert.strictEqual((await post('/api/mail/message', { ...creds, uid: 'x' })).status, 400);
    assert.strictEqual((await post('/api/mail/list', { ...creds, folder: 'Нет такой' })).status, 400);
  });
});
