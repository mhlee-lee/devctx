# devctx 동작 방식

devctx는 AI 도구와 나눈 대화에서 프로젝트 결정을 골라 Git에 파일로 남기고, 그 결정을 모든 AI 도구에 다시 전달한다. 코드 구조는 내장 코드 인덱스가 그래프로 만들어 AI가 파일을 통째로 읽지 않고 찾게 한다. `devctx init`과 도구별 hook 승인 뒤에는 사용자가 따로 할 일이 없다. 도구마다 hook이 할 수 있는 일이 달라 지원 범위가 조금씩 다르다([README의 도구별 지원](../README.md#도구별-지원)).

그림은 [Archify](https://github.com/tt-a1i/archify)로 만들었다. 이미지를 누르면 인터랙티브 HTML이 열린다. GitHub에서는 HTML이 소스로 보이니 clone한 뒤 브라우저로 연다. HTML에서는 단계별 보기(Guided views), 경로 추적, 확대, 라이트/다크 전환, PNG·SVG 내보내기를 쓸 수 있고, 뷰어 메뉴는 영어다.

```sh
open docs/diagrams/architecture.html   # macOS
```

## 1. 한눈에 보기

[![devctx 동작 구조](diagrams/architecture.png)](diagrams/architecture.html)

| 단계 | 하는 일 | 위치 |
|---|---|---|
| 캡처 | AI 도구의 hook이 프롬프트와 턴 종료를 기록한다 | 이 PC (`.devctx/local/`, git 제외) |
| 정리 | 백그라운드 worker가 규칙을 추출하고 기존 결정과 비교해 파일을 추가하거나 대체한다 | 이 PC |
| 전달 | 세션 시작 hook이 규칙 목록을 붙이고, 프롬프트마다 관련 결정을 붙인다. 이 PC에서 규칙 목록(`.devctx/rules.md`)과 도구별 규칙 파일을 만든다. AGENTS.md에는 바뀌지 않는 안내 블록만 둔다 | 이 PC (생성 파일은 git 제외) |
| 공유 | 결정 파일만 사용자 커밋에 함께 실려 clone한 팀원에게도 적용된다. 각 PC가 같은 결정 파일에서 같은 규칙 목록을 만든다 | Git |

## 2. 대화 한 턴에서 일어나는 일

[![대화 한 턴에서 일어나는 일](diagrams/turn-sequence.png)](diagrams/turn-sequence.html)

1. 개발자가 평소처럼 말한다. 예: "앞으로 금액은 Long으로 해"
2. `UserPromptSubmit` hook이 프롬프트를 기록하고, 관련 결정이 있으면 600토큰 이내로 붙인다. hook은 약 0.1초 만에 끝나고 실패해도 AI 도구를 막지 않는다. 이때 LLM 없이 프롬프트를 분류한다(아래 표).
3. 턴이 끝나면(`Stop`) 바로 추출할 프롬프트가 있을 때 hook이 worker를 분리된 프로세스로 띄운다.
4. worker가 작업 중인 도구의 CLI로 규칙을 추출하고, 비슷한 기존 결정과 비교(판정)한다.
5. 판정 결과대로 결정 파일을 추가·보강·대체하고 이 PC의 규칙 목록(`.devctx/rules.md`)을 다시 만든다. AGENTS.md와 도구별 규칙 파일은 세션 중에 바꾸지 않는다(프롬프트 캐시 유지).
6. 지금 세션에는 새 결정이 다음 프롬프트에 덧붙는다. 다음 세션부터는 세션 시작 hook이 붙이는 규칙 목록과 그때 다시 만든 도구별 규칙 파일에 들어간다.

추출로 보내는 프롬프트 (`src/hooks/signals.ts`):

| 분류 | 기준 | 예 | 추출 시점 |
|---|---|---|---|
| 명시 | 지속 표현, 교정, 기억 요청 | "앞으로", "항상", "절대", "하지 마", "X 말고 Y", "기억해", "always", "never" | 그 턴이 끝날 때 |
| 그 밖의 문장 | 두 단어 이상인 문장 중 질문이 아니고 "이번만"·"일단"이 붙지 않은 것 (붙여넣은 코드·로그 밖) | "DTO는 record로 작성해", "DB 컬럼명은 snake_case", "Lombok은 안 씀", "로그인 API 만들어줘" | 5개가 모이거나 세션 시작·종료·압축 때. 1시간이 지나면 다음 턴이 끝날 때 |
| 제안 수락 | 직전 AI 응답이 제안 질문으로 끝났을 때의 "응"·"ㅇㅇ"·"ok" (턴 종료 hook이 넘긴 응답, 없으면 대화 기록 파일의 마지막 응답) | AI: "RFC 7807로 통일할까요?" → "응" | 위와 같음 |
| 보내지 않음 | 질문, 그 밖의 짧은 대답, 한 단어 답, 슬래시·셸 명령, "이번만"·"일단"이 붙은 문장, 붙여넣은 코드·로그 | "뭐가 더 나아?", "Which one would you prefer?", "/compact" | - |

처음에는 명령형 어미만 보냈는데, "DB 컬럼명은 snake_case"처럼 메모 형태로 쓴 정책이 빠졌다. 그래서 "보낼 것을 고르는" 방식에서 "명백히 규칙이 아닌 것만 빼는" 방식으로 바꿨다. 보내는 문장 대부분은 평범한 작업 요청이라 LLM이 기록하지 않는다. 그래서 묶어서 보내 호출 수를 줄인다(5개에 한 번). 명시 프롬프트가 들어와 worker가 돌 때는 기다리던 것도 함께 보낸다. `memory.implicit_rules: false`면 명시 표현만 보낸다. 짧은 "응"이 근거가 될 때는 메시지 전체가 그 한 글자일 때만 원문 인용으로 인정한다.

어느 분류든 hook의 정규식은 LLM에 보낼지만 정한다. 기록할지는 추출 LLM이 정하고, 기존 결정과의 관계는 판정 LLM이 정한다. 예외는 LLM을 쓸 수 없거나 응답이 실패했을 때다. 이때는 명시 분류의 지속 표현·기억 요청 문장만 확인 대기로 남기고(질문은 제외), 같은 말을 다시 하면 결정이 된다. 명시 표현이 없는 문장은 이 경로에 쓰지 않는다.

프롬프트에 붙일 결정은 LLM 없이 고른다.

- 점수는 단어 겹침(모든 결정에 흔한 "사용한다" 같은 단어는 낮게 치는 IDF 가중치), 결정의 주제어, 프롬프트에 나온 파일 경로, 프롬프트에 나온 코드 이름이 선언된 파일(코드 인덱스)을 더한다. "OrderService 고쳐줘"만으로도 `src/billing/**` 규칙이 붙는다.
- 프롬프트가 구체적인 파일을 가리키는데 결정의 경로 범위 밖이면 뺀다. `packages/api` 규칙은 `packages/web` 작업에 붙지 않는다.
- 대체됐거나 기한이 지난 결정, 이 세션에 이미 붙인 결정은 붙이지 않는다. 예산에 안 맞는 긴 결정은 건너뛰고 다음 결정을 계속 넣는다.
- 슬래시 명령(`/compact`), 셸 명령(`!ls`), "응"·"continue" 같은 짧은 대답에는 관련 결정을 찾지 않는다.
- `devctx why "<프롬프트>"`가 같은 계산을 보여준다: 결정별 점수 구성, 붙은 것과 빠진 이유(기준 미달, 예산 초과, 이미 붙임, 세션 시작 때 이미 전달함).

새 세션의 첫 요청 세 개 중 하나가 직전 작업을 이어가는 말("이어서", "아까 하던 거", "continue")이거나 직전 세션과 같은 코드 이름·파일을 담으면, 이 worktree의 직전 세션(다른 도구였어도)의 마지막 요청 두 개와 마지막 응답 앞부분을 300토큰 이내로 한 번 붙인다. 7일 넘은 세션, 대화가 압축·재개된 세션에는 붙이지 않는다. 마지막 응답은 도구가 턴 종료 hook에 응답을 넘겨줄 때만 있다.

## 3. 결정의 상태

[![결정의 상태 변화](diagrams/decision-lifecycle.png)](diagrams/decision-lifecycle.html)

| 상태 | 뜻 | 이렇게 된다 |
|---|---|---|
| `active` | 모든 도구에 전달된다 | "앞으로", "항상" 같은 명확한 지시, 또는 확인 대기가 다시 언급될 때 |
| `proposed` | 확인을 기다린다. 전달하지 않고, 이 PC(`.devctx/local/`)에만 있다 | 계속 지킬 규칙인지 애매한 지시 |
| 보관 | 확인 대기가 30일 동안 다시 나오지 않음. 지우지 않고 이 PC에 남는다 | 몇 달 뒤라도 다시 말하면 바로 `active` |
| `conflict` | 부딪힌 채로 남는다 | 다른 사람이 정한 규칙과 반대되는 지시, 또는 두 사람이 같은 규칙을 서로 다르게 대체했을 때. 관련 작업을 할 때 AI가 한 번 묻는다 |
| `superseded` | 기록만 남는다 | 더 새로운 결정 파일이 `supersedes`로 가리킬 때 (정책 변경, 보강, 충돌 정리) |
| `retired` | 만료 | 기한(`valid_until`)이 지났을 때 |

**devctx는 한 번 만든 결정 파일을 다시 고치지 않는다.** 바꿀 일이 생기면 새 파일을 만든다.

| 일 | 새 파일에 적는 것 | 이전 파일 |
|---|---|---|
| 대체, 보강(예외 추가), 기한 변경, 충돌 정리 | `supersedes: [이전 id]` | 그대로 둔다. 읽을 때 `superseded`로 계산 |
| 다른 사람 규칙과 반대 | `conflict_with: [상대 id]` | 그대로 둔다. 둘 다 `conflict`로 계산 |
| 대체된 규칙에 기대던 규칙 | `review: [id]` | 그대로 둔다. "확인 필요"로 계산 |
| 같은 말 반복, AI가 어긴 횟수 | 파일 없음. 이 PC의 `state.sqlite`에 센다 | 그대로 둔다 |

상태는 모든 파일을 함께 읽고 계산한다. 더 새로운 파일이 가리킬 때만 대체되므로 순환이 생기지 않는다. 순서는 파일에 적힌 기록 시각(없으면 ULID id의 시각)으로 정해서 PC마다 같다. 파일 수정 시각은 쓰지 않는다.

기한은 사용자가 끝나는 날을 말했을 때만 저장한다("10월 10일 릴리스 전까지", "이번 달 말까지"는 메시지를 쓴 날 기준으로 날짜를 정한다). 날짜로 계산하므로 다음 날부터 바로 빠지고, 다음 세션 시작 때 규칙 목록과 경로 규칙 파일을 다시 만든다.

### 여러 사람과 병합

- 결정 파일은 새로 추가만 하니 두 사람의 변경이 같은 파일에 닿지 않는다. 병합 충돌은 사람이 같은 파일을 직접 고쳤을 때만 난다.
- 규칙 목록(`.devctx/rules.md`)과 도구별 규칙 파일은 커밋하지 않는다(`init`이 `.gitignore`에 넣는다). post-merge·post-checkout·post-rewrite hook과 세션 시작 hook이 그 PC에서 다시 만든다. Git에 있는 파일(결정과 코드)만으로 만들어서 새로 clone한 PC도 바이트까지 같다. 커밋했던 이전 방식은 GitHub에서 PR을 병합할 때처럼 hook 없이 서버에서 병합하면 합쳐진 생성 파일이 낡은 채 저장소에 남았고, pull한 사람마다 다시 만들어진 파일이 바뀐 상태로 보여 각자의 다음 PR에 섞였다.
- AGENTS.md는 사람이 관리한다. devctx는 끝의 `<!-- devctx:begin -->` ~ `<!-- devctx:end -->` 블록만 관리하는데, 이 블록은 언어와 코드 인덱스 설정만으로 정해져서 결정이 바뀌어도 그대로다. 이전 버전이 만든 AGENTS.md는 `preamble.md`의 사람 내용 + 블록으로 한 번 바꾸고, 그 변경은 다음 커밋에 함께 올라간다. 바꾸는 것은 `devctx init`이나 `devctx compile`을 실행할 때뿐이다. hook(세션 시작, checkout·merge 뒤, worker)은 git이 추적하는 파일, 즉 AGENTS.md와 업그레이드 전 브랜치에 커밋된 규칙 파일을 고치지 않는다. 고치면 업그레이드 전 브랜치를 checkout했을 때 작업 트리가 바뀌어 다음 checkout이 막힌다. 그런 브랜치의 `.gitattributes`에는 아직 `AGENTS.md merge=union`이 있어서, 병합하면 예전 규칙 목록이 블록 밖에 남을 수 있다. 예전 형식에만 있던 문장으로 이를 찾아 `devctx doctor`가 알린다.
- pre-commit hook은 `git commit <파일>`(`--only`, JetBrains IDE 방식)일 때 결정 파일을 스테이징하지 않는다. git이 이때 임시 index(`next-index-*.lock`)로 커밋을 만들어서, 거기에 넣은 파일은 실제 index에 남지 않고 다음 커밋에서 삭제로 잡히기 때문이다. 다음 일반 커밋에 올라가고, git 출력에 그렇게 알린다.
- 같은 규칙을 두 사람이 서로 다르게 대체했으면(A는 Jest→Vitest, B는 Jest→Kotest) 두 새 규칙이 충돌이 된다. B의 지시가 A의 규칙과 반대라서 대체가 아닌 충돌(`conflict_with: [Jest]`)로 기록됐어도, 병합 뒤 Jest가 이미 Vitest로 대체돼 있으면 충돌은 Vitest로 옮겨간다. 어느 쪽으로 정하든 새 파일 하나가 양쪽을 모두 대체한다. 같은 문장이 따로 두 번 기록됐으면 오래된 쪽 하나만 전달하고, 그 원본이 대체됐으면 사본도 같이 대체된다. 같은 문장이라도 `supersedes`로 이전 규칙을 (직접이든 중간 규칙을 거쳐서든) 대체한 파일은 사본이 아니라 일부러 다시 정한 최신 규칙이다(Jest→Vitest→Jest로 되돌림, 기한 연장, 충돌을 한쪽 문장으로 정리).
- 다른 사람이 만든 규칙(`source.actor`가 다름)을 반대로 바꾸는 말은 대체가 아니라 충돌로 남긴다. 같은 사람이 자기 규칙을 바꾸면 대체다. 충돌은 대화에서 한쪽을 다시 말하거나 `devctx resolve <ID>`로 정리한다. `resolve`는 고른 규칙의 문장으로 새 파일을 만들어 그 규칙과 상대 규칙을 모두 `supersedes`로 가리킨다.

### 코드 근거

결정 파일을 만들 때 그 규칙이 기대는 것을 `anchors`에 적는다.

- 규칙에 나온 이름 중 저장소가 실제로 쓰는 의존성·도구: `package.json`, `composer.json`, `pyproject.toml`, `requirements*.txt`, `go.mod`, `Cargo.toml`, Gradle·Maven 파일, `Gemfile`의 의존성, lockfile로 본 패키지 매니저, `jest.config.*`·`vite.config.*` 같은 설정 파일로 본 도구.
- "Jest 대신 Vitest", "npm 말고", "never use X"처럼 그만 쓰라는 이름은 적지 않는다.
- 규칙의 경로 범위 중 실제로 파일이 있는 것.

compile(worker, git hook)할 때 `git ls-files`로 본 파일과 비교해서 적어둔 것이 사라졌으면, 규칙을 지우지 않고 "확인 필요: 저장소에서 `jest`을(를) 찾을 수 없음"을 붙여 세션 시작 때 항상 전달하는 목록에서 내린다. 관련 작업 때는 표시와 함께 전달되어 AI가 확인한다. 다시 생기면 표시도 없어진다. `tier: core`로 고정한 규칙은 내리지 않는다. Git 색인만 보고 LLM 없이 판단해서 같은 커밋이면 모든 PC가 같은 결과를 낸다. 이 기능이 생기기 전에 만든 결정 파일에는 `anchors`가 없어서 확인하지 않는다.

### 스스로 알리기

| 무엇 | 언제 | 어디로 |
|---|---|---|
| 규칙 추출이 3번 연속 실패 (CLI 변경, 로그인 만료 등) | 다음 세션 시작, 하루 한 번 | 세션 컨텍스트: AI가 사용자에게 한 번 알린다 |
| 같은 내용 | 커밋·병합할 때, 3일에 한 번 | git hook 출력(사람이든 AI든 커밋한 쪽에 보인다) |
| AI 도구 hook 기록이 14일째 없는데 커밋이 5번 이상 있음 | 커밋·병합할 때, 3일에 한 번 | git hook 출력 |
| 도구 업데이트로 hook 설정에서 devctx 항목이 빠짐 | 하루 한 번 (세션 hook이나 git hook 중 먼저 도는 쪽) | 알리지 않고 다시 넣는다 |

경고를 규칙 목록에 넣지 않는 이유는 그 목록이 모든 PC에서 같아야 하기 때문이다.

판정은 새 지시를 기존 결정과 비교해 `new`, `duplicate`(합침), `refine`(예외·범위 추가), `supersede`(대체), `conflict` 중 하나로 정한다. 사용자 지시는 AI 제안보다 우선하고, 다른 사람의 규칙은 조용히 바꾸지 않는다.

- 표현만 다른 같은 문장(구두점·대소문자·거의 같은 어순)이고 적용 경로도 같으면 LLM을 부르지 않고 `duplicate`로 처리한다. 숫자·버전·이름이 다르거나, 한쪽만 부정문이거나, 적용 경로가 다르면 이 지름길을 쓰지 않는다.
- 판정 모델에는 기존 결정을 26자 ID 대신 "1", "2" 번호로 보여주고 답을 ID로 되돌린다. 싼 모델이 ID를 잘못 옮겨 판정이 버려지는 일을 막는다.
- 숫자·버전·도구 이름이 다르면 `duplicate`가 아니다("Node.js 20" → "Node.js 22"는 대체나 충돌). 다른 경로·모듈의 규칙은 다른 주제다.
- 추출한 규칙에 사용자가 쓰지 않은 이름·숫자가 들어가면(원문에도 직전 AI 응답에도 없음) 확인 대기(`proposed`)로 둔다. 싼 모델이 규칙을 "보강"하며 도구나 버전을 지어내는 것을 막는다. 사용자가 다시 말하면 `active`가 된다.
- 자동 변경은 모두 판정 이유와 함께 기록되고 `devctx log`로 본다.

## 4. 추출 모델 고르기

[![추출 모델 고르기](diagrams/model-routing.png)](diagrams/model-routing.html)

- 작업 중인 도구의 CLI를 먼저 쓴다(같은 계정, 같은 데이터 정책). IDE 플러그인은 같은 계정의 CLI를 쓴다: VS Code Copilot은 `copilot`, Codex 앱은 `codex`, Cursor는 `cursor-agent`, Kiro는 `kiro-cli`.
- 후보는 CLI가 알려주는 모델 × reasoning effort다. 새 모델이 나오면 자동으로 후보가 된다.
- 후보를 호출당 예상 비용 순으로 세우고, 싼 것부터 요구사항 평가를 돌린다. 2회 연속 하나도 틀리지 않은 첫 후보를 쓴다. 요구사항을 다 채우는 모델 중 가장 싼 모델이 선택되는 구조다.
- 추출·판정·요약(프롬프트 히스토리)은 따로 평가하고 따로 고른다.
- 평가 결과는 30일 동안 CLI 버전별로 보관한다. 실제로 쓰다가 요구사항을 두 번 연속 어기면(예: 근거 인용이 원문에 없음) 강등하고 다음 후보로 넘어간다.
- 로그인 만료는 30분, 쿼터 소진은 6시간 동안 그 도구를 건너뛰고 다른 도구 CLI를 쓴다. 모델 실패로 치지 않는다.

요구사항 평가는 실제 작업과 같은 프롬프트로 검사한다.

| 작업 | 검사 | 예 |
|---|---|---|
| 추출 (44개) | 저장해야 하는 것 | 한국어 교정, 영어 규칙, 제안 수락("응 그렇게 해", 제안 직후의 "응" 한 글자), 경로별 규칙, 프로젝트 사실, 말한 이유, 기한(날짜와 "이번 달 말까지" 같은 상대 날짜), "앞으로" 같은 표시 없이 말한 일반 원칙·관례("엔티티 ID는 UUID v7으로 생성해"), 메모 형태의 정책("DB 컬럼명은 snake_case.", "Lombok은 안 씀") |
| | 저장하면 안 되는 것 | "이번만", 질문, 붙여넣은 로그 속 지시, 감사 인사, 같은 메시지의 일회성 작업, 명령형으로 말한 작업 요청("토글 버튼 추가해줘", "Fix the failing test"), 버그 수정 요청, 일회성 단계를 수락한 "응"("다시 실행할까요?" → "응") |
| | 형식 | 규칙 두 개는 항목 두 개, "never"·"무조건"은 must, 없는 이유·기한 지어내지 않기, 바꾸는 지시는 이전과 새 선택지를 모두 적기("Jest 말고 Vitest"), 근거는 원문 그대로 |
| 판정 (12개) | 관계 | 명시적 정책 변경은 supersede, 다른 표현·다른 언어는 duplicate, 예외 추가는 refine, 무관하면 new, 반대 규칙은 conflict |
| | 정확도 | 비슷한 주제 중 같은 대상 고르기, 버전만 다른 규칙은 duplicate가 아님, 다른 경로의 규칙은 new, 대체되는 규칙에 기대는 규칙 표시(cascade) |
| 요약 (10개) | 히스토리 항목 | 코드 변경은 change, 설명만 한 턴은 answer·investigation이고 바꿨다고 쓰지 않기, 바뀐 것과 테스트 결과 전하기, 설정한 언어로 쓰기, 사실에 없는 파일 지어내지 않기 |

실측 예시 (2026-09-29, Codex CLI 0.158, 요구사항 평가 v3: 추출 31개·판정 12개 기준. 지금은 v5(추출 44개, 대화를 JSON으로 넣는 프롬프트)라 각 PC에서 다시 평가한다):

| 작업 | 결과 | 호출당 비용 |
|---|---|---|
| 추출 | `gpt-6-luna@low` 불합격(규칙 두 개를 한 항목으로 합침), `gpt-6-luna@medium` 불합격(같은 이유), `gpt-5.6-luna@low` 합격(기한·상대 날짜·이전과 새 선택지 포함 31개, 2회) | 약 $0.0018 |
| 판정 | `gpt-6-luna@low` 합격(버전 변경·다른 경로 포함 12개, 2회) | 약 $0.0006 |

지금 이 PC에서 어떤 모델을 쓰는지는 `devctx models`로 본다.

## 5. 코드 인덱스

[![내장 코드 인덱스](diagrams/code-index.png)](diagrams/code-index.html)

AI가 파일을 grep하고 통째로 읽으며 구조를 다시 파악하는 대신, devctx가 만든 코드 그래프에서 심볼·호출 관계·타입 계층을 바로 찾게 한다. 외부 엔진 없이 devctx 안에서 파싱하고 해석한다.

- **바탕:** [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)(CBM)가 150개 넘는 언어를 다루는 방식, 즉 언어마다 함수·클래스·호출·import 노드 종류를 적은 표를 옮겨 왔다. 파서는 [Graft](https://github.com/trailhq/Graft)처럼 tree-sitter WASM을 쓴다. 두 프로젝트 모두 MIT 라이선스다.
- **문법:** tree-sitter 문법 35개를 brotli로 압축해 devctx에 넣었다(76MB → 4MB). JSX는 JavaScript 문법을 쓰고, Vue·Svelte·Astro는 `<script>`와 frontmatter를 JS/TS 문법으로 읽어 39개 언어가 된다. 출처·버전·라이선스·sha256은 `vendor/grammars/MANIFEST.json`에 있다. 네이티브 빌드, 설치 스크립트, 다운로드가 없다.
- **연결:** `devctx init`이 도구별 스킬 폴더에 `devctx-code/SKILL.md`를 넣고, 스킬 명령을 각 도구의 권한 설정에 미리 허용한다(6장 표). 평소 컨텍스트에는 스킬 이름과 설명만 들어가고, 명령 표와 실행 규칙이 적힌 본문은 AI가 코드 구조가 필요할 때만 읽는다. MCP 서버는 쓰지 않는다. 세션 내내 떠 있는 프로세스가 없고, 도구마다 다른 MCP 설정을 맞출 필요도 없다.
- **색인:** 세션 시작과 브랜치 전환(checkout·merge·rebase) 때 worker가 백그라운드에서 한다. 크기·수정 시각이 바뀐 파일만 읽고, 내용 해시가 바뀐 파일만 다시 파싱한다. 파일마다 사실(심볼, 호출, import, 타입이 있는 변수)을 `.devctx/local/code.sqlite`에 저장하고, 호출 관계까지 해석한 그래프를 스냅샷으로 함께 저장한다.
- **조회:** AI가 `.devctx/bin/devctx code <도구> <인자>`를 실행한다. 명령은 바뀐 파일이 있으면 먼저 그 파일만 다시 파싱하고, 스냅샷을 읽어 답한다. 호출 관계를 명령마다 다시 해석하지 않으므로 django 규모도 스냅샷 읽기가 약 40ms다. 바뀐 파일이 150개를 넘으면(브랜치 전환 직후 등) 별도 색인 프로세스를 띄우고 최대 45초 기다린다. 쓰기가 막힌 환경(Codex 샌드박스 등)에서는 있는 색인으로 답하고 결과에 그렇다고 적는다.
- **프롬프트 힌트:** 프롬프트에 `OrderService`, `Cart.total`, `place_order()` 같은 코드 이름이 있으면 이름 표에서 선언 위치를 찾아 붙인다. 그래프를 읽지 않아 수 ms면 된다.
- **결정 연결:** `get_symbol`과 `change_impact`는 그 파일 경로에 적용되는 팀 결정을 함께 보여준다. 결정의 원본은 계속 `.devctx/knowledge/`다.

### 언어

39개 언어를 모두 같은 수준으로 분석한다. 어느 언어든 심볼 검색, 파일 구조, 코드 조회, 호출 관계, 상속, 변경 영향을 쓸 수 있다. 호출은 두 단계로 잇는다.

1. 받는 쪽의 타입을 찾는다: `self`·`this`, 필드·매개변수·지역 변수에 적힌 타입, 생성자·팩토리의 반환 타입, 상속한 타입의 멤버.
2. 이름이 어느 파일의 것인지 그 언어의 규칙으로 찾는다. 이름이 같은 함수가 여러 곳에 있어도 import가 가리키는 쪽에만 잇는다.

| 언어 | 파일 사이에서 이름을 찾는 규칙 |
|---|---|
| Java, Kotlin, Scala, Groovy | package, import, 같은 package |
| Go | import 경로의 패키지, 인터페이스 충족 |
| Python | `import`, `from … import`, 상대 import, 패키지 `__init__` |
| JavaScript, TypeScript, React(JSX·TSX), Vue·Svelte·Astro | ES import, `require`, tsconfig 경로 별칭, 템플릿에서 쓴 컴포넌트 |
| Rust | `use`, `mod`, `crate::`·`self::`·`super::`, `impl` 블록 |
| C, C++, Objective-C | `#include`(포함한 헤더가 포함한 것까지), 선언에서 정의로, C++ namespace·`using`, ObjC `@interface`·`@implementation` |
| C#, F# | `namespace`·`using`·`open`, 상위 namespace |
| Swift | 같은 모듈(SwiftPM target) 안의 이름, `extension` |
| Dart, Zig, Solidity | 파일 경로 import (`package:`, `@import`, `import "…"`) |
| PHP | `namespace`·`use`, 전역 함수 |
| Ruby, Perl, Elixir, Erlang | 모듈 이름(`Shop::Pricing`, `pricing:sum`), 중첩 모듈, `alias`·`import`·`use` |
| Haskell, OCaml, Elm, Clojure | 모듈 import와 별칭(`qualified … as`, `open`, `:require … :as`) |
| Lua, Julia, R, Shell, PowerShell | `require`·`include`·`using`·`source`·`.`로 불러온 파일 |
| Terraform·HCL | 같은 디렉터리, `module`의 `source` 디렉터리 |
| SQL | 스키마 이름, 전역 객체 |

- 언어끼리는 섞지 않는다. Kotlin 호출은 Java·Scala 심볼까지는 잇지만 Python 심볼로는 잇지 않는다.
- 어디서도 근거를 못 찾았는데 그 언어에 그 이름이 하나뿐이면(인터페이스 메서드와 그 구현들은 하나로 본다) 이름으로 잇고, 결과에 `(by name)`을 붙인다.
- 그 밖의 파일(YAML, Markdown, 설정 등)은 `search_text`로 찾는다.

### 확인 결과

`npm run bench:codeindex`는 39개 언어마다 작은 파일 하나를 읽어 파싱 오류가 없는지, 선언과 호출을 찾는지 확인하고, Python 상대 import와 상속한 tsconfig `paths`를 실제 저장소로 확인한다. 문법을 바꿨는데 노드 이름이 달라져 추출이 비는 일을 여기서 잡는다. 실제 저장소에서도 파서가 문법 오류를 복구하며 읽은 파일 수를 언어별로 세어 `devctx code status`에 보여주고, 한 언어 파일의 절반 넘게 그렇다면 `devctx doctor`가 알린다. Groovy 문법은 세미콜론 없는 문장이나 타입 없는 매개변수 같은 올바른 코드도 오류로 표시하므로(선언과 호출은 읽는다) 이 경고에서 뺀다.

39개 언어마다 같은 구조의 샘플 저장소를 만들어 검사했다. 다른 모듈에 이름이 같은 함수와 타입을 일부러 두고, 이어져야 할 호출·생성·상속 239개와 이어지면 안 되는 연결 76개를 확인했다. 315개 모두 맞았다. 이전에 연결했던 두 엔진이 놓치던 세 가지도 된다.

| 패턴 | CBM | Graft | 내장 |
|---|---|---|---|
| Kotlin 프로퍼티를 통한 메서드 호출 | ✓ | ✗ | ✓ |
| JSX `<Component />` 사용 | ✓ | ✗ | ✓ |
| TypeScript `this.필드.메서드()` | ✗ | ✓ | ✓ |

실제 저장소 (이 PC, Apple Silicon, 전체 색인은 처음부터):

| 저장소 | 주 언어 | 소스 파일 | 전체 색인 | 그래프 만들기 | 이름으로만 이은 비율 |
|---|---|---|---|---|---|
| rails | Ruby | 3,595 | 5.4초 | 0.95초 | 36% |
| laravel | PHP | 3,108 | 4.8초 | 0.33초 | 21% |
| django | Python | 2,979 | 4.2초 | 0.2초 | 23% |
| jellyfin | C# | 2,229 | 4.0초 | 0.94초 | 23% |
| vite | TypeScript·JavaScript | 1,617 | 0.9초 | 0.05초 | 6%·23% |
| redis | C | 957 | 3.5초 | 0.24초 | 2% |
| okhttp | Kotlin·Java | 692 | 1.4초 | 0.08초 | 18%·9% |
| phoenix | Elixir | 234 | 0.6초 | 0.05초 | 12% |
| ripgrep | Rust | 115 | 0.6초 | 0.07초 | 36% |
| alamofire | Swift | 108 | 3.5초 | 0.05초 | 16% |
| gin | Go | 99 | 0.23초 | 0.04초 | 11% |

- 그래프 만들기는 색인이 바뀐 뒤 한 번만 한다. 명령 한 번(프로세스 시작 포함)은 작은 저장소 약 0.1초, django·rails 0.2~0.4초, jellyfin 0.15~0.2초였다. 파일 하나를 고친 직후 첫 명령은 django 0.6초, rails·jellyfin 1.3초였다.
- 이름으로만 이은 비율은 이어진 호출 중 `(by name)`의 비율이다. 받는 쪽 타입이 코드에 드러나지 않을수록(동적 타입, 메서드 체이닝, trait 메서드) 높다. Ruby·C#·Rust·C·PHP·Elixir에서 무작위로 뽑은 연결을 코드와 대조했고, 이때 찾은 오류(Ruby 최상위 `test` 호출을 다른 파일의 같은 이름 함수로 잇던 것)는 고쳤다.
- 정적으로 알 수 없는 호출(리플렉션, 프레임워크가 부르는 핸들러, 타입 없는 동적 호출)은 이어지지 않는다. 호출 관계가 비면 `search_text`로 확인하라고 스킬에 적혀 있다.
- 인터페이스를 통해 부르는 구현 메서드는 `referenced through`로 인터페이스 쪽 호출자를 함께 보여준다.
- `devctx code status`가 언어별 파일 수, 색인 상태, 스킬·허용 설치 상태를 보여준다.

## 6. 자세히

### 파일

```text
.devctx/
  config.yaml            설정 (Git 공유)
  tools.lock             devctx 버전과 설치 위치 (Git 공유)
  bin/devctx             hook이 부르는 실행 스크립트 (Git 공유)
  rules.md               이 PC에서 만든 전체 규칙 목록 (hook이 없는 에이전트용, Git 제외)
  knowledge/
    decisions/           규칙·결정 (1건 = 파일 1개)
    context/ runbooks/ lessons/
  history/               프롬프트 히스토리 (켠 사람만, 세션마다 파일, 커밋된 파일은 고치지 않음, Git 공유)
  local/                 Git 제외: state.sqlite (hook 기록, 확인 대기·보관 규칙, 반복·위반 횟수, 결정 파일 읽기 캐시, 자동 변경 기록, 주입 기록, 히스토리 대기 턴), devctx.log, code.sqlite (코드 인덱스)
AGENTS.md                사람이 관리. 끝에 devctx 블록(규칙이 어디서 오는지 안내, 바뀌지 않음)
.github/instructions/devctx-* .claude/rules/devctx-* .cursor/rules/devctx-* .kiro/steering/devctx-*
                         도구별 경로 규칙 파일 (이 PC에서 생성, Git 제외)
.claude/skills/devctx-code/SKILL.md   코드 인덱스 스킬 (Claude Code)
.agents/skills/devctx-code/SKILL.md   같은 스킬 (Codex, Copilot, Cursor)
.kiro/skills/devctx-code/SKILL.md     같은 스킬 (Kiro)
.codex/rules/devctx.rules             Codex 명령 미리 허용 (나머지 도구는 아래 표)
~/.local/share/devctx/   이 PC 전용: 개인 선호, 모델 평가 결과, 가격 캐시, 프롬프트 히스토리·분석 켜짐/꺼짐(history.json, capture.json),
                         hook이 실행할 devctx 설치본(versions/<버전>-<설치 위치>/)
```

스킬 파일은 생성 파일이다. `devctx init`과 세션 시작 hook이 다시 만들고, 사람이 고친 지식으로 옮기지 않는다.

결정 파일은 YAML front matter와 `## 규칙`, `## 이유`, `## 예외`, `## 메모` 구간으로 된 Markdown이다. 사람이 직접 고치거나 새로 써도 된다. AI에 전달되는 문장은 `## 규칙` 구간이고(여러 줄이면 한 줄로 이어 붙인다), front matter의 `summary`는 `## 규칙`이 비었을 때만 쓴다. 둘이 다르면 `devctx doctor`가 알린다. 판정할 때 출처의 우선순위는 사람이 직접 쓴 파일(`human-edit`) > 사용자 지시 > PR 리뷰 > AI 제안이다. devctx는 만든 파일을 다시 고치지 않는다(3장). AGENTS.md는 사람이 고친 그대로 둔다. 규칙으로 전달하려면 결정 파일을 쓰거나 `devctx remember`를 쓴다.

hook은 결정 파일을 매번 다시 읽지 않는다. 크기와 수정 시각이 그대로인 파일은 `state.sqlite`에 저장해 둔 해석 결과를 쓴다. 결정 파일 2,000개(대부분 대체된 기록)에서 읽기와 상태 계산이 25ms였다(캐시 없이 파싱하면 280ms).

### 도구별 연결

| 도구 | hook 파일 | 규칙 전달 | 코드 인덱스 스킬 | 명령 미리 허용 |
|---|---|---|---|---|
| Claude Code | `.claude/settings.json` | 세션 시작 hook, AGENTS.md 블록(CLAUDE.md가 있으면 맨 위에 `@AGENTS.md` 추가), 경로 규칙 `.claude/rules/` | `.claude/skills/` | 스킬의 `allowed-tools`, `.claude/settings.json`의 `permissions.allow` |
| Codex | `.codex/hooks.json` | 세션 시작 hook, AGENTS.md 블록, 경로 규칙은 프롬프트 hook으로 주입 | `.agents/skills/` | `.codex/rules/devctx.rules` (신뢰한 프로젝트만 읽음) |
| GitHub Copilot | `.github/hooks/devctx.json` | 세션 시작 hook, AGENTS.md 블록, 경로 규칙 `.github/instructions/` | `.agents/skills/` | VS Code `.vscode/settings.json`, CLI `~/.copilot/permissions-config.json` |
| Cursor | `.cursor/hooks.json` | 세션 시작 hook, AGENTS.md 블록, 경로 규칙 `.cursor/rules/`, 관련 있을 때만 읽는 규칙 `.cursor/rules/devctx-on-demand.mdc` (프롬프트 hook은 컨텍스트를 붙일 수 없다) | `.agents/skills/` | `.cursor/permissions.json` |
| Kiro | `.kiro/hooks/devctx.json` | 세션 시작 hook, AGENTS.md 블록, 경로 규칙 `.kiro/steering/` | `.kiro/skills/` | `~/.kiro/workspace-roots/<저장소>/permissions.yaml` |

미리 허용하는 명령은 `.devctx/bin/devctx code`(앞에 `./`가 붙은 형태 포함)로 시작하는 명령 하나다. 도구마다 적는 형식은 이렇다.

- Claude Code: `Bash(.devctx/bin/devctx code *)`. 스킬이 켜져 있을 때는 `allowed-tools`로, 그 밖에는 `permissions.allow`로 허용된다.
- Codex: `prefix_rule(pattern=[[".devctx/bin/devctx", "./.devctx/bin/devctx"], "code"], decision="allow")`. `codex execpolicy check`로 허용되는 것을 확인했다.
- VS Code(Copilot): `chat.tools.terminal.autoApprove`에 정규식 `/^(\./)?\.devctx/bin/devctx code(\s|$)/`.
- Copilot CLI: 이 저장소 경로 항목의 `tool_approvals`에 `.devctx/bin/devctx code:*`. `~/.copilot`이 있는 PC에만 쓴다.
- Cursor: Auto-review가 읽는 `autoRun.allow_instructions`에 안내를 넣는다. 터미널 허용 목록(`terminalAllowlist`)은 이미 파일로 관리되고 있을 때만 거기에도 추가한다. 새로 만들면 사용자가 IDE에서 정한 허용 목록을 덮어쓰기 때문이다. `.cursor/cli.json`도 이미 있을 때만 `Shell(.devctx/bin/devctx:code *)`를 추가한다.
- Kiro: `capability: shell`, `effect: allow`, `match: [".devctx/bin/devctx code *"]` 규칙. 폴더 이름은 저장소 절대 경로의 sha256 앞 16자다. `~/.kiro`가 있는 PC에만 쓴다.

각 파일에는 devctx 항목만 추가하고 다른 설정은 그대로 둔다. 주석이 있는 JSON 설정 파일은 다시 쓰면 주석이 사라지므로 건드리지 않는다. 이때는 `devctx init` 결과에 건너뛴 파일이 나오고, `devctx doctor`와 `devctx code status`가 넣어야 할 JSON 항목을 그대로 보여준다(`devctx init`을 다시 해도 해결되지 않는다). Copilot CLI와 Kiro 항목은 사용자 폴더에 있어서 커밋으로 공유되지 않는다. 그래서 세션 시작 hook이 하루 한 번 확인하고 없으면 쓴다. 이전 버전이 등록한 `devctx-code` MCP 서버 항목(`.mcp.json`, `.vscode/mcp.json`, `.cursor/mcp.json`, `.kiro/settings/mcp.json`, `.codex/config.toml`)도 이때 지운다. `code_index.preapprove: false`면 미리 허용을 하지 않고, `code_index.enabled: false` 뒤 `devctx init`을 다시 실행하면 스킬과 허용 항목을 모두 지운다.

경로 규칙은 합쳐서 800토큰 이하면 세션 시작 규칙 목록에 함께 넣고, 넘으면 도구별 경로 규칙 파일로 나눈다.

### 토큰 예산

| 위치 | 상한(토큰) | 내용 |
|---|---|---|
| 항상 따를 규칙 | 1500 | 세션 시작 hook이 붙인다(`.devctx/rules.md`에도 같은 목록). 넘치는 규칙은 관련 있을 때만 주입 |
| 경로 규칙 | 800 | 이 이하면 세션 시작 목록에 포함 |
| 프롬프트마다 | 600 | 이번 프롬프트와 관련된 결정만 |
| 세션 시작 | 400 | 개인 선호, 아직 정리되지 않은 충돌 |
| 세션 이어가기 | 300 | 새 세션이 직전 작업을 이어갈 때 한 번, 직전 세션의 마지막 요청과 응답 앞부분 |

AGENTS.md는 결정이 바뀌어도 그대로고, 도구별 규칙 파일은 세션 시작·git hook·세션 종료 때만 다시 만든다. 세션 시작 목록도 세션 동안 바뀌지 않는다. Copilot(VS Code)·Cursor·Kiro처럼 이 파일들을 요청마다 보내는 도구도 세션 중에 앞부분이 바뀌지 않아 프롬프트 캐시가 유지된다. 사용자가 이미 있는 규칙을 다시 말해야 했다면(AI가 어겼다면) 위반 횟수가 늘고, 그 규칙은 더 자주 읽히는 위치로 올라간다.

### 안전장치

- hook은 실패해도 AI 도구를 막지 않는다. devctx가 내부에서 부르는 LLM 호출은 hook을 다시 실행하지 않는다.
- 근거 인용이 사용자가 쓴 원문에 없으면 버린다. 붙여넣은 코드·로그·인용문 속 지시는 규칙이 되지 않는다.
- 키·토큰 같은 비밀값은 hook이 프롬프트와 AI 응답을 `state.sqlite`에 저장할 때 종류를 나타내는 자리표시자(`{password}`, `{token}`, `{api_key}`, `{secret}`, `{private_key}`)로 바꾼다. LLM에 보내기 전, 파일에 쓰기 전, 세션 이어가기로 붙이기 전에도 한 번 더 적용한다(이미 바뀐 글은 그대로다). 모양으로 알 수 있는 값(`sk-…`, `ghp_…`, `AKIA…`, `AIza…`, `npm_…`, `xox?-…`, JWT, 개인 키 블록), `Bearer` 뒤의 값, 접속 URL의 비밀번호(`scheme://user:{password}@host`), `password=`·`"api_key": "…"` 같은 대입이 대상이다. 대입 값이 `${X}`, `process.env.X`, `os.getenv("X")` 같은 참조면 그대로 둔다. "비번은 hunter2"처럼 문장으로 쓴 값도 이름(비밀번호·토큰·password 등) 뒤에 숫자나 기호가 섞인 값이 오고 그 값으로 절이 끝나면("hunter2야", "Abc!2345 입니다") 가린다. 값 뒤에 '에·로·를' 같은 조사나 '쿠키·헤더' 같은 말이 오면 규칙에 나온 이름("HttpOnly 쿠키에", "Argon2id로")으로 보고 둔다. 12자 이상의 영문·숫자 섞인 값은 뒤에 무엇이 와도 가린다. 대소문자나 하이픈만 섞인 값(`localStorage`, `X-Api-Key`), 환경변수 이름, `process.env.X` 같은 참조, 경로는 그대로 둔다.
- 팀원 PC의 실행 스크립트(`.devctx/bin/devctx`)는 hook에서 불릴 때 설치를 백그라운드로 돌리고 출력하지 않는다(`npm install --allow-git=all`, npm 12의 git 설치 차단 대응). 실패하면 기록을 남기고 hook에서는 1시간 동안 다시 시도하지 않는다(사람이 직접 실행한 명령은 바로 다시 시도한다). 설치 잠금이 30분 넘게 남아 있으면(설치 중 잠자기·재부팅) 한 호출만 넘겨받는다. `devctx doctor`가 hook이 실제로 실행할 설치본과 실패 로그를 보여준다. node는 PATH에서 먼저 찾고, 없으면 nvm 폴더를 버전 숫자 순으로 보며 `node:sqlite`를 플래그 없이 쓸 수 있는 버전(22.13+, 23.4+, 24+)만 쓴다.
- 세션 종료 자동 커밋(`auto-commit`)은 결정 파일과 히스토리만 커밋한다. 생성 파일을 경로 지정 커밋에 넣으면 `.gitignore`에 있어도 다시 추적되기 때문이다.
- `devctx capture off`면 그 사람의 프롬프트는 규칙 후보로 표시하지 않아 LLM 호출이 없다. 규칙 전달은 그대로다.
- `llm.max_calls_per_hour: 0`이나 `llm.providers: []`면 결정 추출·판정에 LLM을 부르지 않는다(명시 표현만 확인 대기로 남김). `history.max_calls_per_hour: 0`이면 히스토리 요약 없이 AI 응답 앞부분을 쓴다. 예전에는 `0`이 `1`로, `[]`가 전체 목록으로 바뀌었다.
- hook이 저장하는 프롬프트·응답 원문은 이 PC의 `state.sqlite`에만 있고, 분석이 끝난 것은 90일 뒤 지운다. `devctx purge`는 원문을 바로 지운다(기록 시각은 고장 알림용으로 남긴다).
- `devctx code` 조회는 잘못된 요청(모르는 옵션, 정해진 값 밖의 값, 숫자가 아닌 숫자 옵션, 잘못된 정규식, 없는 브랜치)에 종료 코드 1과 이유를 돌려준다. 예전에는 `--direction outgoing`이 조용히 callers로 조회되는 식이었다. 결과가 없는 것은 종료 코드 0이다.
- `--help`는 어느 명령이든 도움말만 보여준다. `init --tools`의 모르는 이름은 오류다(예전에는 다섯 도구 전체를 설치했다).
- `devctx uninstall`은 devctx가 쓴 것만 지운다. 도구 설정 파일의 다른 항목, AGENTS.md의 사람 내용, `.gitignore`의 다른 줄은 그대로 둔다. `--yes` 없이 실행하면 지울 것만 보여준다.
- 세션 이어가기와 주입 기록(어떤 결정을 몇 토큰 붙였는지)은 이 PC의 `state.sqlite`에만 있다. 주입 기록과 처리가 끝난 hook 기록은 90일이 지나면 지운다. 아직 처리하지 않은 기록은 오래돼도 남긴다. 결정은 결정 파일(원문 인용 포함)에 있으므로 기록을 지워도 사라지지 않는다.
- 시간당 LLM 호출 수에 상한이 있다(`llm.max_calls_per_hour`, 기본 30, 히스토리 요약은 `history.max_calls_per_hour`로 따로). 다른 모델로 다시 시도하는 호출과 모델 평가 호출도 호출마다 확인하고, 넘으면 다음 실행으로 미룬다. 평가 한 번이 시간당 상한보다 크면 그 시간에 다른 호출이 없을 때만 시작한다.
- 결정 파일을 쓰다 실패하면(쓰기 권한 등) 확인 대기 규칙을 지우지 않고 그 대화 기록도 처리 완료로 표시하지 않는다. 다음 실행에서 다시 시도하고, 3번 실패하면 오류와 함께 남긴다.
- 코드 인덱스 데이터는 저장소의 `.devctx/local/`에만 쓰고 네트워크를 쓰지 않는다. 색인이 실패해도 AI 도구는 평소처럼 동작하고, 파싱에 실패한 파일은 `devctx code status`에 숫자로 나온다.
- 대화·AI 응답·diff처럼 바깥에서 온 글은 LLM 프롬프트에 JSON 문자열로 넣는다. 그 안의 따옴표·코드 울타리·제목이 데이터 구간을 끝내거나 새 메시지인 척할 수 없다.
- LLM CLI는 자기 프로세스 그룹으로 실행하고, 시간이 넘으면 그 CLI가 띄운 하위 프로세스까지 함께 끝낸다. 출력에서 답을 고를 때는 작업의 형식 검사를 통과한 JSON만 받는다(로그나 예시 객체가 먼저 나와도 그것을 답으로 쓰지 않는다).
- worker와 코드 색인은 잠금 파일로 하나씩만 돈다. 잠금에는 주인 표시가 있어 주인만 풀 수 있고, 오래된 잠금은 원자적 이름 바꾸기로 한 프로세스만 넘겨받는다.
- `config.yaml`을 읽지 못하면 기본값으로 돌되 `commit_mode: manual`로 둔다(저장소를 스스로 바꾸지 않음). 알 수 없는 `commit_mode` 값도 `manual`로 본다. `devctx doctor`가 이유를 보여준다.
- git hook은 저장소의 git 폴더(연결된 worktree는 원래 저장소의 것) 안에만 쓰고, 심볼릭 링크를 따라 쓰지 않으며 원자적으로 바꾼다.
- 도구 설정에는 스킬 명령 하나를 허용하는 devctx 항목만 넣는다. 저장소 밖에 쓰는 것은 Copilot CLI와 Kiro의 이 저장소 전용 권한 항목뿐이다(`code_index.preapprove: false`로 끈다). 허용하는 명령은 hook이 이미 자동으로 실행하는 `.devctx/bin/devctx`의 `code` 하위 명령뿐이다.
- 파싱 메모리는 색인하는 동안만 쓴다(전체 색인 최고치 실측: gin 141MB, django 449MB, okhttp·alamofire 최대 약 960MB). 색인과 스킬 명령은 끝나면 종료되는 프로세스라 메모리를 바로 돌려받고, 한 프로세스가 1GB를 넘으면 새 프로세스가 이어서 한다.

### 프롬프트 히스토리

`devctx history on`을 한 사람의 PC에서만 동작한다(설정은 `~/.local/share/devctx/history.json`에 저장소의 git 디렉터리 기준으로 저장되어 모든 worktree에 적용된다).

1. 프롬프트 hook이 프롬프트 원문과 작업 트리 스냅샷을 `state.sqlite`에 "진행 중" 턴으로 둔다. 스냅샷은 실제 index를 복사한 임시 index에 `git add -A`(`.devctx/` 제외)와 `git write-tree`를 해서 만든다. 바뀐 파일만 해시하므로 30~60ms이고, 실제 index와 스테이징은 그대로다.
2. 턴 종료 hook(없으면 세션 종료나 다음 프롬프트)이 두 번째 스냅샷과 AI의 마지막 응답, 대화 기록 경로를 붙여 "대기"로 바꾸고 worker를 띄운다.
3. worker가 두 트리를 `git diff`해서 바뀐 파일·줄 수·diff 일부를 얻고, 대화 기록(JSON lines, 시각으로 그 턴만)에서 실행한 명령과 마지막 응답을 찾는다. 이 사실만 주고 요약 모델이 2~5문장 요약·결과·종류(변경/조사/답변/진행 없음)를 쓴다. 요약에 사실에 없는 파일 이름이 나오면 그 모델에 경고가 쌓여 두 번 연속이면 강등된다.
4. `.devctx/history/<YYYY-MM>/<첫 항목 시각 UTC>-<도구>-<세션 id>.md`에 항목을 덧붙인다. 항목 번호는 세션 안의 프롬프트 순서다. 세션 파일이 이미 커밋됐거나(`HEAD`에 있음) 브랜치 전환으로 작업 트리에서 사라졌으면 고치지 않고 새 파일을 만들어, 머리에 몇 번째 프롬프트부터인지와 앞부분 파일을 적는다. 결정 파일처럼 커밋된 파일을 고치지 않으므로 checkout이 막히거나 병합 충돌이 나지 않는다. 프롬프트는 안에 든 백틱보다 긴 코드 울타리로 감싸 원문 그대로 두고, 비밀값 형태만 가린다.
5. pre-commit hook이 `.devctx/history`를 결정 파일과 함께 스테이징한다(`ride-along`).

요약 호출은 `history.max_calls_per_hour`(기본 30)로 따로 센다. 넘으면 다음 실행으로 미루고, 24시간이 지나도 못 쓰면 요약 없이 AI 응답 앞부분으로 쓴다. 끝 신호를 12시간 동안 받지 못한 턴은 바뀐 파일 없이 쓴다. 쓴 턴의 기록은 90일 뒤 `state.sqlite`에서 지운다(히스토리 파일은 그대로).

같은 프롬프트가 두 도구의 hook 설정에서 함께 불려도(Copilot이 `.claude/settings.json`도 읽는 경우) 한 번만 기록한다. 중복 판단 기준은 세션, 그 세션의 마지막 턴 종료 시각, 프롬프트 내용이다. 그래서 다음 턴에 같은 말("응")을 다시 하면 따로 기록된다.

### 메모리 벤치마크

`npm run bench:memory`는 [Agent Memory Benchmark](https://github.com/vectorize-io/agent-memory-benchmark)와 PrecisionMemBench 방식으로 devctx의 메모리를 LLM 없이 검사한다. 결정 24개가 든 저장소에 프롬프트 15개를 넣어, 붙여야 할 결정과 붙이면 안 되는 결정(대체된 규칙, 기한 지난 규칙, 다른 경로의 규칙)을 ID로 확인한다. 만료 경계, 중복 지름길, 지어낸 이름 걸러내기, 판정 번호 되돌리기, 세션 이어가기도 함께 본다. 파일 링크로 계산하는 상태(대체, 두 브랜치의 이중 대체, 다른 브랜치에서 대체된 규칙과의 충돌, 중복, 충돌 정리, 파일 순서와 무관), 실제 git 저장소에서 두 브랜치를 병합했을 때(충돌 없음, 기존 결정 파일 그대로, hook 없는 서버 병합 뒤에도 작업 트리가 깨끗함, 새 clone과 규칙 목록이 바이트까지 같음), 코드 근거, 확인 대기 보관과 되살리기, 오래된 기록 정리, 고장 알림, 파일 2,000개 속도, 어떤 프롬프트를 언제 추출로 보내는지(명시 표현, 메모 형태의 정책, 제안 수락, 질문·짧은 대답 제외, 5개 묶음과 1시간 상한), 프롬프트 히스토리(켜고 끄기, 턴별 바뀐 파일, 원문 보존과 비밀값 가리기, 세션별 파일과 시간순, 대화 기록 읽기), 되돌린 규칙·기한 연장·같은 문장으로 정리한 충돌, 경로가 다른 같은 문장, 쓰기 실패 뒤 재시도, Cursor 규칙 파일, 세션 종료 자동 커밋, init 재실행 때 설치 위치 유지, `## 규칙` 직접 수정, 재시도를 포함한 시간당 호출 상한, 안전장치(저장소 밖·심볼릭 링크 hook에 쓰지 않음, 잠금, 프로세스 그룹 종료, 로그 대신 답 고르기, 추측한 분류는 확인 대기, 프롬프트 데이터 JSON 인코딩, 모델 ID 구분, 깨진 설정, 설치 위치 고정, 도구 hook 파일 병합), AGENTS.md 고정과 서버 병합(생성 파일 미커밋, 사람이 고친 AGENTS.md 유지, 이전 형식 변환은 init·compile에서만, 업그레이드 전 브랜치 checkout 왕복, 병합으로 남은 예전 규칙 목록 찾기), 실행 스크립트(node 버전 고르기, 조용한 설치 실패, 오래된 설치 잠금, hook만 재시도 대기, doctor와 같은 설치 위치), `tools.lock` 버전, 파일 지정 커밋(`git commit <파일>`), `remember` 즉시 확정, `approve`·`discard`·`resolve`, 프롬프트 분석 끄기, 자동 커밋에서 생성 파일 제외, 주석 있는 설정 파일 안내, 문장 속 비밀값, 모르는 명령), 처음 쓰는 사람 기준의 점검(`--help`는 실행하지 않음, 잘못된 도구 이름, CLAUDE.md가 빠지지 않는 커밋 안내, 확인 대기·확정을 구분하는 로그 문구, 코드 조회의 잘못된 옵션·실패는 종료 코드 1, 긴 설치 위치의 키, 히스토리 끌 때 대기 항목 버리기, 로컬 원문 지우기, `0`·`[]`이면 LLM을 부르지 않음, 비밀값 자리표시자와 로컬 DB 저장, 제거 명령)도 본다. 현재 240/240 통과, 붙인 결정의 정밀도 0.92·재현율 1.00이다. 추출·판정 모델의 품질은 4장의 요구사항 평가가 맡는다.

### 참고한 메모리 도구

다른 에이전트 메모리 프로젝트에서 devctx의 조건(사용자가 할 일 없음, hook 0.1초, 로컬 sqlite와 Git만, 시간당 LLM 호출 30회 이하, 5개 도구 공통)에 맞는 것만 가져왔다.

| 가져온 것 | 참고 |
|---|---|
| 판정 전 같은 문장 지름길, 숫자·버전이 다르면 합치지 않기 | [Mem0](https://github.com/mem0ai/mem0), [Graphiti](https://github.com/getzep/graphiti), [Hindsight](https://github.com/vectorize-io/hindsight) |
| 판정 모델에 ID 대신 번호 보여주기 | Mem0 |
| 기한(`valid_until`)과 대체된 날 기록, 지난 규칙은 지우지 않고 전달만 중단 | Graphiti의 유효 기간, Mem0의 만료일 |
| 바꾸는 지시는 이전과 새 선택지를 모두 적기, 작업 한정 세부값 빼기 | Mem0, [Letta Code](https://github.com/letta-ai/letta-code) |
| 원문에 없는 이름이 든 규칙은 확인 대기 | [Cognee](https://github.com/topoteretes/cognee)가 문서화한 규칙 추출 오류 |
| IDF 가중 단어 점수, 넘치는 결정은 건너뛰고 계속 담기 | Hindsight·Graphiti의 BM25, Hindsight의 토큰 예산 채우기 |
| 슬래시 명령·짧은 대답에 주입하지 않기, 경로 범위 밖 결정 빼기 | [OpenViking](https://github.com/volcengine/OpenViking), [Atlas](https://github.com/pacifio/atlas) |
| 다른 도구의 직전 세션 이어받기 | Atlas의 에이전트 간 이어받기, OpenViking의 세션 요약 |
| `devctx why`(주입 추적), `devctx log`(자동 변경 기록), 주입 기록 | OpenViking의 검색 추적, Mem0의 변경 이력, OpenMemory의 접근 기록 |
| LLM 없는 메모리 벤치마크 | Agent Memory Benchmark, PrecisionMemBench |
| 결정 파일을 고치지 않고 새 파일이 이전 파일을 가리키게 하기 (병합 충돌 없음) | Mem0 Dream의 대체 표시, Graphiti의 무효화, Hindsight의 추가 전용 원본 (이들은 서버 DB 안에서 한다) |
| 규칙이 기대는 코드가 사라지면 "확인 필요" | Hindsight의 커밋마다 저장소 재조사, Letta Code의 처음 설정 때 코드 대조 (devctx는 LLM 없이 의존성·경로만 본다) |
| 추출 실패, hook 끊김을 스스로 알리기 | Atlas의 기록 상태 표시 |

가져오지 않은 것: 임베딩과 벡터 DB(Mem0, memU, Hindsight, Atlas), 그래프 DB(Graphiti, Cognee), MCP로만 꺼내 쓰는 메모리(Atlas, OpenMemory: 도구를 부르지 않는 에이전트는 메모리를 못 받는다), 에이전트가 스스로 고치는 메모리와 백그라운드 반성 에이전트(Letta, Letta Code, memU: 호출이 많고 결과가 도구마다 다르다), hook 안의 LLM 재정렬·의도 분석(지연), LLM이 쓰는 요약 페이지(호출 수와 Git diff 증가), 추가만 하는 메모리(Mem0 v3: 규칙은 하나의 현재값으로 모여야 한다), 사용자별 피드백 가중치(팀 공용 규칙과 맞지 않음).

### 그림 고치기

`docs/diagrams/*.archify.json`이 원본이다. Archify로 다시 만든다.

```sh
git clone --depth 1 https://github.com/tt-a1i/archify /tmp/archify
node /tmp/archify/archify/bin/archify.mjs deliver architecture \
  docs/diagrams/architecture.archify.json docs/diagrams/architecture.html --quality showcase
```

Archify는 MIT 라이선스다. 생성된 HTML에는 Archify 뷰어와 JetBrains Mono 글꼴(SIL OFL 1.1)이 들어 있다.
