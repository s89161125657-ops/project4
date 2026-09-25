'use strict';

/*
 * Минимальный IMAP-клиент без зависимостей (только чтение):
 * вход, список папок, список писем, получение письма целиком.
 * Используется сервером приложения для кнопки «Почта» (например, почта Beget).
 */

const tls = require('tls');
const net = require('net');

const TIMEOUT = 30000;
const MAX_MESSAGE = 30 * 1024 * 1024;

class ImapError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** Строка IMAP: в кавычках, если это ASCII, иначе — литерал {n} в UTF-8 */
function arg(value) {
  const s = String(value);
  if (/^[\x20-\x7e]*$/.test(s)) return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  return { literal: Buffer.from(s, 'utf8') };
}

// ---------- Разбор ответов сервера ----------

/**
 * Читает ответы IMAP из потока байт. Каждый ответ — строка (с литералами {n}):
 * { text: строка без литералов (литерал заменён на \u0000N\u0000), literals: [Buffer] }
 */
class ResponseReader {
  constructor(onResponse) {
    this.buf = Buffer.alloc(0);
    this.onResponse = onResponse;
    this.cur = null;
    this.need = 0; // сколько байт литерала ещё ждём
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.need > 0) {
        if (this.buf.length < this.need) return;
        this.cur.literals.push(this.buf.subarray(0, this.need));
        this.buf = this.buf.subarray(this.need);
        this.need = 0;
        continue;
      }
      const nl = this.buf.indexOf('\r\n');
      if (nl < 0) return;
      const line = this.buf.subarray(0, nl).toString('utf8');
      this.buf = this.buf.subarray(nl + 2);
      if (!this.cur) this.cur = { text: '', literals: [] };
      const m = /\{(\d+)\+?\}$/.exec(line);
      if (m) {
        const n = +m[1];
        if (n > MAX_MESSAGE) throw new ImapError('Письмо слишком большое', 'TOO_BIG');
        this.cur.text += line.slice(0, m.index) + '\u0000' + this.cur.literals.length + '\u0000';
        this.need = n;
        if (n === 0) { this.cur.literals.push(Buffer.alloc(0)); }
        continue;
      }
      this.cur.text += line;
      const done = this.cur;
      this.cur = null;
      this.onResponse(done);
    }
  }
}

// ---------- Клиент ----------

