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

> **★ 현재 자세(r16 · "App Check 우선 1단계").** 서버 세션 채점의 뜻-고르기 재설계(id-echo 완전
> 제거)는 **2단계로 유보**된 상태다. 그래서 **지금 배포본에서 랭킹 위조를 실제로 막는 주 방어선은
> 이 App Check enforce**(=앱 밖 스크립트 차단)이다. r16 에서 코드로 한 것은 (a) `/sync` 도 App Check
> 게이트에 포함, (b) **무채점 개인단어 크레딧 제거**(정답 0으로 적립되던 가장 무른 곁길 봉쇄)뿐이고,
> **팩 id-echo·att 시딩 같은 '인페이지 콘솔' 위조는 남아 있다**(§0 상단 ❌ 참고 — 상한·이상탐지로만
> 억제). 이 인페이지 위조까지 없애려면 2단계(서버 출제 뜻-4지선다·index 채점)를 진행해야 한다.
> ⇒ **App Check enforce 를 켜지 않으면 이번 변경의 보안 이득은 '개인 곁길 봉쇄' 하나뿐**이다. 꼭 켤 것.
> (설계 근거·2단계 계획은 `docs/server-scoring.md`.)

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

## 4) 강제(enforcement) 전환 — ⚠️ 순서를 반드시 지킬 것

검증 비율이 정상 학생에서 ~100% 로 안정된 **뒤에만** 강제를 켠다.

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

## 체크리스트

- [ ] 콘솔 App Check 에서 웹 앱 등록 + reCAPTCHA v3 공급업체 설정, 도메인에 배포 도메인·`localhost` 포함.
- [ ] `firebase-config.js` 에 `APPCHECK_SITE_KEY`(사이트키)·`PROJECT_NUMBER`(=messagingSenderId) 기입 후 배포.
- [ ] 워커 env 에도 `PROJECT_NUMBER` 동일값 설정(`docs/server-scoring.md`).
- [ ] 측정항목에서 정상 학생 검증 비율이 ~100% 로 안정될 때까지 **모니터링**(`APPCHECK_ENFORCE=false`).
- [ ] 안정 확인 **후에** Cloud Firestore 강제 ON(4-a 경고 순서 준수) / 워커 `APPCHECK_ENFORCE=true`(4-b).
- [ ] 디버그 토큰은 개발 브라우저에만, 배포본엔 비움.

## 참고

- App Check 는 **심층방어의 한 겹**이지 위조 차단의 본체가 아니다. 랭킹 위조의 실제 차단은 **서버
  세션 채점 + 상한**이다 — 설계·엔드포인트·env·롤아웃 순서: **`docs/server-scoring.md`**.
- 워커 배포·env·확인 방법: **`rank-worker/README.md`**.
- Firebase 기본 셋업(프로젝트·로그인·Firestore 규칙): `docs/firebase-setup.md`.
