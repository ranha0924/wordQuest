/* ================================================================
   send-reminders.mjs — WordQuest 일일 복귀 알림 발송 (Node 20+)
   ----------------------------------------------------------------
   흐름:
     1) Firestore users/* 문서 로드 (firebase-admin, 서비스 계정)
     2) 각 사용자: meta.notify && due>0 이면 대상 (lib.shouldRemind)
     3) 이메일은 Auth 에서 uid 로 조회 (Firestore 문서엔 이메일 없음)
     4) SendGrid v3 API 로 발송 (fetch, SDK 불필요)

   오프라인/무자격 검증:
     node send-reminders.mjs --dry-run --fixture fixtures/sample-users.json
       → 파이어베이스/네트워크 없이 대상 선별 + 이메일 미리보기만 출력.

   필요 환경변수(실발송):
     FIREBASE_SERVICE_ACCOUNT  서비스 계정 키 JSON (문자열)
     SENDGRID_API_KEY          SendGrid API 키
     REMINDER_FROM_EMAIL       인증된 발신 이메일
   선택:
     REMINDER_FROM_NAME  (기본 'WordQuest')
     REMINDER_APP_URL    복습하러 가기 링크(배포 URL)
     REMINDER_TZ         기본 타임존 (기본 'Asia/Seoul'; meta.tz 있으면 우선)
     REMINDER_DRY_RUN=1  --dry-run 과 동일
   ================================================================ */
import { readFileSync } from 'node:fs';
import { todayInTimeZone, shouldRemind, buildEmail } from './lib.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

const DRY_RUN = has('--dry-run') || process.env.REMINDER_DRY_RUN === '1';
const FIXTURE = val('--fixture');

const ENV = {
  fromName: process.env.REMINDER_FROM_NAME || 'WordQuest',
  fromEmail: process.env.REMINDER_FROM_EMAIL || '',
  appUrl: process.env.REMINDER_APP_URL || '',
  defaultTz: process.env.REMINDER_TZ || 'Asia/Seoul',
  sendgridKey: process.env.SENDGRID_API_KEY || '',
};

function log(...a) { console.log(...a); }
function fail(msg) { console.error('✗ ' + msg); process.exit(1); }

/* ── 사용자 로드: fixture(오프라인) 또는 Firestore ─────────────── */
async function loadUsers() {
  if (FIXTURE) {
    // fixtures/*.json = [{ uid, email, words:{...}, meta:{...} }, ...]
    const arr = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    log(`· fixture 로드: ${FIXTURE} (${arr.length}명)`);
    return arr;
  }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) fail('FIREBASE_SERVICE_ACCOUNT 미설정 (또는 --fixture 를 쓰세요).');

  let svc;
  try { svc = JSON.parse(raw); }
  catch { fail('FIREBASE_SERVICE_ACCOUNT 가 유효한 JSON 이 아닙니다.'); }

  // firebase-admin 은 실발송 경로에서만 동적 import (fixture 검증 시 미설치여도 OK)
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const { getAuth } = await import('firebase-admin/auth');

  const app = initializeApp({ credential: cert(svc) });
  const db = getFirestore(app);
  const auth = getAuth(app);

  const snap = await db.collection('users').get();
  log(`· Firestore users: ${snap.size}개 문서`);

  const users = [];
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    let email = null;
    try { email = (await auth.getUser(doc.id)).email || null; }
    catch (e) { console.warn(`  · ${doc.id}: Auth 이메일 조회 실패(${e.code || e.message})`); }
    users.push({ uid: doc.id, email, words: data.words, meta: data.meta });
  }
  return users;
}

/* ── SendGrid v3 발송 (fetch) ─────────────────────────────────── */
async function sendEmail(to, msg) {
  const body = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: ENV.fromEmail, name: ENV.fromName },
    subject: msg.subject,
    content: [
      { type: 'text/plain', value: msg.text },
      { type: 'text/html', value: msg.html },
    ],
    headers: { 'List-Unsubscribe': `<mailto:${ENV.fromEmail}?subject=unsubscribe>` },
    tracking_settings: {
      click_tracking: { enable: false },
      open_tracking: { enable: false },
    },
  };
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ENV.sendgridKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`SendGrid ${res.status} ${res.statusText} ${detail}`);
  }
}

/* ── 메인 ─────────────────────────────────────────────────────── */
async function main() {
  log(`WordQuest 복귀 알림 — ${DRY_RUN ? 'DRY-RUN(발송 안 함)' : '실발송'}`);

  if (!DRY_RUN && !FIXTURE) {
    const req = { FIREBASE_SERVICE_ACCOUNT: process.env.FIREBASE_SERVICE_ACCOUNT, SENDGRID_API_KEY: ENV.sendgridKey, REMINDER_FROM_EMAIL: ENV.fromEmail };
    const missing = Object.keys(req).filter((k) => !req[k]);
    // 전혀 미설정(초기 상태) → 크론 실패 알림 스팸 방지 위해 정상 종료.
    if (missing.length === Object.keys(req).length) {
      log('복귀 알림 미설정 — 시크릿 3종 등록 전. 건너뜀(docs/reminder-setup.md).');
      return;
    }
    // 일부만 설정 → 설정 오류이므로 명시적 실패.
    if (missing.length) fail('설정 누락: ' + missing.join(', '));
  }

  const users = await loadUsers();
  let targeted = 0, sent = 0, failed = 0;
  const skips = { 'opted-out': 0, 'nothing-due': 0, 'no-email': 0 };

  for (const u of users) {
    const tz = (u.meta && u.meta.tz) || ENV.defaultTz;
    const today = todayInTimeZone(tz);
    const decision = shouldRemind(u, today);

    if (!decision.send) { skips[decision.reason] = (skips[decision.reason] || 0) + 1; continue; }
    if (!u.email) { skips['no-email']++; log(`  · ${u.uid}: 이메일 없음 — 건너뜀`); continue; }

    targeted++;
    const msg = buildEmail({
      due: decision.due, streak: decision.streak,
      appUrl: ENV.appUrl, fromName: ENV.fromName,
    });

    if (DRY_RUN) {
      log(`  ▷ [dry] ${u.email}  (due ${decision.due}, streak ${decision.streak}, tz ${tz})`);
      log(`         제목: ${msg.subject}`);
      continue;
    }
    try {
      await sendEmail(u.email, msg);
      sent++;
      log(`  ✓ ${u.email}  (due ${decision.due})`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${u.email}: ${e.message}`);
    }
  }

  log('────────────────────────────────');
  log(`대상 ${targeted}명 · ${DRY_RUN ? '미리보기' : `발송 ${sent} / 실패 ${failed}`}`);
  log(`건너뜀: 옵트아웃 ${skips['opted-out']} · 복습없음 ${skips['nothing-due']} · 이메일없음 ${skips['no-email']}`);

  if (!DRY_RUN && failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
