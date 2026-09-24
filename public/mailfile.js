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

    // Обход дерева (красно-чёрное дерево через left/right, вложенные хранилища через child).
    // Потоки корня — по имени, потоки хранилищ — "хранилище/поток" (вложения письма).
    const result = new Map();
    const stack = [{ id: rootEntry.child, prefix: '', depth: 0 }];
    const visited = new Set();
    while (stack.length) {
      const { id, prefix, depth } = stack.pop();
      if (id === FREE_SECT || id >= entries.length || visited.has(id)) continue;
      visited.add(id);
      const e = entries[id];
      stack.push({ id: e.left, prefix, depth }, { id: e.right, prefix, depth });
      if (e.type === 2) result.set(prefix + e.name, readStream(e));
      else if (e.type === 1 && depth < 1) stack.push({ id: e.child, prefix: prefix + e.name + '/', depth: depth + 1 });
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

    // Текст берём из HTML-версии письма (PR_HTML или HTML внутри сжатого RTF):
    // только в ней указано, где стоят картинки, и нет жёстких переносов строк.
    // Если HTML нет — обычный текст (PR_BODY).
    let html = '';
    const htmlBin = bin('1013');
    if (htmlBin) html = decodeBytes(htmlBin, htmlCharset(htmlBin) || ansiCharset);
    else html = str('1013');
    if (!html) {
      const rtf = bin('1009');
      if (rtf) {
        try { html = rtfToHtml(decompressRtf(rtf)) || ''; } catch { html = ''; }
      }
    }
    let body = html ? htmlToText(html) : '';
    if (!body.trim()) body = str('1000');
    // Картинки из вложений (для меток [cid:...] в тексте)
    const images = [];
    const attachDirs = new Set([...streams.keys()].filter((k) => k.startsWith('__attach_version1.0_#')).map((k) => k.split('/')[0]));
    for (const dir of attachDirs) {
      const a = (id) => {
        const u = streams.get(dir + '/__substg1.0_' + id + '001F');
        if (u) return decodeUtf16(u);
        const b = streams.get(dir + '/__substg1.0_' + id + '001E');
        return b ? decodeBytes(b, ansiCharset) : '';
      };
      const data = streams.get(dir + '/__substg1.0_37010102');
      if (!data) continue;
      const name = a('3707') || a('3704');
      const mime = a('370E') || mimeFromName(name);
      if (!/^image\//i.test(mime)) continue;
      images.push({ cid: a('3712'), name, mime, bytes: data });
    }

    return {
      images,
      subject: str('0037'),
      fromName: str('0C1A') || str('0042'),
      fromEmail,
      to: str('0E04'),
      cc: str('0E03'),
      date,
      body
    };
  }

  function mimeFromName(name) {
    const ext = (/\.(\w+)$/.exec(name || '') || [])[1];
    const map = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff', emz: '', wmz: '' };
    return (ext && map[ext.toLowerCase()]) || '';
  }

  function htmlCharset(bytes) {
    const head = decodeBytes(bytes.subarray(0, 2048), 'latin1');
    const m = /charset\s*=\s*["']?([\w-]+)/i.exec(head);
    return m ? m[1] : null;
  }

  // ---------- Сжатый RTF (PR_RTF_COMPRESSED) и HTML внутри него ----------
  const RTF_PREBUF = '{\\rtf1\\ansi\\mac\\deff0\\deftab720{\\fonttbl;}{\\f0\\fnil \\froman \\fswiss \\fmodern \\fscript \\fdecor MS Sans SerifSymbolArialTimes New RomanCourier{\\colortbl\\red0\\green0\\blue0\r\n\\par \\pard\\plain\\f0\\fs20\\b\\i\\u\\tab\\tx';

  /** Распаковка LZFu (MS-OXRTFCP). Возвращает Uint8Array с RTF. */
  function decompressRtf(data) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const rawSize = dv.getUint32(4, true);
    const type = dv.getUint32(8, true);
    if (type === 0x414c454d) return data.subarray(16, 16 + rawSize); // MELA — без сжатия
    if (type !== 0x75465a4c) throw new Error('Неизвестный формат RTF');
    const dict = new Uint8Array(4096);
    for (let i = 0; i < RTF_PREBUF.length; i++) dict[i] = RTF_PREBUF.charCodeAt(i);
    let wp = RTF_PREBUF.length;
    const out = new Uint8Array(rawSize);
    let op = 0;
    let ip = 16;
    while (ip < data.length && op < rawSize) {
      const control = data[ip++];
      for (let bit = 0; bit < 8 && ip < data.length && op < rawSize; bit++) {
        if (control & (1 << bit)) {
          if (ip + 1 >= data.length) return out.subarray(0, op);
          const word = (data[ip] << 8) | data[ip + 1];
          ip += 2;
          const offset = word >> 4;
          const len = (word & 0xf) + 2;
          if (offset === (wp & 0xfff)) return out.subarray(0, op);
          for (let k = 0; k < len && op < rawSize; k++) {
            const c = dict[(offset + k) & 0xfff];
            out[op++] = c;
            dict[wp & 0xfff] = c;
            wp++;
          }
        } else {
          const c = data[ip++];
          out[op++] = c;
          dict[wp & 0xfff] = c;
          wp++;
        }
      }
    }
    return out.subarray(0, op);
  }

  // \fcharset -> кодовая страница Windows
  const FCHARSET_CP = { 0: 1252, 128: 932, 129: 949, 134: 936, 136: 950, 161: 1253, 162: 1254, 163: 1258, 177: 1255, 178: 1256, 186: 1257, 204: 1251, 222: 874, 238: 1250 };
  if (typeof TextDecoder !== 'undefined') {
    try { new TextDecoder('windows-874'); } catch { delete FCHARSET_CP[222]; }
  }

  // Группы, которые целиком пропускаются
  const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'listtable', 'listoverridetable', 'rsidtbl', 'latentstyles', 'themedata', 'datastore', 'xmlnstbl', 'generator']);

  /** Извлекает исходный HTML из RTF с \fromhtml1 (MS-OXRTFEX). Если HTML нет — null. */
  function rtfToHtml(rtfBytes) {
    const rtf = bytesToLatin1(rtfBytes);
    if (!/\\fromhtml1/.test(rtf.slice(0, 4000))) return null;
    const cpm = /\\ansicpg(\d+)/.exec(rtf.slice(0, 4000));
    const docCharset = (cpm && codepageName(+cpm[1])) || 'windows-1252';
    // Кодировка байтов \'hh зависит от шрифта: {\fN ...\fcharsetM ...} в таблице шрифтов
    const fontCharset = new Map();
    const fre = /\{\\f(\d+)[^{};]*?\\fcharset(\d+)/g;
    let fm;
    while ((fm = fre.exec(rtf.slice(0, 200000)))) {
      const cp = FCHARSET_CP[+fm[2]];
      if (cp && !fontCharset.has(+fm[1])) fontCharset.set(+fm[1], codepageName(cp));
    }
    const deff = /\\deff(\d+)/.exec(rtf.slice(0, 4000));
    const parts = [];
    let bytes = [];
    let bytesCharset = docCharset;
    const flushBytes = () => { if (bytes.length) { parts.push(decodeBytes(new Uint8Array(bytes), bytesCharset)); bytes = []; } };
    const emit = (str) => { flushBytes(); parts.push(str); };
    const pushByte = (b) => {
      const cs = fontCharset.get(st.font) || docCharset;
      if (cs !== bytesCharset) { flushBytes(); bytesCharset = cs; }
      bytes.push(b);
    };

    let st = { htmlrtf: false, tag: false, skip: false, uc: 1, font: deff ? +deff[1] : 0 };
    const stack = [];
    let skipChars = 0;
    let i = 0;
    const n = rtf.length;
    const out = () => !st.skip && (st.tag || !st.htmlrtf);
    while (i < n) {
      const c = rtf[i];
      if (c === '{') {
        stack.push(st);
        st = Object.assign({}, st);
        i++;
        // Назначение: {\*\htmltag... }, {\*\mhtmltag...}, {\fonttbl ...}
        const m = /^(\\\*)?\\([a-zA-Z]+)(-?\d+)?/.exec(rtf.slice(i, i + 40));
        if (m) {
          const word = m[2];
          if (m[1]) {
            if (word === 'htmltag') st.tag = true;
            else st.skip = true; // \mhtmltag и прочие служебные назначения
          } else if (RTF_SKIP.has(word)) st.skip = true;
        }
        continue;
      }
      if (c === '}') {
        st = stack.pop() || st;
        i++;
        continue;
      }
      if (c === '\\') {
        const next = rtf[i + 1];
        if (next === '\\' || next === '{' || next === '}') {
          if (skipChars > 0) skipChars--;
          else if (out()) emit(next);
          i += 2;
          continue;
        }
        if (next === "'") {
          const hex = rtf.substr(i + 2, 2);
          i += 4;
          if (skipChars > 0) { skipChars--; continue; }
          if (out()) pushByte(parseInt(hex, 16));
          continue;
        }
        if (next === '*') { i += 2; continue; }
        const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i, i + 40));
        if (!m) { i += 2; continue; }
        i += m[0].length;
        const word = m[1];
        const num = m[2] === undefined ? null : +m[2];
        if (word === 'htmlrtf') { st.htmlrtf = num !== 0; continue; }
        if (word === 'uc') { st.uc = num || 0; continue; }
        if (word === 'f' && num !== null) { st.font = num; continue; }
        if (word === 'u') {
          if (out()) emit(String.fromCharCode(num < 0 ? num + 65536 : num));
          skipChars = st.uc;
          continue;
        }
        if (skipChars > 0) { skipChars--; continue; }
        if (!out()) continue;
        if (word === 'par' || word === 'line') emit('\n');
        else if (word === 'tab') emit('\t');
        else if (word === 'emdash') emit('—');
        else if (word === 'endash') emit('–');
        else if (word === 'lquote') emit('‘');
        else if (word === 'rquote') emit('’');
        else if (word === 'ldblquote') emit('“');
        else if (word === 'rdblquote') emit('”');
        else if (word === 'bullet') emit('•');
        continue;
      }
      if (c === '\r' || c === '\n') { i++; continue; }
      if (skipChars > 0) { skipChars--; i++; continue; }
      if (out()) {
        const code = c.charCodeAt(0);
        if (code >= 0x80) pushByte(code);
        else emit(c);
      }
      i++;
    }
    flushBytes();
    return parts.join('');
  }

  // ---------- HTML -> текст ----------
  const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®' };

  function htmlToText(html) {
    return String(html)
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|head|title|xml)\b[\s\S]*?<\/\1>/gi, '')
      // Переносы строк в исходном HTML — это просто пробелы
      .replace(/\s+/g, ' ')
      .replace(/<img\b[^>]*>/gi, (tag) => {
        const src = (/\bsrc\s*=\s*["']?([^"'\s>]+)/i.exec(tag) || [])[1] || '';
        if (/^cid:/i.test(src)) return '\n[' + src + ']\n';
        if (/^(?:https?:|data:image\/)/i.test(src)) return '\n[img:' + src + ']\n';
        const alt = (/\balt\s*=\s*["']([^"']*)/i.exec(tag) || [])[1];
        return alt ? '\n[image: ' + alt + ']\n' : '';
      })
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
    const enc = (h['content-transfer-encoding'] || '').toLowerCase();
    const decode = () => enc === 'base64' ? base64ToBytes(body) : enc === 'quoted-printable' ? qpToBytes(body) : latin1ToBytes(body);
    if (/^image\//.test(ctype)) {
      (found.images = found.images || []).push({
        cid: (h['content-id'] || '').replace(/^\s*<|>\s*$/g, ''),
        name: decodeWords(param(h['content-disposition'], 'filename') || param(h['content-type'], 'name')),
        mime: ctype.split(';')[0].trim(),
        bytes: decode()
      });
      return found;
    }
    if (/attachment/i.test(h['content-disposition'] || '')) return found;
    const bytes = decode();
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
      images: found.images || [],
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

  /**
   * Разбор перетащенного файла письма. name — имя файла, bytes — Uint8Array.
   * Возвращает { text, images: [{cid, name, mime, bytes}] }.
   */
  function fileToMail(name, bytes) {
    let mail = null;
    if (isCfb(bytes)) mail = parseMsg(bytes);
    else if (/\.(eml|mht|mhtml)$/i.test(name) || /^(?:[\w-]+:.*\r?\n)+/.test(bytesToLatin1(bytes.subarray(0, 2000)))) mail = parseEml(bytes);
    if (mail) return { text: mailToText(mail), images: mail.images || [] };
    const text = decodeBytes(bytes, 'utf-8');
    return { text: /<html|<body|<div|<p[\s>]/i.test(text) ? htmlToText(text) : text, images: [] };
  }

  function fileToText(name, bytes) {
    return fileToMail(name, bytes).text;
  }

  return { decompressRtf, rtfToHtml, fileToMail, fileToText, parseMsg, parseEml, htmlToText, mailToText, readCfbRootStreams };
});
