# WordQuest — 핸드오프 문서

> 단어 도감 · WORD QUEST — 영단어 복습을 16비트 JRPG 턴제 전투로 포장한 학습 웹앱.
> "틀린 단어는 보스가 된다." 대상: 고1(내신·수능 기초 어휘).

최종 업데이트: 2026-07-11 (① 복귀 알림 스캐폴드 추가) · 저장소: https://github.com/ranha0924/wordQuest (branch `main`)

---

## 1. 한눈에 보기

- **정적 웹앱** — 빌드 없음. Vercel이 `index.html`을 루트로 서빙. 무설치·오프라인·무료. **오프라인 우선**이며 클라우드 동기화(Firebase)는 **선택** — 설정/로그인 없으면 지금처럼 로컬 전용(§4.9).
- **저장** — 브라우저 `localStorage`(키: `wordquest_v1`)가 주 저장소. 백업은 JSON 내보내기/가져오기. 로그인 시 Firestore로 기기 간 동기화(선택, §4.9).
- **파일 구성**
  | 파일 | 역할 |
  |---|---|
  | `index.html` | 앱 전체 — 스타일(CSS) + 마크업 + 로직(JS)이 한 파일에. |
  | `words.js` | **단어은행 데이터**(602개). `window.WORDBANK` 배열. 로직과 분리됨. |
  | `assets/` | **몬스터·배경·용사 이미지**(로컬 자체 포함). `assets/mon/` 스프라이트 26종(투명 PNG) + `bg.png`·`hero.png`. 외부 CDN 의존 없음. |
  | `cloud.js` | **클라우드 동기화**(Firebase Auth+Firestore). `window.Cloud` 노출, 미설정 시 no-op. 오프라인 우선. |
  | `firebase-config.js` | Firebase 웹 config(사용자가 값 채움). 비어 있으면 로컬 전용. |
  | `firestore.rules` | Firestore 보안 규칙(본인 문서만 접근). |
  | `scripts/reminders/` | **일일 복귀 알림 발송기**(①). `lib.mjs`(순수 로직+테스트) · `send-reminders.mjs`(Firestore→SendGrid) · `fixtures/`. 메인 앱과 독립(Node). 참고 §4.10. |
  | `.github/workflows/daily-reminder.yml` | 알림 발송 **크론**(매일 08:00 KST) + 수동 트리거. |
  | `docs/` | `cloud-sync-design.md`(설계), `firebase-setup.md`(동기화 셋업), `reminder-setup.md`(알림 셋업). |
  | `워드퀘스트-기획서.md` | 최초 기획서 v1(게임 디자인 원안). |
  | `vocamon.html` | 예전 별도 프로토타입. 현행 앱과 무관(정리 대상). |
  | `HANDOFF.md` | 이 문서. |

- **로드 순서**: `index.html`이 `<script src="words.js">`로 데이터를 먼저 로드 → 메인 `<script>`가 `window.WORDBANK`를 참조. words.js가 없으면 `[]`로 폴백(앱은 돌아가되 예문/은행 기능만 빔).

---

## 2. 이번 작업 요약 (평가 → 개선)

영어 교사 관점 초기 평가 **60/100**에서 출발해 지적사항을 순차 개선(학습 설계 기준 ≈88–90). 이후 **홀리스틱 냉정 평가 72/100**(전달·신뢰성·검증까지 포함) — 최대 약점 2가지(**① 복귀 알림 부재**, **② 데이터 취약**) 중 **②를 이번 세션에 착수**.

| 커밋 | 내용 |
|---|---|
| `63786e6` | **간격반복(SRS) 재설계** + 3단계 출제 모드(영→한 / 한→영 / 예문빈칸) |
| `62a1355` | **근사치 오답지** + 다의어(`;`) + **발음 TTS** |
| `666773a` | **센스별 예문**(다의어 2번째 뜻 예문) + **약점 분석**(정답률) |
| `f7d228e` | **타이핑 철자 모드**(stage 2·3+ 4지선다 → 직접 입력) |
| `6508168` | **words.js 분리** + 단어은행 **62→602개** + 전체 담기 버튼 |

