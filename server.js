'use strict';

/*
 * Минимальный сервер без зависимостей:
 *  - раздаёт статические файлы из ./public
 *  - GET  /api/config     — сообщает клиенту, как переводить
 *  - POST /api/translate  — перевод массива текстов через Google Translate
 *
 * Если задана переменная GOOGLE_TRANSLATE_API_KEY, используется официальный
 * Google Cloud Translation API v2, иначе — бесплатный публичный эндпоинт.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { translateText, splitChunks } = require('./public/translate-core');

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 2 * 1024 * 1024;
const TARGETS = new Set(['ru', 'en', 'zh-CN']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8'
};

const cache = new Map();
const CACHE_LIMIT = 1000;

function cacheSet(key, value) {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, value);
}

async function fetchJson(url, options) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('Google Translate ответил ' + res.status);
  return res.json();
}

async function translateWithKey(text, target) {
  const chunks = splitChunks(text);
  const url = 'https://translation.googleapis.com/language/translate/v2?key=' + encodeURIComponent(API_KEY);
  const data = await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: chunks, target, format: 'text' })
  });
  return data.data.translations.map((t) => t.translatedText).join('\n');
}

async function translateOne(text, target) {
  const key = target + '\u0000' + text;
  if (cache.has(key)) return cache.get(key);
  const result = API_KEY
    ? await translateWithKey(text, target)
    : await translateText(text, target, (url) => fetchJson(url));
  cacheSet(key, result);
  return result;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Слишком большой запрос'), { status: 413 }));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleTranslate(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (e) {
    return sendJson(res, e.status || 400, { error: e.status ? e.message : 'Некорректный JSON' });
  }
  const texts = payload && payload.texts;
  const target = (payload && payload.target) || 'ru';
  if (!Array.isArray(texts) || texts.some((t) => typeof t !== 'string') || !TARGETS.has(target)) {
    return sendJson(res, 400, { error: 'Ожидается { texts: string[], target: "ru" }' });
  }
  try {
    const translations = await mapLimit(texts, 3, (t) => translateOne(t, target));
    sendJson(res, 200, { translations });
  } catch (e) {
    console.error('translate error:', e.message);
    sendJson(res, 502, { error: 'Не удалось получить перевод: ' + e.message });
  }
}

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Не найдено');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

const server = http.createServer((req, res) => {
  const pathname = req.url.split('?')[0];
  if (pathname === '/api/translate' && req.method === 'POST') return void handleTranslate(req, res);
  if (pathname === '/api/config' && req.method === 'GET') return sendJson(res, 200, { serverKey: Boolean(API_KEY) });
  if (pathname === '/healthz') return sendJson(res, 200, { ok: true });
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  res.writeHead(405);
  res.end();
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Сервер запущен: http://localhost:${PORT}` + (API_KEY ? ' (Google Cloud Translation API)' : ''));
  });
}

module.exports = { server };
