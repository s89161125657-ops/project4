'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseThread, parseDate, parseSender, formatDateRu } = require('../public/parser');
const { splitChunks, isMostlyRussian, parseGtx } = require('../public/translate-core');

test('Outlook (EN) thread with top reply without header', () => {
  const text = [
    'Hi Sergey,', '', '', 'OK, thanks.', 'Li',
    '',
    '________________________________',
    'From: Sergey Zaytsev <zsa@inpren.ru>',
    'Sent: Monday, September 22, 2025 10:15 AM',
    'To: Li Wei <liwei@haiermed.com>; Wang Fang <wf@haiermed.com>',
    'Cc: Anna <anna@inpren.ru>',
    'Subject: RE: Delivery',
    '',
    'Dear Li,', '', 'Please confirm.', '',
    '-----Original Message-----',
    'From: Wei, Li [mailto:liwei@haiermed.com]',
    'Sent: 19.09.2025 16:02',
    'To: zsa@inpren.ru',
    'Subject: Delivery',
    '',
    'Ready.'
  ].join('\r\n');
  const msgs = parseThread(text);
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].unknown, true);
  assert.deepEqual(msgs[0].lines, ['Hi Sergey,', 'OK, thanks.', 'Li']);
  assert.equal(msgs[1].email, 'zsa@inpren.ru');
  assert.equal(msgs[1].name, 'Sergey Zaytsev');
  assert.equal(msgs[1].dateRaw, 'Monday, September 22, 2025 10:15 AM');
  assert.equal(formatDateRu(msgs[1].date), '22.09.2025 10:15');
  assert.deepEqual(msgs[1].lines, ['Dear Li,', 'Please confirm.']);
  assert.equal(msgs[2].name, 'Li Wei');
  assert.equal(msgs[2].email, 'liwei@haiermed.com');
  assert.equal(formatDateRu(msgs[2].date), '19.09.2025 16:02');
  assert.deepEqual(msgs[2].lines, ['Ready.']);
});

test('Russian Outlook headers', () => {
  const text = [
    'От: Зайцев Сергей <zsa@inpren.ru>',
    'Отправлено: пятница, 19 сентября 2025 г. 10:00',
    'Кому: liwei@haiermed.com',
    'Тема: Поставка',
    '',
    'Добрый день!'
  ].join('\n');
  const [m] = parseThread(text);
  assert.equal(m.name, 'Зайцев Сергей');
  assert.equal(formatDateRu(m.date), '19.09.2025 10:00');
  assert.deepEqual(m.lines, ['Добрый день!']);
});

test('Chinese Foxmail / NetEase headers', () => {
  const text = [
    '发件人: 李伟 <liwei@haiermed.com>',
    '发送时间: 2025年9月22日 下午 3:05',
    '收件人: zsa@inpren.ru',
    '主题: 回复: 交货',
    '',
    '您好！',
    '',
    '---- Replied Message ----',
    '| From | Sergey<zsa@inpren.ru> |',
    '| Date | 09/21/2025 11:20 |',
    '| To | liwei@haiermed.com |',
    '| Subject | Delivery |',
    'Hello'
  ].join('\n');
  const msgs = parseThread(text);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].name, '李伟');
  assert.equal(formatDateRu(msgs[0].date), '22.09.2025 15:05');
  assert.deepEqual(msgs[0].lines, ['您好！']);
  assert.equal(msgs[1].email, 'zsa@inpren.ru');
  assert.equal(formatDateRu(msgs[1].date), '21.09.2025 11:20');
  assert.deepEqual(msgs[1].lines, ['Hello']);
});

test('Gmail "On ... wrote:" (quoted, wrapped) and Russian variant', () => {
  const text = [
    'Thanks!',
    '',
    'On Mon, Sep 22, 2025 at 10:15 AM Amanda Lee <amanda@example.com>',
    'wrote:',
    '> Hello,',
    '>',
    '> > пн, 22 сент. 2025 г. в 09:00, Сергей Зайцев <zsa@inpren.ru>:',
    '> > Привет'
  ].join('\n');
  const msgs = parseThread(text);
  assert.equal(msgs.length, 3);
  assert.equal(msgs[1].name, 'Amanda Lee');
  assert.equal(msgs[1].dateRaw, 'Mon, Sep 22, 2025 at 10:15 AM');
  assert.deepEqual(msgs[1].lines, ['Hello,']);
  assert.equal(msgs[2].name, 'Сергей Зайцев');
  assert.equal(formatDateRu(msgs[2].date), '22.09.2025 09:00');
  assert.deepEqual(msgs[2].lines, ['Привет']);
});