해결한 4대 지적:
1. 복습 구멍(포획=영구졸업) → 확장 사다리로 포획 후에도 복습 지속.
2. 재인 편중 → 재인/역방향/문맥/철자생산으로 단계 상승.
3. 오답지 무작위 → 철자·품사·뜻유형 유사도 기반 근사치.
4. 단일 뜻·발음 없음 → 다의어 + 센스별 예문 + TTS.

### 이번 세션(2026-07-11) 추가

| 커밋 | 내용 |
|---|---|
| `c413d12` | **몬스터 로스터 확장** — 신규 16종(힉스필드 Nano Banana 2) + **엘리트 등급 신설**(3단계 진화) + 전 에셋 로컬화(CloudFront → `assets/`) |
| `52f28cd` | **등장 깜빡임 수정** — 새 몬스터 디코드 전까지 숨겨 이전 몬스터 잔상 제거(§4.8) |
| `3babade` 외 | **클라우드 동기화(②)** — Firebase Auth(이메일 링크)+Firestore, 오프라인 우선(§4.9) |

- 냉정 평가 약점 대응: **② 데이터 신뢰성** = 클라우드 동기화 착수(로그인 시 기기 간 진도 보존).

### 다음 세션(2026-07-11 이어서) 추가 — ① 복귀 알림 착수

| 내용 |
|---|
| **① 이메일 복귀 알림 스캐폴드** — GitHub Actions 크론(매일 08:00 KST)이 Firestore를 읽어 옵트인 사용자에게 "오늘 복습 N마리" 메일 발송. `scripts/reminders/`(순수 로직+테스트+발송기) + 워크플로 + `docs/reminder-setup.md`. 앱엔 **매일 복습 알림 옵트인 토글**(`meta.notify`) + `meta.tz` 기록 추가. 참고 §4.10 |

- 냉정 평가 **최대 약점 ① 복귀 알림** 대응: 코드/워크플로/문서 **완성**. 로직은 단위 테스트(7)·fixture 드라이런·브라우저 토글 검증(9) 통과.
- **활성화만 남음**: 사용자가 시크릿 3종(SendGrid 키·발신 이메일·Firebase 서비스계정) 등록하면 발송 시작(§4.10, `docs/reminder-setup.md`). 실메일 라이브 발송은 사용자 셋업 후 확인 예정.
- **미완(백로그 §8)**: **PWA** 미착수 · 동기화 두 기기 병합 라이브 최종검증(사용자 Firebase 셋업 후).

---

## 3. 데이터 모델

### 단어(word) 객체 — `S.words[]`
```js
{
  id: 'abandon',        // 소문자 키(고유)
  w:  'abandon',        // 영어 표기
  m:  '버리다; 포기하다', // 한국어 뜻. 다의어는 ';' 로 구분
  stage: 0,             // 정착 단계 0..6 (SRS)
  wrong: 0,             // 누적 오답 수 (등급/약점 분석용)
  seen: 0,              // 누적 시도 수 (정답률 = (seen-wrong)/seen)
  cap: false,           // 포획(도감 등록) 여부
  capAt: '2026-07-11',  // 최초 포획일(선택)
  due: '2026-07-11',    // 다음 출현 예정일 (YYYY-MM-DD). null이면 미정
  created: '2026-07-11',
  updatedAt: 1783747848808 // (선택) 이 단어 최종 변경 ms. 클라우드 단어별 병합 기준(§4.9)
}
```

### 메타 — `S.meta`
`{ lastDay, streak, bestCombo, muted, theme, exp, updatedAt }` — `updatedAt`은 meta 최신저장(LWW) 기준(§4.9)

