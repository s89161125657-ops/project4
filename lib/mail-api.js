'use strict';

/*
 * Обработчики /api/mail/* — чтение писем из почтового ящика по IMAP.
 * Адрес сервера задаётся только переменными окружения (IMAP_HOST, IMAP_PORT),
 * логин и пароль приходят в каждом запросе и нигде не сохраняются.
 */

const { ImapClient, ImapError, decodeFolderName } = require('./imap');
const { parseEml } = require('../public/mailfile');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Защита от подбора пароля: не больше FAIL_LIMIT неудачных входов за FAIL_WINDOW с одного адреса
const FAIL_LIMIT = 10;
const FAIL_WINDOW = 10 * 60 * 1000;
const failures = new Map();

function mailConfig() {
  return {
    host: process.env.IMAP_HOST || 'imap.beget.com',
    port: Number(process.env.IMAP_PORT) || 993,
    secure: process.env.IMAP_TLS !== '0',
    insecureTls: process.env.IMAP_TLS_INSECURE === '1'
  };
}

function tooManyFailures(ip) {
  const now = Date.now();
  const list = (failures.get(ip) || []).filter((t) => now - t < FAIL_WINDOW);
  failures.set(ip, list);
  return list.length >= FAIL_LIMIT;
}

function noteFailure(ip) {
  const list = failures.get(ip) || [];
  list.push(Date.now());
  failures.set(ip, list);
  if (failures.size > 10000) failures.delete(failures.keys().next().value);
}

/** Открывает соединение, входит, выполняет fn(client) и закрывает соединение */
async function withMailbox(creds, ip, fn) {
  if (!creds || typeof creds.user !== 'string' || typeof creds.password !== 'string' || !creds.user.trim() || !creds.password) {
    throw new ImapError('Укажите адрес почты и пароль', 'INPUT');
  }
  if (tooManyFailures(ip)) throw new ImapError('Слишком много неудачных попыток входа. Попробуйте через 10 минут.', 'LIMIT');
  const client = new ImapClient(mailConfig());
  try {
    await client.connect();
    try {
      await client.login(creds.user.trim(), creds.password);
    } catch (e) {
      if (e.code === 'AUTH') noteFailure(ip);
      throw e;
    }
    return await fn(client);
  } finally {
    client.logout().catch(() => {});
  }
}

/** Папки: { path — имя для IMAP, name — читаемое имя } */
async function folders(creds, ip) {
  return withMailbox(creds, ip, async (c) => {
    const list = await c.listFolders();
    return { folders: list.map((f) => ({ path: f.name, name: decodeFolderName(f.name), flags: f.flags })) };
  });
}

/** Сведения о письме по его заголовкам */
function summarize(s) {
  const mail = parseEml(new Uint8Array(s.header));
  const date = mail.date || (s.internalDate ? new Date(s.internalDate) : null);
  return {
    uid: s.uid,
    fromName: mail.fromName,
    fromEmail: mail.fromEmail,
    subject: mail.subject,
    date: date ? date.toISOString() : null,
    size: s.size
  };
}

/**
 * Список писем папки, новые сверху.
 * query — поиск по теме и отправителю; before — показать письма старше этого uid (для «Ещё»).
 */
async function list(params, ip) {
  const folder = typeof params.folder === 'string' && params.folder ? params.folder : 'INBOX';
  const limit = Math.min(Math.max(Number(params.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const query = typeof params.query === 'string' ? params.query.slice(0, 200) : '';
  const before = Number(params.before) || 0;
  return withMailbox(params, ip, async (c) => {
    await c.examine(folder);
    let uids = await c.searchUids(query);
    if (before) uids = uids.filter((u) => u < before);
    const page = uids.slice(-limit);
    const summaries = await c.fetchSummaries(page);
    const messages = summaries.map(summarize).sort((a, b) => b.uid - a.uid);
    return { messages, more: uids.length > page.length };
  });
}

/** Письмо целиком (.eml) в base64 */
async function message(params, ip) {
  const folder = typeof params.folder === 'string' && params.folder ? params.folder : 'INBOX';
  const uid = Number(params.uid);
  if (!Number.isInteger(uid) || uid <= 0) throw new ImapError('Не указано письмо', 'INPUT');
  return withMailbox(params, ip, async (c) => {
    await c.examine(folder);
    const raw = await c.fetchRaw(uid);
    return { raw: raw.toString('base64') };
  });
}

const STATUS = { INPUT: 400, AUTH: 401, LIMIT: 429, NOT_FOUND: 404, NO: 400, BAD: 400, TOO_BIG: 413 };

function errorStatus(e) {
  return (e && STATUS[e.code]) || 502;
}

module.exports = { folders, list, message, mailConfig, errorStatus, _failures: failures };
