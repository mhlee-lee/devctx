# devctx

AI 코딩 도구와 대화하며 정한 프로젝트 결정을 자동으로 기록하고, 모델·도구·세션이 바뀌어도 같은 규칙으로 일하게 해준다. 결정은 Git에 파일로 남아 clone한 팀원에게도 그대로 적용된다.

지원 도구: Claude Code, Codex (앱·CLI), GitHub Copilot (VS Code·CLI), Cursor, Kiro

동작 방식은 [docs/how-it-works.md](docs/how-it-works.md)에 그림과 함께 정리했다.

## 하는 일

- 대화 중 "앞으로 금액은 BigDecimal로 해" 같은 지시를 결정 파일로 남긴다.
- 정책이 바뀌면 이전 결정을 대체하고, 같은 뜻의 지시는 하나로 합친다.
- 결정을 AGENTS.md와 도구별 규칙 파일로 만들어 모든 도구가 같은 규칙을 읽게 한다.
- 프롬프트마다 관련 결정만 골라 붙여 토큰을 아낀다.
- 한 번 `devctx init`하면 이후는 자동이다.

## 요구 사항

- macOS 또는 Linux (Windows는 아직 지원하지 않는다)
- Node.js 22.13 이상, Git
- 로그인된 AI 도구 CLI 하나 이상: `claude`, `codex`, `copilot`, `cursor-agent`, `kiro-cli`
  - 없어도 동작하지만, 그때는 "앞으로", "항상" 같은 표시가 있는 문장만 확인 대기(proposed)로 남긴다.

## 설치

아직 npm에 배포하지 않아 소스에서 설치한다.

```sh
git clone <이 저장소 URL> dev-context
cd dev-context
npm install   # 의존성 설치와 빌드(prepare)
npm link      # devctx 명령을 전역에 연결
devctx version
```

## 프로젝트에 적용

```sh
cd <내 프로젝트>
devctx init
git add .devctx AGENTS.md .gitattributes .claude .codex .github .cursor .kiro
git commit -m "chore: devctx 설정"
```

`init`이 하는 일:

- `.devctx/`에 설정, 지식 폴더, hook이 부르는 실행 스크립트(`.devctx/bin/devctx`)를 만든다.
- 도구별 hook 파일을 추가한다: `.claude/settings.json`, `.codex/hooks.json`, `.github/hooks/devctx.json`, `.cursor/hooks.json`, `.kiro/hooks/devctx.json`
- 기존 AGENTS.md는 `.devctx/knowledge/preamble.md`로 옮기고, AGENTS.md는 생성 파일이 된다. CLAUDE.md가 있으면 맨 위에 `@AGENTS.md`를 넣는다.
- git hook(pre-commit, post-merge, post-checkout, post-rewrite)에 devctx 블록을 넣는다.

도구마다 처음 한 번 확인할 것:

- Codex: 새 프로젝트 hook을 신뢰할지 묻는다. `/hooks`에서 승인한다.
- Cursor: 신뢰한 워크스페이스에서만 hook이 실행된다.
- 다른 도구도 프로젝트 설정을 신뢰할지 물으면 허용한다.

## 팀원과 공유

팀원은 clone만 하면 된다. hook이 `.devctx/bin/devctx`를 부르고, 이 스크립트가 `.devctx/tools.lock`의 `devctx_source`에서 devctx를 이 PC에 설치한다(첫 호출 때 백그라운드로). git hook은 커밋되지 않지만 첫 AI 세션에서 자동으로 설치된다.

`devctx_source` 기본값은 이 PC의 로컬 경로라 다른 PC에서는 동작하지 않는다. 이 저장소를 원격에 올린 뒤 설치 위치를 지정한다.

```sh
devctx init --source github:<owner>/dev-context#v0.1.0   # 또는 npm 스펙: @scope/devctx@0.1.0
```

`devctx doctor`가 로컬 경로를 쓰고 있으면 알려준다.

## 사용

평소처럼 AI 도구와 대화하면 된다.

| 기록된다 | 기록되지 않는다 |
|---|---|
| "앞으로 ...", "항상 ...", "이 프로젝트에서는 무조건 ..." | "이번만 ...", "일단 ..." |
| AI 작업을 고치는 말: "Double 말고 BigDecimal 써" | 질문, 감사 인사 |
| AI 제안 수락: "응 그렇게 하자. 앞으로 그 형식으로 맞춰" | 붙여넣은 로그·코드 속 문장 |

