# WordQuest — 핸드오프 문서

> 단어 도감 · WORD QUEST — 영단어 복습을 16비트 JRPG 턴제 전투로 포장한 학습 웹앱.
> "틀린 단어는 보스가 된다." 대상: 고1(내신·수능 기초 어휘).

최종 업데이트: 2026-07-11 (① 복귀 알림 스캐폴드 + PWA + 부사 46개 + 고1 필수 어휘 팩 224·14주제) · 저장소: https://github.com/ranha0924/wordQuest (branch `main`)

> **정정(2026-07-15)** — 아래 본문 중 일부가 현행과 다르니 이 블록을 우선한다.
> - **배포**: Vercel 아님 → **GitHub Pages**(`.github/workflows/deploy-pages.yml`, main push 시 자동). 배포 URL은 `https://ranha0924.github.io/wordQuest/`.
> - **인증**: 이메일 링크(패스워드리스) 아님 → **Google 로그인**(`cloud.js`의 `GoogleAuthProvider`). §4.9/§4.10의 "이메일 링크" 서술은 무시.
> - **복귀 알림(§4.10)**: `scripts/reminders/`·알림 크론은 **현재 저장소에 없음**(제거됨). 관련 서술은 히스토리 참고용.
> - **레거시**: `vocamon.html` **삭제됨**(self-XSS 소지 프로토타입 정리).
> - **firestore.rules 배포**: 이 저장소엔 firebase.json/CLI 설정이 없다 → 규칙 변경은 **Firebase 콘솔에 수동 반영**해야 라이브에 적용된다.
> - **데이터 안전(2026-07-15)**: `persist()` 저장 실패 시 경고 배너, 손상 blob은 `wordquest_v1_corrupt`에 보관, 가져오기 요소 검증, 리셋 전 자동 백업, SW는 정상 셸 응답만 캐시. 상세는 `docs/security-review-2026-07-15.md`.
> - **선생님 권한 보안(2026-07-15)**: 과거 하드코딩 비번(`TEACHER_PW='8889'`) 소프트 게이트는 소스 열람·콘솔(`Cloud.chooseRole('teacher')`)로 우회됐고, 실제로 한 학생이 스스로 선생님이 됨. → **서버 허용목록으로 전환**(워커·비번 없음): `firestore.rules`가 선생님 자격을 **`teacherAllow/{이메일}` 컬렉션에 있는 계정**(또는 마스터)으로만 인정하고, 그 목록 쓰기는 마스터만 → 학생 셀프 승격 불가(콘솔 시도도 `permission-denied`). `role='teacher'`·반 생성/수정/코드·`classPacks` 쓰기 전부 `isTeacher()`(허용목록)/마스터 게이트. 클라이언트는 8889 게이트 삭제, `chooseRole('teacher')`가 규칙에 막히면 친절 안내. **구멍은 규칙만 콘솔 배포하면 즉시 닫힘(이메일 불필요, 마스터만 선생님)**, 선생님 추가는 콘솔에서 `teacherAllow` 문서 추가(코드 수정 0). 셋업·재성 정리는 **`docs/teacher-auth-setup.md`**.

---

## 1. 한눈에 보기

- **정적 웹앱** — 빌드 없음. Vercel이 `index.html`을 루트로 서빙. 무설치·오프라인·무료. **오프라인 우선**이며 클라우드 동기화(Firebase)는 **선택** — 설정/로그인 없으면 지금처럼 로컬 전용(§4.9).
- **저장** — 브라우저 `localStorage`(키: `wordquest_v1`)가 주 저장소. 백업은 JSON 내보내기/가져오기. 로그인 시 Firestore로 기기 간 동기화(선택, §4.9).
- **파일 구성**
  | 파일 | 역할 |
  |---|---|
  | `index.html` | 앱 전체 — 스타일(CSS) + 마크업 + 로직(JS)이 한 파일에. |
  | `words.js` | **범용 고빈도 단어은행**(648개). `window.WORDBANK` 배열. 로직과 분리됨. |
  | `pack-hs1.js` | **고1 필수 어휘 팩**(224개, 14주제 큐레이션). `window.WORDPACK_HS1`. 예문·품사 포함, BANK에 편입돼 cloze 지원. 참고 §4.7. |
  | `manifest.webmanifest` · `sw.js` | **PWA** — 설치형 매니페스트 + 서비스 워커(앱 셸 오프라인 캐시). 참고 §4.11. |
  | `assets/` | **몬스터·배경·용사 이미지**(로컬 자체 포함). `assets/mon/` 스프라이트 60종(투명 PNG) + `bg.png`·`hero.png` + `icons/`(PWA 앱 아이콘 192·512·maskable·apple-180). 외부 CDN 의존 없음. |
  | `cloud.js` | **클라우드 동기화**(Firebase Auth+Firestore). `window.Cloud` 노출, 미설정 시 no-op. 오프라인 우선. |
  | `firebase-config.js` | Firebase 웹 config(사용자가 값 채움). 비어 있으면 로컬 전용. |
  | `firestore.rules` | Firestore 보안 규칙(본인 문서만 접근). |
  | `scripts/reminders/` | **일일 복귀 알림 발송기**(①). `lib.mjs`(순수 로직+테스트) · `send-reminders.mjs`(Firestore→SendGrid) · `fixtures/`. 메인 앱과 독립(Node). 참고 §4.10. |
  | `.github/workflows/daily-reminder.yml` | 알림 발송 **크론**(매일 08:00 KST) + 수동 트리거. |
  | `docs/` | `cloud-sync-design.md`(설계), `firebase-setup.md`(동기화 셋업), `reminder-setup.md`(알림 셋업). |
  | `워드퀘스트-기획서.md` | 최초 기획서 v1(게임 디자인 원안). |
  | ~~`vocamon.html`~~ | 삭제됨(2026-07-15). 예전 별도 프로토타입 — self-XSS 소지로 정리. |
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

### 이번 세션(2026-07-16) 추가 — 랭킹 미등재(KV 쓰기 한도) 근본 대응