test('Gmail web UI copy', () => {
  const text = [
    'Li Wei <liwei@haiermed.com>',
    'Mon, Sep 22, 2025, 3:05 PM (2 days ago)',
    'to me',
    '',
    'Hello Sergey',
    'Sergey Zaytsev <zsa@inpren.ru>',
    '22 сент. 2025 г., 17:40 (2 дня назад)',
    'кому: Li',
    'Hi Li'
  ].join('\n');
  const msgs = parseThread(text);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].dateRaw, 'Mon, Sep 22, 2025, 3:05 PM');
  assert.deepEqual(msgs[0].lines, ['Hello Sergey']);
  assert.equal(formatDateRu(msgs[1].date), '22.09.2025 17:40');
  assert.deepEqual(msgs[1].lines, ['Hi Li']);
});

test('signature with phone is not a header; body "From:" is not a header', () => {
  const text = [
    'From: Li <liwei@haiermed.com>',
    'Sent: 22.09.2025 10:00',
    '',
    'From: Moscow to Beijing',
    'To: be continued',
    'Li Wei <liwei@haiermed.com>',
    'Tel: +86 532 123-45-67'
  ].join('\n');
  const msgs = parseThread(text, { stripSignatures: false });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].lines.length, 4);
  // по умолчанию подпись (имя + телефон) убирается
  assert.deepEqual(parseThread(text)[0].lines, ['From: Moscow to Beijing', 'To: be continued']);
});

test('one-line header and name lookup by email', () => {
  const text = [
    'From: Li Wei <liwei@haiermed.com> Sent: Monday, 22 September 2025 09:10 To: zsa@inpren.ru Subject: Test',
    'Body 1',
    'From: liwei@haiermed.com',
    'Date: 2025-09-21 08:00',
    'Body 2'
  ].join('\n');
  const msgs = parseThread(text);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].name, 'Li Wei');
  assert.equal(formatDateRu(msgs[0].date), '22.09.2025 09:10');
  assert.equal(msgs[1].name, 'Li Wei');
  assert.equal(formatDateRu(msgs[1].date), '21.09.2025 08:00');
});

test('parseSender / parseDate edge cases', () => {
  assert.deepEqual(parseSender('"John Smith" <John@X.com<mailto:John@X.com>>'), { name: 'John Smith', email: 'john@x.com' });
  assert.deepEqual(parseSender('zsa@inpren.ru'), { name: '', email: 'zsa@inpren.ru' });
  assert.equal(formatDateRu(parseDate('3 мая 2025 г. 12:00 AM')), '03.05.2025 00:00');
  assert.equal(formatDateRu(parseDate('9/22/2025 1:05 PM')), '22.09.2025 13:05');
  assert.equal(parseDate('no date here'), null);
});

test('translate-core helpers', () => {
  const long = Array.from({ length: 300 }, (_, i) => 'Line number ' + i).join('\n');
  const chunks = splitChunks(long, 500);
  assert.ok(chunks.every((c) => c.length <= 500));
  assert.equal(chunks.join('\n'), long);
  assert.equal(isMostlyRussian('Привет, как дела? OK'), true);
  assert.equal(isMostlyRussian('Hello there'), false);
  assert.equal(parseGtx([[['Привет. ', 'Hello. '], ['Мир', 'World']]]), 'Привет. Мир');
});

const { stripSignature } = require('../public/parser');
const { applyGlossary, collectNames, protectNames, restoreNames } = require('../public/translate-core');

const CUI_SIGNATURE = [
  'Best regards',
  '崔保振',
  'Cui',
  'Service Manager',
  'Mobile Phone: +86 13402261534',
  'Qingdao Haier Biomedical Co.,Ltd.',
  'No.280 Fengyuan Road, High-tech Zone, Qingdao(266111), P.R.China'
];

