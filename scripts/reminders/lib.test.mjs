/* node --test 로 실행. 네트워크/파이어베이스 불필요. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { todayInTimeZone, countDueWords, shouldRemind, buildEmail } from './lib.mjs';

// 2026-07-11 14:30 UTC 고정 시각.
const NOW = Date.UTC(2026, 6, 11, 14, 30, 0);

test('todayInTimeZone: UTC vs KST 날짜 경계', () => {
  assert.equal(todayInTimeZone('UTC', NOW), '2026-07-11');
  assert.equal(todayInTimeZone('Asia/Seoul', NOW), '2026-07-11'); // +9 → 23:30 같은 날
  // 자정 근처: 15:30 UTC = 00:30 KST 다음날
  const late = Date.UTC(2026, 6, 11, 15, 30, 0);
  assert.equal(todayInTimeZone('UTC', late), '2026-07-11');
  assert.equal(todayInTimeZone('Asia/Seoul', late), '2026-07-12');
});

test('todayInTimeZone: 잘못된 타임존 → UTC 폴백', () => {
  assert.equal(todayInTimeZone('Not/AZone', NOW), '2026-07-11');
  assert.equal(todayInTimeZone(undefined, NOW), '2026-07-11');
});

test('countDueWords: dueIds() 규칙 미러', () => {
  const today = '2026-07-11';
  const words = {
    past:    { id: 'past',    due: '2026-07-01' }, // 지남 → 대상
    today:   { id: 'today',   due: '2026-07-11' }, // 오늘 → 대상
    future:  { id: 'future',  due: '2026-08-01' }, // 미래 → 제외
    nodue:   { id: 'nodue',   due: null },         // due 없음 → 대상
    empty:   { id: 'empty',   due: '' },           // 빈 문자열 → 대상
    gone:    { id: 'gone',    due: '2026-07-01', deleted: true }, // 삭제 → 제외
  };
  assert.equal(countDueWords(words, today), 4); // past, today, nodue, empty
});

test('countDueWords: 빈/이상 입력 방어', () => {
  assert.equal(countDueWords(null, '2026-07-11'), 0);
  assert.equal(countDueWords({}, '2026-07-11'), 0);
  assert.equal(countDueWords(undefined, '2026-07-11'), 0);
});

test('shouldRemind: 옵트아웃 / 없음 / 발송', () => {
  const today = '2026-07-11';
  const due = { a: { due: '2026-07-01' } };

  assert.deepEqual(
    shouldRemind({ words: due, meta: { notify: false } }, today),
    { send: false, reason: 'opted-out' }
  );
  assert.deepEqual(
    shouldRemind({ words: due, meta: {} }, today), // notify 미설정 → 기본 꺼짐
    { send: false, reason: 'opted-out' }
  );
  assert.deepEqual(
    shouldRemind({ words: {}, meta: { notify: true } }, today),
    { send: false, reason: 'nothing-due' }
  );
  const ok = shouldRemind({ words: due, meta: { notify: true, streak: 5 } }, today);
  assert.equal(ok.send, true);
  assert.equal(ok.due, 1);
  assert.equal(ok.streak, 5);
});

test('buildEmail: 제목/본문에 개수·링크·연속 반영', () => {
  const e = buildEmail({ due: 7, streak: 3, appUrl: 'https://example.app/' });
  assert.match(e.subject, /7마리/);
  assert.match(e.text, /7마리/);
  assert.match(e.text, /https:\/\/example\.app\//);
  assert.match(e.text, /3일 연속/);
  assert.match(e.html, /7마리/);
  assert.match(e.html, /example\.app/);
});

test('buildEmail: streak 0 → 시작 문구, appUrl 없으면 버튼/링크 생략', () => {
  const e = buildEmail({ due: 1, streak: 0 });
  assert.match(e.text, /새로운 연속 학습 기록/);
  assert.doesNotMatch(e.text, /지금 복습하러 가기 →/); // 링크 줄 생략
  assert.doesNotMatch(e.html, /지금 복습하러 가기/);   // 버튼 생략
});