| 커밋 | 내용 |
|---|---|
| (v107) | **'오늘 학습이 Firebase에 안 남음' — 조용한 동기화 실패를 홈에 가시화** — 증상: 한 학생의 **예전 날짜는 Firestore에 있는데 오늘치만 없음**(동기화 자체는 됐던 계정). 진단: 오늘 세션에서 `syncNow()`가 한 번도 성공 못 해 오늘 학습이 **로컬(localStorage)에만 갇힘**. 유력 원인 ①**오늘 로그아웃 상태로 공부**(앱은 오프라인 우선이라 로그인 없이도 다 돌아가고, `syncNow`는 `if(!user)return` → 아무것도 안 올라감) ②로그인은 됐지만 그 브라우저(인앱 등)에서 Firestore 연결 실패로 `catch` 조용히 삼킴. **핵심 문제는 앱이 이 상태를 학생에게 전혀 안 알려줌** — 로그인/동기화 상태(`cloud-status`)는 '영입소' 화면 안에만 있고 홈·전투 화면엔 표시 없음. 날짜 키 불일치(cloud.js `todayStr` vs index.html `today()`)는 확인 결과 **동일 로직 → 아님**. **수정**: `cloud.js` 가 `syncNow` 성공/실패 시각(`lastSyncOkAt`/`lastSyncFailAt`)을 기록하고 `Cloud.syncState()`(`{signedIn,failing,okAt}`) 노출. `index.html` 홈 화면에 `#home-syncwarn` 배너 + `renderSyncWarn()`: **오늘 학습 기록이 로컬에 있는데**(dailyHistory/doneByDay) ①로그아웃이면 "⚠️ 로그인 안 됨 — 오늘 학습이 백업 안 돼요 [로그인하고 저장하기]" ②로그인+저장 실패 중이면 "⚠️ 서버 저장 실패 [지금 다시 저장]" 표시(버튼이 로그인/재동기화 실행). 정상(로그인+성공)이면 숨김 → 조용한 유실이 **보이는 경고**가 됨. 데이터는 안 잃음(로그인/재접속해 동기화 성공하면 로컬 오늘치가 merge=union 으로 그대로 서버에 올라감). 검증: 분기 단위테스트 10/10(미설정/미학습/로그아웃/실패/정상/doneByDay만/구버전 폴백/버튼 배선) + Playwright 실부팅 스모크(홈 렌더·배너 표시·런타임 무오류) 통과. 캐시 v106→v107(main 이 이미 v105·v106 라벨 사용 → 충돌 회피). **앱(Pages)만 배포하면 적용**(워커·규칙 무변경). ※ 후속 근본책 후보: 앱이 날짜를 KST 고정 기록(기기 시간대 skew 완전 제거) — 백로그. |
| (v104) | **선생님 대시보드 '오늘 학습 없음' 오표시 수정 — 서버 검증값과 앱 보고값을 합집합으로** — v100 설계상 대시보드는 학생이 서버 출석기록(`att`)을 하나라도 가지면 그 순간부터 `summary.daily`(앱 자기보고)를 **무시하고 서버 출석맵만** 썼다(`verifiedHere?vDaily(v.days):sm.daily`). 그런데 워커는 오늘을 **서버 시계 KST**(`kstToday`)로 정하고 학생 앱은 **기기 로컬 날짜**(`today()`)로 기록해, ①기기 시간대가 KST 아닌 학생 ②오늘 공부했지만 아직 미동기화한 학생은 서버 출석맵에 '오늘'이 없어서 **앱엔 오늘 기록이 있는데도 '오늘 학습 없음'으로 오표시**됐다. r4 배포로 서버 검증이 실제로 잘 돌기 시작하면서(대부분 학생이 '서버값만' 모드로 전환) 이 빈틈이 '몇몇 학생 오늘 기록 누락'으로 드러남. **수정**: `mergedDaily(s)` 헬퍼로 **오늘 학습·히트맵·상세·대시보드 주간랭킹**을 `서버 출석 ∪ 앱 보고`(날짜별 서버값 우선, 없으면 앱값)로 표시 → 정직한 학생이 '학습 없음'으로 잘못 뜨는 거짓 음성 제거. **연속일수·학습일 ✓ 숫자는 여전히 서버 검증값만**(위조 방지 유지 — 합집합은 표시용 날짜 존재/히트맵/오늘 카운트에만). 거짓 양성 없음(앱 보고 오늘은 학생이 실제 공부해야만 생김). ✅ 배너 문구도 '오늘·히트맵은 서버+앱 합침, ✓ 숫자는 서버' 로 정정. 검증: 합집합 시나리오 7종 11/11(거짓음성 해소·서버값 우선·거짓양성 없음·폴백 보존·vb=null 안전·날짜 합집합·주간합) + 기존 랭킹 렌더 12/12 회귀 + 인라인 스크립트 구문 무결. 캐시 v103→v104. **이 수정은 앱(Pages)만 배포하면 적용**(워커 변경 없음). |
| (v103) | **"대시보드엔 기록이 있는데 랭킹엔 학생이 없다" 근본 수정 — KV 무료 한도(1,000회/일) 사고 대응 완성판(워커 r4)** — 원인: 랭킹 보드는 워커가 KV에 쓴 키(`c:`/`g:`)로만 만들어지는데, 무료 플랜 쓰기 한도 초과로 put 이 throw → 구버전 워커는 `/sync` 전체가 500 → **이후 동기화한 학생들의 보드 키가 안 생겨 랭킹 통째 미등재**(대시보드는 v101부터 Firestore 직읽이라 정상 → 증상 불일치처럼 보임). 80a09ff(쓰기 절약·미배포 보관)도 ①점수 변경마다 put 2회는 남아 전교 규모면 여전히 초과 가능 ②한도 소진 시 **조용히 누락**(학생이 보드에 안 뜸) ③`/board` list 실패가 '빈 랭킹'으로 위장되는 구멍이 있었음. **워커 r4**(worker.js·worker-dashboard.js 쌍둥이): ⓐ**등재 우선** — 이번 주 키 없으면 무조건 기록(학생당 주 2회면 등재 완료) ⓑ**갱신 스로틀** — 등재 후엔 이름/연속 변경·`RANK_STEP`(기본 5)단어 진행·`RANK_FLUSH_MIN`(기본 15)분 경과 시에만 갱신(sync 폭주≠put 폭주) ⓒ**한도 내성+가시화** — put 실패해도 200 + `degraded:true` ⓓ**`/board` 내 행 즉석 병합** — 본인 점수·연속을 KV 무관하게 서버가 즉석 계산해 병합(쓰기 0회 → put 밀려도 "내가 안 보임" 원천 차단), 전체 보드 상위 100 밖이면 내 행 끝에 보존 ⓔ**list 실패는 503 `kv_limit`**(빈 랭킹 위장 금지) ⓕ**모든 응답에 `v:'r4'` 리비전** — 워커 주소만 브라우저로 열어도 배포 여부 확인 가능. **클라**: `cloud.js` 가 `/sync` 응답(내 점수·degraded)을 보관(`rankStatus`), 신규 `getRankInfo` 가 '서버 오류/미로그인/미소속/빈 보드'를 구분 반환(기존 `getRank` 시그니처는 구버전 호환 유지) → `index.html` 랭킹 모달이 오류를 "아직 푼 친구가 없어요"로 뭉개지 않고 **오류 안내 + 내 점수(서버 확인값) 표시**, degraded 면 "반영 지연" 알림. 검증: 워커 순수함수 31/31 + 통합(모의 KV/fetch, 등재우선·스로틀·degraded·내행합성·503·top100+내행) 21/21 + 렌더 분기 12/12(XSS 포함), 쌍둥이 공유구간 기계적 동일, 전 스크립트 구문 무결. 캐시 v102→v103. **⚠️ 적용하려면 rank-worker 재배포 필요**(서비스워커 형식이면 worker-dashboard.js 붙여넣기·Deploy, 새 바인딩 불필요 — 배포 확인은 워커 주소 열어 `v:"r4"` 확인). 무료 한도가 계속 빠듯하면 `RANK_STEP=10` 또는 Workers Paid 전환(README). 참고 `rank-worker/README.md` §무료 플랜 |

### 이번 세션(2026-07-15) 추가