### 단어은행 항목 — `words.js`
```js
{ w:'witness', pos:'v', m:'목격하다; 증인',
  ex:'Did anyone witness the accident?',   // 1번째 뜻 예문
  ex2:'The witness described the suspect.' } // (선택) 2번째 뜻 예문
```
- `pos`: `v`(동사)/`n`(명사)/`a`(형용사)/`ad`(부사). 오답지 품사 매칭에 사용.
- 예문은 **단어 원형을 그대로 포함**해야 빈칸(cloze) 출제에 쓰임(안 그러면 자동으로 빈칸 대신 한→영 출제).

---

## 4. 핵심 시스템

### 4.1 간격반복(SRS)
- 상수: `MASTER_MAX=6`, `CAPTURE_STAGE=3`, `LADDER=[0,1,3,7,16,35,75]`(정답 후 stage 기준 다음 복습까지 일수).
- 정답: `stage+1`, `due = 오늘 + LADDER[stage]`. **stage 3 최초 도달 = 포획**(도감 등록) 후에도 계속 사다리(7·16·35·75일)를 타며 복습.
- 오답: `stage=0`, `due=오늘`, `wrong++`. 포획된 단어도 잊으면 stage 초기화되어 재학습(단, `cap`은 유지 → 도감 완성률 안 깎임, "복습 대기" 표시).
- 관련: `answer()`/`submitSpell()` → `resolveAnswer(correct)`, `dueIds()`, `renderMonHP()`, 마이그레이션 `migrateWords()`.

### 4.2 출제 모드 (stage로 상승)
| stage | 모드 | 형식 | 테스트 |
|---|---|---|---|
| 0–1 | `e2k` | 영어→한국어 뜻 **4지선다** | 재인 |
| 2 | `k2e` | 한국어 뜻→영어 **타이핑** | 역방향 인출 (여기서 포획) |
| 3+ | `cloze` | 예문 빈칸→영어 **타이핑** | 문맥 인출 (포획 후 유지 복습) |
- `pickMode(w)`가 결정. cloze는 예문에 원형이 있는 단어만(`clozable(w)`), 없으면 k2e로 폴백(정답 노출 방지).
- k2e·cloze는 정답이 영어 단어 → 몬스터 이름을 답 전까지 `？？？몬`으로 가림.
- 타이핑 채점: 대소문자·앞뒤 공백 무시, 정확 철자만 정답. 1글자 차이(`lev()<=1`)면 "아깝다! 한 글자 차이다" 안내(여전히 오답). 글자 수 힌트(`○`→입력 시 `●`).
- 숫자키 1–4는 e2k에서만 동작(타이핑 방해 방지).
- 관련: `nextMon()`, `makeChoices()`, `askText()`, `clozeText()`, `renderChoices()`/`renderSpellInput()`.

### 4.3 오답지 근사치화
- 후보를 유사도로 점수화해 헷갈리는 보기 우선.
  - 영어(k2e/cloze): `engSim()`(접두 공유·접미 일치·편집거리 `lev()`) + 같은 품사 가점.
  - 한국어(e2k): `koType()`(어미로 동사/형용사/명사 추정) 일치 + 품사 가점.
- 같은 뜻(`x.m===w.m`) 단어는 오답 보기에서 제외(중복정답 방지).

### 4.4 다의어 + 센스별 예문
- 뜻은 `;`로 여러 개. `bankSenses(w)`가 각 뜻을 `ex`/`ex2`에 매핑.
- cloze는 턴마다 한 센스를 골라 **그 문장 + 그 뜻 힌트**만 노출 → 뜻을 구분 학습.

### 4.5 발음 (TTS)
- `speak(word)` — 브라우저 `speechSynthesis`(en-US). 효과음 음소거와 독립.
- 🔊 버튼: 전투(정답 공개 후 자동 재생 + 버튼) + 도감 포획 카드. 아이콘은 픽셀 SVG(`SPK_SVG`).

### 4.6 약점 분석
- `seen` 시도수 추적 → `acc(w)` 정답률.
- 결과 화면 `renderWeak()`: 전체 정답률 + 취약 단어 TOP3(오답순). 도감 카드에도 정답률 표시.

