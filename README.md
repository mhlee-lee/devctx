# devctx

AI 코딩 도구와 대화하며 정한 프로젝트 결정을 자동으로 기록하고, 모델·도구·세션이 바뀌어도 같은 규칙으로 일하게 해준다. 결정은 Git에 파일로 남아 clone한 팀원에게도 그대로 적용된다.

지원 도구: Claude Code, Codex (앱·CLI), GitHub Copilot (VS Code·CLI), Cursor, Kiro

처음 쓴다면 [처음 사용하는 사람을 위한 안내](docs/getting-started.md)부터 읽는다. 무엇이 기록되는지, 어디에 저장되는지, 토큰과 비용이 얼마나 드는지 정리했다. 동작 방식은 [docs/how-it-works.md](docs/how-it-works.md)에 그림과 함께 정리했다.

## 하는 일

- 대화 중 "앞으로 금액은 BigDecimal로 해" 같은 지시를 결정 파일로 남긴다. "릴리스 전까지" 같은 기한이 있으면 그날까지만 적용한다.
- 정책이 바뀌면 이전 결정을 대체하고, 같은 뜻의 지시는 하나로 합친다.
- 결정을 세션을 시작할 때 AI에 전달하고, 이 PC에서 도구별 규칙 파일로 만들어 모든 도구가 같은 규칙을 따르게 한다. AGENTS.md는 사람이 관리하는 파일로 두고, devctx는 규칙이 어디서 오는지 알려주는 바뀌지 않는 블록 하나만 넣는다. 결정이 늘어도 AGENTS.md가 바뀌지 않아 도구의 프롬프트 캐시가 깨지지 않는다.
- 프롬프트마다 관련 결정만 골라 붙여 토큰을 아낀다. 무엇이 왜 붙는지는 `devctx why`로 본다.
- 도구를 바꿔 새 세션에서 "아까 하던 거 이어서 해줘"라고 하면 직전 세션의 체크포인트(처음·마지막 요청, AI가 남긴 남은 작업, 실패·통과한 테스트와 빌드, 그 뒤의 커밋과 커밋 안 된 파일)를 붙여준다.
- 세션을 시작할 때 최근 7일 동안 바뀐 결정("Jest → Vitest")을 알려, 코드에 남은 옛 방식을 따라 하지 않게 한다.
- AI가 `search_history`로 이전 작업(예전 요청과 결과, 실패했다가 통과한 검증과 그 턴, 대체된 결정과 이유)을 필요할 때만 찾아본다. 사람은 `devctx recall`로 같은 검색을 한다.
- 다른 세션에서 본 에러(`TS2345`, `Missing script: "test"` 등)가 프롬프트에 나오면 그때 어떻게 통과시켰는지 한 줄 붙인다. LLM 없이 대화 기록 파일의 종료 코드로 판단하고, 이 PC에만 둔다.
- 내장 코드 인덱스로 39개 언어(tree-sitter 문법 35개. JSX는 JavaScript 문법을, Vue·Svelte·Astro는 스크립트 부분을 JS/TS 문법으로 읽는다)의 심볼·호출 관계·타입 계층을 만들고, 모든 도구에 스킬 `devctx-code`로 제공한다. AI가 파일을 통째로 읽지 않고 필요한 코드만 찾는다.
- 원하면(`devctx history on`) 내가 입력한 프롬프트 원문과 AI가 그 프롬프트로 한 작업의 요약을 시간순으로 Git에 남긴다.
- 한 번 `devctx init`하고 도구마다 프로젝트 hook을 한 번 승인하면 이후는 자동이다. 도구마다 hook이 할 수 있는 일이 달라 지원 범위가 조금씩 다르다([도구별 지원](#도구별-지원)).

## 요구 사항

- macOS 또는 Linux (Windows는 아직 지원하지 않는다)
- Node.js 22.13 이상(23은 23.4 이상), Git
- 로그인된 AI 도구 CLI 하나 이상: `claude`, `codex`, `copilot`, `cursor-agent`, `kiro-cli`
  - 없어도 동작하지만, 그때는 "앞으로", "항상" 같은 표시가 있는 문장만 확인 대기(proposed, 이 PC에만)로 남긴다.
- 코드 인덱스는 추가 설치가 없다. 문법(tree-sitter WASM)이 devctx에 들어 있고, 네이티브 빌드나 다운로드를 하지 않는다.

## 설치

아직 npm에 배포하지 않아 소스에서 설치한다.

```sh
git clone https://github.com/mhlee-lee/devctx.git dev-context
cd dev-context
npm install   # 의존성 설치와 빌드(prepare)
npm link      # devctx 명령을 전역에 연결
devctx version
```

## 프로젝트에 적용

```sh
cd <내 프로젝트>
devctx init
# init이 마지막에 출력하는 git add 명령을 그대로 실행한다. 예:
git add -A -- .devctx AGENTS.md .gitattributes .gitignore .claude .github/hooks .agents .vscode/settings.json
git commit -m "chore: devctx 설정"
```

`init`이 출력하는 목록은 고른 도구에 따라 실제로 만들거나 바꾼 경로만 담는다(CLAUDE.md를 고쳤으면 그것도). 없는 경로가 섞여 `git add`가 실패하는 일이 없다.

`--tools`에 모르는 이름을 주면(`--tools claud`) 아무것도 설치하지 않고 오류와 가능한 이름을 보여준다. 어느 명령이든 `--help`를 붙이면 도움말만 보여주고 실행하지 않는다.

설치 뒤 제대로 동작하는지는 [처음 사용하는 사람을 위한 안내의 5분 확인](docs/getting-started.md#2-설치-직후-확인할-것)대로 확인한다. `devctx doctor`의 `ok`는 파일과 설치 상태가 맞다는 뜻이고, AI CLI의 로그인까지 확인한 것은 아니다.

코드 인덱스를 쓰지 않으려면 `devctx init --no-code-index`.

`init`이 하는 일:

- `.devctx/`에 설정, 지식 폴더, hook과 스킬이 부르는 실행 스크립트(`.devctx/bin/devctx`)를 만든다.
- 도구별 hook 파일을 추가한다: `.claude/settings.json`, `.codex/hooks.json`, `.github/hooks/devctx.json`, `.cursor/hooks.json`, `.kiro/hooks/devctx.json`
- AGENTS.md 끝에 devctx 블록(`<!-- devctx:begin -->` ~ `<!-- devctx:end -->`)을 넣는다. 규칙이 어디서 오는지 알려주는 고정 안내라 결정이 바뀌어도 내용이 그대로다. 나머지는 사람이 관리하고 devctx는 건드리지 않는다. 이전 버전이 만든 AGENTS.md는 사람이 쓴 부분(`preamble.md`)과 이 블록으로 바꾼다. CLAUDE.md가 있으면 맨 위에 `@AGENTS.md`를 넣는다.
- git hook(pre-commit, post-merge, post-checkout, post-rewrite)에 devctx 블록을 넣는다. `core.hooksPath`가 저장소 밖(여러 저장소가 함께 쓰는 전역 hook 폴더)을 가리키거나 hook 파일이 심볼릭 링크면 건드리지 않고 `devctx doctor`에 이유를 보여준다.
- `.gitignore`에 이 PC에서 만드는 규칙 파일(`.devctx/rules.md`, 도구별 `devctx-*` 경로 규칙 파일)을 넣는다. 이 파일들은 결정 파일에서 PC마다 똑같이 만들어지므로 커밋하지 않는다. 이전 버전이 커밋한 것은 추적을 멈춘다(파일은 남는다).
- `.gitattributes`에 스킬 파일과 Codex 명령 규칙의 병합 방식(`merge=union`)을 적는다.
- 코드 인덱스 스킬 `devctx-code`를 도구별 스킬 폴더에 넣고, 스킬 명령을 도구별 권한 설정에 미리 허용한다([코드 인덱스](#코드-인덱스) 참고).
- 이전 버전이 등록한 `devctx-code` MCP 서버 항목이 있으면 지운다. 다른 서버는 그대로 둔다.

도구마다 처음 한 번 확인할 것:

- Codex: 새 프로젝트 hook을 신뢰할지 묻는다. `/hooks`에서 승인한다. 프로젝트의 `.codex/`(hook, 명령 허용 규칙)는 신뢰한 프로젝트에서만 읽는다.
- Claude Code: 프로젝트 설정을 신뢰할지 물으면 허용한다.
- Cursor, VS Code: 신뢰한 워크스페이스에서만 hook과 명령 자동 허용이 동작한다.

### 도구별 지원

도구마다 hook이 받는 정보와 돌려줄 수 있는 것이 달라서 할 수 있는 일이 다르다. 아래는 각 도구의 hook 문서를 기준으로 구현한 내용이다.

| | Claude Code | Codex | Copilot | Cursor | Kiro |
|---|---|---|---|---|---|
| 대화에서 결정 기록 | ✓ | ✓ | ✓ | ✓ | ✓ |
| 프로젝트 규칙 (세션 시작 hook으로 전달) | ✓ | ✓ | ✓ | ✓ | ✓ |
| 경로별 규칙 | `.claude/rules/` | 프롬프트 hook | `.github/instructions/` | `.cursor/rules/` | `.kiro/steering/` |
| 프롬프트마다 관련 결정·코드 힌트 | ✓ | ✓ | ✓ | ✗ (hook이 컨텍스트를 붙일 수 없음) | ✓ |
| 관련 있을 때만 읽는 규칙 | 프롬프트 hook | 프롬프트 hook | 프롬프트 hook | `.cursor/rules/devctx-on-demand.mdc` (Agent가 설명을 보고 고름) | 프롬프트 hook |
| 세션 이어가기 | ✓ | ✓ | ✓ | ✗ | ✓ |
| 세션 종료 hook (`auto-commit`, 대기 중인 기록 처리) | ✓ | ✓ | ✓ | ✓ | ✗ (다음 세션 시작 때 처리) |

hook이 동작하지 않는 환경(승인 전, 다른 에이전트)에서는 AGENTS.md의 devctx 블록이 `.devctx/rules.md`(이 PC에서 만든 전체 규칙 목록)를 읽으라고 안내한다.

#### 규칙을 AGENTS.md에 넣지 않는 이유

Copilot(VS Code), Cursor, Kiro 같은 도구는 AGENTS.md와 규칙 파일을 요청마다 보내고, 앞부분이 같으면 프롬프트 캐시를 쓴다. 세션 중에 이 파일들이 바뀌면 그 대화 전체의 캐시가 깨져 다음 요청부터 비용이 다시 든다. 그래서 규칙은 이렇게 전달한다.

- AGENTS.md: 사람이 쓴 내용 + 바뀌지 않는 devctx 블록. 결정이 늘어도 그대로다.
- 세션 시작: hook이 그때의 규칙 목록을 붙인다. 세션 동안 바뀌지 않는다.
- 세션 중에 새로 정한 결정: 다음 프롬프트에 덧붙인다(앞부분은 그대로라 캐시가 유지된다).
- 도구별 경로 규칙 파일과 `.devctx/rules.md`: 세션 시작, git hook(checkout·merge 등), 세션 종료 때만 다시 만든다. 턴이 끝날 때는 `.devctx/rules.md`만 갱신한다.

AI 응답 원문은 턴 종료 hook이 넘겨줄 때 쓰고, 넘겨주지 않으면 대화 기록 파일(`transcript_path`)에서 읽는다. 둘 다 없으면 "응"만으로 제안을 수락한 것은 알아보지 못한다.

## 팀원과 공유

팀원은 clone만 하면 된다. hook이 `.devctx/bin/devctx`를 부르고, 이 스크립트가 `.devctx/tools.lock`의 `devctx_source`에서 devctx를 이 PC에 설치한다(첫 호출 때 백그라운드로). git hook은 커밋되지 않지만 첫 AI 세션에서 자동으로 설치된다.

- 설치는 `npm install --allow-git=all`로 한다. npm 12부터 git 주소 설치가 기본으로 막혀 있어서다(`allow-git=none`, 이전 npm은 이 옵션을 무시한다).
- AI 도구 hook과 git hook에서 부를 때는 설치를 백그라운드로 돌리고 아무것도 출력하지 않는다. 커밋이나 checkout에 npm 오류가 찍히지 않는다. 설치가 실패하면 hook은 1시간 뒤에 다시 시도하고, 그 사이 기록 없이 넘어간다. 사람이 직접 실행한 명령(`.devctx/bin/devctx version` 등)은 바로 다시 설치한다.
- `devctx doctor`의 `hook runtime` 항목이 이 PC의 hook이 실제로 실행할 devctx(설치 위치·버전)와 마지막 설치 실패 로그를 보여준다. doctor 자신은 전역 설치본으로 돌아도, hook이 쓰는 쪽을 따로 확인한다.
- 설치본은 버전과 설치 위치(`devctx_source`)마다 따로 둔다. 패키지 버전이 같아도 커밋 SHA가 바뀌면 새로 설치한다.
- PATH에 node가 없을 때(Dock에서 연 IDE 등) nvm 폴더를 버전 숫자 순으로 보고 `node:sqlite`를 쓸 수 있는 것(22.13+, 23.4+, 24+)을 쓴다.

`devctx_source` 기본값은 이 PC의 로컬 경로라 다른 PC에서는 동작하지 않는다. 팀과 쓰려면 설치 위치를 공개 저장소의 커밋으로 정하고, 바뀐 `tools.lock`을 커밋한다.

```sh
SHA=$(git -C <devctx를 clone한 폴더> rev-parse HEAD)      # 지금 쓰는 devctx의 커밋
devctx init --source github:mhlee-lee/devctx#$SHA         # npm에 배포한 뒤라면 정확한 버전: @scope/devctx@0.1.0
# init이 출력하는 git add 명령으로 .devctx/tools.lock과 실행 스크립트를 커밋한다
git add -A -- .devctx && git commit -m "chore: devctx 설치 위치 고정"
```

도구에서 프로젝트 hook을 승인하면, clone한 PC는 첫 hook 실행 때 `devctx_source`가 가리키는 코드를 설치하고 실행한다. 그래서 `devctx_source`는 내용이 바뀌지 않는 것으로 고정한다. git 태그와 브랜치(`#v0.1.0`, `#main`)나 npm 범위·태그(`@^0.1.0`, `@latest`)는 나중에 다른 코드를 가리킬 수 있다. 이런 값이면 `devctx init`과 `devctx doctor`가 알린다. 커밋 SHA는 git이 내용 해시로 확인하고, 정확한 npm 버전은 레지스트리에서 다시 올릴 수 없다.

`devctx doctor`가 로컬 경로를 쓰고 있으면 알려준다.

`tools.lock`은 팀이 함께 쓰는 고정값이라 `devctx init`을 다시 실행해도(hook·스킬 갱신) 바뀌지 않는다. 바꾸는 것은 `--source`를 줄 때뿐이고, 그때 버전은 그 위치를 따른다(정확한 npm 버전이면 그 버전, git 주소면 지금 실행 중인 devctx의 버전). 그래서 버전 이름과 실제 코드가 어긋나지 않는다. devctx를 올린 뒤 팀도 옮기려면 새 커밋 SHA나 버전으로 `--source`를 주고 다시 커밋한다.

`.devctx/bin/devctx`(실행 스크립트)도 커밋된 파일이라 devctx를 업데이트해도 저절로 바뀌지 않는다. 다른 버전의 devctx가 쓴 스크립트면 `devctx doctor`가 `shim version`으로 알리고, `devctx init`을 다시 실행해 커밋하면 된다.

## 사용

평소처럼 AI 도구와 대화하면 된다.

| 기록된다 | 기록되지 않는다 |
|---|---|
| "앞으로 ...", "항상 ...", "이 프로젝트에서는 무조건 ..." | "이번만 ...", "일단 ..." |
| AI 작업을 고치는 말: "Double 말고 BigDecimal 써" | 질문, 감사 인사 |
| AI 제안 수락: "응 그렇게 하자. 앞으로 그 형식으로 맞춰" | 붙여넣은 로그·코드 속 문장 |
| 기한 있는 규칙: "10월 10일 릴리스 전까지 의존성 올리지 마" (그날이 지나면 자동 만료) | 특정 코드에 대한 작업 요청: "LoginForm에 토글 버튼 추가해줘" |
| 표시 없이 말한 일반 규칙: "DTO는 record로 작성해", "불필요한 일반화는 하지 마", "DB 컬럼명은 snake_case" | |
| AI 제안에 "응"으로만 답한 수락 (AI: "RFC 7807로 통일할까요?" → "응") | |

- 프롬프트는 두 단계로 고른다. 먼저 hook이 LLM 없이 "앞으로", "항상", "~하지 마", "X 말고 Y" 같은 표현을 찾고, 이런 프롬프트는 그 턴이 끝날 때 바로 추출한다. 표현이 없는 프롬프트도 질문, "응"·"고마워" 같은 짧은 대답, 슬래시 명령, "이번만"·"일단"이 붙은 문장, 붙여넣은 코드·로그만 빼고 모두 5개씩 모아(또는 세션 시작·종료 때, 1시간이 지나면 다음 턴이 끝날 때) LLM이 지속 규칙인지 일회성 작업인지 판단한다. AI가 제안을 묻고 끝낸 직후의 "응"은 수락으로 보고 함께 보낸다(도구가 AI 응답이나 대화 기록 파일을 넘겨줄 때). 명시 표현만 보내려면 `memory.implicit_rules: false`. 자세한 기준은 [처음 사용하는 사람을 위한 안내](docs/getting-started.md#3-무엇이-기록되나)에 있다.
- 결정은 `.devctx/knowledge/decisions/`에 1건 1파일로 쌓인다. 직접 고치거나 새로 써도 된다. AI에 전달되는 문장은 파일의 `## 규칙` 구간이다. front matter의 `summary`와 다르면 `## 규칙`을 쓰고 `devctx doctor`가 알린다. 판정할 때는 사람이 직접 쓴 파일(`source.kind: human-edit`)이 AI 제안이나 대화에서 뽑은 규칙보다 우선한다. 기한은 `valid_until: 2026-10-10`처럼 적는다.
- devctx는 한 번 만든 결정 파일을 다시 고치지 않는다. 규칙이 바뀌면 새 파일을 만들고 거기에 "무엇을 대체하는지"(`supersedes`)를 적는다. 이전 파일의 상태(대체됨, 충돌, 만료)는 파일들을 읽을 때 계산한다.
- 계속 지킬 규칙인지 애매한 말은 확인 대기로 이 PC에만 둔다. 다시 말하거나 `devctx approve <ID>`로 확정하면 결정 파일이 된다(`devctx approve`만 치면 목록). 필요 없으면 `devctx discard <ID>`. 30일 동안 다시 나오지 않으면 보관으로 옮기고, 몇 달 뒤에라도 다시 말하면 바로 적용된다.
- `devctx remember "규칙"`은 직접 남기는 것이라 LLM이 없어도 바로 확정된다. 결과로 저장됨·이미 있음·확인 대기·충돌 중 무엇인지와 다음에 할 일을 보여준다.
- 내 프롬프트를 분석하지 않게 하려면 `devctx capture off`(이 PC에서 이 저장소, `--global`이면 이 PC의 모든 저장소). 그러면 내 프롬프트로 LLM을 부르지 않아 내 AI CLI 쿼터를 쓰지 않는다. 팀 규칙은 그대로 전달된다.
- "나한테는 짧게 답해줘" 같은 개인 선호는 저장소가 아니라 이 PC(`~/.local/share/devctx/`)에 저장한다.
- 기본 커밋 방식(`ride-along`)에서는 내가 커밋할 때 새 결정 파일이 함께 커밋된다.
- 자동으로 바뀐 내용과 이유는 `devctx log`로 본다.
- 규칙 문장이 채팅 역할 태그(`[SYSTEM]`, `<system>`)를 흉내 내거나 "이전 지시를 모두 무시하라"는 식이면 그 결정은 어디에도 전달하지 않고(보류) `devctx doctor`와 `devctx status`가 파일과 이유를 알린다. 결정 파일은 일반 커밋에 함께 실려 AGENTS.md보다 덜 검토되기 때문이다. 대화에서 그런 문장이 규칙으로 뽑히면 Git에 쓰지 않고 이 PC에만 두며, `devctx approve`도 거절한다. "생성 파일의 lint 경고는 무시한다"처럼 평범한 규칙은 해당하지 않는다.

### 여러 사람이 같이 쓸 때

각자 브랜치에서 결정이 생겨도 병합 충돌이 나지 않는다.

- 커밋하는 것은 결정 파일뿐이다. 결정 파일은 새로 추가만 하니 두 사람의 변경은 늘 다른 파일이다. 같은 파일을 고치는 건 사람이 직접 고칠 때뿐이다.
- 규칙 목록(`.devctx/rules.md`)과 도구별 규칙 파일은 커밋하지 않고 PC마다 결정 파일에서 만든다. 같은 결정 파일이면 어느 PC에서 만들어도 같다. 그래서 GitHub에서 PR을 병합하는 것처럼 hook 없이 서버에서 병합해도 오래된 규칙이 저장소에 남지 않고, pull한 사람의 작업 트리가 바뀐 상태가 되지도 않는다.
- AGENTS.md는 사람이 고친 내용이 그대로 남는다. devctx는 자기 블록만 관리한다. hook은 git이 추적하는 파일을 고치지 않는다. 그래서 업그레이드 전 브랜치(예전 AGENTS.md와 규칙 파일이 커밋돼 있음)를 checkout해도 작업 트리가 바뀌지 않고, 다시 돌아올 때 막히지 않는다. 예전 AGENTS.md는 `devctx init`이나 `devctx compile`을 실행할 때만 바꾼다.
- 업그레이드 전 브랜치를 병합해 예전 규칙 목록이 AGENTS.md의 devctx 블록 밖에 남으면(그 브랜치의 `.gitattributes`에 `merge=union`이 남아 있을 때) `devctx doctor`가 알린다. 그 부분은 지운다.
- `git commit <파일>`처럼 파일을 지정한 커밋(JetBrains IDE 등)에서는 pre-commit hook이 결정 파일을 함께 올리지 않는다. 임시 index에 올리면 실제 index에 남지 않아 다음 커밋에서 결정 파일이 지워지기 때문이다. 다음 일반 커밋에 함께 올라가고, git 출력에 그렇게 알린다.
- 두 사람이 같은 규칙을 각자 다르게 바꿨으면(예: Jest를 한 명은 Vitest로, 한 명은 Kotest로) 충돌로 표시되고, 관련 작업 때 AI가 어느 쪽을 따를지 한 번 묻는다. 같은 문장이 따로 두 번 기록됐으면 하나만 전달한다. 같은 문장이라도 이전 규칙을 대체하며 다시 정한 것(Jest→Vitest→Jest로 되돌림, 기한 연장)은 사본이 아니라 최신 규칙으로 본다.
- 내가 만든 규칙은 새로 말하면 대체된다. 다른 팀원이 만든 규칙(결정 파일의 `source.actor`가 다른 사람)은 조용히 바꾸지 않고 충돌로 남긴다. 정리는 대화에서 한쪽을 다시 말하거나 `devctx resolve <ID>`로 남길 쪽을 고른다(ID는 `devctx status`의 6자리).
- 같은 말을 몇 번 했는지, AI가 몇 번 어겼는지 같은 숫자는 PC마다 `.devctx/local/`에 둔다. 그래서 이런 숫자는 그 PC의 프롬프트 주입 순서에만 쓰이고 팀 규칙 목록에는 영향이 없다.

### 코드가 바뀌면

결정을 기록할 때 그 규칙이 기대는 것을 함께 적는다. 규칙에 나온 의존성·도구 이름(`package.json`, `build.gradle`, `pyproject.toml`, `go.mod` 같은 파일과 lockfile, 설정 파일에서 찾은 것)과, 파일이 있는 경로 범위다. 나중에 대화 없이 PR로 그것이 사라지면(예: Jest를 빼고 Vitest를 넣음) 그 규칙을 지우지 않고 "확인 필요: 저장소에서 `jest`을(를) 찾을 수 없음"을 붙여 세션 시작 때 항상 전달하는 목록에서 내리고, 관련 작업 때만 표시와 함께 전달한다. 다시 생기면 표시도 없어진다. `tier: core`로 고정한 규칙은 내리지 않는다. 확인은 Git에 올라간 파일만 보고 LLM 없이 해서, 모든 PC가 같은 결과를 낸다.

### 세션 이어가기

Claude Code에서 하던 작업을 Codex, Copilot, Kiro에서 이어갈 때(Cursor는 프롬프트 hook이 내용을 붙일 수 없어 지원하지 않는다), 새 세션의 첫 요청이 "이어서", "아까 하던 거", "continue" 같은 말이거나 직전 세션과 같은 코드 이름을 담고 있으면 직전 세션의 체크포인트를 한 번 붙인다.

```text
[devctx] 이 저장소의 직전 작업 (Claude Code, 3시간 전, 요청 3개). 이어서 하는 요청이면 참고:
- 처음 요청: OrderService.applyDiscount를 DiscountPolicy 전략으로 리팩터링해줘
- 마지막 요청: 테스트도 돌려줘
- 마지막 응답 (앞부분): DiscountPolicy 전략으로 분리하고 반올림을 Money로 옮겼다. …
- 남은 작업 (마지막 응답에서): 중복 할인 테스트 추가; 동시 갱신 테스트가 아직 실패: 락은 교착이 생겨 되돌림, 단일 갱신 큐 검토
- 그 세션의 마지막 검증: `npm test` 실패, `npm run typecheck` 통과
- 그 세션 시작 이후 커밋: 9776a64 Extract DiscountPolicy
- 지금 작업 트리 (feature/discount @ 9776a64): 커밋 안 된 파일 2개: src/billing/Policy.kt, src/billing/Money.kt
```

- 요청과 응답은 hook이 기록한 것, 남은 작업은 AI 마지막 응답의 "남은 작업"·"다음 단계"·"Next steps"·"TODO" 부분(없으면 응답 끝 문단), 검증은 도구의 대화 기록 파일(Claude Code, Codex, Copilot CLI)에서 테스트·빌드·린트 명령과 종료 코드(`npm test | tail`처럼 종료 코드가 다른 명령의 것이면 "결과 모름"), 작업 트리는 git에서 읽는다. LLM을 부르지 않는다.
- 이 PC의 `.devctx/local/`에만 있고 Git에는 올라가지 않는다. 비밀값 형태는 가린다. 관계없는 새 작업에는 붙이지 않는다.
- 크기는 `inject.handoff_budget_tokens`(기본 400)다. 모자라면 마지막 요청, 남은 작업, 검증 결과부터 넣는다.

## 프롬프트 히스토리

내가 입력한 프롬프트와 AI가 그 프롬프트로 한 작업을 시간순으로 Git에 남긴다. 사람마다 따로 켜고 끄며, 기본은 꺼짐이다.

```sh
devctx history on    # 이 PC에서 이 저장소의 기록 켜기 (모든 worktree에 적용)
devctx history       # 켜짐/꺼짐, 기록한 세션·항목 수, 최근 기록
devctx history off   # 끄기 (이미 쓴 기록은 그대로)
devctx history off --discard   # 끄면서, 켜져 있을 때 보냈지만 아직 파일에 쓰지 않은 항목도 버리기
```

기록은 턴이 끝난 뒤 백그라운드에서 쓴다. 그래서 켜져 있을 때 보낸 프롬프트가 끈 뒤에 파일로 쓰일 수 있고, `history off`가 그런 항목이 몇 개인지 알려준다.

켜져 있으면 세션을 시작할 때 AI가 "기록 중"이라고 한 번 알리고, `devctx status`와 `devctx doctor`에도 상태가 나온다. 켜고 끄는 설정은 이 PC(`~/.local/share/devctx/history.json`)에 있어서 팀원에게 퍼지지 않는다.

- **파일:** `.devctx/history/2026-10/2026-10-01T133950Z-claude-1491cd.md`처럼 세션마다 파일 하나다. 파일 이름이 첫 항목의 시각(UTC)으로 시작해 이름순이 곧 시간순이고, 파일 안의 항목은 프롬프트 순서다. 끝의 `1491cd`는 세션 id다. 한 번 커밋된 파일은 다시 고치지 않는다. 커밋 뒤에 같은 세션에서 이어진 프롬프트는 같은 세션 id를 단 새 파일에 쓰고, 그 파일 머리에 앞부분 파일을 적는다. 그래서 `git checkout`이 막히거나 병합 충돌이 나지 않는다. 두 사람이 같은 파일을 쓰는 일도 없다.
- **항목:** 시각·걸린 시간·브랜치·모델, **프롬프트 원문**, **작업 내용**(처음 보는 사람도 알 수 있는 2~5문장 요약과 결과), 바뀐 파일과 줄 수, 실행한 명령.
- **작업 내용을 만드는 방법:** 프롬프트를 받을 때와 턴이 끝날 때 작업 트리를 git으로 스냅샷해 비교한다(실제 index와 스테이징은 건드리지 않는다). 그래서 도구와 상관없이 그 사이에 바뀐 파일이 나오는데, 같은 시간에 내가 에디터로 직접 고친 파일도 함께 잡힌다. 여기에 AI의 마지막 응답과 대화 기록(도구가 넘겨줄 때: 실행한 명령)을 더해 저비용 LLM이 요약한다. 요약 모델도 요구사항 평가(`summarize`)를 통과한 가장 싼 모델이고, 호출 상한은 결정 추출과 따로 센다(`history.max_calls_per_hour`). LLM을 쓸 수 없으면 AI 응답 앞부분을 그대로 넣는다.
- **Git:** 결정 파일처럼 내가 커밋할 때 함께 커밋된다(`ride-along`). `manual`이면 직접 `git add .devctx/history`.
- **이 PC의 로컬 DB:** 히스토리를 꺼도 hook은 프롬프트를 `.devctx/local/state.sqlite`(Git 제외)에 저장한다. 규칙 추출과 세션 이어가기에 쓰기 때문이다. 자세한 내용과 지우는 방법(`devctx purge`)은 [이 PC에 남는 대화](#이-pc에-남는-대화)에 있다.
- **가리는 것:** 키·토큰처럼 보이는 값(`password=...`, `token = ...`, `sk-...` 등)은 코드 속이어도 종류를 알 수 있는 자리표시자(`{password}`, `{token}`, `{api_key}`, `{secret}`, `{private_key}`)로 바꾼다. 예: "스테이징 비번은 hunter2야" → "스테이징 비번은 {password}야", `postgres://app:pw@db` → `postgres://app:{password}@db`, `Bearer …` → `Bearer {token}`. 히스토리 파일뿐 아니라 이 PC의 `state.sqlite`에 저장할 때도 바꿔서 원래 값은 디스크에 남지 않는다. "비번은 hunter2", "the password is Tr0ub4dor"처럼 문장으로 쓴 값도 숫자나 기호가 섞여 있으면 가린다. 규칙 문장("토큰은 환경변수로 관리한다", "리프레시 토큰은 HttpOnly 쿠키에 저장한다", "비밀번호는 Argon2id로 해시한다")처럼 값 뒤에 '에·로' 같은 조사나 '쿠키·헤더' 같은 말이 오면 이름으로 보고 그대로 둔다. 모든 형태를 잡지는 못하니 비밀값은 프롬프트에 쓰지 않는다. 프롬프트가 20,000자를 넘으면 뒷부분을 생략 표시와 함께 자른다. `/compact` 같은 슬래시 명령은 기록하지 않는다.

## 이 PC에 남는 대화

hook은 프롬프트와 AI의 마지막 응답을 이 PC의 `.devctx/local/state.sqlite`에 저장한다(Git에 올라가지 않는다). 규칙 추출, "응"만 한 수락 판단, 세션 이어가기, 이전 작업 검색(`devctx recall`, `search_history`), 프롬프트 히스토리에 쓴다. 도구의 대화 기록 파일에서 읽은 검증 사례(실패한 테스트·빌드와 에러 몇 줄, 그것을 통과시킨 턴)도 여기에 둔다.

- 저장할 때 비밀값을 자리표시자(`{password}`, `{token}` 등)로 바꾼다. 원래 값은 디스크에 쓰지 않는다.
- 분석이 끝난 프롬프트는 90일이 지나면 지운다. 아직 분석하지 않은 것은 분석될 때까지 남는다. 히스토리 항목의 원문도 파일에 쓴 뒤 90일이 지나면 지운다.
- 히스토리를 꺼도(`devctx history off`), 프롬프트 분석을 꺼도(`devctx capture off`) 이 저장은 계속된다. 세션 이어가기에 쓰기 때문이다.
- 지금 바로 지우려면 `devctx purge`. 프롬프트·응답 원문, 쓰기 전 히스토리 항목, 세션 이어가기 정보를 지운다. 아직 정리하지 않은 프롬프트 속 규칙은 기록되지 않는다. 결정 파일과 확인 대기 규칙은 남는다.

## 코드 인덱스

AI가 grep과 파일 읽기를 반복하지 않도록, devctx가 저장소를 직접 파싱해 코드 그래프(심볼, 호출 관계, 타입 계층, 파일 구조)를 만든다. [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)의 언어별 노드 표와 [Graft](https://github.com/trailhq/Graft)의 WASM 파서 방식을 바탕으로 devctx 안에 구현했다. 외부 엔진이나 상주 서버가 없다.

AI 도구는 스킬 `devctx-code`로 쓴다. 스킬은 저장소 파일이라 clone하면 따라오고, AI가 코드 위치나 호출 관계가 필요할 때 스킬을 읽고 `.devctx/bin/devctx code <도구>`를 실행한다. 스킬 설명만 평소 컨텍스트에 들어가고 본문은 쓸 때만 읽힌다.

- **언어:** 39개 모두 같은 수준으로 분석한다. 호출을 그 언어의 import·모듈·네임스페이스·include 규칙과 변수·필드 타입으로 따라가 해석한다. 이름이 같은 함수가 여러 곳에 있어도 import가 가리키는 쪽에만 잇는다. 목록과 확인 결과는 [동작 방식 5장](docs/how-it-works.md#5-코드-인덱스)에 있다.
- **자동 색인:** 세션 시작, 브랜치 전환(checkout·merge·rebase) 때 백그라운드로 색인한다. 편집 중에는 명령을 실행할 때 바뀐 파일만 다시 파싱한다.
- **빠른 응답:** 호출 관계 해석 결과를 저장해 두고, 명령마다 해석을 다시 하지 않는다. 명령 한 번에 작은 저장소는 약 0.1초, django·rails 규모는 0.2~0.4초 걸린다(프로세스 시작 포함).
- **프롬프트 힌트:** 프롬프트에 `OrderService`, `place_order` 같은 코드 이름이 있으면 그 선언 위치를 함께 붙인다.
- **결정 연결:** 심볼 조회와 변경 영향 결과에 그 파일에 적용되는 팀 결정이 함께 나온다.
- **저장 위치:** `.devctx/local/code.sqlite` (Git 제외, 지우면 다음 세션에 다시 만든다).

명령 (저장소 루트에서 `.devctx/bin/devctx code …`, 설치한 PC에서는 `devctx code …`):

| 명령 | 하는 일 |
|---|---|
| `search_symbols <이름\|단어>` | 이름이나 단어로 클래스·함수·메서드·컴포넌트 찾기 (camelCase·snake_case 인식) |
| `get_symbol <이름\|Class.method\|path:line>` | 시그니처, 문서, 코드, 멤버, 상위·하위 타입, 사용처, 사용하는 것, 적용되는 팀 결정 |
| `trace_calls <대상> [--direction callers\|callees\|both]` | 호출하는 쪽·호출받는 쪽을 여러 단계로 추적, 인터페이스 구현체 |
| `file_outline <path>` | 파일 전체를 읽지 않고 선언 목록과 줄 범위 보기 |
| `repo_overview [dir]` | 언어, 주요 디렉터리, 많이 쓰이는 심볼, 진입점, 타입 계층 |
| `change_impact [--base main]` | `git diff`에서 바뀐 심볼과 영향받는 호출자, 테스트, 관련 팀 결정. 지운 파일과, 그 파일에만 있던 이름을 아직 쓰는 곳(이름으로 찾음)도 보여준다 |
| `search_text <텍스트> [--regex]` | 모든 파일 대상 텍스트·정규식 검색 (문자열, 설정, 모든 언어) |
| `search_history <단어\|에러 메시지\|코드 이름> [--days 90]` | 이전 작업: 이 PC의 지난 요청과 그때 AI 응답, 실패했다가 통과한 검증과 에러, 커밋된 프롬프트 히스토리(요약·결과), 대체·만료된 결정과 이유·후속 결정. 코드 인덱스를 끄면 스킬이 없어 AI는 이 명령을 모른다(사람은 `devctx recall`) |

스킬과 미리 허용은 도구마다 이렇게 들어간다. AI가 스킬 명령을 실행할 때 승인 창이 뜨지 않게 하려는 것이다. `code_index.preapprove: false`로 끈다.

| 도구 | 스킬 | 명령 미리 허용 |
|---|---|---|
| Claude Code | `.claude/skills/devctx-code/` | 스킬의 `allowed-tools`, `.claude/settings.json`의 `permissions.allow` |
| Codex | `.agents/skills/devctx-code/` | `.codex/rules/devctx.rules` (`prefix_rule`, 신뢰한 프로젝트에서 읽음) |
| Copilot (VS Code) | `.agents/skills/devctx-code/` | `.vscode/settings.json`의 `chat.tools.terminal.autoApprove` |
| Copilot CLI | `.agents/skills/devctx-code/` | `~/.copilot/permissions-config.json`의 이 저장소 항목 |
| Cursor | `.agents/skills/devctx-code/` | `.cursor/permissions.json`의 Auto-review 안내 (터미널 허용 목록이 이미 파일로 관리될 때만 거기에도 추가) |
| Kiro | `.kiro/skills/devctx-code/` | `~/.kiro/workspace-roots/<저장소>/permissions.yaml`의 shell 허용 규칙 |

Copilot CLI와 Kiro는 저장소 파일로 권한을 받지 않아서, 사용자 폴더에 이 저장소 전용 항목을 쓴다. `devctx init`과 하루 한 번 세션 시작 hook이 확인하므로 팀원 PC에도 따로 할 일이 없다. 허용되는 것은 `.devctx/bin/devctx code`로 시작하는 명령 하나뿐이고, 같은 스크립트를 hook이 이미 자동으로 실행한다.

`devctx code status`로 색인 상태와 스킬·허용 설치 상태를 본다.

잘못된 요청은 종료 코드 1과 이유를 돌려준다: 모르는 옵션(`--limt`), 정해진 값 밖의 값(`--direction`은 `callers`·`callees`·`both`, `incoming`·`outgoing`도 받는다), 잘못된 정규식, 없는 브랜치. 결과가 없는 것은 오류가 아니다(종료 코드 0). AI가 실패를 성공으로 읽지 않게 하려는 것이다.

## 명령어

| 명령 | 설명 |
|---|---|
| `devctx init [--tools claude,codex,...] [--source <npm\|git>] [--lang ko\|en] [--no-code-index]` | 저장소에 설치. 다시 실행하면 hook, 스킬, 권한 설정, 실행 스크립트를 갱신한다. 설치 위치(`devctx_source`)는 `--source`를 줄 때만 바꾼다 |
| `devctx status` | 기록된 결정 목록, 히스토리·프롬프트 분석 켜짐 여부 |
| `devctx code [status]` | 코드 인덱스 상태, 저장소 언어, 스킬·허용 설치 상태 |
| `devctx code index` | 지금 색인 (바뀐 파일만 다시 파싱) |
| `devctx code <도구> <인자>` | 코드 인덱스 조회. 예: `devctx code trace_calls CartService.checkout --direction both` |
| `devctx doctor` | 연결 상태 점검 (LLM 호출 없음) |
| `devctx models` | 작업(추출·판정·요약)별로 쓰는 모델, 후보 비용과 평가 결과 |
| `devctx models --qualify <tool> [--task extract\|judge\|summarize]` | 싼 후보부터 요구사항 평가를 지금 돌린다 |
| `devctx history [on\|off] [--discard]` | 프롬프트 히스토리 켜기·끄기(이 PC), 상태와 최근 기록. `off --discard`는 아직 쓰지 않은 항목도 버린다 |
| `devctx why "프롬프트" [--all]` | 그 프롬프트에 hook이 붙일 결정과 점수, 빠진 이유, 직전 세션 연결 여부와 붙일 체크포인트 |
| `devctx recall "단어" [--days N] [--limit N]` | 이전 작업 찾기 (이 PC의 지난 요청·응답, 히스토리, 대체된 결정과 이유). AI는 스킬의 `search_history`로 같은 검색을 한다 |
| `devctx log [--limit N]` | 자동으로 바뀐 결정(추가·보강·대체·충돌·만료)과 판정 이유, 그 규칙의 지금 상태(적용 중·확인 대기 등) |
| `devctx remember "규칙"` | 직접 기록. LLM이 없어도 바로 확정된다 |
| `devctx approve [<ID>]` | 이 PC의 확인 대기 목록 / 확정해 결정 파일로 저장 |
| `devctx discard <ID>` | 확인 대기 규칙 버리기 |
| `devctx resolve <ID>` | 충돌 정리: 고른 규칙만 남기고 상대 규칙은 대체 |
| `devctx capture [on\|off] [--global]` | 내 프롬프트를 규칙 후보로 분석할지 (기본 켜짐, 이 PC 설정) |
| `devctx compile [--check]` | 이 PC의 규칙 목록과 도구별 규칙 파일 재생성, AGENTS.md의 devctx 블록 확인 (`--check`는 최신인지만 확인) |
| `devctx worker` | 대기 중인 기록을 지금 처리 (보통 hook이 자동 실행) |
| `devctx purge` | 이 PC에 저장된 프롬프트·AI 응답 원문 지우기 |
| `devctx uninstall [--yes] [--keep-history]` | 이 저장소에서 devctx 제거. `--yes` 없이는 지울 것만 보여준다 |

## 추출 모델

무조건 싼 모델이 아니라, 요구사항을 전부 통과한 모델 중 가장 싼 모델을 쓴다.

1. 작업 중인 도구의 CLI에서 모델 목록을 가져온다. 모델 × reasoning effort가 각각 후보다.
2. 호출당 예상 비용이 싼 후보부터 요구사항 평가를 돌린다. 추출 44개, 판정 12개, 요약 10개 항목을 2회 연속 하나도 틀리지 않아야 통과다.
3. 처음 통과한 후보를 쓴다. 추출·판정·요약은 따로 고른다.
4. 실제로 쓰다가 요구사항을 두 번 연속 어기면 강등하고 다음 후보로 넘어간다.

새 모델이 나오면 자동으로 후보가 된다. 자세한 기준과 실측 결과는 [동작 방식 4장](docs/how-it-works.md#4-추출-모델-고르기)에 있다.

## 설정

`.devctx/config.yaml` (Git 공유). 자주 바꾸는 항목:

```yaml
language: ko                  # 생성 문서 언어: ko | en
targets: [claude, codex, copilot, cursor, kiro]
git:
  commit_mode: ride-along     # ride-along | auto-commit (세션 종료 시 별도 커밋) | manual
inject:
  prompt_budget_tokens: 600   # 프롬프트마다 붙이는 관련 결정 상한
  handoff_budget_tokens: 400  # 새 세션이 직전 작업을 이어갈 때 붙이는 직전 세션 체크포인트 상한 (0이면 끔)
llm:
  prefer_host_tool: true      # 작업 중인 도구의 CLI로 추출
  qualify_runs: 2             # 요구사항 평가 반복 횟수
  max_tier: large             # 자동 선택 상한: small | medium | large
  max_calls_per_hour: 30      # 0이면 LLM을 부르지 않는다 (providers: []도 같다)
  pin: {}                     # 모델 고정 (평가 생략). 예: { codex: gpt-6-luna }
memory:
  personal: true              # 개인 선호는 저장소 밖에 저장
  implicit_rules: true        # "앞으로" 같은 표현이 없는 프롬프트도 5개씩 묶어 LLM이 판단 (false면 명시 표현만)
code_index:
  enabled: true               # 내장 코드 인덱스를 스킬 devctx-code로 제공
  exclude: []                 # 색인에서 뺄 경로 glob. 예: ["**/generated/**"]
  max_file_kb: 512            # 이보다 큰 소스 파일은 파싱하지 않는다
  preapprove: true            # 도구별 권한 설정에 스킬 명령을 미리 허용
history:
  max_calls_per_hour: 30      # 프롬프트 히스토리 요약 호출 상한 (켜고 끄기는 사람마다: devctx history on|off)
```

## 문제 해결

- 평소에는 따로 볼 필요가 없다. devctx가 스스로 알린다.
  - 규칙 추출이 3번 연속 실패하면 다음 세션에서 AI가 한 번 알려준다.
  - 커밋은 계속되는데 AI 도구 hook 기록이 14일째 없으면, 커밋할 때 git 출력에 경고가 뜬다(사람이 커밋하든 AI가 커밋하든 보인다).
  - 도구 업데이트로 hook 설정에서 devctx 항목이 빠지면 하루 한 번 점검 때 다시 넣는다.
- 먼저 `devctx doctor`를 실행한다. hook 파일, git hook, 실행 스크립트와 hook이 실제로 실행할 devctx, 설치된 AI CLI, 선택된 모델, 최근 기록 시각, 추출 실패, 코드 근거가 사라진 규칙, 문장 때문에 전달을 보류한 규칙(`held rules`)을 보여준다. `llm CLIs`는 설치 여부만 본다. 로그인이 되어 실제로 답하는지는 `llm usage (7d)`(성공한 호출 수)로 확인한다.
- 팀원 PC에서 아무것도 기록되지 않으면 `devctx doctor`의 `hook runtime`을 본다. 설치 실패 로그가 나오면 `devctx_source`(커밋 SHA나 정확한 npm 버전인지, 접근 권한이 있는지)를 확인하고 `.devctx/bin/devctx version`으로 바로 설치해 본다.
- 로그: `.devctx/local/devctx.log`
- 결정이 쌓이지 않으면 도구에서 프로젝트 hook을 승인했는지 확인한다. 기록됐는데 적용되지 않으면 `devctx log`에서 판정 이유를 본다(확인 대기 `proposed`로 남았는지 등).
- 관련 결정이 안 붙거나 엉뚱한 결정이 붙으면 `devctx why "그 프롬프트"`로 점수와 빠진 이유를 본다. 결정의 `scope.topics`에 사람들이 실제로 쓰는 단어(한국어·영어 이름, 동의어, 이 규칙이 막는 문제)를 넣으면 잘 붙는다. 대화에서 기록되는 새 결정은 추출할 때 이런 주제어를 3~8개 뽑는다. 영문 주제어는 단어 단위로 맞춘다(`PR`은 "prompt"에 걸리지 않는다).
- 로그인이 만료되거나 쿼터가 끝난 도구는 잠시 건너뛰고 다른 도구 CLI로 처리한다. 로그인 만료는 해당 CLI를 실행해 다시 로그인하면 된다.
- `.vscode/settings.json`처럼 주석이 있는 JSON 설정 파일은 주석이 지워지지 않게 devctx가 고치지 않는다. 이때 `devctx doctor`와 `devctx code status`가 직접 넣을 항목을 그대로 보여준다(`devctx init`을 다시 해도 해결되지 않는다).
- AI가 코드 인덱스를 안 쓰면 `devctx code status`로 스킬 파일과 허용 설정이 있는지 본다. 도구의 스킬 목록(`/skills` 등)에 `devctx-code`가 보여야 한다. `devctx code index`로 바로 색인할 수 있다.
- 스킬 명령에 승인 창이 뜨면 명령에 파이프나 `&&`가 붙었는지 본다. 붙으면 미리 허용한 명령으로 인식되지 않는다. `.devctx/bin/devctx`에 실행 권한이 있어야 한다(`devctx doctor`가 확인한다).
- 호출 관계가 비어 나오면 동적 호출(리플렉션, 프레임워크가 부르는 핸들러 등)일 수 있다. `search_text`로 사용처를 확인한다. `(by name)` 표시는 이름만 보고 이은 연결이다.

## 제거

```sh
devctx uninstall          # 지울 것만 보여준다
devctx uninstall --yes    # 실제로 지운다 (--keep-history: .devctx/history/는 남긴다)
# 출력된 git add 명령으로 커밋해야 팀원에게도 반영된다
```

지우는 것: 도구별 hook 파일의 devctx 항목(다른 항목은 남기고, devctx 항목만 있던 파일은 삭제), 코드 인덱스 스킬과 미리 허용 항목(사용자 폴더의 Copilot CLI·Kiro 항목 포함), `.git/hooks/*`·`.gitattributes`·`.gitignore`의 devctx 블록, 도구별 `devctx-*` 규칙 파일, AGENTS.md의 devctx 블록(사람이 쓴 내용은 남는다. devctx 내용만 있으면 파일을 지우고 CLAUDE.md의 `@AGENTS.md`도 지운다), `.devctx/`(결정 파일, 설정, 로컬 DB, 프롬프트 히스토리).

남는 것: 이 PC의 공용 데이터 `~/.local/share/devctx/`(개인 선호, 모델 평가, 설치본). 다른 저장소에서 쓰지 않으면 직접 지운다.

## 개발

```sh
npm run typecheck
npm run build
npm run dev -- status   # 빌드 없이 소스로 실행
npm run bench:memory    # 메모리 벤치마크 (LLM 없이: 추출 대상 고르기, 관련 결정 고르기, 만료·대체, 중복 판정, 세션 이어가기 체크포인트, 최근 바뀐 결정, 이전 작업 검색, 검증 사례, 바꿔 말한 질의, 규칙 문장 보류, 두 브랜치 병합, 코드 근거, 프롬프트 히스토리, 안전장치)
npm run bench:codeindex # 언어별 추출 확인 (39개 언어마다 파싱 오류 없음·선언·호출, 파일 사이 해석)
node scripts/vendor-grammars.mjs --build   # vendor/grammars/ 다시 만들기 (tree-sitter CLI 필요, 관리자용)
```

외부 코드와 문법의 라이선스는 [THIRD_PARTY.md](THIRD_PARTY.md)에 있다.

아직 남은 것: npm 배포, Windows 지원, 명령 출력의 언어 통일(새 명령은 `language` 설정을 따르지만 오래된 명령의 기술 정보는 영어로 나온다). 스킬과 명령 미리 허용은 각 도구 문서 기준으로 구현했고, 실제 도구에서 확인한 것은 Codex 명령 규칙(`codex execpolicy check`)뿐이다. Kiro의 작업 공간 권한 폴더 이름(경로의 sha256 앞 16자)은 문서에 없고 이 PC의 Kiro가 만든 폴더로 확인했다. 코드 근거는 이 버전부터 만든 결정 파일에만 기록되고, 그 전 파일은 확인하지 않는다.