| 커밋 | 내용 |
|---|---|
| (v100) | **선생님 대시보드 연속일수·학습일수 위조 차단 — 서버 검증으로 전환** — 랭킹은 v77·v78에서 서버 집계로 위조를 막았지만 **선생님 대시보드는 여전히 학생이 자기 계정에 쓴 `summary.streak`(연속일수)·`summary.daily`(날짜별 기록)를 그대로 신뢰**해, 학생이 콘솔로 그 값을 바꾸면 대시보드에 그대로 떴다(`firestore.rules` 는 타입만 검사하고 값 진위는 검증 안 함 → 트리비얼 위조). **랭킹과 동일한 서버 검증으로 전환**: ① `rank-worker` 가 `/sync` 때마다 **서버 시계(KST) 기준 오늘** 실제 완료가 있으면 `att:{uid}` 출석맵에 그날을 남긴다 — **날짜 키를 서버가 정하므로**(클라가 보낸 `today` 무시) 학생이 과거 날짜/연속을 못 심는다. 반 명단 `mem:{cid}:{uid}`(45일). ② 새 엔드포인트 **`GET /teacher?class=CLASSID`**(소유 선생님·마스터만, 반 `ownerUid` 를 요청자 토큰으로 확인 → 규칙과 동일 신뢰선)가 학생별 `{streak(서버 관측), studyDays, days(출석맵)}` 반환. ③ `cloud.js teacherBoard()` 가 이 값을 받아 `renderTeacherStudents` 가 🔥연속·📅학습일(신규 표시)·히트맵·상세를 **서버 검증값**으로 렌더(✓ 표시). 정답률·포획은 앱 기록임을 범례로 명시. **워커 구버전이면 `/teacher`→404 → 앱 자동 폴백 + "⚠️ 서버 검증 미적용(재배포 필요)" 배너**(무중단). `verifyFirebase` 가 email 반환하도록 확장(마스터 판정). 검증: 워커 순수함수 단위테스트 20/20(`kstToday`·`streakFromDays`·`pruneDays`·`isMasterUser`), 클라 렌더 실소스 추출 테스트 10/10, 전체 인라인 스크립트+cloud.js+worker.js 구문 무결. **⚠️ 적용하려면 rank-worker 재배포 필요**(worker.js 재붙여넣기·Deploy, 새 변수/바인딩 불필요). 캐시 **v99→v100**(같은 시각 다른 세션이 main에 `v99=Firestore 초기화 롤백`을 이미 배포 → 번호 충돌 회피 위해 v100. 이 작업은 그 v99 위에 rebase되어 Firestore 롤백을 보존함). 배포·설계: `rank-worker/README.md`, §4.12 |
| (v93) | **삼성 인터넷 '회색 레이아웃' 수정 (v92 후속)** — v92 감지가 못 잡던 케이스. **삼성 인터넷**은 인앱 WebView 가 아니라 UA 에 `; wv)`·앱 토큰이 없고, **SVG 를 `<img>` 로는 정상 렌더**(v92 (2) 캔버스 검사 통과)하는데 **`border-image` 로만 회색**으로 깨져 프레임이 유지돼 회색이 남았음(= v92 에서 예고한 잔여 구멍). border-image 렌더 성공 여부는 JS 로 직접 피처검사가 불가 → **UA 로 직접 폴백**: `SamsungBrowser` + 동류의 비주류 모바일 브라우저(`MiuiBrowser/HeyTap/Vivo/Oppo/UCBrowser/QQBrowser/Quark/Puffin`) 추가. 주류(Chrome·Firefox·Edge·Safari·**네이버 웨일**)는 프레임 유지. 더불어 삼성·크롬 **자동 다크모드**가 이미-어두운 페이지를 다시 회색 처리하지 않게 `<meta name="color-scheme" content="dark">` + `:root{color-scheme:dark}` 추가. Playwright 5-UA(삼성 v23·삼성 v10·크롬 안드로이드·데스크톱·웨일) 검증: 삼성만 `nosvgframe`+`border-image:none`, 나머지는 프레임 유지. 캐시 v92→v93. **참고**: 구글 로그인 계정 선택(`prompt:'select_account'`)은 v92 에 이미 반영됨(매 로그인마다 계정 선택창). |
| (v92) | **인앱 WebView '회색 레이아웃' 근본 수정 + 구글 로그인 계정 선택** — ① 픽셀 프레임(`border-image:var(--frame-*)`, SVG data-URI)을 '테두리로' 못 그리는 인앱 WebView(구글 클래스룸·카카오·네이버·인스타 등)가 프레임을 **회색 깨진 이미지**로 렌더해 화면 전체가 회색으로 보이던 문제. 기존 감지(SVG 를 `<img>`+canvas 로 그려 색 확인)는 **`<img>`는 되는데 `border-image`는 깨지는** WebView·canvas taint 예외·타임아웃 미탐이 남았음 → **UA 선제 감지**(`; wv)` 안드로이드 시스템 WebView 토큰 + KAKAOTALK/NAVER/Instagram/FB*/Line/Daum/GSA/everytime + iOS ` Safari/` 토큰 없는 WKWebView)로 첫 페인트 전 동기 폴백, canvas 재검증도 **모든 오류·모호함을 '깨짐'으로 간주(fail-safe)** 하도록 강화(`index.html` head 스크립트). 감지 시 `html.nosvgframe *{border-image:none}` 으로 solid 테두리 폴백(어디서나 정상). ② 구글 로그인에 `provider.setCustomParameters({prompt:'select_account'})` 추가(`cloud.js` `signInGoogle`) — 기기에 계정이 여러 개여도 **원하는 계정을 고를 수 있게**(기존엔 마지막/단일 세션 자동 로그인). Playwright 4-UA(데스크톱·안드로이드 wv·카카오 iOS·iOS 사파리) 검증: WebView 는 `nosvgframe`+`.hdr/.subbtn` `border-image:none`, 정식 브라우저는 픽셀 프레임 유지(무회귀). 캐시 v91→v92. |
| (v89) | **'업데이트 소식' 팝업에 '객관식 보기 품사 통일' 항목 추가** — 별도 작업(`e2k 오답 품사 통일`)으로 반영된 개선(뜻 고르기 오답을 정답과 같은 품사로 맞춰 어미로 답 유추 차단, `posKey`/`_bankByPos`)을 팝업(`#news-modal`)에 🎯 항목으로 안내. 내용이 바뀌어 `NEWS_VER` 를 `20260716`→`20260716b` 로 올려 모두에게 1회 재노출. Chromium 재렌더로 6항목 표시·무오류 확인. 캐시 v88→v89. |
| (v88) | **"업데이트 소식" 팝업 추가 + OCR AI경로 복구 완료** — 접속 시 최근 개선사항(📸사진 인식 개선·❤️하트 충전 후 단어 안 나옴 수정·📝뜻/보기 잘림 수정·🏆랭킹 오류 수정·🔒해킹위험 차단)을 **버전당 1회**(`localStorage['wq_news']===NEWS_VER`) 알리는 모달(`#news-modal`). 로그인/역할 모달과 겹치지 않게 `getComputedStyle` 로 미루고, `cloud-account` 확정·`hideLoginModal`·오프라인 안전망 타이머에서 호출(멱등). 실제 Chromium 오프라인 렌더로 표시·무오류 확인, 로직 5시나리오 시뮬 통과. **참고: OCR upstream_error(403)의 근본 원인은 Cloudflare Worker egress 리전 차단**이었고, 워커를 **AI Gateway 경유**로 바꿔(주소 이중결합·게이트웨이 인증 해제까지) 해결 → Claude 고품질 인식 정상화. 캐시 v87→v88. |
| (v87) | **AI OCR `upstream_error` 실제 원인 표면화** — 앱이 워커가 주던 Anthropic `status`·`detail` 을 버려 원인을 못 보던 것을, `runOCRApi` 에서 401/403/404/400(credit)/429 로 분류 표시(+ 폴백 후에도 남도록 `_ocrApiFail` 에 detail 기록). 진단 결과 403 "Request not allowed"(리전 차단)로 확인돼 v88 의 AI Gateway 전환으로 이어짐. 워커에 `ANTHROPIC_BASE`(AI Gateway 경유) 옵션 추가. 캐시 v86→v87. |
| (v86) | **사진 OCR 인식 불량 수정 — 파서가 정답을 대량 폐기하던 문제** — 원인은 인식 엔진이 아니라 인식 텍스트를 "영어단어 - 한국어뜻"으로 거르는 파서(`ocrParseLine`)였음. ① 줄이 **반드시 알파벳으로 시작**해야 통과 → `1. apple 사과`·`① abandon 버리다`처럼 **번호·불릿 붙은 단어장 줄을 통째로 폐기**(사실상 대부분의 단어장 형식). ② **'한국어 앞 영어 2단어↑ = 예문'** 규칙이 `look forward to`·`in spite of`·`take care of` 같은 **정상 구동사·숙어까지 폐기**하고 `give up`을 `give`로 **오등록**. AI(Claude)·기기내(Tesseract) **두 경로 모두**에 적용되는 병목이라 체감 인식률이 크게 떨어졌음. → 파서 재설계: **앞머리 목록기호(번호·원문자·불릿) 선제거** + **명시적 구분자(` - `·`:`·다중공백) 있으면 왼쪽을 구·숙어까지 허용하는 표제어로 신뢰**, 예문 배제는 문장 신호(단어수·문장부호·대문자 문장)로 유지. 실제 파일 추출 코드로 회귀 테스트 27/27(정상 등록 회복 + 예문·헤더·잡음 폐기 유지), 메인 스크립트 전체 파싱 무결 확인. 캐시 버전 v85→v86. |
| (v85) | **너무 귀엽던 일반 몬스터 4종 재생성(덜 귀엽게·몬스터답게)** — `firefox`·`moonrabbit`·`cactusling`·`sparkpup`를 힉스필드(nano_banana)로 다시 생성. 기존 common 톤('cute chibi adorable…')이 원인이라, 이 4종만 '작지만 사납고 이빨을 드러낸 저레벨 몬스터' 톤으로 프롬프트를 바꿔 재생성(불꽃 여우 마수·달 토끼 마수·가시 선인장 마물·번개 자칼 마수). 파일명·`ASSETS.common` 슬롯은 그대로 두어(길이 24 유지·해시 분포 불변) 교체만 함. 크로마 배경→기존 파이프라인(`process.py`: 연결성분 배경제거·오토크롭·600×600·256색 양자화)으로 규격화, 체커보드 컷아웃 QA + 인게임 축소 크기 가독성 확인. 캐시 버전 v84→v85(SW 캐시 purge로 동일 파일명 이미지 갱신). |
| (v84) | **'하트 충전 후 단어 안 나옴' 수정** — 마나 버튼이 대화창 `#b-msg`(문제의 단어·뜻이 표시되는 곳)를 안내 메시지로 덮은 뒤 **복원하지 않는 경로**가 있었음: `useHeal`이 하트가 이미 가득이면 `'체력이 이미 가득 찼다!'`만 띄우고 끝(전투 시작 시 하트는 항상 가득 → 5콤보에서 ❤️ 버튼을 누르면 바로 재현), `useBlast`도 소탕 대상이 없으면 `'소탕할 복습 몬스터가 없다!'`만 띄우고 끝 → 단어가 사라져 답을 못 맞힘. 공용 `restoreAsk()`(phase 가드)로 **모든 경로에서 문제 텍스트를 반드시 되살리도록** 수정. Playwright로 하트가득·소탕대상없음·정상회복 3케이스 단어 복구 검증(ALL_PASS). |
| (v83) | **모바일 몬스터 이름 잘림 수정** — 네임플레이트 이름(`.monname`)이 `nowrap`+말줄임이라 긴 영어 단어가 모바일에서 잘리던 것 → 여러 줄 wrap(`white-space:normal;overflow-wrap:anywhere`)으로 전부 표시. |
| (v82) | **보기 글자 잘림/안 보임 수정** — 정답 선택지(`.choice`) 텍스트를 한 줄 말줄임(`nowrap`+ellipsis)에서 **여러 줄 wrap**(`white-space:normal;overflow-wrap:anywhere`)으로 변경. 긴 뜻이 잘리거나, iOS 플렉스에서 텍스트 폭이 0으로 붕괴돼 'e2k 모드 뜻이 아예 안 보이던' 현상을 함께 해결. 아이폰 폭에서 가로 잘림 0 검증. |
| (v81) | **랭킹 공지 배너** — 랭킹 모달에 "집계가 오늘부터 새로 시작 · 매주 월요일 리셋" 안내(`#rank-notice`). 서버 집계 전환으로 이번 주 점수가 0부터 시작하는 이유를 학생이 이해하도록. |
| (v80) | **동기화 진도 유실 방어 — 빈 병합이 데이터를 못 덮게** — 보안규칙 오류·사이트데이터 삭제가 겹치면 빈 상태가 로컬/원격을 덮어 진도가 사라질 위험을 양방향 차단. `applyMerged`: 병합이 비었는데 로컬에 단어가 있으면 유지(로컬 보존). `syncNow`: 병합 결과가 비었는데 원격에 단어가 있으면 업로드 보류(원격 보존). 병합은 원래 union 이라 클라우드는 대체로 보존되지만, 이 가드로 엣지에서도 빈 상태가 진도를 못 지운다. Playwright로 빈 병합 무효화 검증(GUARD_PASS). |
| (v79) | **iOS '전투 중 단어 뜻 안 보임' 수정** — 대화창 `#b-msg` 타자기 효과가 텍스트를 비우고 `setInterval(20ms)`로 복원하는데, 일부 iPhone(저전력 모드·백그라운드 타이머 스로틀)에서 인터벌이 지연·정지되면 대화창이 **빈 채로 남아** 뜻이 안 보였음. **안전장치 `setTimeout` 추가**로 일정 시간 뒤 전체 텍스트를 무조건 표시(정상 기기는 타이핑이 먼저 끝나 미발동). 보기 버튼(`.choice`) 텍스트도 `flex:1;min-width:0`로 0폭 붕괴 방지. Playwright로 인터벌 스톨 시뮬레이션 검증(빈 채→복구). |
| (v78) | **랭킹 연속일수(streak)도 서버 산정** — 클라가 보낸 streak 무시. 워커가 '오늘 실제 배포단어 완료(todayIds∩classWords)'를 관측해 연속을 이어감(어제 이어짐 +1·공백 리셋·오늘/어제까지만 표시, `st:{uid}={last,n}`). `/sync` 가 `today`·`todayIds` 추가 수신. 점수에 이어 연속까지 콘솔 위조 불가. §4.12 |
| (v77) | **랭킹 서버 집계 도입 — 점수 위조 근본 차단(선택 활성화)** — 점수를 클라가 못 쓰고 Cloudflare 워커(`rank-worker/`)가 "이번 주 완료한 배포 단어 수"를 배포단어 대조로 집계(천장=배정 단어수, 상한 없음). `markDone`→`doneByDay`(날짜별 보관), `cloud.js`가 워커 `/sync`·`/board` 사용. `window.RANK_ENDPOINT`로 게이트(미설정 시 기존 Firestore 폴백 → 워커 배포 전 앱 정상). 배포: `rank-worker/README.md`, 설계: §4.12 |
| (v76) | **랭킹 상한(cap) 제거 — 정상 고득점 보존** — v75의 값 상한(하루 500·주간 2000)은 진짜 열심히 한 학생의 큰 값까지 깎아 부적절 → 제거. `firestore.rules`·`cloud.js` 모두 값 상한 없이 **구조 검증(필드 화이트리스트·타입·음수 방지·days 맵크기)** + 숫자 타입가드(정렬 오염 방지)만 유지. 숫자 위조의 **근본 차단은 서버 집계(Cloudflare 워커+KV, OCR 워커와 동일 패턴)로 별도 대응 예정** — 검토 문서 참고 |
| (v75) | **랭킹 점수 위조(치팅) 차단** — 학생이 콘솔로 `days`/`wk` 를 조작해 1등을 만든 사건 대응. ①`firestore.rules`: 랭킹 항목 `wk`(0~2000)·`streak`(0~4000)·`days`(map, ≤9키) 상한 + 필드 화이트리스트로 서버가 과대 기록을 거부. ②`cloud.js`: `weekSum`/`getRank`/`getGlobalRank` 에 하루 500·주간 2000·연속 4000 상한을 걸어 조작 값이 표시·정렬을 지배하지 못하게 함(기록·조회 양쪽). 보안 리뷰 (2)·(4) 해소. ★규칙은 Firebase 콘솔에 수동 게시 필요 |
| (v74) | **중복 종류 정리** — 종류가 겹치는 몬스터 3종 제거(원본 유지·신규 삭제): `snowbun`(↔moonrabbit 토끼)·`direwolf`(↔werewolf 늑대)·`irongolem`(↔rock/armor 골렘). 63종 → **60종** |
| (v73) | **몬스터 그림 대폭 확장** — 힉스필드(Nano Banana 2)로 신규 37종 생성, 26종 → **63종**. 아트 풀을 3개(`cute`/`elite`/`boss`)에서 **등급별 4개**(`common`/`rare`/`epic`/`legend`)로 재편해 영웅·전설이 각자 전용 아트를 가짐. `monAsset`을 `rarity().key` 기반으로 일원화(§4.8) |

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
| **PWA(설치형·오프라인 셸)** — `manifest.webmanifest` + `sw.js`(앱 셸 precache + 자산 stale-while-revalidate + 오프라인 내비 폴백) + 브랜드 앰버 픽셀 아이콘. Firebase API는 캐시 우회(실시간성 보존). 참고 §4.11 |

