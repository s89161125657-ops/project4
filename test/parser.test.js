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
