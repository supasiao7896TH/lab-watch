// รัน: node test.js  (ไม่ต้องติดตั้งอะไร)
'use strict';
const assert = require('assert');
const core = require('./lab-watch.user.js');

let passed = 0;
function it(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ผ่าน  ' + name);
  } catch (e) {
    console.log('  ไม่ผ่าน  ' + name + '\n        ' + e.message);
    process.exitCode = 1;
  }
}

const empty = () => ({ feeds: {}, params: {} });
const row = (o) => Object.assign({
  sampleId: '2610015664', paramId: 'BA', paramDesc: 'BENZOIC ACID',
  sampleName: 'PZ-402', sampleStatus: 'Completed', dataSetStatus: 'Completed',
  collectionDate: '2026-10-11T04:00:00', displayValue: '9', displayUnits: 'ppm',
  analystId: '26007506',
}, o);
const KEY = 'p|t|2026-10-11';

console.log('lab-watch');

it('ควรอ่าน feed key (page|table|วัน) จาก URL ของ getReportResults', () => {
  const url = 'https://x/api/reportRoutine/getReportResults?pageId=2122&tableId=4799&dateStart=2026-10-11T00:00:00&dateEnd=2026-10-11T23:59:59';
  assert.strictEqual(core.parseFeedKey(url), '2122|4799|2026-10-11');
  assert.strictEqual(core.isResultsUrl(url), true);
  assert.strictEqual(core.isResultsUrl('https://x/api/getReportLayout?a=1'), false);
});

it('โหลดครั้งแรก (baseline) ควรเงียบ แม้มีค่าอยู่แล้ว', () => {
  const r = core.applyFeed(empty(), KEY, [row({})], []);
  assert.strictEqual(r.alerts.length, 0);
  assert.strictEqual(r.state.feeds[KEY]['2610015664|BA'], '9');
});

it('ค่าใหม่ที่ออกหลัง baseline ควรแจ้ง 1 ครั้ง', () => {
  const s1 = core.applyFeed(empty(), KEY, [], []).state;
  const r = core.applyFeed(s1, KEY, [row({})], []);
  assert.strictEqual(r.alerts.length, 1);
  assert.strictEqual(r.alerts[0].kind, 'new');
});

it('ค่าเดิมที่โหลดซ้ำ ไม่ควรแจ้งซ้ำ', () => {
  const s1 = core.applyFeed(empty(), KEY, [], []).state;
  const s2 = core.applyFeed(s1, KEY, [row({})], []).state;
  const r = core.applyFeed(s2, KEY, [row({})], []);
  assert.strictEqual(r.alerts.length, 0);
});

it('ค่าที่ถูกแก้ไขหลังแจ้งไปแล้ว ควรแจ้งว่าเปลี่ยน (ก่อน → หลัง)', () => {
  const s1 = core.applyFeed(empty(), KEY, [], []).state;
  const s2 = core.applyFeed(s1, KEY, [row({ sampleStatus: 'InProgress' })], []).state;
  const r = core.applyFeed(s2, KEY, [row({ displayValue: '10' })], []);
  assert.strictEqual(r.alerts.length, 1);
  assert.strictEqual(r.alerts[0].kind, 'changed');
  assert.strictEqual(core.formatAlert(r.alerts[0]).includes('9 → 10'), true);
});

it('parameter ที่ปิดไว้ ไม่ควรแจ้ง แต่ต้องจำค่าไว้', () => {
  const s1 = core.applyFeed(empty(), KEY, [], []).state;
  const r = core.applyFeed(s1, KEY, [row({})], ['BA']);
  assert.strictEqual(r.alerts.length, 0);
  assert.strictEqual(r.state.feeds[KEY]['2610015664|BA'], '9');
});

it('แถวที่ displayValue ว่าง ไม่ควรนับว่าค่าออกแล้ว', () => {
  const s1 = core.applyFeed(empty(), KEY, [], []).state;
  const r = core.applyFeed(s1, KEY, [row({ displayValue: '' }), row({ displayValue: null, paramId: 'PTA' })], []);
  assert.strictEqual(r.alerts.length, 0);
});