### 4.7 단어은행 & 시딩
- `words.js`의 `window.WORDBANK`(602개) → `BANK`(소문자 키 맵). `bankEx()`/`bankSenses()`/`clozable()`/`posOf()`.
- 첫 방문: `SAMPLE` 20개 자동 시딩.
- **영입소** 3가지 등록: (1) 붙여넣기(`abandon - 버리다` 형식, `parseText()`), (2) 샘플 20개 버튼, (3) **"교과서 고빈도 단어 담기"** 버튼 = 은행 전체를 **하루 25개씩 순차 출현**(staggered due)하도록 시딩.
- 붙여넣은 단어가 은행과 철자 일치하면 예문·품사 자동 연결.

### 4.8 몬스터 에셋 & 등급 진화
- 이미지는 전부 **로컬**(`assets/`): 몬스터 스프라이트 `assets/mon/*.png`(600×600 투명 PNG), 배경 `assets/bg.png`, 용사 `assets/hero.png`. 외부 CDN 의존 없음(과거 CloudFront → 로컬로 이관).
- `ASSETS = { bg, hero, cute[14], elite[4], boss[8] }` (`MON='assets/mon/'`). `monAsset(w)`가 누적 오답 수로 풀을 골라 "진화"를 표현:

  | 등급 | 오답 | 몬스터 풀 |
  |---|---|---|
  | 일반 COMMON | 0 | `cute` (14종) |
  | 희귀 RARE | 1~2 | `elite` (4종) |
  | 영웅·전설 EPIC/LEGEND | 3+ | `boss` (8종) |

- 단어→몬스터는 `hash(word) % 풀길이`로 결정론적(같은 단어는 같은 등급 안에서 항상 같은 몬스터). 오답이 쌓여 등급이 오르면 다른 풀에서 **새 모습으로 진화**(일반→희귀→영웅·전설).
- 로드 실패 시 `setMonImg`가 절차 생성 스프라이트(`sprite()`, 12×11 대칭 픽셀)로 폴백 → 오프라인·이미지 유실에도 동작.
- 신규 16종은 힉스필드(Nano Banana 2)로 기존 몬스터를 스타일 레퍼런스 삼아 생성 후, 배경제거·600 정규화·PNG8(128색) 최적화(장당 ~34KB).
- **등장 깜빡임 방지**: `#b-spr`은 단일 `<img>`를 재사용 → 새 `src`를 넣어도 디코드 전까진 이전 몬스터 비트맵이 잠깐 보였음. `setMonImg(img,w,onReady)`가 **디코드 완료 시에만** 콜백하고, `nextMon`은 로드 전 `opacity=0`으로 숨겼다가 준비되면 `wqAppear`로 노출. `img.complete`(캐시/동일 URL)·onerror 폴백·1.5s 안전장치 처리. 무대 암전→점등(spawn) 연출은 유지.

