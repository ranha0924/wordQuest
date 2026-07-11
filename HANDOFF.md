# WordQuest — 핸드오프 문서

> 단어 도감 · WORD QUEST — 영단어 복습을 16비트 JRPG 턴제 전투로 포장한 학습 웹앱.
> "틀린 단어는 보스가 된다." 대상: 고1(내신·수능 기초 어휘).

최종 업데이트: 2026-07-11 · 저장소: https://github.com/ranha0924/wordQuest (branch `main`)

---

## 1. 한눈에 보기

- **정적 웹앱** — 백엔드/빌드 없음. Vercel이 `index.html`을 루트로 서빙. 무설치·오프라인·무료.
- **저장** — 브라우저 `localStorage` (키: `wordquest_v1`). 계정/서버 없음. 백업은 JSON 내보내기/가져오기.
- **파일 구성**
  | 파일 | 역할 |
  |---|---|
  | `index.html` | 앱 전체 — 스타일(CSS) + 마크업 + 로직(JS)이 한 파일에. |
  | `words.js` | **단어은행 데이터**(602개). `window.WORDBANK` 배열. 로직과 분리됨. |
  | `assets/` | **몬스터·배경·용사 이미지**(로컬 자체 포함). `assets/mon/` 스프라이트 26종(투명 PNG) + `bg.png`·`hero.png`. 외부 CDN 의존 없음. |
  | `워드퀘스트-기획서.md` | 최초 기획서 v1(게임 디자인 원안). |
  | `vocamon.html` | 예전 별도 프로토타입. 현행 앱과 무관(정리 대상). |
  | `HANDOFF.md` | 이 문서. |

- **로드 순서**: `index.html`이 `<script src="words.js">`로 데이터를 먼저 로드 → 메인 `<script>`가 `window.WORDBANK`를 참조. words.js가 없으면 `[]`로 폴백(앱은 돌아가되 예문/은행 기능만 빔).

---

## 2. 이번 작업 요약 (평가 → 개선)

영어 교사 관점 초기 평가 **60/100**에서 출발해 지적사항을 순차 개선. 추정 현재 **≈88–90/100**.

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
  created: '2026-07-11'
}
```

### 메타 — `S.meta`
`{ lastDay, streak, bestCombo, muted, theme, exp }`

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

---

## 5. 확장·수정 가이드

- **단어 추가/편집** → `words.js`에 한 줄: `{w:'단어',pos:'v',m:'뜻',ex:'원형 포함 예문.'}`. 다의어는 `m:'뜻1; 뜻2'` + `ex2` 추가.
  - 예문에 **단어 원형**이 들어가야 빈칸 출제됨(3인칭 -s, 과거형 등은 원형이 안 잡혀 k2e로 폴백).
  - 문자열은 작은따옴표. 문장에 **아포스트로피 금지**(`don't`→`do not`)로 따옴표 깨짐 방지.
- **SRS 간격 조정** → `LADDER` 상수.
- **포획 기준 변경** → `CAPTURE_STAGE`.
- **모드 난이도 배치 변경** → `pickMode()`.
- **몬스터 추가/교체** → `assets/mon/`에 투명 PNG(권장 600×600) 저장 후 `ASSETS`의 해당 등급 배열(`cute`/`elite`/`boss`)에 `MON+'파일명.png'` 한 줄 추가. 풀 길이가 바뀌면 기존 단어의 몬스터 배정이 재셔플됨(데이터 무관, 외형만 변경). 참고 §4.8.
- **테마** → 현재 Arcade 고정(전환 UI 숨김). 되돌리려면 CSS의 `#themebtn,.themelabel,.themepick{display:none!important;}` 한 줄 제거.

---

## 6. 개발 워크플로

- 백엔드/빌드/의존성 없음. `index.html`을 브라우저로 열면 됨(단, `words.js`가 옆에 있어야 함).
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
5. **동기화/계정 없음** — localStorage 로컬 저장. 기기 이동은 백업 내보내기/가져오기로.
6. **배포 URL 미확인** — `wordquest.vercel.app`은 404. 실제 URL로 라이브 QA 미수행(로직은 동일 파일 Playwright로 커버).
7. 타자기-피드백 레이스(위 6장). 실사용 무해하나 자동화 검증 시 주의.

---

## 8. 백로그 (다음 후보)

- **듣기 모드**: 예문/단어 음성 → 받아쓰기 또는 4지선다.
- **단어은행 확장/정확화**: 특정 출판사 기준 맞춤(웹 조사 필요, 완전성 보장 어려움).
- 오답 통계 대시보드 확장(과별/일별 추이).
- 예문 센스 3개+ 지원, 콜로케이션.
- (원한다면) 서버 DB(Supabase 등)로 계정·기기 간 동기화·공유 단어장·선생님 대시보드 — 앱 성격이 온라인 서비스로 바뀌는 큰 작업.
- `vocamon.html` 등 레거시 정리.

---

## 9. 참고 — 주요 함수 위치(모두 `index.html` 메인 `<script>`)

`pickMode` `clozable` `makeChoices` `askText` `clozeText` `bankSenses` · `nextMon` `answer` `submitSpell` `resolveAnswer` · `renderChoices` `renderSpellInput` `renderMonHP` `renderParty` · `renderDex` `renderHome` `renderReg` `renderWeak` `endBattle` · `dueIds` `rarity` `acc` `koType` `engSim` `lev` `posOf` · `migrateWords` `persist` `parseText` `speak` · 시딩: `samplebtn`/`bankbtn` 핸들러.
데이터: `words.js`(`window.WORDBANK`).