- 냉정 평가 **최대 약점 ① 복귀 알림** 대응: 코드/워크플로/문서 **완성**. 로직은 단위 테스트(7)·fixture 드라이런·브라우저 토글 검증(9) 통과.
  - **활성화만 남음**: 사용자가 시크릿 3종(SendGrid 키·발신 이메일·Firebase 서비스계정) 등록하면 발송 시작(§4.10, `docs/reminder-setup.md`). 실메일 라이브 발송은 사용자 셋업 후 확인 예정.
- **PWA(Phase B) 완료**: 설치 가능 + **오프라인 완전 부팅** 검증(HTTP 서버 + Playwright: SW 등록·제어·캐시·오프라인 리로드 시 WORDBANK 전량 로드·폰트/CSS 렌더까지 확인). 향후 웹푸시 토대.
- **단어은행 품질 1차 보강**: 품사 편중(부사 3개뿐) 완화 — 고빈도 수능 부사 46개 추가(부사 3→49, 총 648). 후보를 중복·예문 원형 포함·아포스트로피 자동 검증 후 삽입, 브라우저에서 BANK 조회·clozable·posOf 확인.
- **고1 필수 어휘 팩 정식 내장(냉정 평가 레버 ③)**: "범용 빈도 리스트라 교과서 약속 미이행" 지적 대응. `pack-hs1.js`(**14주제×16=224**, 뜻+cloze 예문) 신설 + 영입소 **"고1 필수 어휘 팩 담기"** 추천 버튼 + 기존 "교과서 고빈도"를 **"고빈도 영단어(범용)"로 정직하게 개칭**. 224개 자동검증(기존팩/신규셋 중복0·예문 원형·아포스트로피0·주제 완비), 앱에서 로드·BANK 편입(cloze)·시딩 224·중복방지 확인. 주제: 자아·감정/학교·진로/환경·기후/과학·기술/문화·사회/건강·안전/소통·관계/시간·변화/경제·소비/여행·모험/예술·표현/사고·판단/성질·정도/도시·생활.
- **미완(백로그 §8)**: 동기화 두 기기 병합 라이브 최종검증(사용자 Firebase 셋업 후) · ① 실메일 라이브.

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
| 2+ (확률) | `listen` | **음성 듣고**→영어 **타이핑**(받아쓰기) | 청취+철자 생산 |
- `pickMode(w)`가 결정. cloze는 예문에 원형이 있는 단어만(`clozable(w)`), 없으면 k2e로 폴백(정답 노출 방지).
- **듣기(`listen`)**: stage≥2에서 `LISTEN_P=0.35` 확률로 다른 생산 모드를 대체(TTS 가능 시). 문제 제시 때 `speak(w.w)` 자동 재생 + **다시 듣기** 버튼(`replaybtn`), 뜻을 힌트로 노출, 이름 가림. 채점은 `submitSpell`(k2e·cloze와 동일).
- k2e·cloze·listen은 정답이 영어 단어 → 몬스터 이름을 답 전까지 `？？？몬`으로 가림.
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

