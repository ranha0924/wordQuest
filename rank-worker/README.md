# 랭킹 집계 워커 (rank-worker) — 점수 위조(치팅) 근본 차단

랭킹 점수를 **클라이언트가 못 쓰게** 하고, **서버(이 워커)가 "이번 주 완료한 단어 수"를 센다.**
학생이 콘솔에서 `wk:99999` 같은 값을 넣어도 랭킹에 반영되지 않는다.

## 원리 (상한 없이 위조만 차단)
- 워커는 로그인 토큰을 검증(OCR 워커와 동일)하고, **학생 본인의 동기화된 완료기록**(`users/{uid}/private/state` 의 `meta.doneByDay`)을 Firestore REST 로 직접 읽어 **"이번 주(월~오늘) 완료한 단어 유니크 수"**를 센다.
- 클라이언트가 보낸 숫자/목록은 신뢰하지 않는다 → 콘솔로 `wk` 를 직접 못 쓴다.
- 배포단어에 국한하지 않고 완료한 **모든 단어(개인등록·기본팩·배포)**를 종류 불문 카운트한다.
- 점수의 자연 천장 = "실제로 완료 기록된 단어 수". 임의 큰 숫자가 원천 불가하고, 진짜 열심히 한 학생의 값은 **상한 없이** 반영된다.
- 점수는 워커만 KV에 기록 → 클라 직접 쓰기가 없다.

## 배포 (약 5분, Cloudflare 대시보드)
1. **Workers & Pages → Create → Worker** 로 새 워커 생성(예: `wordquest-rank`).
2. 코드에 이 폴더의 `worker.js` 내용을 통째로 붙여넣고 **Deploy**.
3. **Settings → Variables and Secrets** 에 추가:
   - `FIREBASE_API_KEY` — `firebase-config.js` 의 `apiKey`(공개값).
   - `PROJECT_ID` — Firebase `projectId` (예: `wordquest-a250d`).
   - `ALLOW_ORIGIN` *(선택)* — 앱 도메인(예: `https://<사용자>.github.io`). 기본 `*`.
4. **Settings → Bindings → KV Namespace** 에서 네임스페이스 하나 만들고(예: `wordquest-rank-kv`) 변수명 **`RANK_KV`** 로 바인딩.
5. 배포된 워커 주소를 `firebase-config.js` 의 `window.RANK_ENDPOINT` 에 넣고 커밋·배포.
   ```js
   window.RANK_ENDPOINT = "https://wordquest-rank.<계정>.workers.dev";
   ```
   → 이 값이 채워지는 순간부터 랭킹이 서버 집계로 전환된다(비어 있으면 기존 Firestore 방식으로 폴백하므로, 배포 전까지 앱은 그대로 동작).

## (선택) 심층방어 — Firestore 랭킹 쓰기 잠그기
워커로 전환되면 앱은 `leaderboards/*` 를 더는 읽지 않으므로 거기에 위조 값을 넣어도 무해하다.
그래도 깔끔하게 잠그려면, 배포·확인 후 `firestore.rules` 의 두 `leaderboards` 매치의 `allow write` 를 아래로 바꿔 게시한다(읽기도 필요 없으면 함께 `if false`):
```
// leaderboards/_global/entries/{uid} 와 leaderboards/{cid}/entries/{uid} 공통
allow write: if false;   // 점수는 rank-worker(KV)만 기록 — 클라 직접 쓰기 금지
```
`allow delete` 는 남겨두면 과거 위조 항목 정리에 쓸 수 있다.

## 현재 치팅 항목 즉시 제거
Firebase 콘솔에서 값이 비정상으로 큰 항목 삭제:
`leaderboards/_global/entries/{uid}` · `leaderboards/{반ID}/entries/{uid}`.

## 선생님 대시보드도 서버 검증 (연속일수·학습일수 위조 차단) — v100
과거엔 선생님 대시보드가 학생이 자기 계정에 쓴 `summary.streak`(연속일수)·`summary.daily`(날짜별 기록)를 **그대로 믿어서**, 학생이 콘솔로 그 값을 바꾸면 대시보드에 그대로 떴다(랭킹만 서버 집계였고 대시보드는 아니었음).
이제 이 워커가 **서버 시계(KST) 기준으로 관측한** 출석·연속일수를 KV에 남기고, 선생님 전용 조회로 내려준다:
- `/sync` 때마다: 서버가 정한 **오늘(KST)** 에 실제 완료가 있으면 `att:{uid}` 에 그날을 기록한다. **날짜 키를 서버가 정하므로** 학생이 과거 날짜/연속을 못 심는다(클라가 보낸 `today` 는 출석 산정에 안 쓴다).
- `mem:{cid}:{uid}` 로 반 명단을 남겨(45일 롤링) 선생님이 학생 출석을 조회할 수 있게 한다.
- **`GET /teacher?class=CLASSID`** — **소유 선생님(또는 마스터)만**. 반 학생별 `{ streak(서버 관측 연속일수), studyDays(학습일수), days(출석맵) }` 반환. 남의 반은 `403`(반 문서 `ownerUid` 를 요청자 토큰으로 확인 → `firestore.rules` 와 동일 신뢰선).
- 앱(`cloud.js teacherBoard`)이 이 값을 받아 대시보드의 🔥연속·📅학습일·히트맵을 **서버 검증값**으로 표시한다. 워커가 구버전이면 `/teacher` 가 `404` → 앱이 자동 폴백하고 대시보드에 "⚠️ 서버 검증 미적용(재배포 필요)" 배너를 띄운다.
- (선택) `MASTER_EMAIL` 변수로 마스터 이메일 재정의 가능(기본 `ranha.park@gmail.com`, `firestore.rules` 와 동일).

> ⚠️ **이 기능은 워커 재배포가 필요하다.** `worker.js` 를 다시 붙여넣고 **Deploy** 하면 즉시 켜진다(새 변수·바인딩 불필요, 기존 `RANK_KV`·`FIREBASE_API_KEY`·`PROJECT_ID` 그대로). 서버 검증값은 **재배포 시점부터** 쌓이므로 배포 직후 며칠은 히트맵이 비어 보일 수 있다(정상).

## 참고
- 지표 = '이번 주(월~오늘) 완료한 단어 유니크 수'. **개인등록·기본팩·배포 단어 모두 포함**(완료 = 배틀에서 맞혀 `doneByDay` 에 기록된 것). 매주 월요일 새 주 키로 넘어가며 자동 리셋.
- **연속일수(streak)도 서버가 센다**: 클라가 보낸 값은 무시하고, 워커가 '그날 실제로 뭐라도 완료했는지'를 관측해 연속을 이어간다(하루라도 빠지면 끊김).
- 완벽한 100% 방어는 아니다: 개인 등록 단어까지 세므로 작정하면 자기 상태문서(`doneByDay`)를 위조할 수 있다. 다만 콘솔로 숫자만 바꾸던 예전 치팅은 불가능하고, 위조하려면 가짜 학습기록을 자기 계정에 만들어야 해서 앱에 그대로 드러나 감사가 가능하다.
- 상태문서는 `meta` 필드만 **mask** 로 읽어(단어 맵 제외) Firestore 읽기 비용을 낮춘다. 반 랭킹은 같은 반 학생만, 전체 랭킹은 상위 100.
