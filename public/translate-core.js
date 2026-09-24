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
  const GLOSSARY = [
    // Cui -> Цуи (и варианты Google Translate: Цуй, Цуя, Цую, Цуем, Цуе)
    [/(?<![A-Za-z])Cui(?![A-Za-z])/g, 'Цуи'],
    [/(?<![А-Яа-яЁё])Цу(?:й|я|ю|ем|е)(?![А-Яа-яЁё])/g, 'Цуи']
  ];

  function applyGlossary(text) {
    let s = String(text);
    for (const [re, to] of GLOSSARY) s = s.replace(re, to);
    return s;
  }

  // Текст уже на русском — переводить не нужно
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

  return { splitChunks, translateText, applyGlossary, parseGtx, isMostlyRussian, MAX_CHUNK };
});