test('signature after "Best regards" is removed', () => {
  const text = [
    'From: 崔保振 Cui <cuibaozhen@haierbiomedical.com>',
    'Sent: Monday, September 22, 2025 10:15 AM',
    'To: zsa@inpren.ru',
    '',
    'Dear Sergey,',
    '',
    'Please check the attached file.',
    '',
    ...CUI_SIGNATURE
  ].join('\n');
  const [m] = parseThread(text);
  assert.deepEqual(m.lines, ['Dear Sergey,', 'Please check the attached file.']);
  const [raw] = parseThread(text, { stripSignatures: false });
  assert.equal(raw.lines.length, 2 + CUI_SIGNATURE.length);
});

test('signature variants', () => {
  // Контакты без прощания
  assert.deepEqual(stripSignature(['The unit is fixed.', 'Thanks', 'Cui', 'Service Manager', 'Mobile Phone: +86 13402261534']),
    ['The unit is fixed.']);
  // Прощание и имя в одной строке, русская подпись
  assert.deepEqual(stripSignature(['Добрый день!', 'Высылаю счёт.', 'С уважением, Сергей Зайцев', 'Тел.: +7 495 123-45-67']),
    ['Добрый день!', 'Высылаю счёт.']);
  assert.deepEqual(stripSignature(['Hello', 'See below.', '--', 'John', 'www.example.com']), ['Hello', 'See below.']);
  // Обычный текст не трогаем
  const body = ['Best price is 100 USD.', 'Please check the attached file', 'Li Wei'];
  assert.deepEqual(stripSignature(body), body);
  const body2 = ['Regards the delivery, we will ship it on Monday.', 'Thank you.'];
  assert.deepEqual(stripSignature(body2), body2);
});

test('glossary: only Sergei Zakharov is translated', () => {
  assert.equal(applyGlossary('Cui'), 'Cui');
  assert.equal(applyGlossary('Sergei Zakharov'), 'Сергей Захаров');
  assert.equal(applyGlossary('Zakharov Sergei'), 'Захаров Сергей');
  assert.equal(applyGlossary('Уважаемый Sergei, г-н Закаров и Сергеи Захаров'), 'Уважаемый Сергей, г-н Захаров и Сергей Захаров');
  assert.equal(applyGlossary('Sergeiev Zakharova'), 'Sergeiev Zakharova');
});

const HAIER_DISCLAIMER = [
  'The information transmitted is intended solely for the use of the addressee and may contain confidential and/or privileged material. Any unauthorized disclosure, reproduction, distribution, dissemination, or taking of any action in reliance upon, this information by persons or entities other than the intended recipient is prohibited. If you received this in error, please contact the sender and delete the email together with any material attached (if any) completely from any device immediately. Unless otherwise stated, any views or opinions expressed in this email are solely those of the author and do not necessarily represent those of Haier Group. ',
  '本邮件可能包含敏感信息且仅限于发给指定的收件人，任何未经授权泄露、复制、散布或传播此信息的行为将被禁止。如果您错误收到了此邮件，请及时告知发送者并立即从所有设备中完全删除此邮件及附件。除非另有说明，否则邮件中可能包含的观点或建议仅代表发件者本人，并不代表海尔集团。 '
];

test('Haier disclaimer is removed (one line per paragraph and wrapped)', () => {
  const head = ['From: Cui <cui@haier.com>', 'Sent: 22.09.2025 10:00', 'To: Sergei Zakharov <zsa@inpren.ru>', ''];
  const text = [...head, 'Dear Sergei,', 'OK.', '', ...CUI_SIGNATURE, '', ...HAIER_DISCLAIMER].join('\n');
  assert.deepEqual(parseThread(text)[0].lines, ['Dear Sergei,', 'OK.']);
  assert.deepEqual(parseThread(text, { stripSignatures: false })[0].lines, ['Dear Sergei,', 'OK.', ...CUI_SIGNATURE]);
  // Оговорка перенесена по строкам и идёт сразу за текстом без пустой строки
  const wrapped = HAIER_DISCLAIMER[0].match(/.{1,70}(\s|$)/g).map((l) => l.trim());
  const text2 = [...head, 'Please check.', ...wrapped, ...HAIER_DISCLAIMER[1].match(/.{1,30}/g)].join('\n');
  assert.deepEqual(parseThread(text2)[0].lines, ['Please check.']);
});