- 결정은 `.devctx/knowledge/decisions/`에 1건 1파일로 쌓인다. 직접 고치거나 새로 써도 되고, 사람이 쓴 내용이 가장 우선한다.
- "나한테는 짧게 답해줘" 같은 개인 선호는 저장소가 아니라 이 PC(`~/.local/share/devctx/`)에 저장한다.
- 기본 커밋 방식(`ride-along`)에서는 내가 커밋할 때 바뀐 결정 파일이 함께 커밋된다.

## 명령어

| 명령 | 설명 |
|---|---|
| `devctx init [--tools claude,codex,...] [--source <npm\|git>] [--lang ko\|en]` | 저장소에 설치. 다시 실행하면 hook과 실행 스크립트를 갱신한다 |
| `devctx status` | 기록된 결정 목록 |
| `devctx doctor` | 연결 상태 점검 (LLM 호출 없음) |
| `devctx models` | 작업(추출·판정)별로 쓰는 모델, 후보 비용과 평가 결과 |
| `devctx models --qualify <tool> [--task extract\|judge]` | 싼 후보부터 요구사항 평가를 지금 돌린다 |
| `devctx remember "규칙"` | hook이 없는 환경에서 직접 기록 |
| `devctx compile [--check]` | AGENTS.md와 규칙 파일 재생성 (`--check`는 최신인지만 확인) |
| `devctx worker` | 대기 중인 기록을 지금 처리 (보통 hook이 자동 실행) |

## 추출 모델

무조건 싼 모델이 아니라, 요구사항을 전부 통과한 모델 중 가장 싼 모델을 쓴다.

1. 작업 중인 도구의 CLI에서 모델 목록을 가져온다. 모델 × reasoning effort가 각각 후보다.
2. 호출당 예상 비용이 싼 후보부터 요구사항 평가를 돌린다. 추출 25개, 판정 10개 항목을 2회 연속 하나도 틀리지 않아야 통과다.
3. 처음 통과한 후보를 쓴다. 추출과 판정은 따로 고른다.
4. 실제로 쓰다가 요구사항을 두 번 연속 어기면 강등하고 다음 후보로 넘어간다.

새 모델이 나오면 자동으로 후보가 된다. 자세한 기준과 실측 결과는 [동작 방식 4장](docs/how-it-works.md#4-추출-모델-고르기)에 있다.

## 설정

`.devctx/config.yaml` (Git 공유). 자주 바꾸는 항목:

```yaml
language: ko                  # 생성 문서 언어: ko | en
targets: [claude, codex, copilot, cursor, kiro]
git:
  commit_mode: ride-along     # ride-along | auto-commit (세션 종료 시 별도 커밋) | manual
llm:
  prefer_host_tool: true      # 작업 중인 도구의 CLI로 추출
  qualify_runs: 2             # 요구사항 평가 반복 횟수
  max_tier: large             # 자동 선택 상한: small | medium | large
  max_calls_per_hour: 30
  pin: {}                     # 모델 고정 (평가 생략). 예: { codex: gpt-6-luna }
memory:
  personal: true              # 개인 선호는 저장소 밖에 저장
```

## 문제 해결

- 먼저 `devctx doctor`를 실행한다. hook 파일, git hook, 실행 스크립트, 쓸 수 있는 AI CLI, 선택된 모델을 보여준다.
- 로그: `.devctx/local/devctx.log`
- 결정이 쌓이지 않으면 도구에서 프로젝트 hook을 승인했는지 확인한다.
- 로그인이 만료되거나 쿼터가 끝난 도구는 잠시 건너뛰고 다른 도구 CLI로 처리한다. 로그인 만료는 해당 CLI를 실행해 다시 로그인하면 된다.

## 제거

1. 도구별 hook 파일에서 `.devctx/bin/devctx`를 부르는 항목을 지운다.
2. `.git/hooks/*`와 `.gitattributes`에서 `# >>> devctx >>>` ~ `# <<< devctx <<<` 블록을 지운다. CLAUDE.md 맨 위의 `@AGENTS.md`도 지운다.
3. AGENTS.md를 `.devctx/knowledge/preamble.md` 내용으로 되돌리고 `.devctx/`를 지운다.
4. 이 PC의 데이터는 `~/.local/share/devctx/`에 있다.

## 개발

```sh
npm run typecheck
npm run build
npm run dev -- status   # 빌드 없이 소스로 실행
```

아직 남은 것: npm 배포, Windows 지원, Cursor·Kiro 연동은 문서 기준으로만 구현하고 실제 CLI로는 검증하지 못했다.
