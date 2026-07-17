#!/usr/bin/env node
/* ============================================================================
   WordQuest 팩 정답 해시 번들 빌더 (서버 세션 채점용)
   ----------------------------------------------------------------------------
   목적: 단어은행/팩 파일(words.js·pack-*.js)에서 각 단어의 정답 해시를 만들어
        rank-worker/worker.js · worker-dashboard.js(트윈) 두 파일의
        PACK_ANSWERS_START ~ PACK_ANSWERS_END 마커 사이에 인라인 주입한다.

        · he = sha256hex( SALT | 'en' | normEn(w.w) )   ← 영어 답 모드(k2e·k2e4·cloze·listen)
        · hk = sha256hex( SALT | 'ko' | normKo(w.m) )    ← e2k(뜻 고르기, 정답=w.m 전체)
        산출물엔 '해시'만 들어가고 원문 정답·salt 는 들어가지 않는다.

   ★ 워커의 normEn/normKo/sha256hex 와 '바이트 동일'해야 한다(불일치 시 전 팩 검증 실패).
   ★ salt 는 워커 env ANSWER_SALT 와 동일해야 한다.

   사용:  ANSWER_SALT="<워커 env 와 동일값>" node scripts/build-pack-answers.mjs
   ============================================================================ */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SALT = process.env.ANSWER_SALT;
if (!SALT) {
  console.error('✖ ANSWER_SALT 환경변수가 필요합니다(워커 env 와 동일값).');
  console.error('  예: ANSWER_SALT="$(openssl rand -hex 16)" node scripts/build-pack-answers.mjs');
  process.exit(1);
}

// ── 정규화 — ★워커 C2 의 normEn/normKo 와 반드시 동일 정의 ──
const normEn = (x) => String(x == null ? '' : x).toLowerCase().trim().replace(/\s+/g, ' ');
const normKo = (x) => String(x == null ? '' : x).trim().replace(/\s+/g, ' ');
const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const he = (w) => sha256hex(SALT + '|en|' + normEn(w));
const hk = (m) => sha256hex(SALT + '|ko|' + normKo(m));

// ── 단어 파일 로드(window 글로벌 방식) ──
//   각 파일은 `window.WORDBANK = [...]` / `window.WORDPACK_* = [...]` 를 설정한다.
const FILES = ['words.js', 'pack-hs1.js', 'pack-hs2.js', 'pack-hs3.js', 'pack-confuse.js', 'pack-vacation.js'];
const win = {};
const sandbox = { window: win };
sandbox.self = win; sandbox.globalThis = sandbox;
const ctx = createContext(sandbox);
for (const f of FILES) {
  let src;
  try { src = readFileSync(join(ROOT, f), 'utf8'); }
  catch (e) { console.warn('· 건너뜀(없음): ' + f); continue; }
  try { runInContext(src, ctx, { filename: f }); }
  catch (e) { console.error('✖ 로드 실패 ' + f + ': ' + e.message); process.exit(1); }
}

// 단어 배열들을 순서대로 모으되 id(=소문자 표기) 중복은 '첫 등장 우선'(앱 BANK 규칙과 동일).
const SOURCES = ['WORDBANK', 'WORDPACK_HS1', 'WORDPACK_HS2', 'WORDPACK_HS3', 'WORDPACK_CONFUSE', 'WORDPACK_VACATION'];
const answers = {};   // id -> {he, hk}
const ids = [];
let total = 0, dup = 0, skipped = 0;
for (const key of SOURCES) {
  const arr = win[key];
  if (!Array.isArray(arr)) { console.warn('· 소스 없음: window.' + key); continue; }
  for (const e of arr) {
    if (!e || typeof e.w !== 'string' || !e.w.trim()) { skipped++; continue; }
    const id = e.w.toLowerCase();       // ★ 앱 seedPack/seedTheme 의 id = e.w.toLowerCase()
    total++;
    if (Object.prototype.hasOwnProperty.call(answers, id)) { dup++; continue; }  // 첫 등장 우선
    const m = (e.m == null) ? '' : String(e.m);
    answers[id] = { he: he(e.w), hk: hk(m) };
    ids.push(id);
  }
}
if (!ids.length) { console.error('✖ 단어를 하나도 못 읽었습니다. 단어 파일 경로/형식 확인.'); process.exit(1); }

// ── 데이터 블록 텍스트 생성(결정론적: id 정렬로 재현 가능한 diff) ──
ids.sort();
const answerEntries = ids.map((id) => JSON.stringify(id) + ':{he:"' + answers[id].he + '",hk:"' + answers[id].hk + '"}');
const idEntries = ids.map((id) => JSON.stringify(id));
const block =
  '/*__PACK_ANSWERS_START__*/\n' +
  '// 생성물: scripts/build-pack-answers.mjs (id ' + ids.length + '개). 직접 수정 금지 — 스크립트로 재생성.\n' +
  'const PACK_ANSWERS = {' + answerEntries.join(',') + '};\n' +
  'const PACK_IDS = new Set([' + idEntries.join(',') + ']);\n' +
  '/*__PACK_ANSWERS_END__*/';

// ── 두 트윈 파일의 마커 사이 치환 ──
const MARK = /\/\*__PACK_ANSWERS_START__\*\/[\s\S]*?\/\*__PACK_ANSWERS_END__\*\//;
const TARGETS = ['rank-worker/worker.js', 'rank-worker/worker-dashboard.js'];
for (const t of TARGETS) {
  const p = join(ROOT, t);
  let code;
  try { code = readFileSync(p, 'utf8'); }
  catch (e) { console.error('✖ 대상 없음: ' + t); process.exit(1); }
  if (!MARK.test(code)) { console.error('✖ 마커 없음: ' + t + ' (/*__PACK_ANSWERS_START__*/ … END 필요)'); process.exit(1); }
  writeFileSync(p, code.replace(MARK, block), 'utf8');
  console.log('✔ 주입: ' + t);
}

console.log('── 완료: ' + ids.length + '개 팩 id (원본 ' + total + '개, 중복 ' + dup + ', 스킵 ' + skipped + ')');
console.log('   he/hk 는 SALT 로 해시됨(원문/솔트 미포함). 워커 env ANSWER_SALT 를 동일값으로 설정할 것.');