### 4.6 약점 분석 & 오답 노트
- `seen` 시도수 추적 → `acc(w)` 정답률. 결과 화면 `renderWeak()`: 전체 정답률 + 취약 단어 TOP3. 도감 카드에도 정답률.
- **오답 노트 화면**(`scr-note`, 홈 메뉴 4번째 `data-go="note"` → `renderNote()`): (1) 전체 통계(정답률·시도·마스터), (2) **주제별 정답률 바**(팩 `PACK_THEME_OF`로 주제 매핑, 시도한 것만 · 색: ≥80 초록/≥60 골드/그외 빨강), (3) 취약 단어 리스트(오답순 최대 30, 발음 버튼), (4) **약점 집중 사냥**(`startWeakDrill`) = due 무관하게 취약 단어(`weakWords()`)만 모아 즉석 전투(SRS 정상 적용, 세션 `drill:true`).

### 4.7 단어은행 & 시딩
- **두 데이터셋**을 `BANK`(소문자 키 맵)에 편입: `words.js`의 `window.WORDBANK`(범용 고빈도 648) + `pack-hs1.js`의 `window.WORDPACK_HS1`(고1 필수 팩 224, 14주제). 겹치면 **WORDBANK 우선**(기존 예문 유지), 팩 신규분(≈157)이 BANK를 채워 cloze·오답지에 쓰임. `bankEx()`/`bankSenses()`/`clozable()`/`posOf()`.
- 첫 방문: `SAMPLE` 20개 자동 시딩.
- **영입소** 등록 경로: (1) 붙여넣기(`abandon - 버리다` 형식, `parseText()`), (2) 샘플 20개 버튼, **"어휘 담기"** 섹션에 위계로 묶음: **주(主)** = `packbtn`(고1 필수 어휘 팩, 골드 실선, 224 전체·하루 25개), 그 아래 **보조 한 줄**(`.addalt` flex) = (3b) `packthemes-toggle`(주제별 골라담기 → 14주제 `.fchip` 칩, `renderPackThemes`/`seedTheme`, 고른 주제만 즉시 담기·담긴 주제 ✓) + (4) `bankbtn`("범용 어휘", 이전 "교과서 고빈도"에서 정직 개칭, 범용 은행 하루 25개). 세 버튼 나열 → 주 1 + 보조 2 구조로 정리. 모두 이미 담긴 단어 제외.
- 붙여넣은 단어가 은행/팩과 철자 일치하면 예문·품사 자동 연결.
- **팩 확장**: `pack-hs1.js`에 `{w,pos,m,ex,th:'주제'}` 추가(예문은 원형 포함·아포스트로피 금지). 검증 파이프라인은 `scratchpad/validate-pack.mjs` 패턴 참고(중복·원형·아포스트로피 자동 점검).