class ImapClient {
  constructor(opts) {
    this.host = opts.host;
    this.port = opts.port || 993;
    this.secure = opts.secure !== false;
    this.insecureTls = Boolean(opts.insecureTls);
    this.tagNo = 0;
    this.pending = null; // текущая команда
    this.waitCont = null;
    this.greeting = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const onConnectError = (e) => reject(new ImapError('Не удалось подключиться к почтовому серверу ' + this.host + ': ' + e.message, 'CONNECT'));
      const sock = this.secure
        ? tls.connect({ host: this.host, port: this.port, servername: net.isIP(this.host) ? undefined : this.host, rejectUnauthorized: !this.insecureTls })
        : net.connect({ host: this.host, port: this.port });
      this.sock = sock;
      sock.setTimeout(TIMEOUT, () => sock.destroy(new Error('таймаут')));
      sock.once('error', onConnectError);
      this.reader = new ResponseReader((r) => this._onResponse(r));
      sock.on('data', (d) => {
        try { this.reader.push(d); } catch (e) { this._fail(e); }
      });
      sock.on('close', () => this._fail(new ImapError('Соединение с почтовым сервером закрыто', 'CLOSED')));
      this.greeting = { resolve: () => { sock.removeListener('error', onConnectError); sock.on('error', (e) => this._fail(e)); resolve(); }, reject };
    });
  }

  _fail(err) {
    if (this.greeting) { const g = this.greeting; this.greeting = null; g.reject(err); }
    if (this.pending) { const p = this.pending; this.pending = null; p.reject(err instanceof ImapError ? err : new ImapError(err.message, 'IO')); }
    if (this.waitCont) { const w = this.waitCont; this.waitCont = null; w.reject(err); }
  }

  _onResponse(r) {
    if (this.greeting) {
      const g = this.greeting;
      this.greeting = null;
      if (/^\* (OK|PREAUTH)/i.test(r.text)) g.resolve();
      else g.reject(new ImapError('Почтовый сервер отказал в соединении', 'GREETING'));
      return;
    }
    if (r.text.startsWith('+')) {
      if (this.waitCont) { const w = this.waitCont; this.waitCont = null; w.resolve(); }
      return;
    }
    if (!this.pending) return;
    if (r.text.startsWith('* ')) { this.pending.untagged.push(r); return; }
    const m = /^(\S+) (OK|NO|BAD)\s*(.*)$/i.exec(r.text);
    if (m && m[1] === this.pending.tag) {
      const p = this.pending;
      this.pending = null;
      if (m[2].toUpperCase() === 'OK') p.resolve(p.untagged);
      else p.reject(new ImapError(m[3] || m[2], m[2].toUpperCase()));
    }
  }

  /** Команда; parts — строки или { literal: Buffer } */
  async command(...parts) {
    const tag = 'A' + (++this.tagNo);
    const done = new Promise((resolve, reject) => { this.pending = { tag, untagged: [], resolve, reject }; });
    done.catch(() => {});
    let line = tag;
    for (const p of parts) {
      if (typeof p === 'string') { line += ' ' + p; continue; }
      // Литерал: отправляем {n}, ждём "+", затем сами байты
      const cont = new Promise((resolve, reject) => { this.waitCont = { resolve, reject }; });
      this.sock.write(line + ' {' + p.literal.length + '}\r\n');
      await Promise.race([cont, done]);
      this.sock.write(p.literal);
      line = '';
    }
    this.sock.write(line + '\r\n');
    return done;
  }

  async login(user, password) {
    try {
      await this.command('LOGIN', arg(user), arg(password));
    } catch (e) {
      if (e.code === 'NO' || e.code === 'BAD') throw new ImapError('Неверный адрес почты или пароль', 'AUTH');
      throw e;
    }
  }

  async listFolders() {
    const res = await this.command('LIST', '""', '"*"');
    const out = [];
    for (const r of res) {
      const m = /^\* LIST \(([^)]*)\) (?:NIL|"(?:[^"\\]|\\.)*") (.+)$/i.exec(r.text);
      if (!m) continue;
      const flags = m[1];
      if (/\\Noselect|\\NonExistent/i.test(flags)) continue;
      out.push({ name: atomOrString(m[2], r.literals), flags });
    }
    return out;
  }

  async examine(folder) {
    await this.command('EXAMINE', arg(folder));
  }

  /** UID писем папки (все или по поиску в теме и отправителе), по возрастанию */
  async searchUids(query) {
    let res;
    if (query && String(query).trim()) {
      const q = String(query).trim();
      const a = arg(q);
      res = await this.command('UID SEARCH', 'CHARSET UTF-8', 'OR', 'SUBJECT', a, 'FROM', arg(q));
    } else {
      res = await this.command('UID SEARCH', 'ALL');
    }
    const uids = [];
    for (const r of res) {
      const m = /^\* SEARCH\s*(.*)$/i.exec(r.text);
      if (m) for (const n of m[1].trim().split(/\s+/)) if (/^\d+$/.test(n)) uids.push(+n);
    }
    return uids.sort((x, y) => x - y);
  }

  /** Краткие сведения о письмах: uid, дата получения, размер и заголовки From/Subject/Date */
  async fetchSummaries(uids) {
    if (!uids.length) return [];
    const res = await this.command('UID FETCH', uids.join(','), '(UID INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])');
    const out = [];
    for (const r of res) {
      if (!/^\* \d+ FETCH/i.test(r.text)) continue;
      const uid = /\bUID (\d+)/i.exec(r.text);
      if (!uid) continue;
      const idate = /INTERNALDATE "([^"]+)"/i.exec(r.text);
      const size = /RFC822\.SIZE (\d+)/i.exec(r.text);
      const lit = /BODY\[HEADER\.FIELDS[^\]]*\] \u0000(\d+)\u0000/i.exec(r.text);
      out.push({
        uid: +uid[1],
        internalDate: idate ? parseInternalDate(idate[1]) : null,
        size: size ? +size[1] : 0,
        header: lit ? r.literals[+lit[1]] : Buffer.alloc(0)
      });
    }
    return out;
  }

  /** Письмо целиком (RFC 822), без отметки «прочитано» */
  async fetchRaw(uid) {
    const res = await this.command('UID FETCH', String(+uid), '(UID BODY.PEEK[])');
    for (const r of res) {
      const lit = /BODY\[\] \u0000(\d+)\u0000/i.exec(r.text);
      if (lit) return r.literals[+lit[1]];
    }
    throw new ImapError('Письмо не найдено', 'NOT_FOUND');
  }

  async logout() {
    try { await this.command('LOGOUT'); } catch { /* уже закрыто */ }
    this.sock.end();
  }
}

function atomOrString(token, literals) {
  const t = token.trim();
  const lit = /^\u0000(\d+)\u0000$/.exec(t);
  if (lit) return literals[+lit[1]].toString('utf8');
  if (t.startsWith('"')) return t.slice(1, -1).replace(/\\(.)/g, '$1');
  return t;
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** "25-Sep-2026 08:23:00 +0300" -> ISO-строка */
function parseInternalDate(s) {
  const m = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const off = (m[7] === '-' ? -1 : 1) * (+m[8] * 60 + +m[9]);
  const t = Date.UTC(+m[3], MONTHS[m[2].toLowerCase()], +m[1], +m[4], +m[5], +m[6]) - off * 60000;
  return new Date(t).toISOString();
}

/** Имя папки IMAP (modified UTF-7, RFC 3501) -> обычная строка */
function decodeFolderName(name) {
  return String(name).replace(/&([^-]*)-/g, (m, b64) => {
    if (!b64) return '&';
    const bytes = Buffer.from(b64.replace(/,/g, '/'), 'base64');
    let out = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
  });
}

module.exports = { ImapClient, ImapError, ResponseReader, decodeFolderName, parseInternalDate, arg };
