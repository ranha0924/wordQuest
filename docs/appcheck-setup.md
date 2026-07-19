# App Check 셋업 가이드 (서버 권위 채점 · 봇/외부 스크립트 차단)

Firebase **App Check** 는 "지금 요청이 **진짜 우리 앱**(정상 브라우저에서 로드된 WordQuest)에서
왔는지"를 reCAPTCHA v3 로 판정해, **앱 밖에서 날아오는 요청**(REST 직접 호출·자동화 스크립트·봇)을
막는다. 서버 세션 채점(`docs/server-scoring.md`)의 **심층방어 한 겹**으로 쓴다.

> **약 15분, 전부 무료.** 안 켜도(아래 두 값이 비어 있으면) 앱은 지금처럼 그대로 동작한다.
> App Check 는 **선택**이며, 켜면 랭킹·동기화의 위조 저항이 한 단계 올라간다.

---

## 0) 먼저 — App Check 가 막는 것 / 못 막는 것 (정직한 한계)

App Check 는 **앱 인스턴스(설치본)를 증명**할 뿐, **작업 하나하나(per-operation)를 증명하지 않는다.**

- ✅ **막는다**: 앱을 거치지 않는 요청 — 콘솔 `fetch()`/`curl` 로 워커·Firestore 를 직접 때리는
  REST 호출, 헤드리스 봇, 외부 자동화 스크립트. 이들은 유효한 App Check 토큰을 못 만든다.
- ❌ **못 막는다**: **진짜 페이지의 개발자도구 콘솔**에 앉은 사람. 그 콘솔은 페이지가 이미 받아 둔
  App Check 토큰을 **그대로 재사용**하므로, App Check 입장에선 "정상 앱의 요청"으로 보인다.

즉 **App Check 만으로 위조가 100% 차단되지는 않는다.** App Check 는 **"앱 밖 대량 자동화"를 걸러
내는 방벽**이고, 그 위에 **버스트/주간 상한**과 (원한다면) **서버 세션 채점**이 얹힌다.

> **★ 현재 자세(r17 · 2단계 서버-MC 완료).** 서버 출제 뜻-4지선다·index 채점(2단계)이 **적용됐다** —
> `/quiz/start` 가 정답 번호를 세션에만 두고 클라엔 보기만 주며, `/quiz/submit` 은 '고른 번호'만
> 받는다. 이로써 **id-echo(답=단어 id 되던지기)는 죽었고**, 랭킹은 **서버 MC 검증분(`ver_mc`)만**으로
> 재정비됐다(att·hash 은퇴 = 랭킹 리셋). **그러나** 단어 뜻이 오프라인용 공개파일이라 **'공개 뜻을 긁어
> 번호를 맞추는 인페이지 스크립터(T3)'는 여전히 통과**한다(~100% 정답이라 탐지도 회피). 즉 2단계로도
> **인페이지 위조는 완전차단이 아니며**, 그걸 막는 **유일한 앱-밖 방벽은 여전히 이 App Check enforce**(=앱
> 밖 스크립트 차단)이다. ⇒ **App Check enforce 를 켜지 않으면 앱 밖 자동화가 그대로 뚫는다**. 반드시 켤 것.
> (2단계가 하는 것: id-echo·복붙 스크립트 사망 + 뜻 스크레이핑 노력 강제 + 저정답률 탐지. 설계는
> `docs/server-scoring.md` r17 배너.)