### 4.8 몬스터 에셋 & 등급 진화
- 이미지는 전부 **로컬**(`assets/`): 몬스터 스프라이트 `assets/mon/*.png`(600×600 투명 PNG), 배경 `assets/bg.png`, 용사 `assets/hero.png`. 외부 CDN 의존 없음(과거 CloudFront → 로컬로 이관).
- `ASSETS = { bg, hero, common[23], rare[14], epic[11], legend[12] }` (`MON='assets/mon/'`). 네 풀은 `rarity(w).key`와 1:1로 매칭되며, `monAsset(w)`가 등급에 따라 풀을 골라 "진화"를 표현:

  | 등급 | 오답 | 몬스터 풀 |
  |---|---|---|
  | 일반 COMMON | 0 | `common` (23종) |
  | 희귀 RARE | 1~2 | `rare` (14종) |
  | 영웅 EPIC | 3~4 | `epic` (11종) |
  | 전설 LEGEND | 5+ | `legend` (12종) |

- 이제 **영웅·전설이 각자 전용 아트 풀**을 가진다(과거엔 둘 다 `boss` 공유). `monAsset(w)=ASSETS[rarity(w).key][hash(word)%풀길이]` — 등급 판정을 `rarity()`로 일원화.
- 단어→몬스터는 `hash(word) % 풀길이`로 결정론적(같은 단어는 같은 등급 안에서 항상 같은 몬스터). 오답이 쌓여 등급이 오르면 다른 풀에서 **새 모습으로 진화**(일반→희귀→영웅→전설).
- 로드 실패 시 `setMonImg`가 절차 생성 스프라이트(`sprite()`, 12×11 대칭 픽셀)로 폴백 → 오프라인·이미지 유실에도 동작.
- 아트는 힉스필드(Nano Banana 2)로 생성. 등급별 톤(치비→전사→정예→초대형 보스)과 몬스터별 배경색(회색/초록/마젠타, 팔레트 충돌 방지)을 프롬프트로 지정 후, **테두리 연결성분 기반 배경제거**(+갇힌 배경 주머니 제거·디프린지)·600 정규화·PNG8(256색) 최적화(장당 23~83KB). 파이프라인은 `scratchpad/process.py`·`run.py`·`roster.py`.
- **등장 깜빡임 방지**: `#b-spr`은 단일 `<img>`를 재사용 → 새 `src`를 넣어도 디코드 전까진 이전 몬스터 비트맵이 잠깐 보였음. `setMonImg(img,w,onReady)`가 **디코드 완료 시에만** 콜백하고, `nextMon`은 로드 전 `opacity=0`으로 숨겼다가 준비되면 `wqAppear`로 노출. `img.complete`(캐시/동일 URL)·onerror 폴백·1.5s 안전장치 처리. 무대 암전→점등(spawn) 연출은 유지.

### 4.9 클라우드 동기화 (선택 · 오프라인 우선)
- **목적**: localStorage 단독의 데이터 취약성 해소 — 기기 이동·브라우저 정리 시 진도 보존(냉정 평가 약점 ②).
- **스택**: `cloud.js` = Firebase Auth(이메일 링크, 패스워드리스) + Firestore. SDK는 gstatic ESM CDN에서 **동적 import**(빌드 도구 없음). `firebase-config.js`가 비면 `window.Cloud`=no-op → **완전 로컬 전용**(회귀 0). 로그인은 **선택**.
- **데이터**: `users/{uid}` 문서 1개 = `{ schema:1, words:{<id>:{...word,updatedAt}}, meta:{...,updatedAt} }` (648단어 ~130KB < 1MB 한도).
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

### 4.11 PWA (설치형 · 오프라인 셸)
- **목적**: 홈화면 설치 + 네트워크 없이도 앱 로드(오프라인 셸). 기존 오프라인 우선(localStorage) 위에 **셸 자체를 캐시**해 완전 오프라인화. 향후 웹푸시(①의 대안 채널) 토대.
- **구성**: `manifest.webmanifest`(name·standalone·portrait·`theme_color #101010`/`background_color #080808`·아이콘 3종) + `sw.js`(서비스 워커). `index.html` `<head>`에 manifest·theme-color·apple-touch 메타, 본문 끝에 SW 등록 + **설치 버튼 로직**(보안 컨텍스트에서만; `file://`·미지원 시 조용히 무시).
- **설치 버튼**: 홈 하단 `#pwa-install`("홈 화면에 앱 설치"). `beforeinstallprompt`를 잡아 기본 배너를 막고 버튼 노출 → 클릭 시 `deferred.prompt()`. `appinstalled`·이미 `display-mode: standalone`이면 숨김. iOS Safari는 이 이벤트 미지원 → 버튼 안 뜸(공유→홈추가는 수동, 향후 힌트 여지).
- **캐시 전략(`sw.js`)**:
  - **내비게이션**: 네트워크 우선 → 실패 시 캐시된 `index.html`(온라인이면 항상 최신 HTML, 오프라인이면 셸 부팅).
  - **자산(동일 출처 + 정적 CDN 허용목록: googleapis 폰트·gstatic·jsdelivr)**: **stale-while-revalidate** — 캐시 즉시 응답 + 백그라운드 갱신. 배포 후 1회 리로드로 최신화. 폰트/CSS까지 캐시돼 오프라인에서도 레트로 렌더 유지.
  - **Firebase Auth/Firestore 등 그 외 교차 출처**: **개입 안 함(캐시 우회)** → 실시간 동기화 보존. 비-GET도 통과.
- **버전 관리**: `sw.js`의 `VERSION` 상수(현재 `v1`). 셸 파일 크게 바꾸면 올려서 구 캐시(`wq-v1`) 무효화. activate에서 현재 캐시 외 전부 삭제 + `clients.claim()`.
- **아이콘**: `assets/icons/`(앰버 픽셀 몬스터, 다크 네이비 방사배경). 192·512(any) + maskable-512(넉넉한 안전지대) + apple-180. `scratchpad/gen-icon.mjs`로 수학 래스터화 후 Chromium 렌더 생성(교체 시 재생성).
- **검증**: `file://`은 SW 미동작 → HTTP 서버 필요(`python3 -m http.server 8792`). Playwright로 SW 등록·제어·캐시 적재·**오프라인 리로드 부팅(WORDBANK 전량)**·manifest 파싱·아이콘 200 전부 통과.