### 4.9 클라우드 동기화 (선택 · 오프라인 우선)
- **목적**: localStorage 단독의 데이터 취약성 해소 — 기기 이동·브라우저 정리 시 진도 보존(냉정 평가 약점 ②).
- **스택**: `cloud.js` = Firebase Auth(이메일 링크, 패스워드리스) + Firestore. SDK는 gstatic ESM CDN에서 **동적 import**(빌드 도구 없음). `firebase-config.js`가 비면 `window.Cloud`=no-op → **완전 로컬 전용**(회귀 0). 로그인은 **선택**.
- **데이터**: `users/{uid}` 문서 1개 = `{ schema:1, words:{<id>:{...word,updatedAt}}, meta:{...,updatedAt} }` (602단어 ~120KB < 1MB 한도).
- **병합(단어별 최신 우선)**: `resolveAnswer`에서 변경 단어에 `updatedAt` 스탬프. 동기화 = pull → merge(단어별 `updatedAt` 큰 쪽, meta는 LWW) → 로컬 반영(`WQ.applyMerged`) + 원격 write. **한 기기가 다른 기기 진도를 덮지 않음.** 리셋 시 원격도 비움(`Cloud.wipeRemote`).
- **트리거**: 로그인 직후·앱 로드·변경 후 디바운스(3s)·탭 이탈(`visibilitychange`). 전투 중(`WQ.isBusy`)엔 로컬 반영 생략(원격 write만) → 진행 방해 방지. `persist()`가 `cloudApplying` 플래그로 병합 반영 중 재-푸시를 막음.
- **UI**: 영입소 **상단** "☁ 클라우드 동기화"(미설정 시 숨김). 훅: `window.WQ`(getState/applyMerged/setSyncStatus/isBusy) ↔ `window.Cloud`(signIn/signOutUser/syncNow/notifyChanged/wipeRemote).
- **셋업**: `docs/firebase-setup.md`(~10분, 무료 Spark 플랜). Firebase 웹 `apiKey`는 **공개 식별자**(배포 JS에 어차피 노출, 커밋 안전). 보안은 `firestore.rules`(본인 문서만) + (선택) Google Cloud 키 리퍼러 제한.
- **주의**: 이메일 링크는 발신 시점의 `location.origin`으로 리다이렉트 → **로그인이 그 origin의 localStorage 맥락에서 완료**됨(다른 브라우저/주소에서 링크 열면 그쪽 진도로 로그인). 로컬은 기본 승인 도메인, 배포 도메인은 Firebase 승인목록에 추가 필요.

### 4.10 복귀 알림 (선택 · 서버리스 · 냉정 평가 최대 약점 ①)
- **목적**: SRS 예정일에 사용자를 다시 부르는 채널. 냉정 평가 **최대 약점 ①**(예정일에 돌아오게 할 알림 부재) 대응.
- **스택(카드·서버 불필요, 무료 범위)**: **GitHub Actions 크론** → `scripts/reminders/send-reminders.mjs`(Node, `firebase-admin`) → Firestore `users/*` 조회 → **SendGrid v3 API**(`fetch`, SDK 없음) 발송. §4.9의 동기화 데이터를 그대로 재사용.
- **선별**: `lib.shouldRemind` = `meta.notify===true` **그리고** 복습 예정(`due<=오늘`, 앱 `dueIds()` 규칙 미러: due 없음/오늘 이하, `deleted` 제외) > 0. 둘 다여야 발송. 이메일 주소는 문서에 저장하지 않고 **Auth에서 uid로 조회**(`admin.auth().getUser`).
- **옵트인(기본 꺼짐)**: 앱 영입소 로그인 뷰의 **"매일 복습 알림" 토글** → `meta.notify` → 클라우드 동기화로 Firestore 반영 → 크론이 조회. 로그아웃/미설정이면 대상 아님.
- **"오늘" 계산**: 크론은 UTC로 돌지만, 사용자별 `meta.tz`(앱이 `persist()`에서 1회 기록) 우선 → 없으면 env `REMINDER_TZ`(기본 `Asia/Seoul`). `todayInTimeZone`(Intl `en-CA`)로 `YYYY-MM-DD`.
- **메일**: 16비트 JRPG 톤(제목 "⚔️ 오늘 복습할 몬스터 N마리…"), 개수·연속(streak)·CTA 링크(`REMINDER_APP_URL`)·끄는 법 안내. 외부 이미지 없음(차단 무해), `List-Unsubscribe` 헤더 포함. 트래킹 off.
- **셋업/활성화**: `docs/reminder-setup.md`. 시크릿 3종 — `FIREBASE_SERVICE_ACCOUNT`(관리자 JSON), `SENDGRID_API_KEY`, `REMINDER_FROM_EMAIL`. 선택 Variables — `REMINDER_APP_URL`/`REMINDER_FROM_NAME`/`REMINDER_TZ`. **미설정이면 크론이 돌아도 실패 종료만 하고 앱엔 무영향**(회귀 0). 서비스 계정은 `firestore.rules` 우회(규칙 수정 불요).
- **검증**: `cd scripts/reminders && npm test`(단위 7) · `npm run dry-run`(fixtures 파이프라인, 네트워크·자격 불요) · 워크플로 `Run workflow`의 `dry_run` 입력. 실메일 라이브 발송만 사용자 시크릿 등록 후.