test('recipients are collected; names are protected from translation', () => {
  const text = [
    'From: Li Wei <liwei@haiermed.com>',
    'Sent: 22.09.2025 10:00',
    'To: Sergei Zakharov <zsa@inpren.ru>; Wang, Fang <wf@haiermed.com>',
    'Cc: 崔保振 Cui <cui@haier.com>',
    '',
    'Hi'
  ].join('\n');
  const [m] = parseThread(text);
  assert.deepEqual(m.recipients.map((r) => r.name), ['Sergei Zakharov', 'Fang Wang', '崔保振 Cui']);
  const names = collectNames([m, ...m.recipients]);
  assert.ok(!names.includes('Sergei') && !names.includes('Sergei Zakharov'));
  const src = 'Dear Sergei, Mr. Cui and Li Wei will call Fang tomorrow. 崔保振 agrees. Liquid is cold.';
  const prot = protectNames(src, names);
  assert.ok(!/Cui|Li Wei|Fang|崔保振/.test(prot.text), prot.text);
  assert.ok(prot.text.includes('Sergei') && prot.text.includes('Liquid'));
  // Переводчик мог вставить пробелы в метки
  const fakeTranslated = prot.text.replace(/QZX(\d+)Z/g, 'QZX $1 Z');
  assert.equal(restoreNames(fakeTranslated, prot.names), src);
});

test('body is only the text after Subject: broken header block is skipped to Subject', () => {
  const text = [
    'From: Cui <cui@haier.com>',
    'Sent: Monday, September 22, 2025 10:15 AM',
    'To: Sergei Zakharov <zsa@inpren.ru>; Li Wei',
    'Wang Fang',
    'Importance: High',
    'Subject: RE: Freezer',
    '',
    'Dear Sergei,',
    'Done.'
  ].join('\n');
  assert.deepEqual(parseThread(text)[0].lines, ['Dear Sergei,', 'Done.']);
});

test('Outlook reading pane copy: subject line, sender, To/Cc, date', () => {
  const text = [
    'RE: Freezer DW-86L728J error E5',
    'Cui <cui@haier.com>',
    'To: Sergei Zakharov <zsa@inpren.ru>',
    'Cc: Li Wei <liwei@haiermed.com>',
    'Mon 9/22/2025 10:15 AM',
    '[cid:image001.png@01DC2B]',
    'Dear Sergei,',
    'The sensor is shipped.',
    'Sent from my iPhone',
    'RE: Freezer DW-86L728J error E5',
    'Sergei Zakharov <zsa@inpren.ru>',
    'To: Cui <cui@haier.com>',
    'Sun 9/21/2025 9:00 AM',
    'Dear Cui,',
    'To be honest, we need it urgently.'
  ].join('\n');
  const msgs = parseThread(text);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].name, 'Cui');
  assert.equal(formatDateRu(msgs[0].date), '22.09.2025 10:15');
  assert.deepEqual(msgs[0].recipients.map((r) => r.name), ['Sergei Zakharov', 'Li Wei']);
  assert.deepEqual(msgs[0].lines, ['[cid:image001.png@01DC2B]', 'Dear Sergei,', 'The sensor is shipped.']);
  assert.deepEqual(msgs[1].lines, ['Dear Cui,', 'To be honest, we need it urgently.']);
});

test('standard signature repeated in several messages is removed', () => {
  const sig = ['Best regards', 'Cui', 'Haier Biomedical - Protecting life science worldwide!', 'Visit our booth at Medica 2025, hall 3.'];
  const msg = (date, body) => ['From: Cui <cui@haier.com>', 'Sent: ' + date, 'Subject: X', '', ...body, '', ...sig, ''];
  const text = [...msg('22.09.2025 10:00', ['Dear Sergei,', 'First answer.']), ...msg('21.09.2025 10:00', ['Dear Sergei,', 'Second answer.'])].join('\n');
  const msgs = parseThread(text);
  assert.deepEqual(msgs[0].lines, ['Dear Sergei,', 'First answer.']);
  assert.deepEqual(msgs[1].lines, ['Dear Sergei,', 'Second answer.']);
  // Одинаковые письма целиком (дубликаты) не обрезаются
  const dup = [...msg('22.09.2025 10:00', ['Hello', 'Same text here.']), ...msg('22.09.2025 10:00', ['Hello', 'Same text here.'])].join('\n');
  assert.deepEqual(parseThread(dup, { stripSignatures: false })[0].lines.slice(0, 2), ['Hello', 'Same text here.']);
  assert.deepEqual(parseThread(dup)[0].lines.slice(0, 2), ['Hello', 'Same text here.']);
});