### 4.12 랭킹 서버 집계 (치팅 근본 차단 · 선택)
- **문제**: 랭킹 점수(`wk`/`days`)를 클라이언트가 자유 기록 → 콘솔에서 `99999` 위조로 1등 가능(실제 사건). 값 상한(cap)은 정상 고득점자를 깎아 부적절하고 근본 해결도 아님(v76에서 제거).
- **해법**: 점수를 **서버(Cloudflare 워커 `rank-worker/`)가 집계.** OCR 워커와 동일하게 Firebase 토큰을 검증하고, 학생이 보낸 "이번 주 완료 단어 id"를 **그 반 배포단어(`classPacks`)와 교집합**해 카운트 → KV에 기록. 점수를 클라가 못 쓴다.
- **핵심 성질**: 교집합이라 **천장 = 배정 단어 수(전부 했을 때)**. 임의 큰 값이 원천 불가, 정상 값은 상한 없이 그대로. 지표는 '이번 주 완료한 **배포 단어** 수'(개인 추가 단어 제외 → 공정 비교).
- **연속일수(streak)도 서버 산정**: 클라가 보낸 streak 은 무시. 워커가 '오늘 실제로 배포단어를 완료했는지(`todayIds ∩ classWords`)'를 관측해 `st:{uid}={last,n}` 로 연속을 이어가며(어제 이어짐 +1, 공백 리셋, 오늘/어제까지만 표시) 산정 → 콘솔로 못 부풀린다.
- **클라이언트**: `markDone`이 완료 id를 **날짜별 `meta.doneByDay`**(최근 9일)로 보관(기존 `doneIds` 마이그레이션). `cloud.js`가 이번 주 id + 오늘 id를 워커 `/sync`로 보고하고 `/board`로 순위를 읽는다. **`window.RANK_ENDPOINT`(firebase-config.js)로 게이트** — 비어 있으면 기존 Firestore 랭킹으로 폴백(워커 배포 전에도 앱 정상).
- **엔드포인트**: `POST /sync {week,today,ids,todayIds,name}`(점수·연속 모두 서버 계산 · 출석 `att`·명단 `mem`도 갱신) · `GET /board?scope=class|global&week=` · `GET /teacher?class=`(소유 선생님·마스터 전용, 선생님 대시보드 서버 검증값 — v100). 배포단어는 5분 KV 캐시.
- **배포/설정**: `rank-worker/README.md`(워커 생성 + `RANK_KV` 바인딩 + `FIREBASE_API_KEY`·`PROJECT_ID` 변수 + `RANK_ENDPOINT` 기입). 선택적 심층방어로 `leaderboards/*` 쓰기를 규칙에서 `if false`로 잠글 수 있음.
- **한계**: 완전 방어는 아님(작정하면 유효 id 스크립트 호출 가능, 그래도 최대치=배정 단어 전부). 콘솔 임의값 치팅은 불가.
- **선생님 대시보드도 서버 검증(v100)**: 대시보드는 오래도록 학생이 쓴 `summary.streak`·`summary.daily` 를 그대로 믿어 **연속일수·학습일수가 콘솔로 위조**됐다(랭킹만 막혀 있었음). 이제 같은 워커가:
  - `/sync` 때 **서버 시계(KST) 기준 오늘**만 출석으로 인정해 `att:{uid} = {날짜:완료수}` 에 남긴다. 날짜 키를 **서버가 정하므로**(클라 `today` 무시) 과거 날짜·연속을 못 심는다 — 랭킹 `st:{uid}` 가 클라 `today` 를 믿던 것보다 강한 위조 차단. 반 명단은 `mem:{cid}:{uid}`(45일 롤링).
  - **`GET /teacher?class=CLASSID`** — 소유 선생님(또는 마스터)만. 반 `ownerUid` 를 요청자 토큰으로 확인(규칙과 동일 신뢰선, 남의 반 `403`). `mem:*` 로 학생을 열거하고 각 `att:{uid}` 를 읽어 `{streak(=출석맵의 오늘/어제부터 연속), studyDays, days}` 반환. 마스터 판정 위해 `verifyFirebase` 가 `{uid,email,emailVerified}` 반환.
  - `cloud.js teacherBoard(cid)` → `renderTeacherStudents` 가 🔥연속·📅학습일·히트맵을 이 값으로 렌더. 워커 구버전이면 `/teacher` 404 → 자동 폴백 + "⚠️ 서버 검증 미적용" 배너. **정답률·포획은 여전히 앱 자기보고**(범례 명시) — 완전 검증 대상 아님.
  - **적용 조건: 워커 재배포**(worker.js Deploy). 검증값은 재배포 시점부터 축적(초기 며칠 히트맵 비어 보임=정상). 기존 랭킹 로직·엔드포인트는 무변경(회귀 없음).

---

## 5. 확장·수정 가이드

- **단어 추가/편집** → `words.js`에 한 줄: `{w:'단어',pos:'v',m:'뜻',ex:'원형 포함 예문.'}`. 다의어는 `m:'뜻1; 뜻2'` + `ex2` 추가.
  - 예문에 **단어 원형**이 들어가야 빈칸 출제됨(3인칭 -s, 과거형 등은 원형이 안 잡혀 k2e로 폴백).
  - 문자열은 작은따옴표. 문장에 **아포스트로피 금지**(`don't`→`do not`)로 따옴표 깨짐 방지.
- **SRS 간격 조정** → `LADDER` 상수.
- **포획 기준 변경** → `CAPTURE_STAGE`.
- **모드 난이도 배치 변경** → `pickMode()`.
- **몬스터 추가/교체** → `assets/mon/`에 투명 PNG(권장 600×600) 저장 후 `ASSETS`의 해당 등급 배열(`common`/`rare`/`epic`/`legend`)에 `MON+'파일명.png'` 한 줄 추가. 풀 길이가 바뀌면 기존 단어의 몬스터 배정이 재셔플됨(데이터 무관, 외형만 변경). 참고 §4.8.
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
- **PWA/SW 검증**(§4.11): 서비스 워커는 `file://`에서 안 돎 → HTTP 서버 필수(`python3 -m http.server 8792` → `127.0.0.1:8792`). Playwright `context.setOffline(true)` 후 `reload`로 오프라인 부팅 확인. SW 갱신 안 잡히면 `sw.js`의 `VERSION` 올리기(또는 DevTools Application→Service Workers→Unregister).
- **배포**: `main` 푸시 → Vercel 자동 배포. 커밋은 브랜치 → `--ff-only` 머지 → 푸시 패턴 사용.

---

## 7. 알려진 한계

1. **콘텐츠 = 범용 은행(648) + 고1 필수 팩(224, 14주제 큐레이션)**. 팩은 여러 교과서·수능에 반복 출현하는 핵심 어휘를 정직하게 선별한 것이지 **특정 출판사 교과서의 정확한 목록은 아님**(저작권·정확성). 정확한 시험범위는 영입소 붙여넣기 또는 `pack-hs1.js`/`words.js` 직접 추가로.
2. **듣기 모드 없음** — 단어 단위 TTS만. 문장 받아쓰기/듣고 고르기 없음.
3. e2k는 여전히 4지선다(재인). 철자 생산은 k2e·cloze에만.
4. 예문은 센스당 1문장(최대 2).
5. **클라우드 동기화는 선택**(§4.9) — 로그인 + Firebase 셋업해야 켜짐. 안 하면 여전히 로컬 전용(백업 내보내기/가져오기 병행 권장).
5b. **PWA 설치·SW는 HTTPS/배포에서만**(§4.11) — 로컬 `file://`은 SW 미동작(HTTP 서버 필요), 홈화면 "설치"는 배포 도메인(HTTPS)에서 뜸. 자산은 stale-while-revalidate라 배포 직후 **1회 리로드** 후 최신 반영. 셸 대개편 시 `sw.js` `VERSION` 올릴 것.
6. **① 복귀 알림 — 코드 완성, 활성화 대기** — 크론+발송기+옵트인·문서 완비(§4.10). 단 SendGrid·Firebase 서비스계정 시크릿 3종을 등록해야 실제 발송. 미등록이면 크론이 실패 종료만 하고 앱엔 무영향. 실메일 라이브 검증은 사용자 셋업 후.
7. **동기화 라이브 최종검증 미완** — 코드·로그인은 확인, 두 기기 실제 병합은 사용자 Firebase 셋업 후 검증 예정. 병합은 whole-doc write(~120KB) — 대량 사용 시 단어별 세분화 여지.
8. **배포 URL 미확인** — `wordquest.vercel.app`은 404였음. 이메일 링크 로그인은 배포 도메인을 Firebase 승인목록에 추가해야 동작.
9. 타자기-피드백 레이스. 실사용 무해하나 자동화 검증 시 충분히 대기.
10. **참고(버그 아님)**: 타이핑 모드는 단어 stage 2+에서만 등장(§4.2). 4지선다만 보이면 단어가 아직 stage 0~1이라는 뜻.

---

## 8. 백로그 (다음 후보)

**우선순위(냉정 평가 기준):**
- **① 알림 활성화 + 라이브 검증** — 코드는 완성(§4.10). 사용자가 시크릿 3종 등록 → `dry_run` → 실발송 확인. (예문 확충 등 발송 카피 다듬기 여지.)
- **동기화 라이브 검증 마무리** — 사용자 Firebase 셋업 후 두 기기 병합 확인(§7-7).
- **웹푸시 알림**(선택) — PWA(§4.11) 위에 Push API + Firebase Cloud Messaging. ①의 이메일 대안(설치 사용자 대상). 서비스 워커 준비됨.

