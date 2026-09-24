/*
 * Общая логика перевода через Google Translate (браузер и Node).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TranslateCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const GTX_URL = 'https://translate.googleapis.com/translate_a/single';
  const MAX_CHUNK = 1500;

  // Делит текст на куски не длиннее max символов, по возможности по строкам и предложениям
  function splitChunks(text, max) {
    max = max || MAX_CHUNK;
    const chunks = [];
    let cur = null;
    for (const line of String(text).split('\n')) {
      const pieces = line.length > max ? splitLong(line, max) : [line];
      for (const piece of pieces) {
        if (cur !== null && cur.length + 1 + piece.length > max) { chunks.push(cur); cur = null; }
        cur = cur === null ? piece : cur + '\n' + piece;
      }
    }
    if (cur !== null) chunks.push(cur);
    return chunks;
  }

  function splitLong(line, max) {
    const out = [];
    let cur = '';
    for (const sent of line.split(/(?<=[.!?。！？;；])\s*/)) {
      let s = sent;
      while (s.length > max) {
        if (cur) { out.push(cur); cur = ''; }
        out.push(s.slice(0, max));
        s = s.slice(max);
      }
      if (cur && cur.length + 1 + s.length > max) { out.push(cur); cur = ''; }
      cur = cur ? cur + ' ' + s : s;
    }
    if (cur) out.push(cur);
    return out;
  }

  function gtxRequest(chunk, target) {
    const params = new URLSearchParams({ client: 'gtx', sl: 'auto', tl: target, dt: 't', q: chunk });
    return { url: GTX_URL + '?' + params.toString() };
  }

  function parseGtx(data) {
    if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('Неожиданный ответ Google Translate');
    return data[0].map((seg) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : '')).join('');
  }

  // Словарь: как передавать по-русски отдельные имена и термины.
  // Применяется к русской колонке после перевода (в т.ч. к именам отправителей).
  // Остальные имена и фамилии не переводятся (см. protectNames).
  const GLOSSARY = [
    // Sergei Zakharov -> Сергей Захаров (в т.ч. "Zakharov Sergei", "Mr. Zakharov", "Dear Sergei")
    [/(?<![A-Za-z])Sergei(?![A-Za-z])/g, 'Сергей'],
    [/(?<![A-Za-z])Zakharov(?![A-Za-z])/g, 'Захаров'],
    // варианты транслитерации Google Translate
    [/(?<![А-Яа-яЁё])Серг(?:еи|ей|ии)\s+Захаров(?![А-Яа-яЁё])/g, 'Сергей Захаров'],
    [/(?<![А-Яа-яЁё])Закаров(?![А-Яа-яЁё])/g, 'Захаров']
  ];
  // Имена, которые переводятся по словарю, а не остаются как есть
  const TRANSLATED_NAMES = /^(?:sergei|zakharov)$/i;
  // Слова, которые не считаем частью имени, даже если они есть в имени отправителя
  const NOT_NAMES = /^(?:mr|mrs|ms|dr|the|and|of|service|sales|support|team|manager|engineer|dept|department|info|admin|office|group|company|ltd|llc|co|inc|will|may|mark|bill|rose|april|june|august|grant|hope|joy)\.?$/i;

  /** Список имён, которые нужно оставить без перевода. people: [{name}] */
  function collectNames(people) {
    const set = new Set();
    for (const p of people) {
      const full = String(p.name || '').trim();
      if (!full) continue;
      const words = full.split(/[\s,]+/).filter(Boolean);
      if (!words.some((w) => TRANSLATED_NAMES.test(w))) set.add(full);
      for (const w of words) {
        const clean = w.replace(/[.,;:()"']/g, '');
        if (clean.length < 2 || TRANSLATED_NAMES.test(clean) || NOT_NAMES.test(clean)) continue;
        // Латинские имена — только с заглавной буквы; китайские иероглифы — любые
        if (/^\p{Lu}/u.test(clean) || /^\p{Script=Han}+$/u.test(clean)) set.add(clean);
      }
    }
    return [...set].sort((a, b) => b.length - a.length);
  }

  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /**
   * Заменяет имена на метки-заглушки, которые переводчик не меняет.
   * Возвращает { text, names } — names нужен для restoreNames.
   */
  function protectNames(text, names) {
    if (!names.length) return { text: String(text), names };
    const re = new RegExp(names.map((n) => /^\p{Script=Han}+$/u.test(n)
      ? escRe(n)
      : '(?<![\\p{L}\\d])' + escRe(n) + '(?![\\p{L}\\d])').join('|'), 'gu');
    const used = [];
    const out = String(text).replace(re, (m) => {
      let idx = used.indexOf(m);
      if (idx < 0) idx = used.push(m) - 1;
      return 'QZX' + idx + 'Z';
    });
    return { text: out, names: used };
  }

  function restoreNames(text, names) {
    return String(text).replace(/QZX\s*(\d+)\s*Z/gi, (m, i) => (names[+i] !== undefined ? names[+i] : m));
  }

  // Для перевода с русского на английский: как писать имя по-английски
  const GLOSSARY_EN = [
    [/(?<![A-Za-z])Serge[yi]\s+(?:Alexandrovich\s+)?Zak?harov(?![A-Za-z])/g, 'Sergei Zakharov'],
    [/(?<![A-Za-z])Zak?harov\s+Serge[yi](?![A-Za-z])/g, 'Zakharov Sergei'],
    [/(?<![А-Яа-яЁё])Сергей\s+Захаров(?![А-Яа-яЁё])/g, 'Sergei Zakharov'],
    [/(?<![А-Яа-яЁё])Захаров\s+Сергей(?![А-Яа-яЁё])/g, 'Zakharov Sergei']
  ];

  /** Правка перевода по словарю; target — язык перевода ('ru' или 'en') */
  function applyGlossary(text, target) {
    let s = String(text);
    for (const [re, to] of (target === 'en' ? GLOSSARY_EN : GLOSSARY)) s = s.replace(re, to);
    return s;
  }

  // Текст на русском — переводится на английский
  function isMostlyRussian(text) {
    const letters = String(text).match(/\p{L}/gu) || [];
    if (!letters.length) return true;
    const cyr = letters.filter((c) => /[Ѐ-ӿ]/.test(c)).length;
    return cyr / letters.length > 0.6;
  }

  /**
   * Переводит один текст по кускам. fetchJson(url) -> Promise<json>.
   */
  async function translateText(text, target, fetchJson) {
    if (!String(text).trim()) return String(text);
    const parts = [];
    for (const chunk of splitChunks(text)) {
      if (!chunk.trim()) { parts.push(chunk); continue; }
      const req = gtxRequest(chunk, target);
      parts.push(parseGtx(await fetchJson(req.url)));
    }
    return parts.join('\n');
  }

  return { splitChunks, translateText, applyGlossary, collectNames, protectNames, restoreNames, parseGtx, isMostlyRussian, MAX_CHUNK };
});
