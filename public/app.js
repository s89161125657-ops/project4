(function () {
  'use strict';

  const { parseThread, formatDateRu, formatElapsed, IMAGE_MARKER_SRC } = window.MailParser;
  const { translateText, isMostlyRussian, applyGlossary, collectNames, protectNames, restoreNames,
    protectImages, restoreImages } = window.TranslateCore;

  const HEADER_GREEN = '#006400';
  const NAVY = '#000080';
  const UNKNOWN_COLOR = '#616161';
  // Фиксированные цвета для конкретных адресов
  const FIXED_COLORS = { 'zsa@inpren.ru': NAVY };
  // Палитра для остальных отправителей (без тёмно-синего и тёмно-зелёного)
  const PALETTE = ['#b71c1c', '#6a1b9a', '#e65100', '#00838f', '#ad1457', '#4e342e',
    '#827717', '#0277bd', '#37474f', '#9e6a00', '#4527a0', '#c62828'];
  const COLORS_KEY = 'mailThread.senderColors.v1';

  const BANNER_LINES = [
    'Ниже изложен перевод переписки для коллег из Haier Biomedical:',
    'Translation of the above text, made using Google Translate (only for information for colleagues from Haier Biomedical):'
  ];

  const $ = (id) => document.getElementById(id);
  const els = {
    paste: $('pasteBtn'), copy: $('copyBtn'),
    stripSig: $('stripSig'), last2: $('last2Btn'), drop: $('dropZone'), file: $('fileInput'), source: $('source'), sourceBox: $('sourceBox'),
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
    if (FIXED_COLORS[key]) return FIXED_COLORS[key];
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

  function cellHtml(color, header, bodyHtml, extraStyle) {
    return '<td style="vertical-align:top;width:50%;padding:10px 14px 14px;' +
      'border-left:4px solid ' + color + ';color:' + color + ';word-wrap:break-word;overflow-wrap:anywhere;' +
      (extraStyle || '') + '">' +
      '<div style="margin:0 0 6px;font-size:14px;">' + header + '</div>' +
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
  function gapRowHtml(a, b) {
    const gap = formatElapsed(a.date, b.date);
    if (!gap) return '';
    return '<tr><td colspan="2" style="padding:6px 14px;background:#f1f3f5;color:#495057;text-align:center;' +
      'font-size:13px;border-top:1px solid #e3e6ea;">' +
      '&#9201; Между письмами прошло: <b>' + esc(gap.ru) + '</b> &nbsp;/&nbsp; Time between messages: <b>' + esc(gap.en) + '</b>' +
      '</td></tr>';
  }

  function buildHtml(messages, translations, colorMap) {
    const rows = messages.map((msg, i) => {
      const color = colorFor(msg, colorMap);
      const tr = translations ? translations[i] : null;
      const leftHeader = headerHtml(msg, msg.dateRaw || formatDateRu(msg.date), '');
      const ruDate = msg.date ? formatDateRu(msg.date) : (tr && tr.date) || msg.dateRaw;
      const rightHeader = headerHtml(msg, ruDate, msg.target);
      let rightBody;
      if (!tr) rightBody = '<span class="pending">Перевод…</span>';
      else if (tr.error) rightBody = '<span style="color:#b3261e">' + esc(tr.error) + '</span>';
      else rightBody = linesHtml(tr.lines, msg.target);
      const sep = i > 0 ? 'border-top:1px solid #e3e6ea;' : '';
      return (i > 0 ? gapRowHtml(messages[i - 1], msg) : '') + '<tr>' +
        cellHtml(color, leftHeader, linesHtml(msg.lines, ''), sep) +
        cellHtml(color, rightHeader, rightBody, sep + 'border-left-width:4px;') +
        '</tr>';
    }).join('');

    return '<div style="font-family:Calibri,Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;color:#1c1e21;">' +
      '<p style="color:' + HEADER_GREEN + ';font-weight:bold;margin:0 0 14px;font-size:14px;">' +
      BANNER_LINES.map(esc).join('<br>') + '</p>' +
      '<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;min-width:640px;table-layout:fixed;">' +
      '<colgroup><col style="width:50%"><col style="width:50%"></colgroup>' +
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
    els.result.innerHTML = buildHtml(current.messages, current.translations, colorMap);
    renderLegend(current.messages, colorMap);
    saveColors(colorMap);
    els.result.hidden = false;
  }

  function setStatus(text, isError) {
    els.status.textContent = text || '';
    els.status.classList.toggle('error', Boolean(isError));
  }

  // ---------- Основной сценарий ----------
  // Сколько последних писем показывать и переводить (0 — все)
  let onlyLast = 0;

  // n самых свежих писем: по датам, если они есть у всех, иначе первые n
  // (почтовые клиенты ставят новые письма в начало цепочки). Порядок сохраняется.
  function pickLatest(messages, n) {
    if (!n || messages.length <= n) return messages;
    const ts = (m) => m.date ? Date.UTC(m.date.y, m.date.m - 1, m.date.d, m.date.hh || 0, m.date.mm || 0) : null;
    if (messages.every((m) => ts(m) !== null)) {
      const top = messages.map((m, i) => ({ i, t: ts(m) }))
        .sort((a, b) => b.t - a.t || a.i - b.i)
        .slice(0, n)
        .map((x) => x.i)
        .sort((a, b) => a - b);
      return top.map((i) => messages[i]);
    }
    return messages.slice(0, n);
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
    const messages = pickLatest(all, onlyLast);
    for (const msg of messages) {
      const body = msg.lines.join('\n').replace(IMAGE_RE, ' ');
      msg.target = body.trim() && isMostlyRussian(body) ? 'en' : 'ru';
    }
    if (!messages.length) {
      setStatus('Не удалось найти письма в тексте.', true);
      return;
    }
    current = { messages, translations: null };
    els.copy.disabled = false;
    const senders = new Set(messages.map((m) => senderKey(m) || '?')).size;
    const summary = (messages.length < all.length
      ? 'Показаны ' + messages.length + ' последних письма из ' + all.length
      : 'Писем: ' + messages.length) + ', отправителей: ' + senders + '.';
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

  async function pasteFromClipboard() {
    onlyLast = 0;
    await readClipboardAndProcess();
  }

  // Перевести только 2 последних письма: берём текст из поля, а если оно пустое — из буфера обмена
  async function translateLastTwo() {
    onlyLast = 2;
    if (els.source.value.trim()) processText();
    else await readClipboardAndProcess();
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
      els.source.value = text;
      processText();
    } catch (e) {
      els.sourceBox.open = true;
      els.source.focus();
      setStatus('Браузер не дал доступ к буферу обмена. Вставьте текст в поле «Исходный текст» сочетанием Ctrl+V.', true);
    }
  }

  function plainText() {
    const out = [BANNER_LINES.join('\n'), ''];
    current.messages.forEach((msg, i) => {
      const tr = current.translations && current.translations[i];
      const gap = i > 0 && formatElapsed(current.messages[i - 1].date, msg.date);
      if (gap) out.push('--- Между письмами прошло: ' + gap.ru + ' / Time between messages: ' + gap.en + ' ---', '');
      const head = (d, lang) => ((lang && msg.name ? applyGlossary(msg.name, lang) : msg.name) || msg.email || 'Отправитель не определён') +
        (d ? ', ' + d : '');
      out.push(head(msg.dateRaw), ...msg.lines, '');
      if (tr && tr.lines) out.push(head(msg.date ? formatDateRu(msg.date) : tr.date || msg.dateRaw, msg.target), ...tr.lines, '');
    });
    return out.join('\n');
  }

  async function copyResult() {
    if (!current) return;
    const html = buildHtml(current.messages, current.translations, loadColors());
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

  // ---------- Перетаскивание письма из Outlook ----------
  async function filesToText(files) {
    const parts = [];
    for (const f of files) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const mail = window.MailFile.fileToMail(f.name, bytes);
      registerImages(mail.images);
      parts.push(mail.text);
    }
    return parts.join('\n\n');
  }

  async function handleDrop(dt) {
    try {
      let text = '';
      imageStore.clear();
      if (dt.files && dt.files.length) {
        text = await filesToText([...dt.files]);
      } else {
        text = dt.getData('text/plain');
        if (!text.trim()) {
          const html = dt.getData('text/html');
          if (html) text = window.MailFile.htmlToText(html);
        }
      }
      if (!text.trim()) {
        setStatus('Не удалось получить письмо. Сохраните его в Outlook как файл (.msg) и перетащите файл сюда, либо скопируйте текст (Ctrl+A, Ctrl+C).', true);
        return;
      }
      els.source.value = text;
      onlyLast = 0;
      processText();
    } catch (e) {
      setStatus('Не удалось прочитать письмо: ' + e.message, true);
    }
  }

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; els.drop.classList.add('over'); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; els.drop.classList.remove('over'); } });
  window.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('drop', (e) => {
    // Письмо можно бросить в любое место страницы
    e.preventDefault();
    dragDepth = 0;
    els.drop.classList.remove('over');
    handleDrop(e.dataTransfer);
  });
  els.drop.addEventListener('click', () => els.file.click());
  els.drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.file.click(); } });
  els.file.addEventListener('change', async () => {
    if (!els.file.files.length) return;
    await handleDrop({ files: els.file.files });
    els.file.value = '';
  });

  els.paste.addEventListener('click', pasteFromClipboard);
  els.last2.addEventListener('click', translateLastTwo);
  els.copy.addEventListener('click', copyResult);
  els.stripSig.addEventListener('change', () => { if (els.source.value.trim()) processText(); });
  els.source.addEventListener('paste', () => setTimeout(() => { onlyLast = 0; imageStore.clear(); processText(); }, 0));
})();