**그 외:**
- **단어은행 품질**: 부사 3→49 보정 + 고1 필수 팩 224(14주제) 내장 완료. 남은 것 — 특정 출판사 시험범위 정밀 매핑, 다의어 2예문 확충(현재 `ex2` 14/648), 주제별 선택 시딩 UI(현재 팩 전체 담기만), 팩 추가 확대 여지.
- **듣기 모드**: 예문/단어 음성 → 받아쓰기 또는 4지선다.
- 오답 통계 대시보드 확장, 콜로케이션, `vocamon.html` 레거시 정리.
- ✅ **완료**: 기기 간 클라우드 동기화 ②(§4.9), 몬스터 로스터·에셋 로컬화, **① 복귀 알림 스캐폴드(§4.10) — 활성화만 남음**, **PWA 설치형·오프라인 셸(§4.11)**.

### 미해결 백로그 (2026-07-16 세션 이후)
이 세션은 랭킹/대시보드 표시·동기화 사고 대응에 집중했다(전부 해결·배포 완료 — v100~v102, Cloudflare Workers Paid 전환으로 KV 한도 해소, 저장소 Private 전환으로 죽었던 Pages는 Public 복귀+Source=GitHub Actions 재설정으로 복구, 워크플로에 `enablement: true` 자동복구 추가). 아래는 **손 안 댄 4건 + 미배포 1건**.

- **① 한글 뜻 앞 `(` 단어 (16개)** — `pack-hs1.js`(1)·`pack-hs2.js`(1)·`pack-hs3.js`(3)·`pack-confuse.js`(8)·`pack-vacation.js`(3). 예: `(생물) 종`, `(짧은) 여행`, `(돈·시간을) 쓰다`. **전수 괄호 균형 검사 → 불균형 0개**: 전부 닫는 괄호가 있는 정상 사전식 문맥 표기다. 사용자가 "깨져 보인다"고 지적 → **표기 정책 결정 필요**(그대로 둘지 / 선행 괄호를 떼거나 뒤로 옮길지). `firstSense()`(index.html:1198, `[;,/·]`로 첫 뜻만 자름)가 괄호를 끊지는 않음(별개 확인).
- **② 도감 나가기 버튼(상단)** — `scr-dex`(index.html:852)의 '◀ 마을로 돌아가기'가 `dexgrid`(867) **아래**(868)에만 있어, 도감이 길면 맨 밑까지 스크롤해야 나감. 화면 상단(스크롤 없이 보이는 위치)에 나가기 버튼/헤더 고정 추가. 안전한 UI 작업.
- **③ DDoS/남용 (서브에이전트 감사 완료 · 미조치)** — 결론: **돈은 안전**(OCR→Anthropic 은 uid별 캡 `USER_DAILY_LIMIT`·`DAILY_CAP`+KV 게이트로 방어; `ocr-worker/worker.js`). **가용성 위험 高**: Firebase **Spark(무료)** 할당량(읽기 5만·쓰기 2만/일)을 로그인 사용자가 브라우저 루프로 소진 → 하루짜리 무료 outage($0·자정 리셋). 벡터 (a) `rank-worker /sync` 는 요청당 Firestore **2읽기**(`getDoneByDay`+`getClassId`) 무가드 → ~2.5만 요청이면 프로젝트 읽기 할당량 고갈; (b) `firestore.rules` 가 본인 문서 **무제한 self-write** 허용 → 쓰기 할당량 고갈; (c) 잘못된 토큰이라도 워커가 매 요청 구글 `accounts:lookup` 호출(증폭). **오픈 가입**이라 공격자 풀 = 구글 계정 아무나. 대응(cheap→proper): **P1** 워커 `/sync` 에 uid·분당 throttle(OCR 워커 KV 카운터 패턴 재사용, ~10/min); **P2** `verifyFirebase` 결과 KV 캐시 or ID토큰 JWT 로컬 검증(구글 호출 증폭 제거); **P3 Firebase App Check**(reCAPTCHA/Play Integrity) — 스크립트/콘솔 클라 차단(근본책); **P4** 워커 `ALLOW_ORIGIN` 앱 도메인으로·Firebase apiKey HTTP referrer 제한. **대시보드에서 확인 필요**: `OCR_KV` 바인딩 존재 · Anthropic 월 스펜드 캡. (`docs/security-review-2026-07-15.md` §2-3 의 오픈가입·global 노출 지적과 연결.)
- **④ JSON 변조 잔여 점검 (미조사)** — 랭킹 `wk`·연속·학습일은 서버(rank-worker) 관측으로 위조 차단 완료. 남은 것: 대시보드의 `summary.accuracy/captured/total/attempts` 등은 여전히 **학생 앱 자기보고**(`users/{uid}` self-write)라 위조 가능(표시용). 위험도·차단 필요성 점검 필요.
- **+ rank-worker 쓰기 절약본 미배포** — ~~커밋 `80a09ff` 붙여넣기 배포 권장~~ → **v103 세션에서 r4 로 대체·강화됨**(등재 우선 + 스로틀 + `/board` 내 행 즉석 병합 + degraded/503 가시화 + `v` 리비전 마커). **여전히 Cloudflare 수동 재배포 필요** — `worker-dashboard.js` 붙여넣기·Deploy 후 워커 주소를 브라우저로 열어 `v:"r4"` 확인. 위 "이번 세션(2026-07-16) — 랭킹 미등재 근본 대응" 항목 참고.

---

## 9. 참고 — 주요 함수 위치

**index.html 메인 `<script>`**: `pickMode` `clozable` `makeChoices` `askText` `clozeText` `bankSenses` · `nextMon` `answer` `submitSpell` `resolveAnswer` · `renderChoices` `renderSpellInput` `renderMonHP` `renderParty` · `renderDex` `renderHome` `renderReg` `renderWeak` `endBattle` · `renderNote` `weakWords` `startWeakDrill`(오답 노트·§4.6) · `renderPackThemes` `seedTheme`(주제 시딩·§4.7) · `dueIds` `rarity` `acc` `koType` `engSim` `lev` `posOf` · `monAsset` `setMonImg`(onReady 콜백) `sprite`(폴백) · `migrateWords` `persist` `parseText` `speak` · 시딩: `packbtn`/`bankbtn` 핸들러.
**클라우드(§4.9)**: 앱 측 `window.WQ`(getState/applyMerged/setSyncStatus/isBusy)·`setCloudStatus`·`renderCloudNotify`·`wireCloudUI`(index.html) ↔ `cloud.js`의 `window.Cloud`.
**알림(§4.10)**: `scripts/reminders/lib.mjs`(`countDueWords`/`todayInTimeZone`/`shouldRemind`/`buildEmail`) · `send-reminders.mjs`(로드·발송 오케스트레이션). 앱 측 옵트인: `renderCloudNotify`·`persist`(meta.tz)·`meta.notify`.
**PWA(§4.11)**: `manifest.webmanifest` · `sw.js`(`handleNavigate`/`handleAsset`·`CACHE`·`CACHE_HOSTS`) · `index.html` head 링크·본문 끝 SW 등록.
**데이터/설정**: `words.js`(`window.WORDBANK`), `pack-hs1.js`(`window.WORDPACK_HS1` — 고1 필수 팩), `firebase-config.js`(`window.FIREBASE_CONFIG`). 시딩: `packbtn`/`bankbtn` 핸들러.