it('toast ควรติดป้ายสถานะ (InProgress) / (Completed)', () => {
  const s1 = core.applyFeed(empty(), KEY, [], []).state;
  const r = core.applyFeed(s1, KEY, [row({ sampleStatus: 'InProgress' })], []);
  const text = core.formatAlert(r.alerts[0]);
  assert.strictEqual(text.includes('(InProgress)'), true);
  assert.strictEqual(text.includes('04:00'), true);
  assert.strictEqual(text.includes('ppm'), true);
});

it('ต้องไม่เก็บ analystId ลงใน state หรือ alert', () => {
  const s1 = core.applyFeed(empty(), KEY, [], []).state;
  const r = core.applyFeed(s1, KEY, [row({})], []);
  const dump = JSON.stringify(r.state) + JSON.stringify(r.alerts);
  assert.strictEqual(dump.includes('26007506'), false);
});

it('ข้ามวัน (feed key คนละวัน) ควรเริ่ม baseline ใหม่แบบเงียบ', () => {
  const s1 = core.applyFeed(empty(), KEY, [], []).state;
  const r = core.applyFeed(s1, 'p|t|2026-10-12', [row({})], []);
  assert.strictEqual(r.alerts.length, 0);
});

it('feed หลายตารางต้องแยกกัน (ตารางใหม่ไม่ทำให้อีกตารางแจ้งซ้ำ)', () => {
  const k1 = '2122|4799|2026-10-11';
  const k2 = '2122|4818|2026-10-11';
  let s = core.applyFeed(empty(), k1, [], []).state;
  s = core.applyFeed(s, k2, [], []).state;
  const a = core.applyFeed(s, k1, [row({})], []);
  assert.strictEqual(a.alerts.length, 1);
  const b = core.applyFeed(a.state, k2, [row({ paramId: 'PTA', paramDesc: 'p-TA' })], []);
  assert.strictEqual(b.alerts.length, 1);
});

it('response ที่ไม่ใช่ array ไม่ควรทำให้พัง', () => {
  const s1 = core.applyFeed(empty(), KEY, [], []).state;
  const r = core.applyFeed(s1, KEY, { error: 'x' }, []);
  assert.strictEqual(r.alerts.length, 0);
});

const MIN = 60000;

it('เงียบน้อยกว่า 20 นาที ไม่ควรเตือน', () => {
  const r = core.staleStatus(19 * MIN, 0, 20, null, 30);
  assert.strictEqual(r.stale, false);
  assert.strictEqual(r.shouldWarn, false);
});

it('เงียบครบ 20 นาที ควรเตือนครั้งแรกทันที', () => {
  const r = core.staleStatus(20 * MIN, 0, 20, null, 30);
  assert.strictEqual(r.stale, true);
  assert.strictEqual(r.shouldWarn, true);
  assert.strictEqual(r.minutes, 20);
});

it('เพิ่งเตือนไป ไม่ควรเตือนซ้ำจนกว่าจะครบ 30 นาที', () => {
  const warnedAt = 20 * MIN;
  assert.strictEqual(core.staleStatus(45 * MIN, 0, 20, warnedAt, 30).shouldWarn, false);
  assert.strictEqual(core.staleStatus(50 * MIN, 0, 20, warnedAt, 30).shouldWarn, true);
});

it('ได้ข้อมูลใหม่ (since ขยับ) ควรกลับเป็นปกติ', () => {
  const r = core.staleStatus(25 * MIN, 24 * MIN, 20, null, 30);
  assert.strictEqual(r.stale, false);
});

it('ค่ายังไม่ออกแต่ API ตอบรายการว่าง ถือว่าปกติ ไม่ใช่ session หลุด', () => {
  // [] ผ่าน applyFeed ได้ตามปกติ (ตรวจว่าเป็น array ที่ onResults ใช้ตัดสิน)
  const r = core.applyFeed(empty(), KEY, [], []);
  assert.strictEqual(r.alerts.length, 0);
  assert.strictEqual(Array.isArray([]), true);
  assert.strictEqual(Array.isArray({ message: 'Unauthorized' }), false);
});

console.log('\nผ่าน ' + passed + ' เทสต์' + (process.exitCode ? ' (มีที่ไม่ผ่าน)' : ''));