> **★★ r19(2026-07-19) — CORS 치명 결함 수정 · enforce 는 반드시 r19 배포 후에.**
> 워커 CORS `Access-Control-Allow-Headers` 에 `X-Firebase-AppCheck` 가 빠져 있어, 토큰을 동봉하는
> **정상 브라우저의 `/sync`·`/quiz/*` 는 프리플라이트에서 거부**(조용한 로컬 폴백 = 크레딧·출석 누락)되고
> **CORS 를 무시하는 앱 밖 스크립트만 통과**하는 역전 상태였다(v121~r18, "외부에서 뚫렸는데 정상
> 학생 점수는 안 오른다" 관측의 유력 원인). r19 가 이를 수정했고, `/sync` 응답에 `acw`(미검증 사유)
> 모니터링 필드와 misconfig 페일클로즈드(enforce=true + PROJECT_NUMBER 누락 = 전부 거부)도 추가됐다.
> **⇒ 구버전(r18 이하) 워커에서 `APPCHECK_ENFORCE=true` 를 켜면 정상 학생까지 전멸한다. 반드시
> r19 트윈 재배포(`v:"r19"` 확인) 후에 아래 §4 순서대로 켤 것.** OCR 워커도 o2 부터 같은 게이트 지원.

> reCAPTCHA **v3 는 무보임(invisible)·무마찰** — 체크박스나 이미지 퍼즐이 없다. 방문 중 행동
> 점수만 백그라운드로 계산하므로 **정상 학생은 아무 것도 눈치채지 못한다**(로그인·학습 흐름 불변).

---

## 1) 콘솔에서 App Check 등록 + 사이트키 발급

1. [Firebase 콘솔](https://console.firebase.google.com) → 프로젝트(`wordquest-a250d`) →
   좌측 **빌드 → App Check**(또는 상단 검색 "App Check").
2. **앱** 탭에서 이 프로젝트의 **웹 앱**을 선택 → **등록**.
3. 공급업체(provider)로 **reCAPTCHA v3** 선택.
   - 처음이면 reCAPTCHA v3 **사이트키/비밀키**를 만들라고 안내한다. 사이트키는 **공개값**,
     비밀키는 Firebase 가 서버측에서 관리(우리가 따로 넣을 곳 없음).
   - 도메인 목록에 배포 도메인(`ranha0924.github.io`)과 `localhost` 를 넣는다.
4. 발급된 **reCAPTCHA v3 사이트키**(`6L...` 형태)를 복사한다.

## 2) `firebase-config.js` 에 두 공개값 기입 + 배포

`firebase-config.js` 아래쪽 App Check 블록의 **두 값**을 채운다(둘 다 공개값·커밋 안전):

```js
window.APPCHECK_SITE_KEY = '6L...';        // 1)에서 복사한 reCAPTCHA v3 사이트키
window.PROJECT_NUMBER     = '363343730753'; // Firebase 프로젝트 "번호"(NUMBER)
```

- **`PROJECT_NUMBER` 는 projectId 문자열(`wordquest-a250d`)이 아니라 숫자 ID** 다.
  이 프로젝트에선 **`FIREBASE_CONFIG.messagingSenderId` 와 같은 값**(`363343730753`)이므로 그대로
  복사하면 된다. (콘솔 **⚙ 프로젝트 설정 → 일반 → 프로젝트 번호** 에서도 확인 가능.)
- 이 값은 **워커**가 App Check 토큰(JWT)의 `aud=projects/<번호>` 를 검증하는 데 쓴다
  (워커 env `PROJECT_NUMBER` 도 같은 값으로 설정 — `docs/server-scoring.md`).

저장 → **커밋·푸시**하면 GitHub Pages 가 배포한다. 이 순간부터 앱이 App Check SDK 를 초기화하고
`/quiz/*` 요청에 App Check 토큰을 실어 보낸다. (**두 값 중 하나라도 비어 있으면 App Check 는 꺼진
상태** = 기존 폴백으로 동작.)

## 3) 모니터링 — "검증됨" 비율이 정상 학생에서 ~100% 가 될 때까지 관찰

**절대 곧바로 강제(enforce)로 넘어가지 않는다.** 먼저 관찰한다.

1. 콘솔 App Check → **측정항목(Metrics)** 에서 Firestore·기타 요청의 **"검증됨(verified)"
   vs "미검증(unverified)"** 비율을 본다.
2. 앱-App Check 클라이언트가 **학생들에게 전파**(캐시 갱신·재방문)되면서 검증 비율이 오른다.
   보통 며칠. **정상 학생 트래픽이 사실상 ~100% 검증됨** 으로 안정될 때까지 기다린다.
3. 이 기간 동안 워커는 **모니터링 모드**(env `APPCHECK_ENFORCE=false`)로 둔다 — App Check 실패를
   **로깅만 하고 통과**시키므로 오탐이 있어도 학생이 안 깨진다(`docs/server-scoring.md`).
4. **워커 도달 확인(r19·중요)**: Firestore 지표는 Firebase 서비스만 보므로, **워커까지 토큰이
   도달·검증되는지**는 따로 본다 — r19 워커 + env `PROJECT_NUMBER` 설정 상태에서 배포된 앱을 열고
   **DevTools → Network → `/sync` 응답 JSON** 을 확인:
   - `acw` 필드가 **없음** = 토큰이 워커에서 **검증됨**(enforce 켜도 이 브라우저는 안전).
   - `acw:"no_token"` = 클라가 토큰을 못 만듦(광고차단기의 reCAPTCHA 차단·구캐시 등) — enforce 시 403 대상.
   - `acw:"skipped"` = 워커 env `PROJECT_NUMBER` 미설정(검증 자체를 안 함).
   (앱 v125+ 는 acw 를 콘솔 경고로도 1회 보여준다. v124 이하 클라에선 Network 탭으로만 확인.)

## 4) 강제(enforcement) 전환 — ⚠️ 순서를 반드시 지킬 것

검증 비율이 정상 학생에서 ~100% 로 안정된 **뒤에만** 강제를 켠다.

### 4-0) 선행 조건(무조건): 워커 r19 배포
`rank-worker` 트윈을 **r19 로 재배포**하고 워커 주소를 브라우저로 열어 `v:"r19"` 를 확인한다.
r18 이하에서 enforce 를 켜면 CORS 결함(상단 r19 배너) 때문에 **정상 학생까지 전부 403/프리플라이트
실패**가 된다. 또 env 는 **`PROJECT_NUMBER` 와 `APPCHECK_ENFORCE` 를 반드시 함께** 설정한다 —
r19 부터 `APPCHECK_ENFORCE=true` 인데 `PROJECT_NUMBER` 가 없으면 전 요청을 `misconfig` 로 거부한다
(페일클로즈드 — 예전처럼 조용히 무력화되지 않는다).

### 4-a) Cloud Firestore 강제
콘솔 App Check → **Cloud Firestore** → **강제 적용(Enforce)**.

> ⚠️ **경고 — 켜는 시점을 틀리면 학생 동기화가 깨진다.**
> App Check **미포함** 클라이언트(옛 캐시·미배포)가 남아 있는 상태에서 Firestore 강제를 켜면,
> 그 클라이언트의 Firestore 읽기·쓰기가 **거부**된다. 결과: **로그인·랭킹·기기 간 동기화 실패.**
> 반드시 **(1) App Check 켠 클라이언트를 배포하고 (2) 학생들에게 전파(3단계 ~100% 검증)된
> 것을 확인한 뒤** 강제를 켠다.
>
> 다행히 **오프라인 학습은 안 깨진다** — 앱은 오프라인 우선이라 학습·SRS·도감은 `localStorage`
> 로 그대로 돈다. 강제 오설정 시 실패하는 것은 **서버 동기화·랭킹 반영뿐**이다(데이터 유실 아님,
> 재동기화 시 union 병합으로 복구). 그래도 학생 혼란을 피하려면 순서를 지킨다.

### 4-b) 워커 `/sync`·`/quiz/*` 강제  (★r16 부터 `/sync` 도 게이트)
Firestore 강제와 **별개**로, 랭킹 워커도 App Check 를 강제하려면 워커 env `APPCHECK_ENFORCE=true`
로 바꾼다(재배포 불필요, 변수만 변경 → 즉시 적용). **r16 부터 게이트 대상 = `/sync` + `/quiz/start`
+ `/quiz/submit`**(전부 랭킹 크레딧·att 기록을 쓰는 경로). 이게 **앱 밖 스크립트로 워커를 직접
때리는 위조(이번 침해의 유력 경로)를 막는 핵심 스위치**다.

> ⚠️ **`/sync` blast radius — 켜는 순서를 지킬 것.** `/sync` 는 랭킹뿐 아니라 **출석·연속(streak)·
> 반 보드 기록**도 담당한다. `APPCHECK_ENFORCE=true` 인데 클라가 유효 App Check 토큰을 못 만들면
> (site key 미기입·미배포·App Check 초기화 실패) `/sync` 가 **403** → 그 학생은 **출석·연속·랭킹을
> 전혀 동기화 못 한다**(학습·SRS·도감은 오프라인이라 무사). 그래서 **반드시 (1) `APPCHECK_SITE_KEY`
> 를 채운 앱을 배포하고 (2) 3단계에서 정상 학생 검증 ~100% 를 확인한 뒤** enforce 를 켠다.
> **즉시 롤백 = 워커 변수 `APPCHECK_ENFORCE=false`(재배포 불요, 즉시 원복).**

> ℹ️ enforce 를 켜기 전(모니터링/미설정)에는 `/sync` 게이트가 **도먼트**다 — `verifyAppCheck` 가
> `PROJECT_NUMBER` 미설정이거나 `APPCHECK_ENFORCE!=='true'` 면 토큰이 없어도 `ok:true` 로 통과시키므로
> **기존 동작 그대로**(회귀 0). 게이트 코드는 r16 에 이미 들어가 있고, 스위치만 사용자가 켜면 된다.
> (r19 예외 1건: `APPCHECK_ENFORCE=true` 인데 `PROJECT_NUMBER` 누락이면 misconfig 거부 — §4-0.)

**켠 뒤 확인(2가지)**:
1. **정상 경로**: 실기기에서 앱을 열어 학습→랭킹 갱신이 그대로 되는지 + DevTools Network `/sync` 가
   200(acw 없음)인지 확인.
2. **차단 경로**: 앱 밖 호출이 403 으로 막히는지 — 로그인 상태 앱의 DevTools Network 에서 `/sync` 요청의
   `Authorization: Bearer …` 값을 복사해, PC 터미널에서 App Check 헤더 **없이**:
   ```bash
   curl -s -X POST '<RANK_ENDPOINT>/sync' -H 'Authorization: Bearer <복사한 ID토큰>' \
     -H 'Content-Type: application/json' -d '{"week":"2026-07-13","ids":[],"todayIds":[]}'
   # → {"error":"appcheck","reason":"no_token","v":"r19"} = 앱 밖 위조 경로가 실제로 차단되고 있다는 뜻
   #   (Authorization 없이 보내면 게이트 앞의 인증에서 401 — 그건 App Check 확인이 아니다)
   ```

> ℹ️ **enforce 중 JWKS 일시 장애**: 워커는 Firebase App Check 공개키(JWKS)를 가져와 서명을 검증한다
> (KV 1시간 캐시). 캐시가 비어 있는 순간 JWKS fetch 까지 실패하면 `no_key` 로 403 이 날 수 있다
> (드묾·일시적, 다음 요청에서 재시도). 지속되면 롤백(`APPCHECK_ENFORCE=false`) 후 원인 확인.

### 4-c) OCR 워커 강제 (o2 · 선택 — 유료 Claude 호출 남용 차단)
랭킹과 별개로, OCR 워커도 o2 부터 같은 게이트를 지원한다(앱 밖 스크립트가 로그인 토큰만으로
유료 Claude 호출·`DAILY_CAP` 을 태우는 공격 차단). **순서가 더 엄격하다**:
1. **앱 v125 배포·전파 확인** — v125 부터 OCR 호출에 App Check 헤더를 동봉하고, 403 `appcheck` 를
   받으면 **기기 내 무료 OCR(Tesseract)로 자동 강등**한다. ⚠️ v124 이하 구캐시 클라는 403 시
   폴백 없이 "인식 서버 오류(appcheck)" 안내만 보므로(수동 입력은 가능), 전파 전에 켜면 AI 인식이
   그만큼 불편해진다 — 급하지 않으니 전파 후에 켤 것.
2. `ocr-worker/worker.js`(o2) 재배포 → 워커 주소 열어 `{"error":"method_not_allowed","v":"o2"}` 확인.
3. env `PROJECT_NUMBER`(랭킹 워커와 같은 값) + `APPCHECK_ENFORCE=true` 설정. 롤백 = `false`.

## 5) 강제 범위 — Firestore 한정, 로그인(Auth)은 무관

- App Check 강제는 **서비스별로 따로** 켠다. 위에서 켠 것은 **Cloud Firestore 범위**다.
- **Firebase Authentication(구글 로그인)은 App Check 강제의 영향을 받지 않는다** — 이 앱은
  Auth 에 App Check 강제를 걸지 않으므로, App Check 설정이 어긋나도 **로그인 자체는 계속 된다.**
  (깨질 수 있는 것은 로그인 이후의 Firestore 동기화뿐 — 4-a 경고 참고.)

## 6) 로컬 개발 — App Check 디버그 토큰

`localhost` 등 reCAPTCHA v3 가 정상 채점하기 어려운 개발 환경에서는 **디버그 토큰**으로 그 브라우저를
정식 기기로 인정시킨다.

1. 개발 브라우저에서 앱을 열고 콘솔 로그에 찍히는 App Check **디버그 토큰(UUID)** 을 복사
   (또는 `firebase-config.js` 의 `window.APPCHECK_DEBUG_TOKEN` 에 임의 UUID 를 지정).
2. 콘솔 App Check → **앱 → ⋮ → 디버그 토큰 관리** 에 그 UUID 를 등록.
3. 그 브라우저는 이제 검증됨으로 취급된다.

> ⚠️ **디버그 토큰은 개발 전용.** 실제 배포본(`firebase-config.js`)에는 `APPCHECK_DEBUG_TOKEN`
> 을 **비워 둔다**(공개 저장소에 유효 토큰을 커밋하지 말 것 — 그 자체가 우회 열쇠가 된다).

---

## 체크리스트 (r19 순서)

- [x] 콘솔 App Check 에서 웹 앱 등록 + reCAPTCHA v3 공급업체 설정, 도메인에 배포 도메인·`localhost` 포함.
- [x] `firebase-config.js` 에 `APPCHECK_SITE_KEY`(사이트키)·`PROJECT_NUMBER`(=messagingSenderId) 기입 후 배포(v121).
- [ ] **① rank-worker 트윈 r19 재배포**(`v:"r19"` 확인) — CORS 수정. 이것만으로 정상 학생 `/sync`·`/quiz` 복구.
- [ ] **② 워커 env `PROJECT_NUMBER=363343730753` 설정**(강제는 아직) → §3-4 방법으로 `/sync` 응답에 `acw` 없음 확인.
- [ ] **③ 앱 v125 배포**(main 병합 → Pages 자동) — OCR·보드 호출에도 토큰 동봉 + acw 콘솔 경고.
- [ ] **④ 워커 `APPCHECK_ENFORCE=true`**(4-b — 앱 밖 `/sync`·`/quiz/*` 위조 차단·이번 침해 경로) + 4-b 의 2가지 확인.
- [ ] **⑤ 콘솔 App Check → Cloud Firestore 강제 ON**(4-a — 지표 ~100% 확인 후).
- [ ] **⑥ (선택) ocr-worker o2 재배포 + env 설정**(4-c — v125 전파 후).
- [ ] 디버그 토큰은 개발 브라우저에만, 배포본엔 비움.
- 각 단계 롤백: 워커 env `APPCHECK_ENFORCE=false`(즉시) / Firestore 는 콘솔에서 강제 해제(즉시).

## 참고

- App Check 는 **심층방어의 한 겹**이지 위조 차단의 본체가 아니다. 랭킹 위조의 실제 차단은 **서버
  세션 채점 + 상한**이다 — 설계·엔드포인트·env·롤아웃 순서: **`docs/server-scoring.md`**.
- 워커 배포·env·확인 방법: **`rank-worker/README.md`**.
- Firebase 기본 셋업(프로젝트·로그인·Firestore 규칙): `docs/firebase-setup.md`.
