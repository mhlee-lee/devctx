# devctx

**AI와 정한 프로젝트 규칙을 기억하고, 다음 대화에서도 이어서 적용합니다.**

“앞으로 커밋 메시지는 한국어로 써줘”처럼 계속 지킬 규칙을 대화에서 찾아 저장합니다. 다른 AI 도구로 바꾸거나 팀원이 프로젝트를 받아도 같은 규칙을 사용할 수 있습니다.

지원 도구: **Codex · Claude Code · GitHub Copilot · Cursor · Kiro**

## 설치

### 준비할 것

- macOS 또는 Linux
- Node.js 22.13 이상과 Git — Node.js 23을 쓰면 23.4 이상
- 사용할 AI 도구의 터미널용 프로그램(CLI) 설치와 로그인

### 처음 적용하기

1. 터미널에서 **적용할 프로젝트 폴더**를 열고 실행합니다.

   ```sh
   npx @astrixmh/devctx init
   ```

2. AI 도구에서 프로젝트를 신뢰하고, devctx의 **자동 실행(hook)을 허용**합니다. Codex는 `/hooks`에서 승인 상태를 확인할 수 있습니다.
3. `init`이 마지막에 안내하는 `git add` 명령으로 생성된 설정을 커밋합니다. 팀원에게도 이 설정이 전달됩니다.
4. AI 도구에서 **새 대화를 시작해 메시지를 한 번 보낸 뒤**, 상태를 확인합니다.

   ```sh
   .devctx/bin/devctx doctor
   ```

`hook runtime`이 정상이고 `capture`에 최근 실행 시각이 나오면 자동 수집이 시작된 것입니다.

## devctx 업데이트

업데이트할 프로젝트 폴더에서 실행합니다.

| 하고 싶은 일 | 명령 |
|---|---|
| 이 PC에 등록된 모든 프로젝트와 현재 프로젝트 업데이트 | `npx @astrixmh/devctx update` |
| 현재 프로젝트만 업데이트 | `npx @astrixmh/devctx update --root .` |
| 변경 없이 새 버전 유무만 확인 | `npx @astrixmh/devctx update --check` |

`.`는 현재 폴더입니다. 프로젝트의 기존 규칙과 설정은 유지됩니다. 업데이트 후 안내되는 변경 파일을 커밋하면 팀원도 같은 버전을 사용합니다.

**기존 프로젝트의 버전을 올릴 때는 `update`를 사용합니다.** `init`을 다시 실행하면 연결 설정은 갱신하지만 기존에 정한 버전은 유지합니다.

<details>
<summary>예전 설치 경로가 잘못됐거나 특정 버전으로 바꾸려면</summary>

현재 프로젝트를 npm 배포본으로 전환할 수 있습니다. 아래는 `0.1.4`를 지정하는 예입니다.

```sh
npx @astrixmh/devctx update --root . --source @astrixmh/devctx@0.1.4
```

</details>

## 평소에는 이렇게 사용합니다

설정이 끝나면 평소처럼 AI 도구와 대화하면 됩니다.

| 대화 예시 | 처리 |
|---|---|
| “앞으로 커밋 메시지는 한국어로 써줘” | 계속 지킬 규칙으로 기록 |
| “이제 테스트는 Jest 대신 Vitest로 통일해” | 기존 규칙을 새 규칙으로 변경 |
| “이번만 임시로 처리해줘” 또는 단순 질문 | 프로젝트 규칙으로 남기지 않음 |

확실하지 않은 규칙은 **확인 대기**로 남을 수 있습니다. 규칙 분석에는 로그인한 AI 도구의 사용량이 쓰입니다.

## 주요 명령어

아래 명령은 **설치된 프로젝트 폴더에서** 실행합니다. `.devctx/bin/devctx`는 해당 프로젝트가 사용하는 devctx 실행 파일입니다.

| 명령 | 설명 |
|---|---|
| `.devctx/bin/devctx version` | 프로젝트에서 사용하는 버전 확인 |
| `.devctx/bin/devctx status` | 저장된 규칙 목록 확인 |
| `.devctx/bin/devctx doctor` | 설치·연결·자동 수집 상태 점검 |
| `.devctx/bin/devctx remember "규칙"` | 규칙을 직접 저장 |
| `.devctx/bin/devctx log` | 규칙이 추가되거나 바뀐 이유 확인 |
| `.devctx/bin/devctx recall "검색어"` | 이전 요청·작업 기록 검색 |
| `.devctx/bin/devctx why "질문 내용"` | 그 질문에 어떤 규칙이 전달되는지 확인 |
| `.devctx/bin/devctx history on` | 대화 원문과 작업 요약을 파일로 기록하기 시작 |
| `.devctx/bin/devctx history off` | 대화 히스토리 파일 기록 중단 |
| `.devctx/bin/devctx capture off` | 내 대화에서 규칙을 자동 수집하지 않음 |
| `.devctx/bin/devctx capture on` | 규칙 자동 수집 다시 켜기 |

