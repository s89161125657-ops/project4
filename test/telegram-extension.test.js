'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { once } = require('events');
const { crc32 } = require('../lib/zip');

const EXT = path.join(__dirname, '..', 'telegram-extension');

/** Читает ZIP по центральному каталогу: { имя: Buffer } */
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.strictEqual(buf.readUInt32LE(p), 0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const packed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = zlib.inflateRawSync(buf.subarray(start, start + packed));
    assert.strictEqual(crc32(data), crc, 'CRC ' + name);
    out[name] = data;
    p += 46 + nameLen;
  }
  return out;
}

test('расширение: все файлы из manifest.json на месте', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.manifest_version, 3);
  const files = [manifest.background.service_worker, ...manifest.content_scripts.flatMap((c) => c.js)];
  for (const f of files) assert.ok(fs.existsSync(path.join(EXT, f)), f);
});

test('расширение: translate-core.js совпадает с public/translate-core.js', () => {
  // Chrome не загружает файлы расширения по ссылкам вне его папки, поэтому там копия
  assert.strictEqual(
    fs.readFileSync(path.join(EXT, 'translate-core.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'public', 'translate-core.js'), 'utf8'),
    'после правки public/translate-core.js скопируйте его в telegram-extension/'
  );
});

test('GET /telegram-extension.zip отдаёт папку расширения', async () => {
  const { server } = require('../server');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const res = await fetch('http://127.0.0.1:' + server.address().port + '/telegram-extension.zip');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'application/zip');
    const files = unzip(Buffer.from(await res.arrayBuffer()));
    const expected = fs.readdirSync(EXT).map((f) => 'telegram-extension/' + f).sort();
    assert.deepStrictEqual(Object.keys(files).sort(), expected);
    for (const name of expected) {
      assert.ok(files[name].equals(fs.readFileSync(path.join(EXT, name.slice('telegram-extension/'.length)))), name);
    }
  } finally {
    server.close();
  }
});
