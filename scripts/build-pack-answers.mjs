#!/usr/bin/env node
/* ============================================================================
   WordQuest 팩 MC 번들 빌더 (서버 출제 4지선다·index 채점용 · r17/2단계)
   ----------------------------------------------------------------------------
   목적: 단어은행/팩 파일(words.js·pack-*.js)에서 각 단어의 {뜻 m, 단어 w} 평문을
        rank-worker/worker.js · worker-dashboard.js(트윈) 두 파일의
        PACK_ANSWERS_START ~ PACK_ANSWERS_END 마커 사이에 PACK_MC 로 인라인 주입한다.

        · PACK_MC[id] = { m: <한글 뜻(w.m)>, w: <영어 단어(w.w)> }
        서버가 이 뜻으로 4지선다(정답=m·오답=다른 단어의 뜻)를 출제하고, 클라는 '고른 번호'만
        보낸다(정답 텍스트 미전송 → id-echo 무효). 뜻은 이미 공개(오프라인 렌더용)라 평문 저장이
        노출을 늘리지 않는다. ★해시/솔트 불요(과거 he/hk 방식 폐기).

   ★ id = e.w.toLowerCase() — 앱 seedPack/seedTheme 규칙과 동일.
   사용:  node scripts/build-pack-answers.mjs      (환경변수 불필요)
          → 두 트윈에 PACK_MC/PACK_IDS 주입. 단어 파일이 바뀌면 재실행 후 워커 재배포.
   ============================================================================ */
import { readFileSync, writeFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── 단어 파일 로드(window 글로벌 방식) — 각 파일은 window.WORDBANK / window.WORDPACK_* 를 설정 ──
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

// id(=소문자 표기) 중복은 '첫 등장 우선'(앱 BANK 규칙과 동일). 뜻(m) 없으면 4지선다 출제 불가 → 제외.
const SOURCES = ['WORDBANK', 'WORDPACK_HS1', 'WORDPACK_HS2', 'WORDPACK_HS3', 'WORDPACK_CONFUSE', 'WORDPACK_VACATION'];
const mc = {};   // id -> {m, w}
const ids = [];
let total = 0, dup = 0, skipped = 0;
for (const key of SOURCES) {
  const arr = win[key];
  if (!Array.isArray(arr)) { console.warn('· 소스 없음: window.' + key); continue; }
  for (const e of arr) {
    if (!e || typeof e.w !== 'string' || !e.w.trim()) { skipped++; continue; }
    const id = e.w.toLowerCase();
    total++;
    if (Object.prototype.hasOwnProperty.call(mc, id)) { dup++; continue; }  // 첫 등장 우선
    const m = (e.m == null) ? '' : String(e.m);
    if (!m.trim()) { skipped++; continue; }                                 // 뜻 없음 → 출제 불가
    mc[id] = { m: m, w: e.w };
    ids.push(id);
  }
}
if (!ids.length) { console.error('✖ 단어를 하나도 못 읽었습니다. 단어 파일 경로/형식 확인.'); process.exit(1); }

// ── 데이터 블록 텍스트 생성(결정론적: id 정렬로 재현 가능한 diff) ──
ids.sort();
const mcEntries = ids.map((id) => JSON.stringify(id) + ':' + JSON.stringify({ m: mc[id].m, w: mc[id].w }));
const idEntries = ids.map((id) => JSON.stringify(id));
const block =
  '/*__PACK_ANSWERS_START__*/\n' +
  '// 생성물: scripts/build-pack-answers.mjs (id ' + ids.length + '개). 직접 수정 금지 — 스크립트로 재생성.\n' +
  'const PACK_MC = {' + mcEntries.join(',') + '};\n' +
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

console.log('── 완료: ' + ids.length + '개 팩 id (원본 ' + total + '개, 중복 ' + dup + ', 스킵(뜻없음 등) ' + skipped + ')');
console.log('   PACK_MC 평문(뜻/단어) 주입 — SALT 불요. index 채점이라 정답 텍스트는 클라가 못 보냄.');
