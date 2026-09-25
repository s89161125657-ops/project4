/*
 * Фоновая часть расширения «ИИ-Телеграм»:
 *  - переводит тексты через Google Translate (из вкладки Telegram запросы на чужой сайт не пройдут);
 *  - по щелчку на значок расширения открывает/закрывает панель во вкладке Telegram;
 *  - после установки подключается к уже открытым вкладкам Telegram — перезагружать их не нужно.
 */
importScripts('translate-core.js');

const { translateText } = self.TranslateCore;
const TELEGRAM = 'https://web.telegram.org/*';
const TARGETS = new Set(['ru', 'en', 'zh-CN']);

const cache = new Map();
const CACHE_LIMIT = 2000;

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('Google Translate ответил ' + res.status);
  return res.json();
}

async function translateOne(text, target) {
  const key = target + '\u0000' + text;
  if (cache.has(key)) return cache.get(key);
  const result = await translateText(text, target, fetchJson);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, result);
  return result;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'translate') return false;
  const { texts, target } = msg;
  if (!Array.isArray(texts) || texts.some((t) => typeof t !== 'string') || !TARGETS.has(target)) {
    sendResponse({ error: 'Некорректный запрос на перевод' });
    return false;
  }
  mapLimit(texts, 3, (t) => translateOne(t, target))
    .then((translations) => sendResponse({ translations }))
    .catch((e) => sendResponse({ error: 'Не удалось получить перевод: ' + e.message }));
  return true; // ответ придёт асинхронно
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.url && tab.url.startsWith('https://web.telegram.org/')) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
    } catch {
      await injectInto(tab.id);
      chrome.tabs.sendMessage(tab.id, { type: 'toggle' }).catch(() => {});
    }
  } else {
    const [open] = await chrome.tabs.query({ url: TELEGRAM });
    if (open) {
      await chrome.tabs.update(open.id, { active: true });
      await chrome.windows.update(open.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url: 'https://web.telegram.org/' });
    }
  }
});

function injectInto(tabId) {
  return chrome.scripting.executeScript({ target: { tabId }, files: ['translate-core.js', 'content.js'] }).catch(() => {});
}

// Telegram уже открыт в браузере — подключаемся к нему сразу после установки/обновления
chrome.runtime.onInstalled.addListener(async () => {
  for (const tab of await chrome.tabs.query({ url: TELEGRAM })) await injectInto(tab.id);
});
