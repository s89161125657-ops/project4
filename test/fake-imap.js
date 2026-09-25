'use strict';

/*
 * Имитатор почтового сервера IMAP для тестов (без TLS).
 * Понимает ровно то, что использует lib/imap.js: LOGIN, LIST, EXAMINE, UID SEARCH, UID FETCH, LOGOUT.
 * Запуск отдельно: node test/fake-imap.js 1143  (логин demo@example.com, пароль «пароль»)
 */

const net = require('net');
const zlib = require('zlib');

const USER = 'demo@example.com';
const PASSWORD = 'пароль';

function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }

/** Однотонная картинка PNG заданного размера (base64) */
function png(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

const PNG = png(400, 300, [255, 128, 128]); // «фото»
const LOGO_AWTECH = png(170, 40, [0, 120, 200]); // логотип в подписи
const LOGO_INPREN = png(150, 50, [40, 40, 90]);

function eml({ from, to, subject, date, body, attach }) {
  const head = [
    'From: ' + from,
    'To: ' + to,
    'Subject: =?UTF-8?B?' + b64(subject) + '?=',
    'Date: ' + date,
    'MIME-Version: 1.0'
  ];
  if (!attach) {
    return head.concat(['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(body), '']).join('\r\n');
  }
  return head.concat([
    'Content-Type: multipart/mixed; boundary="b1"', '',
    '--b1', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(body),
    '--b1', 'Content-Type: image/png; name="photo.png"', 'Content-Disposition: attachment; filename="photo.png"',
    'Content-Transfer-Encoding: base64', '', PNG,
    '--b1', 'Content-Type: image/png; name="awtech-logo.png"', 'Content-Disposition: inline; filename="awtech-logo.png"',
    'Content-ID: <awtech@logo>', 'Content-Transfer-Encoding: base64', '', LOGO_AWTECH,
    '--b1--', ''
  ]).join('\r\n');
}

const MAILBOXES = {
  INBOX: [
    { uid: 11, idate: '24-Sep-2026 09:15:00 +0800', raw: eml({
      from: 'Cui Wei <cui@haier-bio.example>', to: 'Sergei Zakharov <zsa@inpren.ru>',
      subject: 'Board replacement', date: 'Thu, 24 Sep 2026 09:15:00 +0800',
      body: 'Dear Sergei,\r\nWe will send the new board tomorrow.\r\n\r\nBest regards,\r\nCui Wei'
    }) },
    { uid: 12, idate: '24-Sep-2026 17:40:00 +0300', raw: eml({
      from: '=?UTF-8?B?' + b64('Иван Петров') + '?= <petrov@example.ru>', to: 'zsa@inpren.ru',
      subject: 'Счёт на оплату', date: 'Thu, 24 Sep 2026 17:40:00 +0300',
      body: 'Сергей, добрый день!\r\nСчёт во вложении.', attach: true
    }) },
    { uid: 15, idate: '25-Sep-2026 08:05:00 +0300', raw: eml({
      from: 'Sergei Zakharov <zsa@inpren.ru>', to: 'Cui Wei <cui@haier-bio.example>',
      subject: 'RE: Board replacement', date: 'Fri, 25 Sep 2026 08:05:00 +0300',
      body: 'Dear Cui,\r\nThank you, we are waiting for the board.\r\n\r\n' +
        'From: Cui Wei <cui@haier-bio.example>\r\nSent: Thursday, September 24, 2026 9:15 AM\r\n' +
        'To: Sergei Zakharov <zsa@inpren.ru>\r\nSubject: Board replacement\r\n\r\n' +
        'Dear Sergei,\r\nWe will send the new board tomorrow.'
    }) }
  ],
  Sent: [
    { uid: 3, idate: '23-Sep-2026 11:00:00 +0300', raw: [
      'From: Sergei Zakharov <zsa@inpren.ru>', 'To: Cui Wei <cui@haier-bio.example>',
      'Subject: =?UTF-8?B?' + b64('Photo of the defect') + '?=', 'Date: Wed, 23 Sep 2026 11:00:00 +0300',
      'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="m1"', '',
      '--m1', 'Content-Type: multipart/related; boundary="r1"', '',
      '--r1', 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '',
      b64('<p>Dear Cui,</p><p>Please see the <b>photo</b> of the board:</p><p><img src="cid:img1@x"></p><script>alert(1)</script>' +
        '<p>Sergei Zakharov</p><p><img src="cid:inpren@logo"></p>'),
      '--r1', 'Content-Type: image/png', 'Content-ID: <img1@x>', 'Content-Transfer-Encoding: base64', '', PNG,
      '--r1', 'Content-Type: image/png; name="image002.png"', 'Content-ID: <inpren@logo>', 'Content-Transfer-Encoding: base64', '', LOGO_INPREN,
      '--r1--',
      '--m1', 'Content-Type: application/pdf; name="report.pdf"', 'Content-Disposition: attachment; filename="report.pdf"',
      'Content-Transfer-Encoding: base64', '', b64('%PDF-1.4 test'),
      '--m1--', ''
    ].join('\r\n') }
  ],
  '&BCEEPwQwBDw-': [] // «Спам» в modified UTF-7
};

const FOLDERS = [
  '* LIST (\\HasNoChildren) "." INBOX',
  '* LIST (\\HasNoChildren \\Sent) "." "Sent"',
  '* LIST (\\HasNoChildren \\Junk) "." "&BCEEPwQwBDw-"',
  '* LIST (\\Noselect \\HasChildren) "." "Archive"'
];

/** Разбивает команду на слова: атомы, строки в кавычках, литералы (Buffer), списки в скобках — как текст */
function tokenize(parts) {
  const out = [];
  for (const p of parts) {
    if (Buffer.isBuffer(p)) { out.push(p.toString('utf8')); continue; }
    const re = /"((?:[^"\\]|\\.)*)"|(\([^)]*\)(?:\])?|[^\s()]+(?:\[[^\]]*\])?(?:\([^)]*\))?)/g;
    let m;
    while ((m = re.exec(p))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]);
  }
  return out;
}

