# 랭킹 집계 워커 (rank-worker) — 점수 위조(치팅) 근본 차단

랭킹 점수를 **클라이언트가 못 쓰게** 하고, **서버(이 워커)가 "이번 주 완료한 배포 단어 수"를 센다.**
학생이 콘솔에서 `wk:99999` 같은 값을 넣어도 랭킹에 반영되지 않는다.

## 원리 (상한 없이 위조만 차단)
- 클라이언트는 "이번 주에 완료한 단어 id 목록"만 워커로 보낸다.
- 워커는 로그인 토큰을 검증(OCR 워커와 동일)하고, **그 반의 배포 단어(`classPacks`)와 교집합**을 세어 점수로 삼는다.
- 그래서 점수의 자연 천장 = **"배정된 단어를 전부 했을 때"**. 임의 큰 숫자가 원천 불가하고, 진짜 열심히 한 학생의 값은 **상한 없이** 그대로 반영된다.
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

## 참고
- 지표가 '이번 주 완료한 **배포 단어** 수'로 바뀐다(개인 추가 단어는 랭킹에 미포함 — 모두가 같은 배정 단어로 공정 비교).
- 완벽한 100% 방어는 아니다(작정하면 유효 단어 id 를 스크립트로 부를 수 있음). 그래도 최대치가 "배정 단어 전부"라 콘솔로 임의 숫자를 만드는 치팅은 불가능하다.
- 배포 단어는 5분간 KV 캐시(Firestore 읽기 절감). 반 랭킹은 같은 반 학생만, 전체 랭킹은 상위 100.
