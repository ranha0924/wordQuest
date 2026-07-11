/* ================================================================
   lib.mjs — 복귀 알림 순수 로직 (의존성 0 · 단위 테스트 대상)
   ----------------------------------------------------------------
   · 네트워크/파이어베이스와 무관한 계산만 담는다.
   · countDueWords 는 앱(index.html)의 dueIds() 규칙을 그대로 미러:
       due 가 없거나(null/''), due <= 오늘 이면 복습 대상.
   · 삭제 표식(deleted) 단어는 제외 — cloud.js 병합 규칙과 동일.
   ================================================================ */

/** 주어진 시각(now, ms)을 IANA 타임존 tz 기준 'YYYY-MM-DD' 로 반환. */
export function todayInTimeZone(tz, now = Date.now()) {
  const fmt = (zone) => new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(now));
  try {
    return fmt(tz || 'UTC');
  } catch {
    // 잘못된 타임존 → UTC 로 폴백(크래시 방지)
    return fmt('UTC');
  }
}

/**
 * 복습 예정 단어 수. 앱 dueIds() 와 동일 규칙.
 * @param {Object} words  Firestore users/{uid}.words 맵 { id: wordObj }
 * @param {string} todayStr  'YYYY-MM-DD'
 */
export function countDueWords(words, todayStr) {
  if (!words || typeof words !== 'object') return 0;
  let n = 0;
  for (const id of Object.keys(words)) {
    const w = words[id];
    if (!w || w.deleted) continue;          // 삭제 표식 제외
    const due = w.due;
    if (!due || due <= todayStr) n++;        // due 없음 or 오늘 이하 → 복습 대상
  }
  return n;
}

/**
 * 이 사용자에게 지금 알림을 보낼지 판단.
 * @returns {{send:boolean, reason?:string, due?:number, streak?:number}}
 */
export function shouldRemind(userDoc, todayStr) {
  const meta = (userDoc && userDoc.meta) || {};
  if (meta.notify !== true) return { send: false, reason: 'opted-out' };
  const due = countDueWords(userDoc && userDoc.words, todayStr);
  if (due <= 0) return { send: false, reason: 'nothing-due' };
  return { send: true, due, streak: meta.streak || 0 };
}

/** HTML 이스케이프(제목/본문에 사용자 값이 섞일 경우 대비). */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * 복습 리마인더 이메일 본문 구성(제목 · text · html).
 * 브랜드(16비트 JRPG) 톤. 외부 이미지 없음(이메일 이미지 차단 무해).
 * @param {{due:number, streak?:number, appUrl?:string, fromName?:string}} p
 */
export function buildEmail(p) {
  const due = Math.max(0, p.due | 0);
  const streak = Math.max(0, (p.streak || 0) | 0);
  const appUrl = p.appUrl || '';
  const fromName = p.fromName || 'WordQuest';

  const subject = `⚔️ 오늘 복습할 몬스터 ${due}마리가 던전에서 기다려요`;
  const streakLine = streak > 0
    ? `${streak}일 연속 학습 중 — 오늘도 이어가요!`
    : '오늘, 새로운 연속 학습 기록을 시작해요!';

  // ── 플레인 텍스트 ──
  const text = [
    `던전에 몬스터 ${due}마리가 나타났다!`,
    '기억이 흐려지기 전에 오늘 복습을 끝내자.',
    '',
    streakLine,
    appUrl ? `\n지금 복습하러 가기 → ${appUrl}` : '',
    '',
    `— ${fromName}`,
    '알림을 끄려면 앱 영입소의 “매일 복습 알림”을 해제하세요.'
  ].filter((l) => l !== '').join('\n');

  // ── HTML(인라인 스타일 · 테이블 레이아웃 · 다크 아케이드 톤) ──
  const btnRow = appUrl ? `
        <tr><td align="center" style="padding:22px 26px 4px;">
          <a href="${esc(appUrl)}" style="display:inline-block;background:#ffd23f;color:#1a1030;
             font-weight:700;text-decoration:none;padding:13px 26px;border-radius:8px;
             font-size:15px;border:2px solid #1a1030;">▶ 지금 복습하러 가기</a>
        </td></tr>` : '';

  const html = `<!doctype html><html lang="ko"><body style="margin:0;padding:0;background:#0d0d1a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0d0d1a;">
    <tr><td align="center" style="padding:28px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:440px;background:#171730;border:2px solid #34345a;border-radius:14px;
                    font-family:'Segoe UI',system-ui,-apple-system,sans-serif;color:#e8e8f0;">
        <tr><td style="padding:26px 26px 8px;text-align:center;">
          <div style="font-size:13px;letter-spacing:3px;color:#8a8ac0;">W O R D　Q U E S T</div>
          <div style="font-size:46px;line-height:1.1;margin:10px 0 2px;">⚔️👾</div>
        </td></tr>
        <tr><td style="padding:4px 26px 0;text-align:center;">
          <div style="font-size:20px;font-weight:700;color:#ffd23f;">
            오늘 복습할 몬스터 ${due}마리
          </div>
          <div style="font-size:14px;color:#c5c5e0;margin-top:8px;line-height:1.6;">
            던전에 몬스터 ${due}마리가 다시 나타났다.<br>기억이 흐려지기 전에 오늘 복습을 끝내자!
          </div>
        </td></tr>
        <tr><td style="padding:16px 26px 0;text-align:center;">
          <div style="display:inline-block;background:#0d0d1a;border:1px solid #34345a;border-radius:8px;
                      padding:10px 16px;font-size:13px;color:#9be89b;">🔥 ${esc(streakLine)}</div>
        </td></tr>
        ${btnRow}
        <tr><td style="padding:22px 26px 24px;text-align:center;
                   border-top:1px solid #262647;margin-top:14px;">
          <div style="font-size:11px;color:#6a6a95;line-height:1.7;">
            간격 반복(SRS) 일정에 맞춘 복습 알림이에요.<br>
            알림을 끄려면 앱 <b>영입소</b>의 “매일 복습 알림”을 해제하세요.
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, text, html };
}
