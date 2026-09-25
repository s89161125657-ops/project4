/*
 * «ИИ-Телеграм» — панель поверх Telegram Web (web.telegram.org, версии /k/ и /a/).
 *
 *  - «переписка в читабельном виде» — сообщения открытого чата: имя, дата, текст и перевод
 *    (иностранные языки — на русский, русский — на английский), с цветами отправителей;
 *  - «копировать результат» — с цветами, для вставки в письмо Outlook;
 *  - «перевести мой ответ» — текст из поля ввода Telegram переводится и вставляется обратно
 *    (отправляете вы сами); «вернуть исходный текст» — отмена;
 *  - «переводить сообщения прямо в чате» — перевод под каждым входящим сообщением на иностранном языке.
 *
 * Расширение только читает страницу и пишет в поле ввода — само ничего не отправляет.
 */
(() => {
  'use strict';

  const TC = self.TranslateCore;
  const HOST_ID = 'aitg-host';
  const INLINE_CLASS = 'aitg-inline';

  // После обновления расширения старая панель и переводы в чате остаются на странице — убираем их
  document.getElementById(HOST_ID)?.remove();
  document.querySelectorAll('.' + INLINE_CLASS).forEach((n) => n.remove());

  const alive = () => Boolean(globalThis.chrome && chrome.runtime && chrome.runtime.id);

  // ---------- настройки ----------

  const settings = {
    myName: 'Sergei Zakharov',
    replyLang: 'en',
    inline: false,
    limit: '50',
    view: 'both',
    open: false
  };

  function saveSettings() {
    if (alive()) chrome.storage.local.set(settings).catch(() => {});
  }

  // ---------- чтение сообщений со страницы ----------

  // То, что не является текстом сообщения: время, реакции, цитата, имя, кнопки и т.п.
  const NOT_TEXT = [
    '.' + INLINE_CLASS, '.time', '.reactions', '.reply', '.name', '.colored-name', '.bubble-name-forwarded',
    '.webpage', '.document-container', '.document-wrapper', '.audio', '.poll', '.contact', '.clearfix',
    '.MessageMeta', '.Reactions', '.message-title', '.EmbeddedMessage', '.WebPage', '.File', '.Audio',
    '.Poll', '.Contact', 'button', 'svg', 'canvas', 'video', 'style', 'script'
  ].join(',');

  function nodeText(el) {
    if (!el) return '';
    const c = el.cloneNode(true);
    c.querySelectorAll(NOT_TEXT).forEach((n) => n.remove());
    c.querySelectorAll('img').forEach((img) => img.replaceWith(img.alt || ''));
    c.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    c.querySelectorAll('div, p, blockquote, pre, li').forEach((b) => b.append('\n'));
    return c.textContent
      .replace(/ /g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }

  const textOf = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

  function lastVisible(nodes) {
    let found = null;
    for (const n of nodes) if (n.getClientRects().length) found = n;
    return found || nodes[nodes.length - 1] || null;
  }

  function mediaLabels(el) {
    const labels = [];
    const has = (sel) => el.querySelector(sel);
    if (has('.media-sticker-wrapper, .sticker-media, .AnimatedSticker, .StickerView')) labels.push('[Стикер]');
    else if (has('.media-round, .RoundVideo')) labels.push('[Видеосообщение]');
    else if (has('.media-video, .Video, video')) labels.push('[Видео]');
    else if (has('.media-photo, .Photo, .media-inner img')) labels.push('[Фото]');
    if (has('.audio.is-voice, .Audio.voice, .voice-message, .Audio .voice-waveform, .audio-waveform')) labels.push('[Голосовое сообщение]');
    for (const f of el.querySelectorAll('.document-name, .File .file-title')) {
      const name = textOf(f);
      if (name) labels.push('[Файл: ' + name + ']');
    }
    return labels;
  }

  // Telegram Web K (web.telegram.org/k/)
  const WEB_K = {
    container: () => lastVisible(document.querySelectorAll('.chat .bubbles-inner')),
    title(root) {
      const chat = root && root.closest('.chat');
      return textOf((chat || document).querySelector('.chat-info .peer-title, .user-title .peer-title'));
    },
    items: (root) => [...root.querySelectorAll('.bubble[data-mid]')]
      .filter((b) => !b.classList.contains('service') && !b.classList.contains('is-date')),
    isOut: (b) => b.classList.contains('is-out'),
    body: (b) => b.querySelector('.message'),
    name: (b) => textOf(b.querySelector('.name .peer-title, .colored-name .peer-title')),
    group: (b) => b.closest('.bubbles-group'),
    when(b) {
      const ts = Number(b.dataset.timestamp);
      if (ts) return formatDate(new Date(ts * 1000));
      return textOf(b.querySelector('.time-inner, .time'));
    },
    input: () => lastVisible(document.querySelectorAll(
      '.chat .input-message-input[contenteditable="true"]:not(.input-field-input-fake)'))
  };

  // Telegram Web A (web.telegram.org/a/)
  const WEB_A = {
    container: () => lastVisible(document.querySelectorAll('.messages-container')),
    title: () => textOf(document.querySelector('#MiddleColumn .ChatInfo .fullName, .MiddleHeader .ChatInfo .fullName')),
    items: (root) => [...root.querySelectorAll('.Message.message-list-item')],
    isOut: (m) => m.classList.contains('own'),
    body(m) {
      const parts = [...m.querySelectorAll('.text-content')];
      return parts.find((p) => nodeText(p)) || parts[0] || null;
    },
    name: (m) => textOf(m.querySelector('.message-title .sender-title, .message-title-name')),
    group: (m) => m.closest('.sender-group-container'),
    when(m) {
      const t = m.querySelector('.message-time');
      if (!t) return '';
      const full = (t.getAttribute('title') || '').split('\n')[0].trim();
      if (full) return full;
      const day = textOf(m.closest('.message-date-group')?.querySelector('.sticky-date'));
      return (day ? day + ', ' : '') + textOf(t);
    },
    input: () => document.getElementById('editable-message-text')
  };

  function client() {
    if (location.pathname.startsWith('/a')) return WEB_A;
    if (location.pathname.startsWith('/k')) return WEB_K;
    return document.querySelector('.bubbles-inner') ? WEB_K : WEB_A;
  }

  function formatDate(d) {
    return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  /** Сообщения открытого чата: [{ name, when, text, out }] */
  function collectMessages() {
    const tg = client();
    const root = tg.container();
    if (!root) return null;
    const chatTitle = tg.title(root) || 'Собеседник';
    const out = [];
    let prevGroup = null;
    let prevName = '';
    for (const item of tg.items(root)) {
      const isOut = tg.isOut(item);
      const group = tg.group(item);
      // Имя показывается только у первого сообщения из нескольких подряд — берём его у предыдущего
      let name = tg.name(item);
      if (!name) name = isOut ? settings.myName : (group && group === prevGroup && prevName ? prevName : chatTitle);
      prevGroup = group;
      prevName = name;

      const body = tg.body(item);
      const lines = mediaLabels(item);
      const text = nodeText(body);
      if (text) lines.push(text);
      if (!lines.length) continue;
      out.push({ name, when: tg.when(item), text: lines.join('\n'), out: isOut });
    }
    return { chatTitle, messages: out };
  }

  // ---------- перевод ----------

  function translate(texts, target) {
    return new Promise((resolve, reject) => {
      if (!alive()) return reject(new Error('расширение обновилось — перезагрузите страницу Telegram'));
      chrome.runtime.sendMessage({ type: 'translate', texts, target }, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res || res.error) return reject(new Error(res ? res.error : 'нет ответа'));
        resolve(res.translations);
      });
    });
  }

  const hasLetters = (s) => /\p{L}/u.test(s);
  const targetFor = (text) => (TC.isMostlyRussian(text) ? 'en' : 'ru');

  /** Переводит сообщения; имена участников не переводятся */
  async function translateMessages(messages) {
    const names = TC.collectNames(messages.map((m) => ({ name: m.name })));
    const queues = { ru: [], en: [] };
    const jobs = messages.map((m) => {
      if (!hasLetters(m.text)) return null;
      const target = targetFor(m.text);
      const prot = TC.protectNames(m.text, names);
      queues[target].push(prot.text);
      return { target, idx: queues[target].length - 1, names: prot.names };
    });
    const [ru, en] = await Promise.all([
      queues.ru.length ? translate(queues.ru, 'ru') : [],
      queues.en.length ? translate(queues.en, 'en') : []
    ]);
    const done = { ru, en };
    return jobs.map((j, i) => {
      if (!j) return messages[i].text;
      return TC.applyGlossary(TC.restoreNames(done[j.target][j.idx], j.names), j.target);
    });
  }

  // ---------- цвета отправителей ----------

  const PALETTE = ['#1565c0', '#2e7d32', '#6a1b9a', '#00838f', '#e65100', '#5d4037', '#558b2f', '#00695c', '#37474f', '#9e6a00'];
  const MY_COLOR = '#0d2a6b';

  function colorFor(name, isOut) {
    if (isOut) return MY_COLOR;
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  // ---------- панель ----------

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483000; top: 0; right: 0;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; }
  .tab {
    position: fixed; right: 0; top: 50%; transform: translateY(-50%);
    width: 30px; padding: 12px 0; border-radius: 8px 0 0 8px; border: 1px solid #b85700; border-right: 0;
    background: linear-gradient(90deg, #ff9a2e, #f47a00); color: #fff; cursor: pointer;
    font: 700 13px/1 -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
    writing-mode: vertical-rl; text-orientation: mixed; letter-spacing: .5px;
    box-shadow: 0 2px 6px rgba(0,0,0,.35); text-shadow: 0 1px 1px rgba(0,0,0,.3);
  }
  .tab:hover { background: linear-gradient(90deg, #ffab52, #ff8612); }
  .panel {
    position: fixed; top: 0; right: 0; bottom: 0; width: min(540px, 94vw);
    display: none; flex-direction: column; gap: 8px; padding: 12px 14px;
    color: #1d2126; font: 14px/1.45 -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
    background: repeating-linear-gradient(180deg, rgba(255,255,255,.18) 0 1px, rgba(0,0,0,.03) 1px 3px),
                linear-gradient(180deg, #eef0f2, #cfd3d7);
    border-left: 1px solid #8a9098; box-shadow: -4px 0 16px rgba(0,0,0,.3);
  }
  .panel.open { display: flex; }
  .head { display: flex; align-items: center; justify-content: space-between; }
  .head b { font-size: 16px; }
  .head b span { color: #f47a00; }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
  .sep { border-top: 1px solid rgba(0,0,0,.15); margin: 2px 0; }
  button, select, input[type=text] {
    font: inherit; font-size: 13.5px; color: #1d2126; border-radius: 7px; border: 1px solid #8a9098;
  }
  button {
    padding: 6px 12px; cursor: pointer;
    background: linear-gradient(180deg, #f7f8f9 0%, #d8dbdf 55%, #c7cbd0 100%);
    box-shadow: inset 0 1px 0 rgba(255,255,255,.9), 0 1px 2px rgba(0,0,0,.25);
  }
  button:hover:not(:disabled) { border-color: #f47a00; box-shadow: inset 0 1px 0 #fff, 0 0 0 2px rgba(244,122,0,.25); }
  button:disabled { opacity: .55; cursor: default; }
  button.primary {
    color: #fff; font-weight: 600; border-color: #b85700; text-shadow: 0 1px 1px rgba(0,0,0,.3);
    background: linear-gradient(180deg, #ff9a2e 0%, #f47a00 60%, #e26f00 100%);
  }
  button.close { padding: 2px 10px; font-size: 16px; }
  select, input[type=text] { padding: 4px 6px; background: #fff; }
  label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
  input[type=checkbox] { accent-color: #f47a00; width: 16px; height: 16px; margin: 0; }
  .status { min-height: 1.4em; font-size: 13px; color: #4a525c; }
  .status.error { color: #b00020; }
  .result {
    flex: 1; overflow: auto; background: #fff; border: 1px solid #8a9098; border-radius: 8px; padding: 10px 12px;
    user-select: text;
  }
  .hint { color: #4a525c; font-size: 13px; }
  .chat-title { font-weight: 700; margin-bottom: 8px; }
  .msg { border-left: 4px solid var(--c); padding: 2px 0 2px 10px; margin: 0 0 12px; color: var(--c); }
  .who b { font-weight: 700; }
  .who span { color: #4a525c; font-size: 12.5px; }
  .orig, .tr { white-space: pre-wrap; word-wrap: break-word; }
  .tr { margin-top: 4px; padding-top: 4px; border-top: 1px dashed rgba(0,0,0,.15); }
  .view-tr .orig { display: none; }
  .view-tr .tr { margin-top: 0; padding-top: 0; border-top: 0; }
</style>
<button class="tab" title="ИИ-Телеграм">ИИ-Телеграм</button>
<div class="panel" role="complementary" aria-label="ИИ-Телеграм">
  <div class="head"><b>ИИ-<span>Телеграм</span></b><button class="close" title="Закрыть">×</button></div>
  <div class="row">
    <button class="primary" data-act="thread">переписка в читабельном виде</button>
    <button data-act="copy" disabled>копировать результат</button>
  </div>
  <div class="row">
    <label>сообщений: <select data-set="limit">
      <option value="20">последние 20</option><option value="50">последние 50</option>
      <option value="100">последние 100</option><option value="all">все загруженные</option>
    </select></label>
    <label>показывать: <select data-set="view">
      <option value="both">оригинал и перевод</option><option value="tr">только перевод</option>
    </select></label>
  </div>
  <div class="sep"></div>
  <div class="row">
    <button data-act="reply">перевести мой ответ</button>
    <label>на <select data-set="replyLang">
      <option value="en">английский</option><option value="zh-CN">китайский</option><option value="ru">русский</option>
    </select></label>
    <button data-act="undo" disabled>вернуть исходный текст</button>
  </div>
  <div class="row"><label><input type="checkbox" data-set="inline"> переводить сообщения прямо в чате</label></div>
  <div class="row"><label>моё имя: <input type="text" data-set="myName" size="22"></label></div>
  <div class="status" aria-live="polite"></div>
  <div class="result"><div class="hint">
    Откройте чат в Telegram и нажмите «переписка в читабельном виде».<br>
    Берутся сообщения, которые Telegram уже загрузил: чтобы взять более ранние, прокрутите чат вверх.
  </div></div>
</div>`;
  (document.body || document.documentElement).append(host);

  const $ = (sel) => shadow.querySelector(sel);
  const panel = $('.panel');
  const resultEl = $('.result');
  const statusEl = $('.status');
  const copyBtn = $('[data-act="copy"]');
  const undoBtn = $('[data-act="undo"]');

  function setStatus(text, isError) {
    statusEl.textContent = text || '';
    statusEl.classList.toggle('error', Boolean(isError));
  }

  function setOpen(open) {
    settings.open = open;
    panel.classList.toggle('open', open);
    $('.tab').style.display = open ? 'none' : '';
    saveSettings();
  }

  function applySettings() {
    for (const el of shadow.querySelectorAll('[data-set]')) {
      const key = el.dataset.set;
      if (el.type === 'checkbox') el.checked = Boolean(settings[key]);
      else el.value = settings[key];
    }
    resultEl.classList.toggle('view-tr', settings.view === 'tr');
    panel.classList.toggle('open', settings.open);
    $('.tab').style.display = settings.open ? 'none' : '';
    updateInline();
  }

  for (const el of shadow.querySelectorAll('[data-set]')) {
    el.addEventListener('change', () => {
      const key = el.dataset.set;
      settings[key] = el.type === 'checkbox' ? el.checked : (key === 'myName' ? el.value.trim() || 'Я' : el.value);
      saveSettings();
      if (key === 'view') resultEl.classList.toggle('view-tr', settings.view === 'tr');
      if (key === 'inline') updateInline();
    });
  }
  // Клавиши, нажатые в панели, не должны попадать в Telegram (он перехватывает ввод)
  for (const type of ['keydown', 'keyup', 'keypress', 'paste']) {
    panel.addEventListener(type, (e) => e.stopPropagation());
  }

  $('.tab').addEventListener('click', () => setOpen(true));
  $('.close').addEventListener('click', () => setOpen(false));

  // ---------- «переписка в читабельном виде» ----------

  let lastResult = null;

  async function showThread() {
    const data = collectMessages();
    if (!data || !data.messages.length) {
      setStatus('Не нашёл сообщений: откройте чат в Telegram и дождитесь, пока он загрузится.', true);
      return;
    }
    let messages = data.messages;
    if (settings.limit !== 'all') messages = messages.slice(-Number(settings.limit));
    setStatus('Перевожу ' + messages.length + ' сообщ. …');
    const btn = $('[data-act="thread"]');
    btn.disabled = true;
    try {
      const translations = await translateMessages(messages);
      lastResult = { chatTitle: data.chatTitle, messages, translations };
      renderResult(lastResult);
      copyBtn.disabled = false;
      setStatus('Готово: ' + messages.length + ' сообщ. из чата «' + data.chatTitle + '».');
    } catch (e) {
      setStatus('Ошибка перевода: ' + e.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  function renderResult({ chatTitle, messages, translations }) {
    resultEl.textContent = '';
    const title = document.createElement('div');
    title.className = 'chat-title';
    title.textContent = 'Чат: ' + chatTitle;
    resultEl.append(title);
    messages.forEach((m, i) => {
      const box = document.createElement('div');
      box.className = 'msg';
      box.style.setProperty('--c', colorFor(m.name, m.out));
      const who = document.createElement('div');
      who.className = 'who';
      const b = document.createElement('b');
      b.textContent = m.name;
      who.append(b);
      if (m.when) {
        const s = document.createElement('span');
        s.textContent = ', ' + m.when;
        who.append(s);
      }
      const orig = document.createElement('div');
      orig.className = 'orig';
      orig.textContent = m.text;
      const tr = document.createElement('div');
      tr.className = 'tr';
      tr.textContent = translations[i];
      box.append(who, orig, tr);
      resultEl.append(box);
    });
    resultEl.scrollTop = resultEl.scrollHeight;
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const escLines = (s) => esc(s).replace(/\n/g, '<br>');

  async function copyResult() {
    if (!lastResult) return;
    const onlyTr = settings.view === 'tr';
    const html = [];
    const plain = [];
    lastResult.messages.forEach((m, i) => {
      const c = colorFor(m.name, m.out);
      const tr = lastResult.translations[i];
      const head = '<b>' + esc(m.name) + '</b>' + (m.when ? ', ' + esc(m.when) : '');
      html.push('<div style="border-left:4px solid ' + c + ';padding-left:10px;margin:0 0 12px;color:' + c
        + ';font-family:Calibri,Arial,sans-serif;font-size:11pt">' + head
        + (onlyTr ? '' : '<div>' + escLines(m.text) + '</div>')
        + '<div' + (onlyTr ? '' : ' style="margin-top:4px"') + '>' + escLines(tr) + '</div></div>');
      plain.push(m.name + (m.when ? ', ' + m.when : '') + '\n' + (onlyTr ? '' : m.text + '\n') + tr);
    });
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html.join('')], { type: 'text/html' }),
        'text/plain': new Blob([plain.join('\n\n')], { type: 'text/plain' })
      })]);
      setStatus('Скопировано — можно вставить в письмо.');
    } catch (e) {
      setStatus('Не удалось скопировать: ' + e.message, true);
    }
  }

  $('[data-act="thread"]').addEventListener('click', showThread);
  copyBtn.addEventListener('click', copyResult);

  // ---------- «перевести мой ответ» ----------

  let originalReply = null;

  function setInputText(input, text) {
    input.focus();
    const range = document.createRange();
    range.selectNodeContents(input);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    // execCommand — чтобы Telegram «увидел» изменение как обычный ввод
    document.execCommand('delete');
    text.split('\n').forEach((line, i) => {
      if (i) document.execCommand('insertLineBreak');
      if (line) document.execCommand('insertText', false, line);
    });
  }

  async function translateReply() {
    const input = client().input();
    if (!input) return setStatus('Не нашёл поле ввода сообщения — откройте чат.', true);
    const text = nodeText(input);
    if (!text) return setStatus('Напишите ответ в поле ввода Telegram, затем нажмите «перевести мой ответ».', true);
    const target = settings.replyLang;
    const btn = $('[data-act="reply"]');
    btn.disabled = true;
    setStatus('Перевожу ответ…');
    try {
      const [tr] = await translate([text], target);
      const result = target === 'zh-CN' ? tr : TC.applyGlossary(tr, target);
      originalReply = text;
      setInputText(input, result);
      undoBtn.disabled = false;
      setStatus('Перевод вставлен в поле ввода. Проверьте его и отправьте сами.');
    } catch (e) {
      setStatus('Ошибка перевода: ' + e.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  function undoReply() {
    const input = client().input();
    if (!input || originalReply === null) return;
    setInputText(input, originalReply);
    originalReply = null;
    undoBtn.disabled = true;
    setStatus('Исходный текст возвращён.');
  }

  $('[data-act="reply"]').addEventListener('click', translateReply);
  undoBtn.addEventListener('click', undoReply);

  // ---------- перевод прямо в чате ----------

  const inlineDone = new WeakMap(); // сообщение -> текст, для которого уже есть перевод
  const inlineCache = new Map(); // текст -> перевод
  let observer = null;
  let scanTimer = 0;
  let scanning = false;

  function scheduleScan() {
    if (!scanTimer) scanTimer = setTimeout(() => { scanTimer = 0; scanInline(); }, 600);
  }

  function putInline(tg, item, translation) {
    const body = tg.body(item);
    if (!body || !body.isConnected) return;
    body.querySelectorAll('.' + INLINE_CLASS).forEach((n) => n.remove());
    const div = document.createElement('div');
    div.className = INLINE_CLASS;
    div.textContent = translation;
    div.style.cssText = 'margin:4px 0 2px;padding-left:6px;border-left:2px solid #f47a00;'
      + 'font-style:italic;opacity:.85;white-space:pre-wrap;';
    const meta = body.querySelector(':scope > .time, :scope > .MessageMeta, :scope > .Reactions');
    if (meta) meta.before(div);
    else body.append(div);
  }

  async function scanInline() {
    if (!settings.inline || scanning) return;
    if (!alive() || document.getElementById(HOST_ID) !== host) return updateInline(true);
    const tg = client();
    const root = tg.container();
    if (!root) return;
    const todo = [];
    for (const item of tg.items(root)) {
      if (tg.isOut(item)) continue;
      const text = nodeText(tg.body(item));
      if (!text || !hasLetters(text) || TC.isMostlyRussian(text)) continue;
      if (inlineDone.get(item) === text && item.querySelector('.' + INLINE_CLASS)) continue;
      inlineDone.set(item, text);
      if (inlineCache.has(text)) putInline(tg, item, inlineCache.get(text));
      else todo.push({ item, text });
    }
    if (!todo.length) return;
    scanning = true;
    try {
      const texts = [...new Set(todo.map((t) => t.text))];
      const translations = await translate(texts, 'ru');
      texts.forEach((t, i) => inlineCache.set(t, TC.applyGlossary(translations[i], 'ru')));
      if (settings.inline) for (const { item, text } of todo) putInline(tg, item, inlineCache.get(text));
    } catch (e) {
      for (const { item } of todo) inlineDone.delete(item);
      setStatus('Перевод в чате: ' + e.message, true);
    } finally {
      scanning = false;
    }
  }

  function updateInline(forceOff) {
    const on = settings.inline && !forceOff;
    if (on && !observer) {
      observer = new MutationObserver(scheduleScan);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      scheduleScan();
    } else if (!on) {
      if (observer) observer.disconnect();
      observer = null;
      document.querySelectorAll('.' + INLINE_CLASS).forEach((n) => n.remove());
    }
  }

  // ---------- связь с фоновой частью ----------

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'toggle' && document.getElementById(HOST_ID) === host) setOpen(!settings.open);
  });

  chrome.storage.local.get(settings).then((saved) => {
    Object.assign(settings, saved);
    applySettings();
  }).catch(applySettings);
})();