const { stripExcludedPhrases } = require('../public/parser');
const MailFile = require('../public/mailfile');

test('AWT reminder phrase is excluded (one line, wrapped, with link)', () => {
  const phrase = 'Напоминаем, каждый клиент нашей компании имеет личный кабинет с технической и сервисной документацией на нашем сайте www.awt.ru';
  const text = (tail) => ['From: Иван Петров <ivan@awt.ru>', 'Sent: 22.09.2025 10:00', 'Subject: Сервис', '', 'Добрый день!', 'Счёт во вложении.', '', ...tail].join('\n');
  assert.deepEqual(parseThread(text([phrase]), { stripSignatures: false })[0].lines, ['Добрый день!', 'Счёт во вложении.']);
  assert.deepEqual(parseThread(text([phrase + '<https://www.awt.ru/>']), { stripSignatures: false })[0].lines, ['Добрый день!', 'Счёт во вложении.']);
  const wrapped = ['Напоминаем, каждый клиент нашей компании имеет личный', 'кабинет с технической и сервисной документацией на нашем сайте', '[www.awt.ru](https://www.awt.ru)'];
  assert.deepEqual(parseThread(text(wrapped), { stripSignatures: false })[0].lines, ['Добрый день!', 'Счёт во вложении.']);
  // Текст в той же строке до фразы сохраняется
  assert.deepEqual(stripExcludedPhrases(['Спасибо! ' + phrase + '.']), ['Спасибо! ']);
});

test('glossary for Russian -> English', () => {
  assert.equal(applyGlossary('Sergey Zakharov will call', 'en'), 'Sergei Zakharov will call');
  assert.equal(applyGlossary('Сергей Захаров', 'en'), 'Sergei Zakharov');
  assert.equal(applyGlossary('Sergey Zaytsev', 'en'), 'Sergey Zaytsev');
  assert.equal(applyGlossary('Sergei Zakharov', 'ru'), 'Сергей Захаров');
});

test('.eml file is converted to a thread text', () => {
  const eml = [
    'From: =?UTF-8?B?0JjQstCw0L0g0J/QtdGC0YDQvtCy?= <ivan@awt.ru>',
    'To: Cui <cui@haier.com>',
    'Subject: =?UTF-8?Q?RE:_Freezer?=',
    'Date: Mon, 22 Sep 2025 10:15:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Dear Cui,=0D=0A=D0=A1=D0=BF=D0=B0=D1=81=D0=B8=D0=B1=D0=BE!',
    '--b1',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>ignored</p>',
    '--b1--'
  ].join('\r\n');
  const mail = MailFile.parseEml(new Uint8Array(Buffer.from(eml, 'latin1')));
  assert.equal(mail.fromName, 'Иван Петров');
  assert.equal(mail.fromEmail, 'ivan@awt.ru');
  assert.equal(mail.subject, 'RE: Freezer');
  assert.equal(mail.date.toISOString(), '2025-09-22T10:15:00.000Z');
  const [m] = parseThread(MailFile.fileToText('a.eml', new Uint8Array(Buffer.from(eml, 'latin1'))));
  assert.equal(m.name, 'Иван Петров');
  assert.deepEqual(m.lines, ['Dear Cui,', 'Спасибо!']);
});

