/*
 * Чтение писем, перетащенных из почтовой программы:
 *  - .msg (Outlook для Windows) — формат Compound File Binary + свойства MAPI;
 *  - .eml (новый Outlook, Thunderbird, Apple Mail) — MIME.
 * Письмо превращается в текст вида "From: / Sent: / To: / Subject: / текст",
 * который дальше разбирает parser.js (вместе с цитатами предыдущих писем).
 * Работает и в браузере (window.MailFile), и в Node (module.exports).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MailFile = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- Compound File Binary (контейнер .msg) ----------
  const END_OF_CHAIN = 0xfffffffe;
  const FREE_SECT = 0xffffffff;

  function isCfb(bytes) {
    const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    return bytes.length >= 512 && sig.every((b, i) => bytes[i] === b);
  }

  /** Возвращает Map: имя потока верхнего уровня -> Uint8Array */
  function readCfbRootStreams(bytes) {
    if (!isCfb(bytes)) throw new Error('Это не файл Outlook .msg');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u32 = (off) => dv.getUint32(off, true);
    const sectorSize = 1 << dv.getUint16(0x1e, true);
    const miniSectorSize = 1 << dv.getUint16(0x20, true);
    const firstDirSector = u32(0x30);
    const miniCutoff = u32(0x38);
    const firstMiniFat = u32(0x3c);
    const firstDifat = u32(0x44);
    const numDifat = u32(0x48);
    const sectorOffset = (n) => (n + 1) * sectorSize;

    // FAT: номера секторов FAT из DIFAT (109 в заголовке + цепочка секторов DIFAT)
    const fatSectors = [];
    for (let i = 0; i < 109; i++) {
      const s = u32(0x4c + i * 4);
      if (s !== FREE_SECT && s !== END_OF_CHAIN) fatSectors.push(s);
    }
    let difat = firstDifat;
    const perDifat = sectorSize / 4 - 1;
    for (let k = 0; k < numDifat && difat !== END_OF_CHAIN && difat !== FREE_SECT; k++) {
      const off = sectorOffset(difat);
      for (let i = 0; i < perDifat; i++) {
        const s = u32(off + i * 4);
        if (s !== FREE_SECT && s !== END_OF_CHAIN) fatSectors.push(s);
      }
      difat = u32(off + perDifat * 4);
    }
    const fat = new Uint32Array(fatSectors.length * (sectorSize / 4));
    fatSectors.forEach((s, idx) => {
      const off = sectorOffset(s);
      for (let i = 0; i < sectorSize / 4; i++) fat[idx * (sectorSize / 4) + i] = u32(off + i * 4);
    });

    const chain = (start, table) => {
      const out = [];
      const seen = new Set();
      for (let s = start; s !== END_OF_CHAIN && s !== FREE_SECT && s < table.length; s = table[s]) {
        if (seen.has(s)) break; // защита от зацикливания в повреждённом файле
        seen.add(s);
        out.push(s);
      }
      return out;
    };
    const readChain = (start) => {
      const sectors = chain(start, fat);
      const out = new Uint8Array(sectors.length * sectorSize);
      sectors.forEach((s, i) => {
        const off = sectorOffset(s);
        out.set(bytes.subarray(off, Math.min(off + sectorSize, bytes.length)), i * sectorSize);
      });
      return out;
    };

    // Каталог
    const dir = readChain(firstDirSector);
    const ddv = new DataView(dir.buffer);
    const entries = [];
    for (let off = 0; off + 128 <= dir.length; off += 128) {
      const nameLen = ddv.getUint16(off + 0x40, true);
      let name = '';
      for (let i = 0; i + 1 < Math.min(nameLen, 64) - 1; i += 2) name += String.fromCharCode(ddv.getUint16(off + i, true));
      entries.push({
        name,
        type: dir[off + 0x42],
        left: ddv.getUint32(off + 0x44, true),
        right: ddv.getUint32(off + 0x48, true),
        child: ddv.getUint32(off + 0x4c, true),
        start: ddv.getUint32(off + 0x74, true),
        size: ddv.getUint32(off + 0x78, true)
      });
    }
    const rootEntry = entries[0];

    // Мини-поток и мини-FAT (для потоков меньше miniCutoff)
    const miniStream = readChain(rootEntry.start);
    const miniFatBytes = firstMiniFat === END_OF_CHAIN ? new Uint8Array(0) : readChain(firstMiniFat);
    const mfdv = new DataView(miniFatBytes.buffer);
    const miniFat = new Uint32Array(miniFatBytes.length / 4);
    for (let i = 0; i < miniFat.length; i++) miniFat[i] = mfdv.getUint32(i * 4, true);

    const readStream = (e) => {
      if (e.size < miniCutoff) {
        const out = new Uint8Array(e.size);
        let pos = 0;
        for (const s of chain(e.start, miniFat)) {
          const off = s * miniSectorSize;
          const n = Math.min(miniSectorSize, e.size - pos);
          out.set(miniStream.subarray(off, off + n), pos);
          pos += n;
          if (pos >= e.size) break;
        }
        return out;
      }
      return readChain(e.start).subarray(0, e.size);
    };

    // Обход дерева детей корня (красно-чёрное дерево через left/right)
    const result = new Map();
    const stack = [rootEntry.child];
    const visited = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (id === FREE_SECT || id >= entries.length || visited.has(id)) continue;
      visited.add(id);
      const e = entries[id];
      stack.push(e.left, e.right);
      if (e.type === 2) result.set(e.name, readStream(e));
    }
    return result;
  }

  // ---------- Свойства MAPI ----------
  function decodeUtf16(b) {
    let s = '';
    for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b[i] | (b[i + 1] << 8));
    return s.replace(/\0+$/, '');
  }

  function decodeBytes(b, charset) {
    try {
      return new TextDecoder(charset || 'utf-8').decode(b).replace(/\0+$/, '');
    } catch {
      return Array.from(b, (c) => String.fromCharCode(c)).join('').replace(/\0+$/, '');
    }
  }

  function filetimeToDate(lo, hi) {
    const ms = (hi * 4294967296 + lo) / 10000 - 11644473600000;
    return ms > 0 ? new Date(ms) : null;
  }

  // Codepage Windows -> имя кодировки для TextDecoder
  function codepageName(cp) {
    if (cp === 65001) return 'utf-8';
    if (cp === 20127) return 'us-ascii';
    if (cp === 936) return 'gbk';
    if (cp === 950) return 'big5';
    if (cp === 932) return 'shift_jis';
    if (cp === 949) return 'euc-kr';
    if (cp === 20866) return 'koi8-r';
    if (cp >= 1250 && cp <= 1258) return 'windows-' + cp;
    return null;
  }

  function parseMsg(bytes) {
    const streams = readCfbRootStreams(bytes);
    // Числовые свойства (даты, кодировка) — в потоке __properties_version1.0
    const props = new Map();
    const pstream = streams.get('__properties_version1.0');
    if (pstream) {
      const pdv = new DataView(pstream.buffer, pstream.byteOffset, pstream.byteLength);
      for (let off = 32; off + 16 <= pstream.length; off += 16) {
        props.set(pdv.getUint32(off, true), [pdv.getUint32(off + 8, true), pdv.getUint32(off + 12, true)]);
      }
    }
    const cpProp = props.get(0x3ffd0003) || props.get(0x3fde0003);
    const ansiCharset = (cpProp && codepageName(cpProp[0])) || 'windows-1252';

    const str = (id) => {
      const u = streams.get('__substg1.0_' + id + '001F');
      if (u) return decodeUtf16(u);
      const a = streams.get('__substg1.0_' + id + '001E');
      if (a) return decodeBytes(a, ansiCharset);
      return '';
    };
    const bin = (id) => streams.get('__substg1.0_' + id + '0102');

    const emailCandidates = [str('5D01'), str('39FE'), str('0C1F'), str('0065'), str('5D02')];
    const fromEmail = emailCandidates.find((e) => /@/.test(e)) || '';

    let date = null;
    for (const tag of [0x00390040, 0x0e060040, 0x30070040]) {
      const v = props.get(tag);
      if (v) { date = filetimeToDate(v[0], v[1]); if (date) break; }
    }

    let body = str('1000');
    if (!body.trim()) {
      const htmlBin = bin('1013');
      const html = htmlBin ? decodeBytes(htmlBin, htmlCharset(htmlBin) || ansiCharset) : str('1013');
      if (html) body = htmlToText(html);
    }
    return {
      subject: str('0037'),
      fromName: str('0C1A') || str('0042'),
      fromEmail,
      to: str('0E04'),
      cc: str('0E03'),
      date,
      body
    };
  }

  function htmlCharset(bytes) {
    const head = decodeBytes(bytes.subarray(0, 2048), 'latin1');
    const m = /charset\s*=\s*["']?([\w-]+)/i.exec(head);
    return m ? m[1] : null;
  }

  // ---------- HTML -> текст ----------
  const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®' };

  function htmlToText(html) {
    return String(html)
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|head|title|xml)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
      .replace(/<(p|div|tr|li|h[1-6]|table|blockquote)\b[^>]*>/gi, '\n')
      .replace(/<\/t[dh]>/gi, '\t')
      .replace(/<[^>]+>/g, '')
      .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d))
      .replace(/&([a-z]+);/gi, (m, n) => (ENTITIES[n.toLowerCase()] !== undefined ? ENTITIES[n.toLowerCase()] : m))
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ---------- EML (MIME) ----------
  function bytesToLatin1(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return s;
  }
  function latin1ToBytes(s) {
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    return b;
  }
  function base64ToBytes(s) {
    const clean = s.replace(/[^A-Za-z0-9+/=]/g, '');
    if (typeof atob === 'function') return latin1ToBytes(atob(clean));
    return new Uint8Array(Buffer.from(clean, 'base64'));
  }
  function qpToBytes(s) {
    const t = s.replace(/=\r?\n/g, '');
    const out = [];
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(t.substr(i + 1, 2))) { out.push(parseInt(t.substr(i + 1, 2), 16)); i += 2; }
      else out.push(t.charCodeAt(i) & 0xff);
    }
    return new Uint8Array(out);
  }

  // =?utf-8?B?...?= и =?koi8-r?Q?...?=
  function decodeWords(s) {
    return String(s || '')
      .replace(/\?=\s+=\?/g, '?==?')
      .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (m, cs, enc, data) => {
        const bytes = /b/i.test(enc) ? base64ToBytes(data) : qpToBytes(data.replace(/_/g, ' '));
        return decodeBytes(bytes, cs.replace(/\*.*$/, ''));
      });
  }

  function parseHeaders(block) {
    const headers = {};
    const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
    for (const line of unfolded.split(/\r?\n/)) {
      const m = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
      if (m) {
        const k = m[1].toLowerCase();
        if (!(k in headers)) headers[k] = m[2];
      }
    }
    return headers;
  }

  function splitHeadBody(raw) {
    const m = /\r?\n\r?\n/.exec(raw);
    if (!m) return [raw, ''];
    return [raw.slice(0, m.index), raw.slice(m.index + m[0].length)];
  }

  function param(value, name) {
    const m = new RegExp(name + '\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))', 'i').exec(value || '');
    return m ? (m[1] !== undefined ? m[1] : m[2]) : '';
  }

  // Возвращает { plain, html } — первые найденные текстовые части письма
  function walkMime(raw, found) {
    const [head, body] = splitHeadBody(raw);
    const h = parseHeaders(head);
    const ctype = (h['content-type'] || 'text/plain').toLowerCase();
    if (/^multipart\//.test(ctype)) {
      const boundary = param(h['content-type'], 'boundary');
      if (!boundary) return found;
      const parts = body.split('--' + boundary);
      for (let i = 1; i < parts.length; i++) {
        if (/^--/.test(parts[i])) break;
        walkMime(parts[i].replace(/^\r?\n/, ''), found);
      }
      return found;
    }
    if (/attachment/i.test(h['content-disposition'] || '')) return found;
    const enc = (h['content-transfer-encoding'] || '').toLowerCase();
    const bytes = enc === 'base64' ? base64ToBytes(body) : enc === 'quoted-printable' ? qpToBytes(body) : latin1ToBytes(body);
    const text = decodeBytes(bytes, param(h['content-type'], 'charset') || 'utf-8');
    if (/^text\/plain/.test(ctype) && found.plain === undefined) found.plain = text;
    else if (/^text\/html/.test(ctype) && found.html === undefined) found.html = text;
    return found;
  }

  function parseEml(bytes) {
    const raw = bytesToLatin1(bytes);
    const [head] = splitHeadBody(raw);
    const h = parseHeaders(head);
    const found = walkMime(raw, {});
    let body = found.plain !== undefined ? found.plain : found.html !== undefined ? htmlToText(found.html) : '';
    body = body.replace(/\r\n/g, '\n');
    // Заголовки в 8-битной кодировке (без =?..?=) обычно в UTF-8
    const hdr = (k) => decodeWords(decodeBytes(latin1ToBytes(h[k] || ''), 'utf-8'));
    const from = hdr('from');
    const em = /[^\s<>"']+@[^\s<>"']+/.exec(from);
    const fromName = from.replace(/<[^>]*>/, '').replace(/["']/g, '').replace(em ? em[0] : '\u0000', '').trim();
    const date = h.date ? new Date(h.date.replace(/\s*\([^)]*\)\s*$/, '')) : null;
    return {
      subject: hdr('subject'),
      fromName,
      fromEmail: em ? em[0] : '',
      to: hdr('to'),
      cc: hdr('cc'),
      date: date && !isNaN(date) ? date : null,
      body
    };
  }

  // ---------- Сборка текста для разбора ----------
  const pad = (n) => String(n).padStart(2, '0');

  function formatDate(d) {
    if (!d) return '';
    return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function mailToText(mail) {
    const from = mail.fromName && mail.fromEmail ? mail.fromName + ' <' + mail.fromEmail + '>' : (mail.fromName || mail.fromEmail || '');
    const lines = [];
    if (from) {
      lines.push('From: ' + from);
      lines.push('Sent: ' + (formatDate(mail.date) || '-'));
      if (mail.to) lines.push('To: ' + mail.to);
      if (mail.cc) lines.push('Cc: ' + mail.cc);
      lines.push('Subject: ' + (mail.subject || ''));
      lines.push('');
    }
    lines.push(String(mail.body || '').replace(/\r\n?/g, '\n'));
    return lines.join('\n');
  }

  /** Разбор перетащенного файла письма. name — имя файла, bytes — Uint8Array. */
  function fileToText(name, bytes) {
    if (isCfb(bytes)) return mailToText(parseMsg(bytes));
    if (/\.(eml|mht|mhtml)$/i.test(name) || /^(?:[\w-]+:.*\r?\n)+/.test(bytesToLatin1(bytes.subarray(0, 2000)))) {
      return mailToText(parseEml(bytes));
    }
    const text = decodeBytes(bytes, 'utf-8');
    return /<html|<body|<div|<p[\s>]/i.test(text) ? htmlToText(text) : text;
  }

  return { fileToText, parseMsg, parseEml, htmlToText, mailToText, readCfbRootStreams };
});
