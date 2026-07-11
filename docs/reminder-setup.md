# 복귀 알림 셋업 가이드 (매일 복습 메일 켜기 · ①)

SRS(간격 반복) 예정일에 맞춰 **매일 "오늘 복습 N마리" 메일**을 보냅니다.
서버·카드 없이 **GitHub Actions 크론 + SendGrid**로 동작 — 전부 무료 범위.

> **선행 조건**: 클라우드 동기화(Firebase)가 먼저 켜져 있어야 합니다(`docs/firebase-setup.md`).
> 알림은 로그인해서 Firestore에 진도가 올라간 사용자에게만 나갑니다.
> **옵트인**: 사용자가 앱 **영입소 → 매일 복습 알림**을 켠 경우에만 발송(`meta.notify`). 기본은 꺼짐.

작동 방식: 크론 → `scripts/reminders/send-reminders.mjs` → Firestore `users/*` 로드 →
`notify` 켜짐 & 복습 예정(`due<=오늘`) > 0 인 사용자만 → Auth에서 이메일 조회 → SendGrid 발송.

---

## 1) SendGrid — 발신 준비 (약 5분, 무료 100통/일)
1. https://sendgrid.com 가입 → 로그인.
2. **Settings → Sender Authentication → Single Sender Verification** 에서 발신 이메일 등록(본인 메일 OK) → 받은 인증 메일 클릭.
   - (도메인이 있으면 Domain Authentication 이 더 좋지만, Single Sender 로 충분히 시작 가능.)
3. **Settings → API Keys → Create API Key** → 권한 **Restricted → Mail Send 만 On** → 생성 → 키 문자열 복사(한 번만 보임).

## 2) Firebase — 서비스 계정 키 (약 2분)
1. Firebase 콘솔 → **프로젝트 설정(톱니) → 서비스 계정** 탭.
2. **새 비공개 키 생성 → 키 생성** → JSON 파일 다운로드.
   - 이 JSON은 **관리자 비밀키**입니다. 저장소에 커밋 금지. GitHub Secret 에만 넣습니다.
   - 서비스 계정은 `firestore.rules` 를 우회(관리자)하므로 규칙 수정은 필요 없습니다.

## 3) GitHub — 시크릿 등록
저장소 → **Settings → Secrets and variables → Actions → Secrets → New repository secret** 로 3개:

| 이름 | 값 |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | 2)에서 받은 **JSON 파일 전체 내용**을 그대로 붙여넣기 |
| `SENDGRID_API_KEY` | 1)에서 만든 API 키 |
| `REMINDER_FROM_EMAIL` | 1)에서 인증한 발신 이메일 |

**선택**(같은 화면 **Variables** 탭 → New variable, 비민감):

| 이름 | 기본값 | 설명 |
|---|---|---|
| `REMINDER_APP_URL` | (없음) | 메일 "지금 복습하러 가기" 버튼 링크. 배포 URL 넣기 |
| `REMINDER_FROM_NAME` | `WordQuest` | 발신자 표시 이름 |
| `REMINDER_TZ` | `Asia/Seoul` | "오늘" 계산 기본 타임존. 사용자별 `meta.tz` 있으면 그쪽 우선 |

## 4) 동작 확인 (발송 없이)
- **GitHub**: 저장소 → **Actions → daily-reminder → Run workflow** → `dry_run ✓` 후 실행 → 로그에 대상/제목 미리보기만 출력(메일 안 감).
- **로컬**(선택, 파이어베이스 없이 로직만):
  ```bash
  cd scripts/reminders
  npm install
  npm test                                   # 단위 테스트
  REMINDER_APP_URL=https://example.app/ npm run dry-run   # fixtures 로 파이프라인 미리보기
  ```

## 5) 자동 발송
- 준비되면 크론이 **매일 08:00 KST(=23:00 UTC)** 에 자동 실행됩니다.
- 시간 변경: `.github/workflows/daily-reminder.yml` 의 `cron: '0 23 * * *'` 수정(UTC 기준).
- 실제 첫 발송 확인: `dry_run` 없이 Run workflow → 옵트인 켠 계정 메일함 확인.

---

## 비용
- **GitHub Actions**: 퍼블릭 저장소 무료. 프라이빗도 월 무료분(하루 1분 미만 사용).
- **SendGrid**: 무료 100통/일.
- **Firebase**: Spark(무료) — 읽기만 함.

## 문제 해결
- **아무에게도 안 감**: 앱에서 **매일 복습 알림**을 켰는지(옵트인), 복습 예정(`due<=오늘`)이 있는지 확인. 드라이런 로그의 "건너뜀" 집계 참고.
- **SendGrid 403/401**: API 키 권한(Mail Send)·발신 이메일 인증 확인. `REMINDER_FROM_EMAIL` 이 인증한 주소와 일치해야 함.
- **`FIREBASE_SERVICE_ACCOUNT ... JSON 아님`**: 시크릿에 JSON 전체(중괄호 포함)를 붙였는지 확인.
- **메일이 스팸함**: Single Sender 초기엔 흔함. Domain Authentication(SPF/DKIM) 설정 시 개선.
- **날짜가 하루 어긋남**: `REMINDER_TZ` 또는 사용자 `meta.tz` 확인. 크론은 UTC로 돎.
