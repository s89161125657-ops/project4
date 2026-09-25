(function () {
  'use strict';

  const { parseThread, formatDateRu, elapsedBetween, formatMoscow, IMAGE_MARKER_SRC } = window.MailParser;
  const { translateText, isMostlyRussian, applyGlossary, collectNames, protectNames, restoreNames,
    protectImages, restoreImages } = window.TranslateCore;

  const HEADER_GREEN = '#006400';
  const NAVY = '#000080';
  const UNKNOWN_COLOR = '#616161';
  const CUI_COLOR = '#ef6c00'; // оранжевый
  // Постоянные цвета: письма zsa@inpren.ru — тёмно-синие, письма Cui — оранжевые
  function fixedColor(msg) {
    const email = (msg.email || '').toLowerCase();
    const name = msg.name || '';
    if (email === 'zsa@inpren.ru') return NAVY;
    if (/(?:^|[._-])cui(?:[._@-]|baozhen)|^cui/.test(email) || /(?:^|\s)Cui(?:\s|$)|崔保振/.test(name)) return CUI_COLOR;
    return null;
  }
  // Палитра для остальных отправителей: хорошо различимые цвета без красных оттенков
  // (тёмно-синий, оранжевый и тёмно-зелёный заняты)
  const PALETTE = ['#7b1fa2', '#00897b', '#558b2f', '#6d4c41', '#1565c0', '#37474f', '#827717', '#0097a7'];
  const COLORS_KEY = 'mailThread.senderColors.v3';

  const BANNER_LINES = [
    'Ниже изложен перевод переписки для коллег из Haier Biomedical:',
    'Translation of the above text, made using Google Translate (only for information for colleagues from Haier Biomedical):'
  ];

  const $ = (id) => document.getElementById(id);
  const els = {
    paste: $('pasteBtn'), copy: $('copyBtn'),
    stripSig: $('stripSig'), placeholder: $('placeholder'), source: $('source'),
    status: $('status'), legend: $('legend'), result: $('result')
  };

  let runId = 0;
  let current = null; // { messages, translations }
  let configPromise = null;

  // ---------- Цвета отправителей (постоянные между сессиями) ----------
  function loadColors() {
    try { return JSON.parse(localStorage.getItem(COLORS_KEY)) || {}; } catch { return {}; }
  }
  function saveColors(map) {
    try { localStorage.setItem(COLORS_KEY, JSON.stringify(map)); } catch { /* недоступно */ }
  }
  function hashIndex(s, n) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % n;
  }
  function senderKey(msg) {
    return msg.email || (msg.name ? 'name:' + msg.name.toLowerCase() : '');
  }
  function colorFor(msg, map) {
    const key = senderKey(msg);
    if (!key) return UNKNOWN_COLOR;
    const fixed = fixedColor(msg);
    if (fixed) return fixed;
    if (map[key] && PALETTE.includes(map[key])) return map[key];
    const used = new Set(Object.values(map));
    let color = PALETTE.find((c) => !used.has(c));
    if (!color) color = PALETTE[hashIndex(key, PALETTE.length)];
    map[key] = color;
    return color;
  }

  // ---------- Перевод ----------
  function getConfig() {
    if (!configPromise) {
      configPromise = fetch('api/config').then((r) => r.json()).catch(() => ({ serverKey: false }));
    }
    return configPromise;
  }

  async function translateViaServer(texts, target) {
    const res = await fetch('api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts, target })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Ошибка сервера ' + res.status);
    return data.translations;
  }

  async function translateInBrowser(texts, target) {
    const fetchJson = async (url) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error('Google Translate ответил ' + r.status);
      return r.json();
    };
    const out = [];
    for (const t of texts) out.push(await translateText(t, target, fetchJson));
    return out;
  }

  async function translateAll(texts, target) {
    if (!texts.length) return [];
    const cfg = await getConfig();
    if (cfg.serverKey) return translateViaServer(texts, target);
    try {
      return await translateInBrowser(texts, target);
    } catch (e) {
      return translateViaServer(texts, target);
    }
  }

  // ---------- Отрисовка ----------
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // lang: '' — оригинал, 'ru' или 'en' — колонка перевода
  function headerHtml(msg, dateText, lang) {
    const isRu = lang === 'ru';
    if (msg.unknown) {
      return '<i>' + (isRu ? 'Отправитель не определён' : 'Sender not specified') + '</i>';
    }
    const parts = [];
    let who = msg.name || msg.email || (isRu ? 'Отправитель не определён' : 'Unknown sender');
    if (lang && msg.name) who = applyGlossary(who, lang);
    let line = '<b>' + esc(who) + '</b>';
    parts.push(line);
    if (dateText) parts.push(esc(dateText));
    return parts.join(', ');
  }

  /**
   * Дата для строки отправителя: всегда время по Москве с пометкой
   * "(время по Москве)" / "(Moscow time)". lang: язык колонки ('' — оригинал).
   */
  function dateLine(msg, tr, lang) {
    const labelLang = lang || (msg.target === 'en' ? 'ru' : 'en');
    const moscow = formatMoscow(msg.date);
    if (moscow) return moscow + (labelLang === 'ru' ? ' (время по Москве)' : ' (Moscow time)');
    if (msg.date) return formatDateRu(msg.date); // дата без времени
    return lang ? (tr && tr.date) || msg.dateRaw : msg.dateRaw;
  }

  // Светлая заливка цветом отправителя (для лучшего различения писем)
  function tint(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    // смешиваем с белым — так цвет сохранится и при вставке в Outlook
    const mix = (c) => Math.round(255 - (255 - c) * alpha);
    return 'rgb(' + mix((n >> 16) & 255) + ',' + mix((n >> 8) & 255) + ',' + mix(n & 255) + ')';
  }

  function cellHtml(color, header, bodyHtml, extraStyle) {
    // ширина задаётся таблицей: 2 колонки по 50% или одна на всю ширину
    return '<td style="vertical-align:top;padding:10px 14px 14px;background:#ffffff;' +
      'border-left:6px solid ' + color + ';color:' + color + ';word-wrap:break-word;overflow-wrap:anywhere;' +
      (extraStyle || '') + '">' +
      '<div style="margin:0 0 6px;font-size:14px;padding-bottom:4px;border-bottom:1px solid ' + tint(color, 0.35) + ';">' + header + '</div>' +
      '<div style="font-size:14px;">' + bodyHtml + '</div></td>';
  }


  // ---------- Картинки ----------
  // Картинки из перетащенного письма: cid / имя файла -> data: URL
  const imageStore = new Map();
  const IMAGE_RE = new RegExp(IMAGE_MARKER_SRC, 'gi');
  const BROWSER_IMAGE = /^image\/(?:png|jpe?g|gif|bmp|webp|svg\+xml)$/i;

  function bytesToBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(bin);
  }

  // Картинки-вложения перетащенных писем (прикреплены к письму, но не стоят в его тексте)
  let dropAttachments = [];

  // Картинка не упоминается в тексте письма ([cid:...] / имя файла) — значит, это вложение
  function findAttachments(mail) {
    const text = mail.text.toLowerCase();
    return mail.images.filter((img) => {
      const cid = (img.cid || '').toLowerCase();
      const name = (img.name || '').toLowerCase();
      if (cid && (text.includes('cid:' + cid) || text.includes('cid:' + cid.split('@')[0]))) return false;
      if (name && text.includes('[cid:' + name)) return false;
      return true;
    }).map((img) => ({
      name: img.name || 'image',
      src: BROWSER_IMAGE.test(img.mime) ? 'data:' + img.mime + ';base64,' + bytesToBase64(img.bytes) : ''
    }));
  }

  function attachmentsHtml(atts, lang) {
    if (!atts || !atts.length) return '';
    const title = lang === 'ru' ? 'Вложение в письмо:' : 'Attachment to the email:';
    return '<div style="margin-top:12px;"><b>' + title + '</b></div>' + atts.map((a) => a.src
      ? '<div style="margin-top:6px;"><img src="' + esc(a.src) + '" alt="' + esc(a.name) + '" style="display:inline-block;max-width:100%;max-height:420px;border:1px solid #e3e6ea;"></div>'
      : '<div style="margin-top:6px;color:#6b7280;font-style:italic;">[' + esc(a.name) + ']</div>').join('');
  }

  function registerImages(images) {
    for (const img of images) {
      if (!BROWSER_IMAGE.test(img.mime)) continue;
      const url = 'data:' + img.mime + ';base64,' + bytesToBase64(img.bytes);
      if (img.cid) {
        imageStore.set(img.cid.toLowerCase(), url);
        imageStore.set(img.cid.split('@')[0].toLowerCase(), url);
      }
      if (img.name) imageStore.set(img.name.toLowerCase(), url);
    }
  }

  function markerInfo(marker) {
    let m;
    if ((m = /^\[cid:([^\]]+)\]$/i.exec(marker))) {
      const cid = m[1].toLowerCase();
      return { src: imageStore.get(cid) || imageStore.get(cid.split('@')[0]), name: m[1].split('@')[0] };
    }
    if ((m = /^\[img:([^\]]+)\]$/i.exec(marker))) {
      const src = m[1];
      return { src: /^(?:https?:|data:image\/)/i.test(src) ? src : '', name: src.split(/[/?#]/).filter(Boolean).pop() || '' };
    }
    if ((m = /^\[image:\s*([^\]]*)\]$/i.exec(marker))) return { src: imageStore.get(m[1].trim().toLowerCase()), name: m[1].trim() };
    if ((m = /^<([^>]+)>$/.exec(marker))) return { src: imageStore.get(m[1].toLowerCase()), name: m[1] };
    return { src: '', name: marker };
  }

  function imageHtml(marker, lang) {
    const info = markerInfo(marker);
    if (info.src) {
      return '<img src="' + esc(info.src) + '" alt="' + esc(info.name) + '" style="display:inline-block;vertical-align:bottom;max-width:100%;max-height:420px;margin:4px 0;border:1px solid #e3e6ea;">';
    }
    const label = lang === 'ru' ? 'Изображение' : 'Image';
    return '<span style="color:#6b7280;font-style:italic;">[' + label + (info.name ? ': ' + esc(info.name) : '') + ']</span>';
  }

  // Строка текста письма: экранируем текст, картинки показываем как картинки
  function lineHtml(line, lang) {
    let out = '';
    let last = 0;
    IMAGE_RE.lastIndex = 0;
    let m;
    while ((m = IMAGE_RE.exec(line))) {
      out += esc(line.slice(last, m.index)) + imageHtml(m[0], lang);
      last = m.index + m[0].length;
    }
    return out + esc(line.slice(last));
  }

  function linesHtml(lines, lang) {
    return lines.map((l) => lineHtml(l, lang)).join('<br>');
  }

  // ---------- Время между письмами ----------
  function gapRowHtml(a, b, cols) {
    const gap = elapsedBetween(a, b);
    if (!gap) return '';
    return '<tr><td colspan="' + cols + '" style="padding:6px 14px;background:#f1f3f5;color:#495057;text-align:center;' +
      'font-size:13px;border-top:1px solid #e3e6ea;">' +
      'Time between messages: <b>' + esc(gap.en) + '</b>' + (gap.night ? ' (including night)' : '') +
      ' &nbsp;/&nbsp; Между письмами прошло: <b>' + esc(gap.ru) + '</b>' + (gap.night ? ' (включая ночь)' : '') +
      '</td></tr>';
  }

  // pasteMode: вставка из буфера — надпись для коллег и только колонка перевода
  function buildHtml(messages, translations, colorMap, pasteMode) {
    const cols = pasteMode ? 1 : 2;
    const rows = messages.map((msg, i) => {
      const color = colorFor(msg, colorMap);
      const tr = translations ? translations[i] : null;
      const leftHeader = headerHtml(msg, dateLine(msg, tr, ''), '');
      const rightHeader = headerHtml(msg, dateLine(msg, tr, msg.target), msg.target);
      let rightBody;
      if (!tr) rightBody = '<span class="pending">Перевод…</span>';
      else if (tr.error) rightBody = '<span style="color:#b3261e">' + esc(tr.error) + '</span>';
      else rightBody = linesHtml(tr.lines, msg.target);
      rightBody += attachmentsHtml(msg.attachments, msg.target);
      const sep = i > 0 ? 'border-top:1px solid #e3e6ea;' : '';
      return (i > 0 ? gapRowHtml(messages[i - 1], msg, cols) : '') + '<tr>' +
        (pasteMode ? '' : cellHtml(color, leftHeader, linesHtml(msg.lines, '') +
          attachmentsHtml(msg.attachments, msg.target === 'en' ? 'ru' : 'en'), sep)) +
        cellHtml(color, rightHeader, rightBody, sep) +
        '</tr>';
    }).join('');

    return '<div style="font-family:Calibri,Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;color:#1c1e21;">' +
      (pasteMode ? '<p style="color:' + HEADER_GREEN + ';margin:0 0 14px;font-size:14px;">' +
        BANNER_LINES.map(esc).join('<br>') + '</p>' : '') +
      '<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;' + (pasteMode ? '' : 'min-width:640px;') + 'table-layout:fixed;">' +
      (pasteMode ? '' : '<colgroup><col style="width:50%"><col style="width:50%"></colgroup>') +
      '<tbody>' + rows + '</tbody></table></div>';
  }

  function renderLegend(messages, colorMap) {
    const seen = new Map();
    for (const msg of messages) {
      const key = senderKey(msg) || '__unknown';
      if (!seen.has(key)) seen.set(key, { msg, count: 0 });
      seen.get(key).count++;
    }
    els.legend.innerHTML = [...seen.values()].map(({ msg, count }) => {
      const label = msg.unknown || !senderKey(msg) ? 'Отправитель не определён'
        : (msg.name ? msg.name + (msg.email ? ' (' + msg.email + ')' : '') : msg.email);
      return '<span><i style="background:' + colorFor(msg, colorMap) + '"></i>' + esc(label) +
        ' — ' + count + '</span>';
    }).join('');
  }

  function render() {
    if (!current) return;
    const colorMap = loadColors();
    els.result.innerHTML = buildHtml(current.messages, current.translations, colorMap, current.mode === 'paste');
    renderLegend(current.messages, colorMap);
    saveColors(colorMap);
    els.result.hidden = false;
    els.placeholder.hidden = true;
  }

  function setStatus(text, isError) {
    els.status.textContent = text || '';
    els.status.classList.toggle('error', Boolean(isError));
  }

  // ---------- Основной сценарий ----------
  // Два режима работы:
  //  'paste' — текст вставлен из буфера обмена: переводятся только первые 2 письма,
  //            письмо без заголовка (ваш ответ) подписывается "Sergei Zakharov" и временем вставки,
  //            вверху — надпись для коллег из Haier Biomedical;
  //  'drop'  — «Переписка в читабельном виде»: переводится вся переписка, без надписи.
  let mode = 'paste';
  let pastedAt = new Date();
  const ME = { name: 'Sergei Zakharov', email: 'zsa@inpren.ru' };

  function setMode(m) {
    mode = m;
    if (m === 'paste') pastedAt = new Date();
  }

  const pad2 = (n) => String(n).padStart(2, '0');
  // 25.09.2026 8:23
  function formatStamp(d) {
    return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + d.getHours() + ':' + pad2(d.getMinutes());
  }

  async function processText() {
    const text = els.source.value;
    const id = ++runId;
    if (!text.trim()) {
      current = null;
      els.result.hidden = true;
      els.legend.innerHTML = '';
      els.copy.disabled = true;
      setStatus('Нет текста для обработки.', true);
      return;
    }
    const all = parseThread(text, { stripSignatures: els.stripSig.checked }).filter((m) => m.lines.length || !m.unknown);
    if (mode === 'paste' && all.length && all[0].unknown) {
      // Текст без заголовка вверху — это ваш ответ
      const me = all[0];
      me.unknown = false;
      me.name = ME.name;
      me.email = ME.email;
      me.dateRaw = formatStamp(pastedAt);
      me.date = { y: pastedAt.getFullYear(), m: pastedAt.getMonth() + 1, d: pastedAt.getDate(), hh: pastedAt.getHours(), mm: pastedAt.getMinutes() };
    }
    // Вложения перетащенного письма — к первому письму этого отправителя (это само письмо, остальные — цитаты)
    for (const d of dropAttachments) {
      const m = all.find((x) => !x.attachments && ((d.email && x.email === d.email) || (!d.email && d.name && x.name === d.name)));
      if (m) m.attachments = d.atts;
    }
    const messages = mode === 'paste' ? all.slice(0, 2) : all;
    for (const msg of messages) {
      const body = msg.lines.join('\n').replace(IMAGE_RE, ' ');
      msg.target = body.trim() && isMostlyRussian(body) ? 'en' : 'ru';
    }
    if (!messages.length) {
      setStatus('Не удалось найти письма в тексте.', true);
      return;
    }
    current = { messages, translations: null, mode };
    els.copy.disabled = false;
    const senders = new Set(messages.map((m) => senderKey(m) || '?')).size;
    const summary = (messages.length < all.length
      ? 'Показаны первые ' + messages.length + ' письма из ' + all.length
      : 'Писем: ' + messages.length) + '. Отправителей: ' + senders + '.';
    setStatus(summary + ' Перевожу…');
    render();

    // Русские письма переводим на английский, остальные — на русский.
    // Имена и фамилии не переводим (при переводе на русский) — заменяем их метками.
    const names = collectNames(all.flatMap((m) => [m, ...(m.recipients || [])]));
    const queues = { ru: [], en: [] };
    const jobs = messages.map((msg) => {
      const job = { body: -1, date: null, names: [], images: [] };
      const body = msg.lines.join('\n');
      if (body) {
        // Картинки не отправляем в перевод — заменяем метками
        const img = protectImages(body, IMAGE_MARKER_SRC);
        job.images = img.images;
        let text = img.text;
        if (msg.target === 'ru') {
          const prot = protectNames(text, names);
          job.names = prot.names;
          text = prot.text;
        }
        job.body = queues[msg.target].push(text) - 1;
      }
      if (!msg.date && msg.dateRaw) {
        const t = isMostlyRussian(msg.dateRaw) ? 'en' : 'ru';
        job.date = { target: t, idx: queues[t].push(msg.dateRaw) - 1 };
      }
      return job;
    });

    try {
      const [outRu, outEn] = await Promise.all([translateAll(queues.ru, 'ru'), translateAll(queues.en, 'en')]);
      if (id !== runId) return;
      const out = { ru: outRu, en: outEn };
      current.translations = messages.map((msg, i) => {
        const job = jobs[i];
        const lines = job.body >= 0
          ? restoreImages(restoreNames(out[msg.target][job.body], job.names), job.images).split('\n')
            .map((l) => applyGlossary(l.trim(), msg.target)).filter(Boolean)
          : [];
        return { lines, date: job.date ? out[job.date.target][job.date.idx].trim() : '' };
      });
      setStatus(summary + ' Перевод готов.');
    } catch (e) {
      if (id !== runId) return;
      current.translations = messages.map(() => ({ error: 'Перевод недоступен: ' + e.message }));
      setStatus(summary + ' Ошибка перевода: ' + e.message, true);
    }
    render();
  }

  async function readClipboardAndProcess() {
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) throw new Error('unsupported');
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setStatus('Буфер обмена пуст.', true);
        return;
      }
      imageStore.clear();
      dropAttachments = [];
      els.source.value = text;
      processText();
    } catch (e) {
      setStatus('Браузер не дал доступ к буферу обмена. Нажмите Ctrl+V в любом месте страницы.', true);
    }
  }

  function plainText() {
    const out = current.mode === 'paste' ? [BANNER_LINES.join('\n'), ''] : [];
    current.messages.forEach((msg, i) => {
      const tr = current.translations && current.translations[i];
      const gap = i > 0 && elapsedBetween(current.messages[i - 1], msg);
      if (gap) {
        out.push('--- Time between messages: ' + gap.en + (gap.night ? ' (including night)' : '') +
          ' / Между письмами прошло: ' + gap.ru + (gap.night ? ' (включая ночь)' : '') + ' ---', '');
      }
      const head = (lang) => {
        const d = dateLine(msg, tr, lang);
        return ((lang && msg.name ? applyGlossary(msg.name, lang) : msg.name) || msg.email || 'Отправитель не определён') +
          (d ? ', ' + d : '');
      };
      const attLine = (lang) => msg.attachments && msg.attachments.length
        ? [(lang === 'ru' ? 'Вложение в письмо: ' : 'Attachment to the email: ') + msg.attachments.map((a) => a.name).join(', ')] : [];
      if (current.mode !== 'paste') out.push(head(''), ...msg.lines, ...attLine(msg.target === 'en' ? 'ru' : 'en'), '');
      if (tr && tr.lines) out.push(head(msg.target), ...tr.lines, ...attLine(msg.target), '');
    });
    return out.join('\n');
  }

  async function copyResult() {
    if (!current) return;
    const html = buildHtml(current.messages, current.translations, loadColors(), current.mode === 'paste');
    const text = plainText();
    try {
      if (window.ClipboardItem && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' })
        })]);
      } else {
        throw new Error('fallback');
      }
    } catch {
      // Запасной вариант: выделяем результат и копируем через execCommand
      const range = document.createRange();
      range.selectNodeContents(els.result);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const ok = document.execCommand('copy');
      sel.removeAllRanges();
      if (!ok) { setStatus('Не удалось скопировать. Выделите результат и нажмите Ctrl+C.', true); return; }
    }
    setStatus('Результат скопирован — его можно вставить в письмо с сохранением цветов.');
  }

  // ---------- Файлы писем ----------
  // Разбор письма (.eml): картинки и вложения запоминаются, возвращается текст
  function mailFileToText(name, bytes) {
    const mail = window.MailFile.fileToMail(name, bytes);
    registerImages(mail.images);
    const atts = findAttachments(mail);
    if (atts.length) dropAttachments.push({ email: (mail.fromEmail || '').toLowerCase(), name: mail.fromName, atts });
    return mail.text;
  }

  els.paste.addEventListener('click', pasteFromClipboard);
  els.copy.addEventListener('click', copyResult);
  els.stripSig.addEventListener('change', () => { if (els.source.value.trim()) processText(); });
  // Ctrl+V в любом месте страницы — текст из буфера обмена, как кнопка «для Haier в почту»
  document.addEventListener('paste', (e) => {
    // Вставка в поля ввода (например, в окне «Почта») — обычная
    if (e.target && e.target.closest && e.target.closest('input, select, dialog')) return;
    const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    if (!text.trim()) return;
    e.preventDefault();
    setMode('paste');
    imageStore.clear();
    dropAttachments = [];
    els.source.value = text;
    processText();
  });

  // ---------- Окно «Почта» (IMAP): письма прямо из почтового ящика ----------
  const mailEls = {
    logout: $('mailLogout'), account: $('mailAccount'), thread: $('threadBtn'),
    login: $('mailLogin'), user: $('mailUser'), password: $('mailPassword'), host: $('mailHost'),
    browser: $('mailBrowser'), folder: $('mailFolder'), search: $('mailSearch'), refresh: $('mailRefresh'),
    list: $('mailList'), more: $('mailMore')
  };
  const MAIL_USER_KEY = 'mailThread.mailUser';
  // Пароль хранится только в памяти страницы — до перезагрузки
  let mailCreds = null;
  let mailOldest = 0;
  let mailRun = 0;
  let mailSelected = null; // { folder, uid, subject } — выделенное письмо
  const rawCache = new Map(); // последние загруженные письма

  const FOLDER_NAMES = { inbox: 'Входящие', sent: 'Отправленные', 'sent items': 'Отправленные', 'sent messages': 'Отправленные',
    drafts: 'Черновики', trash: 'Корзина', 'deleted items': 'Корзина', 'deleted messages': 'Корзина',
    junk: 'Спам', spam: 'Спам', archive: 'Архив', outbox: 'Исходящие' };
  const FOLDER_FLAGS = [['\\Sent', 'Отправленные'], ['\\Drafts', 'Черновики'], ['\\Trash', 'Корзина'], ['\\Junk', 'Спам'], ['\\Archive', 'Архив']];

  function folderLabel(f) {
    const parts = f.name.split(/[./]/);
    const last = parts[parts.length - 1];
    const known = FOLDER_NAMES[last.toLowerCase()] || (FOLDER_FLAGS.find(([flag]) => (f.flags || '').includes(flag)) || [])[1];
    const prefix = parts.length > 1 && parts[0].toUpperCase() === 'INBOX' ? parts.slice(1, -1) : parts.slice(0, -1);
    return prefix.concat(known || last).join(' / ');
  }

  function folderOrder(f) {
    const i = ['Входящие', 'Отправленные', 'Черновики', 'Спам', 'Корзина'].indexOf(folderLabel(f));
    return i < 0 ? 10 : i;
  }

  // Date / ISO -> "25.09.2026 8:05" по Москве (UTC+3)
  function moscowStamp(date) {
    if (!date) return '';
    const t = new Date(new Date(date).getTime() + 180 * 60000);
    return pad2(t.getUTCDate()) + '.' + pad2(t.getUTCMonth() + 1) + '.' + t.getUTCFullYear() + ' ' + t.getUTCHours() + ':' + pad2(t.getUTCMinutes());
  }

  async function mailApi(action, params) {
    const res = await fetch('api/mail/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, mailCreds, params))
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Ошибка сервера ' + res.status);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function showMailLogin(focus) {
    mailCreds = null;
    selectMail(null);
    mailEls.login.hidden = false;
    mailEls.browser.hidden = true;
    mailEls.logout.hidden = true;
    mailEls.account.textContent = '';
    mailEls.list.innerHTML = '';
    mailEls.password.value = '';
    if (focus) (mailEls.user.value ? mailEls.password : mailEls.user).focus();
  }

  async function mailLogin(e) {
    e.preventDefault();
    mailCreds = { user: mailEls.user.value.trim(), password: mailEls.password.value };
    setStatus('Вход в почту…');
    try {
      const { folders } = await mailApi('folders');
      try { localStorage.setItem(MAIL_USER_KEY, mailCreds.user); } catch { /* недоступно */ }
      folders.sort((a, b) => folderOrder(a) - folderOrder(b));
      mailEls.folder.innerHTML = folders.map((f) =>
        '<option value="' + esc(f.path) + '">' + esc(folderLabel(f)) + '</option>').join('');
      mailEls.login.hidden = true;
      mailEls.browser.hidden = false;
      mailEls.logout.hidden = false;
      mailEls.account.textContent = mailCreds.user;
      mailEls.password.value = '';
      loadMailList(false);
    } catch (err) {
      mailCreds = null;
      setStatus(err.message, true);
    }
  }

  function mailItemHtml(m) {
    const from = m.fromName || m.fromEmail || '(без отправителя)';
    return '<li><button type="button" class="mail-item" role="option" aria-selected="false" data-uid="' + m.uid + '" title="' +
      esc(from + (m.fromEmail && m.fromName ? ' <' + m.fromEmail + '>' : '') + '\n' + (m.subject || '')) + '">' +
      '<span class="mail-from">' + esc(from) + '</span>' +
      '<span class="mail-date">' + esc(moscowStamp(m.date)) + '</span>' +
      '<span class="mail-subject">' + esc(m.subject || '(без темы)') + '</span></button></li>';
  }

  async function loadMailList(append) {
    const id = ++mailRun;
    if (!append) { mailEls.list.innerHTML = ''; mailOldest = 0; selectMail(null); }
    mailEls.more.hidden = true;
    setStatus('Загрузка списка писем…');
    try {
      const data = await mailApi('list', { folder: mailEls.folder.value, query: mailEls.search.value.trim(), before: append ? mailOldest : 0 });
      if (id !== mailRun) return;
      mailEls.list.insertAdjacentHTML('beforeend', data.messages.map(mailItemHtml).join(''));
      if (data.messages.length) mailOldest = data.messages[data.messages.length - 1].uid;
      mailEls.more.hidden = !data.more;
      setStatus(mailEls.list.children.length ? '' : 'Писем нет.');
    } catch (err) {
      if (id !== mailRun) return;
      if (err.status === 401) showMailLogin(false);
      setStatus(err.message, true);
    }
  }

  // Выделение письма (одиночный щелчок)
  function selectMail(item) {
    for (const el of mailEls.list.querySelectorAll('.mail-item.selected')) {
      el.classList.remove('selected');
      el.setAttribute('aria-selected', 'false');
    }
    mailSelected = null;
    if (!item) return;
    item.classList.add('selected');
    item.setAttribute('aria-selected', 'true');
    mailSelected = { folder: mailEls.folder.value, uid: Number(item.dataset.uid), subject: item.querySelector('.mail-subject').textContent };
  }

  async function fetchMailBytes(sel) {
    const key = sel.folder + '\u0000' + sel.uid;
    if (rawCache.has(key)) return rawCache.get(key);
    const { raw } = await mailApi('message', { folder: sel.folder, uid: sel.uid });
    const bin = atob(raw);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    rawCache.set(key, bytes);
    if (rawCache.size > 5) rawCache.delete(rawCache.keys().next().value);
    return bytes;
  }

  // Выделенное письмо -> переписка: 'paste' — как вставка из буфера (для Haier), 'drop' — вся переписка
  async function processMailMessage(sel, m) {
    setStatus('Загрузка письма…');
    try {
      const bytes = await fetchMailBytes(sel);
      imageStore.clear();
      dropAttachments = [];
      els.source.value = mailFileToText('message.eml', bytes);
      setMode(m);
      processText();
    } catch (err) {
      if (err.status === 401) showMailLogin(true);
      setStatus('Не удалось открыть письмо: ' + err.message, true);
    }
  }

  // ---------- Отдельное окно: письмо целиком с вложениями ----------
  function formatSize(n) {
    if (n < 1024) return n + ' Б';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' КБ';
    return (n / 1024 / 1024).toFixed(1).replace('.', ',') + ' МБ';
  }

  function viewerHtml(mail) {
    const images = mail.images || [];
    const html = mail.html || '';
    const cidUrl = new Map();
    for (const img of images) {
      if (img.cid && BROWSER_IMAGE.test(img.mime)) cidUrl.set(img.cid.toLowerCase(), 'data:' + img.mime + ';base64,' + bytesToBase64(img.bytes));
    }
    // Картинки, стоящие в тексте письма (cid:), показываются в тексте; остальные — во вложениях
    const usedCids = new Set();
    let bodyDoc = '';
    if (html) {
      const fixed = html.replace(/cid:([^"'\s>)]+)/gi, (m0, cid) => {
        const url = cidUrl.get(cid.toLowerCase());
        if (!url) return m0;
        usedCids.add(cid.toLowerCase());
        return url;
      });
      bodyDoc = '<!doctype html><html><head><meta charset="utf-8">' +
        '<meta http-equiv="Content-Security-Policy" content="script-src \'none\'; object-src \'none\'; frame-src \'none\'">' +
        '<base target="_blank"><style>body{margin:12px 16px;font:14px/1.45 Calibri,Arial,sans-serif;}img{max-width:100%;height:auto;}</style></head>' +
        '<body>' + fixed + '</body></html>';
    }
    const attachments = images.filter((img) => !img.cid || !usedCids.has(img.cid.toLowerCase())).concat(mail.files || []);
    const attHtml = attachments.map((a) => {
      const url = URL.createObjectURL(new Blob([a.bytes], { type: a.mime || 'application/octet-stream' }));
      const name = a.name || 'attachment';
      const preview = BROWSER_IMAGE.test(a.mime || '') ? '<img src="' + url + '" alt="">' : '';
      return '<li><a href="' + url + '" download="' + esc(name) + '">' + preview + '<span>📎 ' + esc(name) +
        ' <small>(' + formatSize(a.bytes.length) + ')</small></span></a></li>';
    }).join('');
    const row = (label, value) => value ? '<tr><th>' + label + '</th><td>' + esc(value) + '</td></tr>' : '';
    const from = mail.fromName && mail.fromEmail ? mail.fromName + ' <' + mail.fromEmail + '>' : (mail.fromName || mail.fromEmail);
    return '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>' + esc(mail.subject || 'Письмо') + '</title>' +
      '<link rel="icon" href="' + new URL('favicon.svg', location.href).href + '">' +
      '<style>' +
      'html,body{height:100%;margin:0}body{display:flex;flex-direction:column;font:14px/1.45 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#1d2126;background:#eef0f2}' +
      'header{padding:12px 18px;background:#fff;border-top:4px solid #f47a00;border-bottom:1px solid #dde0e4}' +
      'h1{margin:0 0 8px;font-size:19px}table{border-collapse:collapse}th{text-align:left;color:#4a525c;font-weight:normal;padding:1px 12px 1px 0;vertical-align:top;white-space:nowrap}td{padding:1px 0;word-break:break-word}' +
      '.body{flex:1;min-height:200px;margin:12px 18px;background:#fff;border:1px solid #dde0e4;border-radius:6px;overflow:auto}' +
      'iframe{width:100%;height:100%;border:0;display:block}pre{margin:0;padding:12px 16px;white-space:pre-wrap;word-break:break-word;font:14px/1.45 Calibri,Arial,sans-serif}' +
      '.att{margin:0 18px 14px}.att h2{font-size:15px;margin:0 0 6px}.att ul{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:8px}' +
      '.att a{display:flex;flex-direction:column;gap:4px;padding:6px 10px;background:#fff;border:1px solid #c7cbd0;border-radius:6px;color:#1d2126;text-decoration:none;max-width:260px}' +
      '.att a:hover{border-color:#f47a00}.att img{max-width:240px;max-height:160px;object-fit:contain}small{color:#4a525c}' +
      '</style></head><body>' +
      '<header><h1>' + esc(mail.subject || '(без темы)') + '</h1><table>' +
      row('От:', from) + row('Кому:', mail.to) + row('Копия:', mail.cc) +
      row('Дата:', mail.date ? moscowStamp(mail.date) + ' (время по Москве)' : '') +
      '</table></header>' +
      '<div class="body">' + (html
        ? '<iframe sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc="' + esc(bodyDoc) + '"></iframe>'
        : '<pre>' + esc(mail.plain !== undefined ? mail.plain : mail.body) + '</pre>') + '</div>' +
      (attHtml ? '<section class="att"><h2>Вложения (' + attachments.length + ')</h2><ul>' + attHtml + '</ul></section>' : '') +
      '</body></html>';
  }

  async function openMailViewer(sel) {
    const win = window.open('', '_blank');
    if (!win) {
      setStatus('Браузер заблокировал новое окно. Разрешите всплывающие окна для этого сайта.', true);
      return;
    }
    win.document.write('<!doctype html><meta charset="utf-8"><title>' + esc(sel.subject || 'Письмо') + '</title>' +
      '<p style="font:15px Arial,sans-serif;color:#4a525c;padding:20px">Загрузка письма…</p>');
    win.document.close();
    try {
      const mail = window.MailFile.parseEml(await fetchMailBytes(sel));
      win.document.open();
      win.document.write(viewerHtml(mail));
      win.document.close();
    } catch (err) {
      if (err.status === 401) showMailLogin(true);
      win.document.body.textContent = 'Не удалось открыть письмо: ' + err.message;
    }
  }

  // «для Haier в почту»: выделенное письмо — как вставка из буфера; иначе — текст из буфера обмена
  async function pasteFromClipboard() {
    if (mailSelected) return processMailMessage(mailSelected, 'paste');
    setMode('paste');
    await readClipboardAndProcess();
  }

  let searchTimer = 0;
  mailEls.logout.addEventListener('click', () => { setStatus(''); showMailLogin(true); });
  mailEls.login.addEventListener('submit', mailLogin);
  mailEls.folder.addEventListener('change', () => loadMailList(false));
  mailEls.refresh.addEventListener('click', () => loadMailList(false));
  mailEls.more.addEventListener('click', () => loadMailList(true));
  mailEls.search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadMailList(false), 500); });
  mailEls.list.addEventListener('click', (e) => {
    const item = e.target.closest('.mail-item');
    if (item) selectMail(item);
  });
  mailEls.list.addEventListener('dblclick', (e) => {
    const item = e.target.closest('.mail-item');
    if (!item) return;
    selectMail(item);
    openMailViewer(mailSelected);
  });
  // Стрелки — выбор письма, Enter — открыть целиком
  mailEls.list.addEventListener('keydown', (e) => {
    const item = e.target.closest('.mail-item');
    if (!item) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const li = e.key === 'ArrowDown' ? item.parentElement.nextElementSibling : item.parentElement.previousElementSibling;
      const next = li && li.querySelector('.mail-item');
      if (next) { next.focus(); selectMail(next); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      selectMail(item);
      openMailViewer(mailSelected);
    }
  });
  mailEls.thread.addEventListener('click', () => {
    if (!mailSelected) {
      setStatus(mailCreds ? 'Выделите письмо в списке.' : 'Войдите в почту и выделите письмо в списке.', true);
      return;
    }
    processMailMessage(mailSelected, 'drop');
  });

  try { mailEls.user.value = localStorage.getItem(MAIL_USER_KEY) || ''; } catch { /* недоступно */ }
  getConfig().then((cfg) => { mailEls.host.textContent = cfg.mailHost || ''; });
})();