function literal(buf) {
  return Buffer.concat([Buffer.from('{' + buf.length + '}\r\n'), buf]);
}

function createServer() {
  return net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let parts = [];
    let need = 0;
    let authed = false;
    let box = null;
    const log = [];
    sock.write('* OK fake IMAP ready\r\n');

    const handle = (tokens) => {
      log.push(tokens);
      const tag = tokens[0];
      const cmd = (tokens[1] || '').toUpperCase();
      const ok = (t) => sock.write(tag + ' OK ' + (t || 'done') + '\r\n');
      const no = (t) => sock.write(tag + ' NO ' + (t || 'failed') + '\r\n');
      if (cmd === 'LOGOUT') { sock.write('* BYE\r\n'); ok(); sock.end(); return; }
      if (cmd === 'LOGIN') {
        if (tokens[2] === USER && tokens[3] === PASSWORD) { authed = true; return ok('LOGIN completed'); }
        return no('[AUTHENTICATIONFAILED] Authentication failed.');
      }
      if (!authed) return sock.write(tag + ' BAD not authenticated\r\n');
      if (cmd === 'LIST') { sock.write(FOLDERS.join('\r\n') + '\r\n'); return ok(); }
      if (cmd === 'EXAMINE') {
        if (!MAILBOXES[tokens[2]]) return no('Mailbox doesn\'t exist');
        box = MAILBOXES[tokens[2]];
        sock.write('* ' + box.length + ' EXISTS\r\n');
        return ok('[READ-ONLY] Examine completed');
      }
      if (cmd === 'UID' && /^SEARCH$/i.test(tokens[2])) {
        let found = box;
        if (/^CHARSET$/i.test(tokens[3])) {
          const q = tokens[tokens.length - 1].toLowerCase();
          found = box.filter((m) => {
            const text = m.raw.toString();
            const subj = /Subject: =\?UTF-8\?B\?([^?]+)/.exec(text);
            const from = /^From: (.*)$/m.exec(text)[1];
            return (subj && Buffer.from(subj[1], 'base64').toString().toLowerCase().includes(q)) || from.toLowerCase().includes(q);
          });
        }
        sock.write('* SEARCH' + found.map((m) => ' ' + m.uid).join('') + '\r\n');
        return ok();
      }
      if (cmd === 'UID' && /^FETCH$/i.test(tokens[2])) {
        const uids = tokens[3].split(',').map(Number);
        const items = tokens.slice(4).join(' ');
        box.forEach((m, i) => {
          if (!uids.includes(m.uid)) return;
          const raw = Buffer.from(m.raw);
          let chunks;
          if (/BODY\.PEEK\[\]/i.test(items)) {
            chunks = [Buffer.from('* ' + (i + 1) + ' FETCH (UID ' + m.uid + ' BODY[] '), literal(raw), Buffer.from(')\r\n')];
          } else {
            const header = raw.toString().split('\r\n\r\n')[0].split('\r\n')
              .filter((l) => /^(From|Subject|Date):/i.test(l)).join('\r\n') + '\r\n\r\n';
            chunks = [
              Buffer.from('* ' + (i + 1) + ' FETCH (UID ' + m.uid + ' INTERNALDATE "' + m.idate + '" RFC822.SIZE ' + raw.length +
                ' BODY[HEADER.FIELDS (FROM SUBJECT DATE)] '),
              literal(Buffer.from(header)), Buffer.from(')\r\n')
            ];
          }
          sock.write(Buffer.concat(chunks));
        });
        return ok();
      }
      sock.write(tag + ' BAD unknown command\r\n');
    };

    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (need) {
          if (buf.length < need) return;
          parts.push(buf.subarray(0, need));
          buf = buf.subarray(need);
          need = 0;
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.subarray(0, nl).toString('utf8');
        buf = buf.subarray(nl + 2);
        const m = /\{(\d+)\}$/.exec(line);
        if (m) {
          parts.push(line.slice(0, m.index));
          need = +m[1];
          sock.write('+ go ahead\r\n');
          continue;
        }
        parts.push(line);
        const tokens = tokenize(parts);
        parts = [];
        handle(tokens);
      }
    });
    sock.on('error', () => {});
  });
}

module.exports = { createServer, USER, PASSWORD, MAILBOXES, png };

if (require.main === module) {
  const port = Number(process.argv[2]) || 1143;
  createServer().listen(port, '127.0.0.1', () => console.log('fake IMAP on 127.0.0.1:' + port));
}