// Минимальный писатель .msg (Compound File) для проверки чтения
function buildMsg(streams) {
  const SEC = 512;
  const names = Object.keys(streams);
  const dataSectors = [];
  const entries = [{ name: 'Root Entry', type: 5, start: 0xfffffffe, size: 0 }];
  let next = 0;
  for (const n of names) {
    const data = streams[n];
    const count = Math.max(1, Math.ceil(data.length / SEC));
    entries.push({ name: n, type: 2, start: next, size: data.length, data, count });
    next += count;
  }
  const dirSectors = Math.ceil(entries.length * 128 / SEC);
  const dirStart = next;
  const fatStart = dirStart + dirSectors;
  const total = fatStart + 1;
  const fat = new Uint32Array(SEC / 4).fill(0xffffffff);
  for (const e of entries.slice(1)) for (let i = 0; i < e.count; i++) fat[e.start + i] = i === e.count - 1 ? 0xfffffffe : e.start + i + 1;
  for (let i = 0; i < dirSectors; i++) fat[dirStart + i] = i === dirSectors - 1 ? 0xfffffffe : dirStart + i + 1;
  fat[fatStart] = 0xfffffffd;
  const buf = Buffer.alloc((total + 1) * SEC);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(buf, 0);
  buf.writeUInt16LE(9, 0x1e); buf.writeUInt16LE(6, 0x20);
  buf.writeUInt32LE(1, 0x2c); buf.writeUInt32LE(dirStart, 0x30);
  buf.writeUInt32LE(0, 0x38); // все потоки — в обычных секторах
  buf.writeUInt32LE(0xfffffffe, 0x3c); buf.writeUInt32LE(0xfffffffe, 0x44);
  for (let i = 0; i < 109; i++) buf.writeUInt32LE(i === 0 ? fatStart : 0xffffffff, 0x4c + i * 4);
  const off = (n) => (n + 1) * SEC;
  for (const e of entries.slice(1)) Buffer.from(e.data).copy(buf, off(e.start));
  entries.forEach((e, idx) => {
    const o = off(dirStart) + idx * 128;
    buf.write(e.name, o, 'utf16le');
    buf.writeUInt16LE((e.name.length + 1) * 2, o + 0x40);
    buf[o + 0x42] = e.type;
    buf.writeUInt32LE(0xffffffff, o + 0x44);
    buf.writeUInt32LE(idx > 0 && idx + 1 < entries.length ? idx + 1 : 0xffffffff, o + 0x48); // цепочка через right
    buf.writeUInt32LE(idx === 0 && entries.length > 1 ? 1 : 0xffffffff, o + 0x4c);
    buf.writeUInt32LE(e.start, o + 0x74);
    buf.writeUInt32LE(e.size, o + 0x78);
  });
  Buffer.from(fat.buffer).copy(buf, off(fatStart));
  return new Uint8Array(buf);
}

test('.msg file (Outlook) is converted to a thread text', () => {
  const u16 = (s) => new Uint8Array(Buffer.from(s + '\0', 'utf16le'));
  const props = Buffer.alloc(32 + 16);
  // PR_CLIENT_SUBMIT_TIME = 2025-09-22 10:15 UTC (FILETIME)
  const ft = (BigInt(Date.UTC(2025, 8, 22, 10, 15)) + 11644473600000n) * 10000n;
  props.writeUInt32LE(0x00390040, 32);
  props.writeBigUInt64LE(ft, 40);
  const body = 'Dear Sergei,\r\nThe sensor is shipped.\r\n\r\nFrom: Sergei Zakharov <zsa@inpren.ru>\r\nSent: Sunday, September 21, 2025 9:00 AM\r\nTo: Cui\r\nSubject: Sensor\r\n\r\nDear Cui,\r\nPlease send the sensor.' + ' '.repeat(600);
  const msg = buildMsg({
    '__substg1.0_0037001F': u16('RE: Sensor'),
    '__substg1.0_0C1A001F': u16('Cui'),
    '__substg1.0_5D01001F': u16('cui@haier.com'),
    '__substg1.0_0E04001F': u16('Sergei Zakharov'),
    '__substg1.0_1000001F': u16(body),
    '__properties_version1.0': new Uint8Array(props)
  });
  const mail = MailFile.parseMsg(msg);
  assert.equal(mail.subject, 'RE: Sensor');
  assert.equal(mail.fromName, 'Cui');
  assert.equal(mail.fromEmail, 'cui@haier.com');
  assert.equal(mail.date.toISOString(), '2025-09-22T10:15:00.000Z');
  const msgs = parseThread(MailFile.fileToText('x.msg', msg));
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].name, 'Cui');
  assert.deepEqual(msgs[0].lines, ['Dear Sergei,', 'The sensor is shipped.']);
  assert.equal(msgs[1].name, 'Sergei Zakharov');
  assert.deepEqual(msgs[1].lines, ['Dear Cui,', 'Please send the sensor.']);
});