<details>
<summary>규칙 관리와 추가 명령</summary>

`ID`는 `status`나 확인 대기 목록에 표시되는 규칙 번호입니다.

| 명령 | 설명 |
|---|---|
| `.devctx/bin/devctx approve` | 확인 대기 규칙 목록 보기 |
| `.devctx/bin/devctx approve ID` | 선택한 규칙 확정 |
| `.devctx/bin/devctx discard ID` | 확인 대기 규칙 버리기 |
| `.devctx/bin/devctx resolve ID` | 충돌한 규칙 중 선택한 규칙을 남기기 |
| `.devctx/bin/devctx compile` | 저장된 규칙을 AI 도구에 전달할 파일로 다시 만들기 |
| `.devctx/bin/devctx code status` | 코드 검색 기능 상태 확인 |
| `.devctx/bin/devctx code index` | 코드 검색용 정보 갱신 |
| `.devctx/bin/devctx models` | 규칙 분석에 사용하는 AI 모델 확인 |
| `.devctx/bin/devctx worker` | 대기 중인 기록을 지금 처리 |
| `.devctx/bin/devctx purge` | 분석용으로 보관한 대화 원문 삭제 |
| `.devctx/bin/devctx uninstall` | 프로젝트에서 제거할 항목 미리 보기 |
| `.devctx/bin/devctx uninstall --yes` | 프로젝트에서 devctx와 저장된 규칙·기록 제거 |

전체 옵션은 `.devctx/bin/devctx --help`, 명령별 옵션은 `.devctx/bin/devctx history --help`처럼 확인합니다.

</details>

## 규칙 수집과 대화 기록의 차이

- **규칙 자동 수집은 기본 켜짐**입니다. AI가 계속 따라야 할 프로젝트 규칙을 저장합니다.
- **대화 히스토리 파일 기록은 기본 꺼짐**입니다. `history on`으로 켜면 입력한 문장 원문과 작업 요약을 파일로 남깁니다. 이 설정은 PC·프로젝트별로 적용됩니다.
- 히스토리 파일을 커밋하면 팀원도 원문을 볼 수 있습니다. 로컬 분석용 원문은 히스토리 설정과 별개로 이 PC에 보관됩니다.

| 저장 위치 | 내용 |
|---|---|
| `.devctx/knowledge/` | 팀과 공유할 프로젝트 규칙 |
| `.devctx/history/` | 기록 기능을 켰을 때 남기는 대화 히스토리 |
| `.devctx/local/` | 이 PC의 분석용 원문과 실행 기록. Git으로 공유되지 않음 |

## 문제 해결

먼저 프로젝트에서 `.devctx/bin/devctx doctor`를 실행합니다.

| 증상 | 확인할 것 |
|---|---|
| 대화했는데 수집 기록이 없음 | AI 도구의 프로젝트 신뢰·hook 승인 상태를 확인하고 새 대화 시작 |
| 규칙이 저장되지 않음 | `approve`의 확인 대기 목록과 `doctor`의 분석 오류 확인 |
| 히스토리 파일이 생기지 않음 | `history on`으로 파일 기록을 켰는지 확인 |
| 없는 설치 경로 또는 `CLI not found` 오류 | 위 업데이트 안내의 `--source`로 유효한 배포 버전 지정 |

실행 로그는 `.devctx/local/devctx.log`에 있습니다.

## 자세히 알아보기

### 도구별 지원

지원하는 모든 도구에서 규칙을 수집하고 전달합니다. Cursor는 매 질문마다 관련 규칙을 추가하거나 세션을 이어주는 기능이 제한되고, Kiro는 대화 종료 시 자동 커밋을 지원하지 않습니다. [도구별 연결 방식](docs/how-it-works.md#도구별-연결)을 참고하세요.

### 코드 인덱스

AI가 코드의 위치와 관계를 빠르게 찾도록 돕는 검색 기능입니다. `init`이 필요한 스킬과 실행 허용 설정을 함께 준비합니다. 처음 설치할 때 필요 없으면 `npx @astrixmh/devctx init --no-code-index`를 사용합니다. [코드 검색 기능 자세히 보기](docs/how-it-works.md#5-코드-인덱스).

- [처음 사용하는 사람을 위한 안내](docs/getting-started.md): 기록 기준, 저장 위치, 비용, 팀 사용법
- [동작 방식](docs/how-it-works.md): 처리 과정과 개발·검증 자료
- [외부 코드와 문법 라이선스](THIRD_PARTY.md)
