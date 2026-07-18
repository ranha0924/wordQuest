# JSON 변조 잔여 위험 점검 (2026-07-18)

> HANDOFF "미해결 백로그 ④ JSON 변조 잔여 점검"에 대한 감사. 결론: **랭킹 계열은 서버검증으로 안전, 자기보고 표시값은 위조 가능하나 위험도 낮음(표시용).** 저비용 심층방어(규칙 클램프)만 적용.

## 범위 — 학생이 콘솔/스크립트로 자기 Firestore 문서에 임의 값을 쓸 수 있는 지점

| 데이터 | 규칙(firestore.rules) | 위조 가능? | 영향 | 판정 |
|---|---|---|---|---|
| `leaderboards/_global/*`·`/{cid}/*` (wk·streak·days) | `allow write: if false` (178·187) | ❌ 불가 | — | **안전**(워커 KV만 기록) |
| 랭킹 점수 원천(`att` 원장·서버 세션 채점) | 워커가 서버시계로만 기록 | ❌ 불가 | — | **안전**(v110/r6·r13) |
| `users/{uid}.summary.*` (accuracy·captured·total·attempts·todayCount·weekWords·streak) | `validUserDoc`→`validSummary` = **타입만** 검증(값 진위 미검증) | ✅ 가능 | 교사 대시보드 **표시** 왜곡 | **저위험**(표시용·랭킹/비용/가용성 무관) |
| `users/{uid}/private/state` (doneByDay·words·meta) | 필드 검증 0 (rules:101) — 학습저장 필수라 못 잠금 | ✅ 가능 | 서버가 att/세션으로 재검증 → 랭킹 무영향. 단 **무제한 self-write = 쓰기할당량 벡터**(③b와 연결) | **저위험**(랭킹) / 가용성은 ③-P3로 대응 |

## 위험도 평가
- **정답률·포획·학습통계(`summary.*`)**: 교사 대시보드에 "앱 자기보고"로 명시(범례)돼 있고, **랭킹 순위에 안 쓰인다**(워커는 `doneByDay`/att 를 읽지 summary 를 안 읽음). 학생이 자기 정답률을 100%로 위조해도 **자기 대시보드 표시만** 부풀 뿐 상벌·순위·비용에 영향 없음 → **위험도 낮음**.
- 완전 서버검증은 불가/과비용: summary 는 클라 집계값이라 서버가 재현하려면 모든 시도를 관측해야 함(서버 세션 채점을 표시지표로 확장해야 가능) → 현 단계 범위 밖.

## 적용한 저비용 조치 (심층방어)
- `firestore.rules validSummary` 에 **값 범위 클램프** 추가(타입가드에 병기):
  - `accuracy` 0~100(저장이 `Math.round(correct/attempts*100)` 정수, cloud.js:403), `streak` 0~4000, `captured/total/attempts/todayCount/weekWords` 0~1e7.
  - 목적: `accuracy:99999` 같은 **극단값으로 대시보드가 깨지는 것**만 차단. 그럴듯한 위조(`accuracy:100`)는 여전히 가능하나 표시용이라 수용.
- ★ `firestore.rules` 는 이 저장소에 CLI 설정이 없어 **Firebase 콘솔에 수동 게시**해야 라이브 적용. 클라이언트는 표시 시 `int()` 등으로 방어하므로 미게시여도 무해(심층방어).

## 남은 위험(수용) · 후속 후보
- `summary.*`·`private/state` 의 그럴듯한 자기보고 위조는 잔존(표시용·수용). 근본 차단은 **서버 관측 확대**(세션 채점을 표시지표로) — 백로그.
- `private/state` 무제한 self-write 의 **쓰기 할당량 소진(가용성)** 은 별건 ③(가용성 방어)의 **P3(Firestore App Check enforce, 콘솔)** 로 대응 — `rank-worker/README.md#가용성-방어` 참고.
