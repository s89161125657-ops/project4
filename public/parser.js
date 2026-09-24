/*
 * Разбор текста e-mail переписки, скопированного из почтового клиента
 * (Outlook, Gmail, Thunderbird, Apple Mail, Foxmail/NetEase и т.п.).
 * Работает и в браузере (window.MailParser), и в Node (module.exports).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MailParser = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
  const EMAIL_RE_G = new RegExp(EMAIL_RE.source, 'g');
  const TIME_RE_G = /(?:上午|下午|早上|晚上)?\s*\d{1,2}[:：]\d{2}(?::\d{2})?(?:\s*(?:[AaPp]\.?\s?[Mm]\.?)(?![A-Za-z]))?/g;

  // Ключи заголовков письма на разных языках -> тип поля
  const HEADER_KEYS = {
    from: ['from', 'от', 'от кого', 'отправитель', '发件人', '寄件人', '寄件者', 'von', 'de', 'da', 'van', '差出人', '送信者', '보낸 사람', '보낸사람'],
    date: ['sent', 'date', 'sent date', 'отправлено', 'дата', 'дата отправки', '发送时间', '发送日期', '日期', '时间', '寄件日期', '傳送日期', 'gesendet', 'datum', 'envoyé', 'envoye', 'enviado', 'fecha', 'data', 'inviato', '送信日時', '日付', '보낸 날짜'],
    to: ['to', 'cc', 'bcc', 'кому', 'копия', 'скрытая копия', '收件人', '抄送', '密送', '副本', 'an', 'kopie', 'à', 'a', 'para', 'cci', 'wysłano do', '宛先', '받는 사람', '참조'],
    subject: ['subject', 'тема', '主题', '主旨', 'betreff', 'objet', 'asunto', 'oggetto', 'assunto', '件名', '제목'],
    other: ['reply-to', 'importance', 'attachments', 'priority', 'важность', 'вложения', '附件', '重要性', 'anlagen', 'pièces jointes', 'адресат', 'ответить']
  };
  const KEY_TYPE = new Map();
  for (const type of Object.keys(HEADER_KEYS)) {
    for (const k of HEADER_KEYS[type]) KEY_TYPE.set(k, type);
  }

  // Ключи, по которым склеенный в одну строку заголовок разбивается на поля
  const INLINE_SPLIT_RE = /\s+(?=(?:Sent|Date|To|Cc|Subject|Отправлено|Дата|Кому|Копия|Тема|发送时间|收件人|抄送|主题)\s*[:：])/g;

  const WROTE_RE = /(?:wrote|writes|написал\(а\)|написала|написал|пишет|schrieb|a écrit|a ecrit|escribió|escribio|ha scritto|escreveu|写道|寫道|님이 작성)\s*[:：]?\s*$/i;

  const MONTHS = [
    ['jan', 'янв', 'jän', 'janv', 'ene', 'gen'],
    ['feb', 'фев', 'févr', 'fev', 'febr'],
    ['mar', 'мар', 'mär', 'mars'],
    ['apr', 'апр', 'avr', 'abr'],
    ['may', 'ма', 'mai', 'mag'],
    ['jun', 'июн', 'juin', 'giu'],
    ['jul', 'июл', 'juil', 'lug'],
    ['aug', 'авг', 'août', 'aout', 'ago'],
    ['sep', 'сен', 'sept', 'set'],
    ['oct', 'окт', 'okt', 'ott', 'out'],
    ['nov', 'ноя', 'нояб'],
    ['dec', 'дек', 'dez', 'déc', 'dic']
  ];

  function headerKV(line) {
    const m = /^\s*\*{0,2}\s*([^:：\t]{1,25}?)\s*\*{0,2}\s*(?:[:：]|\t+)\s*(.*)$/.exec(line);
    if (!m) return null;
    const key = m[1].trim().toLowerCase();
    const type = KEY_TYPE.get(key);
    if (!type) return null;
    return { key, type, value: m[2].trim() };
  }

  function isBlank(line) {
    return !line || !line.trim();
  }

  // Разделители вида "-----Original Message-----", "________", "---- Replied Message ----"
  function isNoise(line) {
    const t = line.trim();
    if (!t) return true;
    if (/^[-_=—–~*]{4,}$/.test(t)) return true;
    if (/^[-_=—–~]{2,}.{0,60}?[-_=—–~]{2,}$/.test(t)) return true;
    return false;
  }

  function normalize(text) {
    const raw = String(text || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[   ]/g, ' ')
      .replace(/[​-‍﻿⁠]/g, '')
      .split('\n');
    const out = [];
    for (let line of raw) {
      // Снимаем маркеры цитирования "> > "
      line = line.replace(/^\s*(?:>\s?)+/, '');
      // Табличный заголовок "| From | John <j@x.com> |"
      const pm = /^\s*\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|?\s*$/.exec(line);
      if (pm && KEY_TYPE.has(pm[1].trim().replace(/[:：]$/, '').toLowerCase())) {
        line = pm[1].trim().replace(/[:：]$/, '') + ': ' + pm[2];
      }
      // Весь заголовок в одной строке: "From: X Sent: Y To: Z Subject: W"
      const kv = headerKV(line);
      if (kv && kv.type === 'from' && INLINE_SPLIT_RE.test(line)) {
        INLINE_SPLIT_RE.lastIndex = 0;
        out.push(...line.split(INLINE_SPLIT_RE));
        continue;
      }
      INLINE_SPLIT_RE.lastIndex = 0;
      out.push(line);
    }
    return out;
  }

  function looksLikeDate(s) {
    if (!s || s.length > 140 || !/\d/.test(s)) return false;
    return hasTime(s) || parseDate(s) !== null;
  }

  // --- Формат Outlook / Thunderbird: блок "From: / Sent: / To: / Subject:" ---
  function tryHeaderBlock(lines, i) {
    const first = headerKV(lines[i]);
    if (!first || first.type !== 'from') return null;
    let fromRaw = first.value;
    const toRaw = [];
    let dateRaw = '';
    let count = 1;
    let lastType = 'from';
    let j = i + 1;
    // "From:" без значения, а адрес на следующей строке
    if (!fromRaw && j < lines.length && !isBlank(lines[j]) && !headerKV(lines[j])) {
      fromRaw = lines[j].trim();
      j++;
    }
    while (j < lines.length) {
      const line = lines[j];
      if (isBlank(line)) {
        let k = j;
        while (k < lines.length && isBlank(lines[k]) && k - j < 3) k++;
        const next = k < lines.length ? headerKV(lines[k]) : null;
        if (next && next.type !== 'from') { j = k; continue; }
        break;
      }
      const kv = headerKV(line);
      if (kv && kv.type !== 'from') {
        if (kv.type === 'date' && !dateRaw) dateRaw = kv.value;
        if (kv.type === 'to') toRaw.push(kv.value);
        count++;
        lastType = kv.type;
        j++;
        continue;
      }
      if (lastType === 'to' && /[@;,]/.test(line) && !kv) { toRaw.push(line); j++; continue; }
      break;
    }
    if (count < 2) return null;
    if (!dateRaw && !EMAIL_RE.test(fromRaw)) return null;
    return { start: i, end: j, sender: parseSender(fromRaw), dateRaw: cleanDate(dateRaw), recipients: parseRecipients(toRaw.join(';')) };
  }

  // --- Формат Gmail/Apple Mail: "On <дата>, <Имя> <email> wrote:" ---
  function tryWroteLine(lines, i) {
    const line = lines[i].trim();
    if (!line || line.length > 400) return null;
    let cand = null;
    let used = 1;
    const endsWithEmailColon = (s) => EMAIL_RE.test(s) && />\s*[:：]\s*$/.test(s) && hasTime(s);
    if ((WROTE_RE.test(line) && EMAIL_RE.test(line)) || endsWithEmailColon(line)) {
      cand = line;
    } else if (i + 1 < lines.length) {
      const next = lines[i + 1].trim();
      const joined = line + ' ' + next;
      const nextStandalone = EMAIL_RE.test(next) && /\d/.test(next);
      if (!nextStandalone && next.length < 200 &&
          (WROTE_RE.test(next) || endsWithEmailColon(joined)) &&
          EMAIL_RE.test(joined) && /\d/.test(line)) {
        cand = joined;
        used = 2;
      }
    }
    if (!cand) return null;
    // Одиночная строка "wrote:" должна содержать дату или стоять после даты
    if (!/\d/.test(cand)) return null;

    let text = cand.replace(WROTE_RE, '').replace(/[:：]\s*$/, '').trim();
    text = text.replace(/^(?:on|le|am|el|il|em|в|在)\s+/i, '');
    const em = EMAIL_RE.exec(text);
    let before = text.slice(0, em.index);
    before = before.replace(/(?:\[?mailto:|[<\[(«"'\s])+$/i, '');

    let datePart = '';
    let namePart = before;
    const times = [...before.matchAll(TIME_RE_G)];
    if (times.length) {
      const last = times[times.length - 1];
      const endIdx = last.index + last[0].length;
      datePart = before.slice(0, endIdx);
      namePart = before.slice(endIdx);
    } else {
      const c = Math.max(before.lastIndexOf(','), before.lastIndexOf('，'));
      if (c > 0) {
        datePart = before.slice(0, c);
        namePart = before.slice(c + 1);
      }
    }
    namePart = namePart.replace(/^[\s,，]+/, '').replace(/^(?:от|from)\s+/i, '');
    const sender = parseSender(namePart + ' <' + em[0] + '>');
    return { start: i, end: i + used, sender, dateRaw: cleanDate(datePart) };
  }

  function hasTime(s) {
    TIME_RE_G.lastIndex = 0;
    const r = TIME_RE_G.test(s);
    TIME_RE_G.lastIndex = 0;
    return r;
  }

  // --- Веб-интерфейс Gmail: "Имя <email>" / дата / "кому: мне" ---
  function tryGmailUi(lines, i) {
    const line = lines[i].trim();
    const m = /^"?([^<>"@]{0,80}?)"?\s*<([^<>\s]+@[^<>\s]+)>\s*(.*)$/.exec(line);
    if (!m || !EMAIL_RE.test(m[2])) return null;
    let dateRaw = '';
    let j = i + 1;
    if (m[3] && looksLikeDate(m[3])) {
      dateRaw = m[3];
    } else if (m[3]) {
      return null;
    } else {
      while (j < lines.length && isBlank(lines[j]) && j - i < 3) j++;
      if (j >= lines.length || !looksLikeDate(lines[j].trim())) return null;
      dateRaw = lines[j].trim();
      j++;
    }
    let k = j;
    while (k < lines.length && isBlank(lines[k]) && k - j < 3) k++;
    if (k < lines.length && /^(?:to|кому|收件人|发送至|发给|an|à|para|a)(?:\s*[:：]|\s+)/i.test(lines[k].trim()) && lines[k].length < 300) {
      j = k + 1;
    }
    return { start: i, end: j, sender: parseSender(m[1] + ' <' + m[2] + '>'), dateRaw: cleanDate(dateRaw) };
  }

  function cleanDate(s) {
    return String(s || '')
      .replace(/\((?:[^()]*?(?:ago|назад|前|vor|il y a|hace))[^()]*\)/gi, '')
      .replace(/[☆★]/g, '')
      .replace(/^[\s,，]+|[\s,，]+$/g, '')
      .replace(/\s{2,}/g, ' ');
  }

  // Имена получателей из строк To/Cc: "Li Wei <a@b>; Wang, Fang <c@d>, e@f"
  function parseRecipients(raw) {
    const out = [];
    const re = /([^;<>]*?)\s*<\s*(?:mailto:)?([^<>\s]+@[^<>\s]+?)\s*>/g;
    let m;
    let rest = String(raw || '');
    while ((m = re.exec(raw))) {
      const name = m[1].replace(/^[\s,;]+/, '');
      out.push(parseSender(name + ' <' + m[2] + '>'));
    }
    rest = rest.replace(re, ';');
    for (const part of rest.split(';')) {
      const p = parseSender(part);
      if (p.name && !EMAIL_RE.test(part) && p.name.length <= 60) out.push(p);
    }
    return out.filter((p) => p.name);
  }

  function parseSender(raw) {
    const s = String(raw || '').replace(/mailto:/gi, ' ');
    const em = s.match(EMAIL_RE_G);
    const email = em ? em[0].toLowerCase() : '';
    let name = s.replace(EMAIL_RE_G, ' ')
      .replace(/[<>\[\]()]/g, ' ')
      .replace(/["'«»“”‘’]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .replace(/^[,;:\s]+|[,;:\s]+$/g, '');
    // "Smith, John" -> "John Smith"
    const sw = /^([^,\s]+),\s*([^,\s]+)$/.exec(name);
    if (sw) name = sw[2] + ' ' + sw[1];
    if (name.toLowerCase() === email) name = '';
    return { name, email };
  }

  // --- Подписи в конце письма ---
  // Строка-прощание, с которой начинается подпись ("Best regards", "С уважением" ...)
  const CLOSING_RE = new RegExp('^(?:' + [
    '(?:thanks?(?: you)?\\s*(?:&|and|,)?\\s*)?(?:(?:best|kind|kindest|warm|warmest|many|with (?:best|kind|warm))\\s+)?regards',
    '(?:br|b\\.r\\.|rgds|best(?: wishes)?|cheers)(?=\\s*[,.!]|\\s*$)', 'sincerely(?: yours)?', 'yours (?:sincerely|faithfully|truly)',
    'с уважением', 'с наилучшими пожеланиями', 'всего (?:доброго|наилучшего)', 'искренне ваш',
    '此致', '此致敬礼', '祝好', '顺祝商祺', '顺颂商祺', '祝商祺', '谢谢[！!]?\\s*此致',
    'mit freundlichen grüßen', 'viele grüße', 'beste grüße', 'cordialement', 'saludos(?: cordiales)?', 'atentamente', 'distinti saluti'
  ].join('|') + ')(?![A-Za-zА-Яа-яЁё])[\\s,.!:;，。！]*', 'i');

  // Строки с контактами: телефон, e-mail, сайт, адрес, компания
  const CONTACT_RE = new RegExp([
    '(?:tel|phone|mobile|mob|cell|fax|whatsapp|wechat|skype|e-?mail|web(?:site)?|add(?:ress)?|тел|моб|факс|адрес|почта|сайт|电话|手机|传真|邮箱|地址|网址)\\.?\\s*(?:phone)?\\s*[:：.]',
    '\\+?\\d[\\d\\s()\\-]{7,}\\d',
    '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}',
    '(?:https?://|www\\.)\\S+',
    '\\bco\\.?,?\\s*ltd\\b', '\\b(?:llc|inc|gmbh|corp|corporation|limited)\\b', '(?:^|\\s)(?:ооо|оао|зао|ао|пао)\\s', '有限公司',
    '\\b(?:road|street|avenue|district|zone|province|p\\.?\\s?r\\.?\\s?china)\\b', '(?:ул\\.|улица|проспект|г\\.\\s)'
  ].join('|'), 'i');

  const TITLE_RE = /\b(?:manager|engineer|director|specialist|assistant|sales|service|support|president|officer|coordinator|head of|representative)\b|менеджер|инженер|директор|специалист|руководитель|经理|工程师|总监/i;

  // Короткая строка из слов с заглавной буквы (имя, должность, отдел) или с контактами
  function isSignatureLike(line) {
    if (CONTACT_RE.test(line) || TITLE_RE.test(line)) return true;
    if (line.length > 40 || /[.?!。？！:]\s*$/.test(line)) return false;
    const words = line.split(/\s+/);
    return words.length <= 5 && words.every((w) =>
      /^(?:of|and|&|и|de|van|von)$/i.test(w) || !/^[a-zа-яё]/.test(w));
  }

  function stripSignature(lines) {
    // 1) Разделитель подписи "--"
    const dash = lines.findIndex((l) => /^--\s*$/.test(l));
    if (dash >= 0) lines = lines.slice(0, dash);

    // 2) Последнее прощание, после которого идёт только подпись
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines.length - i > 25) break;
      if (lines[i].length <= 80 && CLOSING_RE.test(lines[i])) {
        const rest = lines.slice(i + 1);
        const nameOnSameLine = lines[i].replace(CLOSING_RE, '');
        if (rest.every(isSignatureLike) && (!nameOnSameLine || isSignatureLike(nameOnSameLine))) {
          return lines.slice(0, i);
        }
        break;
      }
    }

    // 3) Блок контактов в конце письма без прощания
    let start = lines.length;
    let contacts = 0;
    while (start > 0 && isSignatureLike(lines[start - 1])) {
      start--;
      if (CONTACT_RE.test(lines[start])) contacts++;
    }
    if (contacts > 0 && start > 0) {
      // Убираем и строку благодарности прямо перед подписью
      if (/^(?:thanks?(?: you)?(?: very much)?|thx|спасибо(?: большое)?|谢谢|感谢)[\s,.!！，。]*$/i.test(lines[start - 1])) start--;
      return lines.slice(0, start);
    }
    return lines;
  }

  // --- Юридические оговорки (disclaimer) в конце писем ---
  // Фрагменты, по которым узнаётся оговорка (достаточно одного в строке).
  const DISCLAIMER_RE = new RegExp([
    'information transmitted is intended',
    'and/or privileged material',
    'unauthorized disclosure, reproduction',
    'other than the intended recipient',
    'delete the email together with any material attached',
    'not necessarily represent those of Haier',
    '本邮件可能包含敏感信息',
    '仅限于发给指定的收件人',
    '任何未经授权泄露',
    '请及时告知发送者',
    '并不代表海尔集团',
    '^\\s*(?:confidentiality notice|disclaimer)\\s*[:：]',
    '^\\s*this (?:e-?mail|message)(?: and any (?:files|attachments)[^.]*)? (?:is|are|may be) (?:strictly )?confidential'
  ].join('|'), 'i');

  // Удаляет оговорку: от строки, где она начинается, до конца абзаца
  function stripDisclaimers(lines) {
    const out = [];
    let skipping = false;
    for (const line of lines) {
      if (isBlank(line)) { skipping = false; out.push(line); continue; }
      if (!skipping && DISCLAIMER_RE.test(line)) skipping = true;
      if (!skipping) out.push(line);
    }
    return out;
  }

  function cleanBody(lines, opts) {
    const out = stripDisclaimers(lines)
      .map((l) => l.replace(/\t/g, '    ').replace(/\s+$/, ''))
      .filter((l) => !isBlank(l) && !isNoise(l))
      .map((l) => l.trim());
    return opts && opts.stripSignatures === false ? out : stripSignature(out);
  }

  function findMarker(lines, i) {
    return tryHeaderBlock(lines, i) || tryWroteLine(lines, i) || tryGmailUi(lines, i);
  }

  /**
   * Разбирает переписку. Возвращает массив писем в порядке следования в тексте:
   * { name, email, dateRaw, date: {y,m,d,hh,mm}|null, lines: [..], unknown }
   * opts.stripSignatures === false — не убирать подписи в конце писем.
   */
  function parseThread(text, opts) {
    const lines = normalize(text);
    const markers = [];
    for (let i = 0; i < lines.length; i++) {
      if (isBlank(lines[i])) continue;
      const m = findMarker(lines, i);
      if (m) {
        markers.push(m);
        i = m.end - 1;
      }
    }

    const messages = [];
    const firstStart = markers.length ? markers[0].start : lines.length;
    const preface = cleanBody(lines.slice(0, firstStart), opts);
    if (preface.length) {
      messages.push({ name: '', email: '', dateRaw: '', lines: preface, unknown: true, recipients: [] });
    }
    markers.forEach((m, idx) => {
      const end = idx + 1 < markers.length ? markers[idx + 1].start : lines.length;
      messages.push({
        name: m.sender.name,
        email: m.sender.email,
        dateRaw: m.dateRaw,
        lines: cleanBody(lines.slice(m.end, end), opts),
        unknown: false,
        recipients: m.recipients || []
      });
    });

    // Дополняем недостающие имя/адрес по другим письмам этого же отправителя
    const nameByEmail = new Map();
    const emailByName = new Map();
    for (const msg of messages) {
      if (msg.email && msg.name && !nameByEmail.has(msg.email)) nameByEmail.set(msg.email, msg.name);
      if (msg.email && msg.name && !emailByName.has(msg.name.toLowerCase())) emailByName.set(msg.name.toLowerCase(), msg.email);
    }
    for (const msg of messages) {
      if (!msg.name && msg.email && nameByEmail.has(msg.email)) msg.name = nameByEmail.get(msg.email);
      if (!msg.email && msg.name && emailByName.has(msg.name.toLowerCase())) msg.email = emailByName.get(msg.name.toLowerCase());
      msg.date = parseDate(msg.dateRaw);
    }
    return messages;
  }

  function findMonth(s) {
    const lower = s.toLowerCase();
    const re = /[a-zа-яёäéèûô]+/g;
    let m;
    while ((m = re.exec(lower))) {
      const w = m[0];
      if (w.length < 3 && w !== 'ма') continue;
      for (let idx = 0; idx < 12; idx++) {
        for (const p of MONTHS[idx]) {
          if (idx === 4 && p === 'ма') {
            // май / мая / мае (не "март")
            if (/^ма[йяе]$/.test(w)) return { month: idx + 1, index: m.index, length: w.length };
            continue;
          }
          if (w.startsWith(p)) return { month: idx + 1, index: m.index, length: w.length };
        }
      }
    }
    return null;
  }

  /** Разбор даты из произвольной строки. Возвращает {y,m,d,hh,mm} или null. */
  function parseDate(str, now) {
    if (!str) return null;
    const s = String(str);
    let y = null, mo = null, d = null;
    let m;
    if ((m = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(s))) {
      y = +m[1]; mo = +m[2]; d = +m[3];
    } else if ((m = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s))) {
      y = +m[1]; mo = +m[2]; d = +m[3];
    } else if ((m = /(?<!\d)(\d{1,2})([./-])(\d{1,2})\2(\d{4}|\d{2})(?!\d)/.exec(s))) {
      let a = +m[1], b = +m[3];
      y = +m[4];
      if (m[2] === '/' && a <= 12 && b > 12) { mo = a; d = b; }
      else if (m[2] === '/' && a <= 12 && b <= 12) { mo = a; d = b; } // US формат Outlook
      else { d = a; mo = b; }
    } else {
      const month = findMonth(s);
      if (month) {
        mo = month.month;
        const withoutTime = s.replace(TIME_RE_G, ' ');
        TIME_RE_G.lastIndex = 0;
        const ym = /\b(\d{4})\b/.exec(withoutTime);
        if (ym) y = +ym[1];
        const monthIdx = findMonth(withoutTime);
        const beforeM = withoutTime.slice(0, monthIdx.index);
        const afterM = withoutTime.slice(monthIdx.index + monthIdx.length);
        const dBefore = /(?:^|[^\d])(\d{1,2})\.?\s*$/.exec(beforeM);
        const dAfter = /^\.?\s*(\d{1,2})(?!\d)/.exec(afterM);
        if (dBefore) d = +dBefore[1];
        else if (dAfter) d = +dAfter[1];
        if (!y) y = (now || new Date()).getFullYear();
      }
    }
    if (y !== null && y < 100) y += 2000;
    if (!y || !mo || !d || mo > 12 || d > 31) return null;

    let hh = null, mm = null;
    const tm = /(上午|下午|早上|晚上)?\s*(\d{1,2})[:：](\d{2})(?::\d{2})?(?:\s*([AaPp])\.?\s?[Mm]\.?(?![A-Za-z]))?/.exec(s);
    if (tm) {
      hh = +tm[2]; mm = +tm[3];
      const pm = (tm[4] && /p/i.test(tm[4])) || tm[1] === '下午' || tm[1] === '晚上';
      const am = (tm[4] && /a/i.test(tm[4])) || tm[1] === '上午' || tm[1] === '早上';
      if (pm && hh < 12) hh += 12;
      if (am && hh === 12) hh = 0;
      if (hh > 23 || mm > 59) { hh = null; mm = null; }
    }
    return { y, m: mo, d, hh, mm };
  }

  const pad = (n) => String(n).padStart(2, '0');

  function formatDateRu(dt) {
    if (!dt) return '';
    let s = pad(dt.d) + '.' + pad(dt.m) + '.' + dt.y;
    if (dt.hh !== null && dt.hh !== undefined) s += ' ' + pad(dt.hh) + ':' + pad(dt.mm);
    return s;
  }

  return { parseThread, stripSignature, stripDisclaimers, parseRecipients, parseDate, parseSender, formatDateRu, normalize };
});