---

## 5. 확장·수정 가이드

- **단어 추가/편집** → `words.js`에 한 줄: `{w:'단어',pos:'v',m:'뜻',ex:'원형 포함 예문.'}`. 다의어는 `m:'뜻1; 뜻2'` + `ex2` 추가.
  - 예문에 **단어 원형**이 들어가야 빈칸 출제됨(3인칭 -s, 과거형 등은 원형이 안 잡혀 k2e로 폴백).
  - 문자열은 작은따옴표. 문장에 **아포스트로피 금지**(`don't`→`do not`)로 따옴표 깨짐 방지.
- **SRS 간격 조정** → `LADDER` 상수.
- **포획 기준 변경** → `CAPTURE_STAGE`.
- **모드 난이도 배치 변경** → `pickMode()`.
- **몬스터 추가/교체** → `assets/mon/`에 투명 PNG(권장 600×600) 저장 후 `ASSETS`의 해당 등급 배열(`cute`/`elite`/`boss`)에 `MON+'파일명.png'` 한 줄 추가. 풀 길이가 바뀌면 기존 단어의 몬스터 배정이 재셔플됨(데이터 무관, 외형만 변경). 참고 §4.8.
- **클라우드 동기화 설정/디버그** → `docs/firebase-setup.md`. 로직은 `cloud.js`, 앱 연동 훅은 `window.WQ`(index.html). 미설정이면 로컬 전용. 참고 §4.9.
- **테마** → 현재 Arcade 고정(전환 UI 숨김). 되돌리려면 CSS의 `#themebtn,.themelabel,.themepick{display:none!important;}` 한 줄 제거.

---

## 6. 개발 워크플로

- 빌드/의존성 없음. 로컬 전용 기능은 `index.html`을 브라우저로 열면 됨(`words.js` 옆에 있어야 함). **단, 클라우드 동기화(`cloud.js`는 ESM 모듈)는 `file://`에서 CORS로 안 됨 → 정적 HTTP 서버 필요**: `python3 -m http.server 8792` 후 `localhost:8792`.
- **문법 체크**: 메인 스크립트 추출 후 `node --check`.
  ```bash
  node -e "const fs=require('fs');const h=fs.readFileSync('index.html','utf8');const b=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)];fs.writeFileSync('/tmp/wq.js',b[0][1]);"
  node --check /tmp/wq.js && node --check words.js
  ```
- **동작 검증**: 정식 테스트 스위트 없음. Playwright로 `file://` 구동해 검증했음.
  - 파이썬: `/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3` (playwright 설치돼 있음).
  - `page.evaluate`로 전역 함수(`pickMode`,`answer`,`nextMon`,`S`…) 직접 호출해 상태 검증.
  - 주의: 전투 응답을 타이핑 애니메이션(20ms/글자)이 끝나기 **전에** 하면 피드백 메시지가 진행 중인 문제 타자기에 덮여 안 보임 → 검증 시 충분히 대기할 것(사람은 그 속도로 못 답하므로 실사용 무해).
- **배포**: `main` 푸시 → Vercel 자동 배포. 커밋은 브랜치 → `--ff-only` 머지 → 푸시 패턴 사용.

---

## 7. 알려진 한계

