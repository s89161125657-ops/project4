(function () {
  'use strict';

  const { parseThread, formatDateRu, elapsedBetween, formatMoscow, IMAGE_MARKER_SRC } = window.MailParser;
  const { translateText, isMostlyRussian, applyGlossary, collectNames, protectNames, restoreNames,
    protectImages, restoreImages } = window.TranslateCore;

  const HEADER_GREEN = '#006400';
  const NAVY = '#000080';
  const UNKNOWN_COLOR = '#616161';
  const BROWN = '#8b4513';
  // Постоянные цвета: письма zsa@inpren.ru — тёмно-синие, письма Cui — коричневые
  function fixedColor(msg) {
    const email = (msg.email || '').toLowerCase();
    const name = msg.name || '';
    if (email === 'zsa@inpren.ru') return NAVY;
    if (/(?:^|[._-])cui(?:[._@-]|baozhen)|^cui/.test(email) || /(?:^|\s)Cui(?:\s|$)|崔保振/.test(name)) return BROWN;
    return null;
  }
  // Палитра для остальных отправителей: яркие, хорошо различимые цвета
  // (без тёмно-синего, коричневого и тёмно-зелёного — они заняты)
  const PALETTE = ['#d50000', '#7b1fa2', '#00897b', '#e65100', '#c51162', '#1565c0',
    '#558b2f', '#6d4c9f', '#ad1457', '#37474f'];
  const COLORS_KEY = 'mailThread.senderColors.v2';

  const BANNER_LINES = [
    'Ниже изложен перевод переписки для коллег из Haier Biomedical:',
    'Translation of the above text, made using Google Translate (only for information for colleagues from Haier Biomedical):'
  ];

  const $ = (id) => document.getElementById(id);
  const els = {
    paste: $('pasteBtn'), copy: $('copyBtn'),
    stripSig: $('stripSig'), drop: $('dropZone'), placeholder: $('placeholder'), file: $('fileInput'), source: $('source'), sourceBox: $('sourceBox'),
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
      const sep = i > 0 ? 'border-top:1px solid #e3e6ea;' : '';
      return (i > 0 ? gapRowHtml(messages[i - 1], msg, cols) : '') + '<tr>' +
        (pasteMode ? '' : cellHtml(color, leftHeader, linesHtml(msg.lines, ''), sep)) +
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
  //  'drop'  — письмо перетащено из Outlook: переводится вся переписка, без надписи.
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
    setMode('paste');
    await readClipboardAndProcess();
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
      if (current.mode !== 'paste') out.push(head(''), ...msg.lines, '');
      if (tr && tr.lines) out.push(head(msg.target), ...tr.lines, '');
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
      setMode('drop');
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
  els.copy.addEventListener('click', copyResult);
  els.stripSig.addEventListener('change', () => { if (els.source.value.trim()) processText(); });
  els.source.addEventListener('paste', () => setTimeout(() => { setMode('paste'); imageStore.clear(); processText(); }, 0));
})();