const { formatElapsed } = require('../public/parser');

test('images stay in the text; logo in signature goes with the signature', () => {
  const text = [
    'From: Cui <cui@haier.com>', 'Sent: 22.09.2025 10:00', 'Subject: Photo', '',
    'Dear Sergei,', 'Please see the photo of the board:', '[cid:image001.png@01DC2B77.5A1B]', 'It is broken.', '',
    'Best regards', 'Cui', '[cid:image002.png@01DC2B77.5A1B]', 'Service Manager'
  ].join('\n');
  assert.deepEqual(parseThread(text)[0].lines,
    ['Dear Sergei,', 'Please see the photo of the board:', '[cid:image001.png@01DC2B77.5A1B]', 'It is broken.']);
});

test('elapsed time between messages', () => {
  const d = (y, m, dd, hh, mm) => ({ y, m, d: dd, hh, mm });
  assert.deepEqual(formatElapsed(d(2025, 9, 22, 10, 15), d(2025, 9, 19, 16, 2)), { ru: '2 дня 18 часов 13 минут', en: '2 days 18 hours 13 minutes' });
  assert.deepEqual(formatElapsed(d(2025, 9, 22, 9, 14), d(2025, 9, 22, 10, 15)), { ru: '1 час 1 минута', en: '1 hour 1 minute' });
  assert.deepEqual(formatElapsed(d(2025, 9, 22, 10, 0), d(2025, 9, 22, 10, 25)), { ru: '0 часов 25 минут', en: '0 hours 25 minutes' });
  assert.deepEqual(formatElapsed(d(2025, 10, 23, 10, 0), d(2025, 9, 22, 8, 0)).ru, '31 день 2 часа 0 минут');
  assert.equal(formatElapsed(d(2025, 9, 22, null, null), d(2025, 9, 22, 10, 0)), null);
});

test('board -> плата; images are protected from translation', () => {
  assert.equal(applyGlossary('Доска управления сломана, замените доску. Две доски, нет досок.', 'ru'),
    'Плата управления сломана, замените плату. Две платы, нет плат.');
  assert.equal(applyGlossary('control board', 'ru'), 'control плата');
  assert.equal(applyGlossary('Доска', 'en'), 'Доска');
  const { protectImages, restoreImages } = require('../public/translate-core');
  const { IMAGE_MARKER_SRC } = require('../public/parser');
  const p = protectImages('See [cid:image001.png@01D] and [img:https://x.org/a.png]', IMAGE_MARKER_SRC);
  assert.equal(p.text, 'See QZY0Z and QZY1Z');
  assert.equal(restoreImages('Смотрите QZY 0 Z и QZY1Z', p.images), 'Смотрите [cid:image001.png@01D] и [img:https://x.org/a.png]');
});

test('.eml inline image is extracted and referenced by cid', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const eml = [
    'From: Cui <cui@haier.com>', 'Subject: Photo', 'Date: Mon, 22 Sep 2025 10:15:00 +0000',
    'Content-Type: multipart/related; boundary="r"', '',
    '--r', 'Content-Type: text/html; charset=utf-8', '',
    '<p>Dear Sergei,</p><p>See photo:<br><img src="cid:photo1@x" width=100></p>',
    '--r', 'Content-Type: image/png; name="board.png"', 'Content-ID: <photo1@x>', 'Content-Transfer-Encoding: base64', '',
    png.toString('base64'), '--r--'
  ].join('\r\n');
  const mail = MailFile.fileToMail('a.eml', new Uint8Array(Buffer.from(eml, 'latin1')));
  assert.equal(mail.images.length, 1);
  assert.equal(mail.images[0].cid, 'photo1@x');
  assert.equal(mail.images[0].mime, 'image/png');
  assert.deepEqual(Buffer.from(mail.images[0].bytes), png);
  assert.deepEqual(parseThread(mail.text)[0].lines, ['Dear Sergei,', 'See photo:', '[cid:photo1@x]']);
});