1. **단어은행은 범용 고빈도 어휘**지 특정 출판사 공통영어 교과서의 정확한 목록이 아님. 정확한 시험범위는 영입소 붙여넣기 또는 `words.js` 직접 추가로.
2. **듣기 모드 없음** — 단어 단위 TTS만. 문장 받아쓰기/듣고 고르기 없음.
3. e2k는 여전히 4지선다(재인). 철자 생산은 k2e·cloze에만.
4. 예문은 센스당 1문장(최대 2).
5. **클라우드 동기화는 선택**(§4.9) — 로그인 + Firebase 셋업해야 켜짐. 안 하면 여전히 로컬 전용(백업 내보내기/가져오기 병행 권장).
6. **① 복귀 알림 — 코드 완성, 활성화 대기** — 크론+발송기+옵트인·문서 완비(§4.10). 단 SendGrid·Firebase 서비스계정 시크릿 3종을 등록해야 실제 발송. 미등록이면 크론이 실패 종료만 하고 앱엔 무영향. 실메일 라이브 검증은 사용자 셋업 후.
7. **동기화 라이브 최종검증 미완** — 코드·로그인은 확인, 두 기기 실제 병합은 사용자 Firebase 셋업 후 검증 예정. 병합은 whole-doc write(~120KB) — 대량 사용 시 단어별 세분화 여지.
8. **배포 URL 미확인** — `wordquest.vercel.app`은 404였음. 이메일 링크 로그인은 배포 도메인을 Firebase 승인목록에 추가해야 동작.
9. 타자기-피드백 레이스. 실사용 무해하나 자동화 검증 시 충분히 대기.
10. **참고(버그 아님)**: 타이핑 모드는 단어 stage 2+에서만 등장(§4.2). 4지선다만 보이면 단어가 아직 stage 0~1이라는 뜻.

---

## 8. 백로그 (다음 후보)

**우선순위(냉정 평가 기준):**
- **PWA** (Phase B) — 설치형·오프라인 셸(manifest + service worker). 향후 웹 푸시 알림 기반도 됨. **미착수**(다음 1순위 후보).
- **① 알림 활성화 + 라이브 검증** — 코드는 완성(§4.10). 사용자가 시크릿 3종 등록 → `dry_run` → 실발송 확인. (예문 확충 등 발송 카피 다듬기 여지.)
- **동기화 라이브 검증 마무리** — 사용자 Firebase 셋업 후 두 기기 병합 확인(§7-7).

**그 외:**
- **단어은행 품질**: 품사 편중(동사 356·명사 111·부사 3) 보정, 특정 출판사 시험범위 매핑, 다의어 2예문 확충(현재 `ex2` 13/602).
- **듣기 모드**: 예문/단어 음성 → 받아쓰기 또는 4지선다.
- 오답 통계 대시보드 확장, 콜로케이션, `vocamon.html` 레거시 정리.
- ✅ **완료**: 기기 간 클라우드 동기화 ②(§4.9), 몬스터 로스터·에셋 로컬화, **① 복귀 알림 스캐폴드(§4.10) — 활성화만 남음**.

---

## 9. 참고 — 주요 함수 위치

**index.html 메인 `<script>`**: `pickMode` `clozable` `makeChoices` `askText` `clozeText` `bankSenses` · `nextMon` `answer` `submitSpell` `resolveAnswer` · `renderChoices` `renderSpellInput` `renderMonHP` `renderParty` · `renderDex` `renderHome` `renderReg` `renderWeak` `endBattle` · `dueIds` `rarity` `acc` `koType` `engSim` `lev` `posOf` · `monAsset` `setMonImg`(onReady 콜백) `sprite`(폴백) · `migrateWords` `persist` `parseText` `speak` · 시딩: `samplebtn`/`bankbtn` 핸들러.
**클라우드(§4.9)**: 앱 측 `window.WQ`(getState/applyMerged/setSyncStatus/isBusy)·`setCloudStatus`·`renderCloudNotify`·`wireCloudUI`(index.html) ↔ `cloud.js`의 `window.Cloud`.
**알림(§4.10)**: `scripts/reminders/lib.mjs`(`countDueWords`/`todayInTimeZone`/`shouldRemind`/`buildEmail`) · `send-reminders.mjs`(로드·발송 오케스트레이션). 앱 측 옵트인: `renderCloudNotify`·`persist`(meta.tz)·`meta.notify`.
**데이터/설정**: `words.js`(`window.WORDBANK`), `firebase-config.js`(`window.FIREBASE_CONFIG`).
