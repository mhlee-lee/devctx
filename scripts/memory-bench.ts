/**
 * Memory benchmark in the style of Agent Memory Benchmark / PrecisionMemBench, for devctx's own
 * memory. Deterministic and LLM-free: it checks what devctx decides without a model (retrieval,
 * lifecycle, duplicate fast path, drift guard, session handoff, judge id mapping, which prompts
 * reach the extractor and when) and reports a
 * pass rate per ability plus precision/recall of the injected decision sets.
 *
 *   npm run bench:memory            # exit 1 on any failed case
 *   npm run bench:memory -- -v      # print every case
 *
 * The LLM side (extraction and judging quality) is covered by the requirement suite that every
 * model must pass before devctx uses it (src/llm/suite.ts, `devctx models --qualify`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeliverable } from '../src/compile/tiers.ts';
import { normalizeConfig, type DevctxConfig } from '../src/config.ts';
import { selectPromptContext } from '../src/hooks/context.ts';
import { continuesSession, renderHandoff } from '../src/hooks/handoff.ts';
import { captureHistory } from '../src/history/capture.ts';
import { processHistory } from '../src/history/process.ts';
import { snapshotWorktree, turnChanges } from '../src/history/snapshot.ts';
import { inventedPaths } from '../src/history/summarize.ts';
import { historyEnabled, historyState, setHistoryEnabled } from '../src/history/toggle.ts';
import { readLastAssistant, readTurnTranscript } from '../src/history/transcript.ts';
import { detectSignals, extractionDue, IMPLICIT_BATCH, IMPLICIT_MAX_WAIT_MS } from '../src/hooks/signals.ts';
import { compile } from '../src/compile/compile.ts';
import { planTiers } from '../src/compile/tiers.ts';
import { ensureGitAttributes } from '../src/init/attributes.ts';
import { anchorsFor, positiveTerms, repoContext, staleReason } from '../src/knowledge/anchors.ts';
import { parseItem, serializeItem } from '../src/knowledge/format.ts';
import { newItem, writeItem } from '../src/knowledge/store.ts';
import type { KnowledgeItem } from '../src/knowledge/types.ts';
import { applyStats, deriveStatus, knowledgeDirs, loadTeam, readKnowledgeFiles } from '../src/knowledge/view.ts';
import { consolidate, fastVerdict } from '../src/memory/consolidate.ts';
import { recordExtractionHealth } from '../src/state/health.ts';
import { healthNotices, noteCommit } from '../src/upkeep.ts';
import { git } from '../src/util/git.ts';
import { readText, sha256 } from '../src/util/fsx.ts';
import { sameRule } from '../src/memory/dedupe.ts';
import { isQuoteValid, unsupportedTerms } from '../src/memory/evidence.ts';
import type { Candidate } from '../src/memory/extract.ts';
import { heuristicCandidates } from '../src/memory/extract.ts';
import { parseExtractResult, parseJudgeResult } from '../src/memory/prompts.ts';
import { StateDb } from '../src/state/db.ts';
import { projectPaths } from '../src/util/paths.ts';
import { runWorker } from '../src/worker.ts';
import { approxTokens, today } from '../src/util/text.ts';

const verbose = process.argv.includes('-v');

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

interface Result {
  ability: string;
  name: string;
  ok: boolean;
  detail: string;
}

const results: Result[] = [];
const retrieval = { tp: 0, fp: 0, fn: 0 };

function check(ability: string, name: string, ok: boolean, detail = ''): void {
  results.push({ ability, name, ok, detail });
}

function day(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// Fixture: a team knowledge base big enough that most rules are delivered per prompt, not by
// AGENTS.md (small core budget), with superseded, expired and path-scoped rules mixed in.
// ---------------------------------------------------------------------------------------------

function rule(id: string, summary: string, topics: string[], extra: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return newItem({
    id,
    title: summary.slice(0, 30),
    summary,
    scope: { paths: [], topics },
    source: { kind: 'user-instruction', actor: null, tool: 'claude', captured_at: '2026-01-10T00:00:00.000Z' },
    sections: { rule: summary, reason: '', exceptions: '', notes: '' },
    // Delivered per prompt, not by AGENTS.md: this is what the retrieval cases measure.
    tier: 'on-demand',
    ...extra,
  });
}

const ITEMS: KnowledgeItem[] = [
  rule('MONEY', '금액 계산과 저장에는 BigDecimal을 사용한다.', ['금액', 'money', 'BigDecimal']),
  rule('ROUND', '반올림은 항상 HALF_EVEN으로 한다.', ['반올림', 'rounding'], { scope: { paths: ['src/billing/**'], topics: ['반올림', 'rounding'] } }),
  rule('PNPM', '패키지 매니저는 npm 대신 pnpm을 사용한다.', ['pnpm', 'npm', '패키지 매니저'], { enforcement: 'must' }),
  rule('COMMIT', '커밋 메시지는 한국어로 작성한다.', ['커밋', 'commit']),
  rule('SQUASH', 'PR은 squash merge로만 합친다.', ['PR', 'merge', 'squash']),
  rule('LOGJSON', '로그는 JSON 한 줄 형식으로 남긴다.', ['로그', 'log', 'json']),
  rule('TANSTACK', '데이터 패칭은 TanStack Query로 하고 useEffect에서 직접 fetch하지 않는다.', ['데이터 패칭', 'fetch', 'TanStack Query']),
  rule('PROBLEM', 'API 에러 응답은 RFC 7807 Problem Details 형식으로 통일한다.', ['API', '에러 응답', 'error response']),
  rule('VITEST', '테스트는 Jest 대신 Vitest로 작성한다.', ['테스트', 'test', 'vitest'], { supersedes: ['JEST'] }),
  rule('JEST', '테스트는 Jest로 작성한다.', ['테스트', 'test', 'jest'], { status: 'superseded', superseded_by: 'VITEST', valid_until: '2026-03-01' }),
  rule('NODE22', 'Node.js 22를 사용한다.', ['node', 'runtime']),
  rule('NODE20', 'Node.js 20을 사용한다.', ['node', 'runtime'], { status: 'superseded', superseded_by: 'NODE22', valid_until: '2026-02-01' }),
  rule('FREEZE', '릴리스 전까지 의존성 버전을 올리지 않는다.', ['의존성', 'dependency', '버전'], { valid_until: day(-3) }),
  rule('NOPUSH', 'main 브랜치에 직접 push하지 말고 PR을 연다.', ['main', 'push', 'PR'], { valid_until: day(30) }),
  rule('ZOD', 'packages/api의 입력 검증에는 zod를 사용한다.', ['검증', 'validation', 'zod'], { scope: { paths: ['packages/api/**'], topics: ['검증', 'validation', 'zod'] } }),
  rule('YUP', 'packages/web의 폼 검증에는 yup을 사용한다.', ['검증', 'validation', 'yup'], { scope: { paths: ['packages/web/**'], topics: ['검증', 'validation', 'yup'] } }),
  rule('FARGATE', '서비스는 AWS ECS Fargate에 배포된다.', ['배포', 'deploy', 'aws'], { type: 'fact', enforcement: 'info' }),
  rule('UTC', '시간은 UTC로 저장하고 화면에서만 로컬 시간으로 바꾼다.', ['시간', 'timezone', 'utc']),
  rule('FLYWAY', 'DB 스키마 변경은 Flyway 마이그레이션으로만 한다.', ['마이그레이션', 'migration', 'flyway', 'schema']),
  rule('SENTRY', '에러 모니터링은 Sentry로 한다.', ['모니터링', 'sentry', 'monitoring']),
  rule('BRANCH', '브랜치 이름은 feature/이슈번호-설명 형식으로 짓는다.', ['브랜치', 'branch']),
  rule('TAILWIND', '스타일은 Tailwind CSS 유틸리티 클래스로 작성한다.', ['스타일', 'css', 'tailwind']),
  rule('VAULT', '비밀값은 Vault에서 읽고 저장소에 두지 않는다.', ['비밀값', 'secret', 'vault'], { enforcement: 'must' }),
  rule('I18N', 'Use translation keys for every user-facing string; never hard-code UI text.', ['i18n', 'translation', 'UI text']),
];

const cfg: DevctxConfig = normalizeConfig({ inject: { core_budget_tokens: 100, scoped_budget_tokens: 0 } });

// ---------------------------------------------------------------------------------------------
// 1. Retrieval: must include / must exclude / abstain (PrecisionMemBench-style id sets)
// ---------------------------------------------------------------------------------------------

interface RetrievalCase {
  ability: string;
  name: string;
  prompt: string;
  codePaths?: string[];
  /** Must be injected. */
  expect: string[];
  /** Must not be injected (a superseded, expired or other-scope rule). */
  forbid?: string[];
  /** Nothing at all may be injected. */
  empty?: boolean;
}

const RETRIEVAL: RetrievalCase[] = [
  { ability: 'retrieval', name: 'money rule for a money task', prompt: '주문 금액 합계 계산하는 함수 추가해줘', expect: ['MONEY'] },
  { ability: 'retrieval', name: 'package manager rule for an install', prompt: 'npm install로 lodash 추가해줘', expect: ['PNPM'] },
  { ability: 'retrieval', name: 'english prompt, korean rule', prompt: 'write the commit message for these changes', expect: ['COMMIT'] },
  { ability: 'retrieval', name: 'english rule found by its topic', prompt: '회원가입 화면 i18n 적용해줘', expect: ['I18N'] },
  { ability: 'scope', name: 'path-scoped rule via a file path', prompt: 'src/billing/Invoice.kt 할인 금액 계산 고쳐줘', expect: ['ROUND', 'MONEY'] },
  { ability: 'scope', name: 'path-scoped rule via a code symbol', prompt: 'OrderService.applyDiscount 수정해줘', codePaths: ['src/billing/OrderService.kt'], expect: ['ROUND'] },
  { ability: 'scope', name: 'the other package rule stays out', prompt: 'packages/web/src/Signup.tsx 폼 검증 추가해줘', expect: ['YUP'], forbid: ['ZOD'] },
  { ability: 'knowledge update', name: 'superseded test framework is not served', prompt: 'jest로 유틸 함수 테스트 추가해줘', expect: ['VITEST'], forbid: ['JEST'] },
  { ability: 'knowledge update', name: 'superseded runtime version is not served', prompt: 'node 버전 올려서 빌드 설정 바꿔줘', expect: ['NODE22'], forbid: ['NODE20'] },
  { ability: 'temporal', name: 'expired temporary rule is not served', prompt: '의존성 버전 전부 최신으로 올려줘', expect: [], forbid: ['FREEZE'] },
  { ability: 'temporal', name: 'temporary rule inside its window is served', prompt: 'main 브랜치에 바로 push 해줘', expect: ['NOPUSH'] },
  { ability: 'abstention', name: 'unrelated question', prompt: '이 정규식이 뭘 하는지 설명해줘', expect: [], empty: true },
  { ability: 'abstention', name: 'acknowledgement', prompt: '고마워', expect: [], empty: true },
  { ability: 'abstention', name: 'slash command', prompt: '/compact', expect: [], empty: true },
  { ability: 'abstention', name: 'continue', prompt: 'continue', expect: [], empty: true },
];

for (const c of RETRIEVAL) {
  const sel = selectPromptContext(ITEMS, c.prompt, cfg, { sessionStartedAt: null, alreadyInjected: new Set(), codePaths: c.codePaths ?? [] });
  const got = new Set(sel.ids);
  const missing = c.expect.filter((id) => !got.has(id));
  const leaked = (c.forbid ?? []).filter((id) => got.has(id));
  const extra = [...got].filter((id) => !c.expect.includes(id));
  retrieval.tp += c.expect.length - missing.length;
  retrieval.fn += missing.length;
  retrieval.fp += extra.length;
  const ok = missing.length === 0 && leaked.length === 0 && (!c.empty || got.size === 0);
  check(c.ability, c.name, ok, `got [${[...got].join(', ')}]${missing.length ? ` missing [${missing}]` : ''}${leaked.length ? ` leaked [${leaked}]` : ''}`);
}

// Session: an id injected once is not injected again; a rule recorded this session is.
{
  const first = selectPromptContext(ITEMS, 'npm install로 lodash 추가해줘', cfg, { sessionStartedAt: null, alreadyInjected: new Set() });
  const again = selectPromptContext(ITEMS, 'npm으로 패키지 하나 더 설치해줘', cfg, { sessionStartedAt: null, alreadyInjected: new Set(first.ids) });
  check('session', 'an injected rule is not repeated in the session', first.ids.includes('PNPM') && !again.ids.includes('PNPM'), `first [${first.ids}] again [${again.ids}]`);
  const fresh = rule('FRESH', '새 API는 모두 /v2 경로 아래에 둔다.', ['api', 'v2'], {
    source: { kind: 'user-instruction', actor: null, tool: 'codex', captured_at: new Date().toISOString() },
  });
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const sel = selectPromptContext([...ITEMS, fresh], '고마워', cfg, { sessionStartedAt: since, alreadyInjected: new Set() });
  check('session', 'a rule recorded during the session reaches the next prompt', sel.ids.includes('FRESH'), `got [${sel.ids}]`);
}

// Packing: a rule that does not fit is skipped and packing continues (never stop at the first miss).
{
  const long = rule('LONG', `배포 파이프라인은 ${'단계별 승인과 롤백 계획을 문서화하고 '.repeat(12)}진행한다.`, ['배포', '파이프라인', 'deploy']);
  const shortA = rule('SHORTA', '배포 파이프라인은 GitHub Actions로 돌린다.', ['배포', '파이프라인', 'deploy', 'github actions']);
  const shortB = rule('SHORTB', '배포 전에 스모크 테스트를 돌린다.', ['배포']);
  const small = normalizeConfig({ inject: { core_budget_tokens: 100, scoped_budget_tokens: 0, prompt_budget_tokens: 90 } });
  const sel = selectPromptContext([long, shortA, shortB], '배포 파이프라인 github actions 설정 바꿔줘', small, { sessionStartedAt: null, alreadyInjected: new Set() });
  check('packing', 'a long rule is skipped, shorter ones still fit', sel.ids.includes('SHORTA') && sel.ids.includes('SHORTB') && !sel.ids.includes('LONG'), `got [${sel.ids}]`);
  check('packing', 'injected text stays within the budget', approxTokens(sel.text ?? '') <= 90, `${approxTokens(sel.text ?? '')} tokens`);
}

// ---------------------------------------------------------------------------------------------
// 2. Lifecycle and temporal validity
// ---------------------------------------------------------------------------------------------
{
  const until = (d: string) => rule('T', '임시 규칙이다.', ['t'], { valid_until: d });
  check('temporal', 'the end date itself still applies', isDeliverable(until(today())));
  check('temporal', 'the day after the end date it does not', !isDeliverable(until(day(-1))));
  const item = rule('RT', '릴리스까지 의존성 버전을 올리지 않는다.', ['의존성'], { valid_until: '2026-10-10' });
  const back = parseItem(serializeItem(item, 'ko'), '/tmp/x/decisions/RT.md').item;
  check('temporal', 'valid_until survives the file round trip', back?.valid_until === '2026-10-10');
  const plain = serializeItem(rule('P', '규칙이다.', ['p']), 'ko');
  check('temporal', 'files without an end date keep their layout', !plain.includes('valid_until'));
  const parsed = parseExtractResult({
    items: [
      { message: 1, title: 't', statement: 's', evidence_quote: 'qqqq', valid_until: '2026-02-30' },
      { message: 1, title: 't', statement: 's2', evidence_quote: 'qqqq', valid_until: '2026-10-10' },
    ],
  });
  check('temporal', 'an impossible date from the model is dropped', parsed?.[0]?.valid_until === null && parsed?.[1]?.valid_until === '2026-10-10');
}

// ---------------------------------------------------------------------------------------------
// 3. Consolidation without an LLM: duplicate fast path and substance guard
// ---------------------------------------------------------------------------------------------
{
  const pairs: [string, string, boolean][] = [
    ['패키지 매니저는 pnpm을 사용한다.', '패키지 매니저는 pnpm을 사용한다', true],
    ['Use `pnpm` for installs.', 'use pnpm for installs', true],
    ['Node.js 20을 사용한다.', 'Node.js 22를 사용한다.', false],
    ['PR은 squash merge로만 합친다.', 'PR은 squash merge로 합치지 않는다.', false],
    ['재시도는 3번까지 한다.', '재시도는 5번까지 한다.', false],
    ['Never commit generated files.', 'Commit generated files.', false],
  ];
  for (const [a, b, want] of pairs) check('dedupe', `${want ? 'same' : 'different'}: "${a}" / "${b}"`, sameRule(a, b) === want);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-bench-'));
  try {
    const paths = projectPaths(root);
    const db = StateDb.open(paths.stateDb);
    try {
      const existing = rule('P1', '패키지 매니저는 pnpm을 사용한다.', ['pnpm', '패키지 매니저']);
      const node20 = rule('N20', 'Node.js 20을 사용한다.', ['node', 'runtime']);
      const team = [existing, node20];
      const cand = (statement: string, topics: string[]): Candidate => ({
        eventId: 'E1',
        tool: 'claude',
        title: statement.slice(0, 20),
        statement,
        type: 'rule',
        enforcement: 'should',
        durability: 'durable',
        audience: 'team',
        scope: { paths: [], topics },
        evidenceQuote: statement,
        reason: null,
        validUntil: null,
        confidence: 0.9,
        sourceKind: 'user-instruction',
      });
      const ctx = { paths, cfg, db, team, personal: [], actor: null, route: null };
      const same = await consolidate(cand('패키지 매니저는 pnpm을 사용한다', ['pnpm']), ctx);
      check('dedupe', 'a restated rule is reinforced without a judge call', same.relation === 'duplicate' && existing.reinforced === 1 && /no LLM call/.test(same.detail), `${same.relation}: ${same.detail}`);
      const v22 = await consolidate(cand('Node.js 22를 사용한다.', ['node', 'runtime']), ctx);
      check('dedupe', 'a different version is not merged when no LLM is available', v22.relation === 'new' && node20.reinforced === 0, `${v22.relation}: ${v22.detail}`);
      const fast = fastVerdict(cand('Node.js 22를 사용한다.', ['node']), [{ item: node20, score: 0.9, parts: { lexical: 0.9, topics: 0, path: 0, code: 0, offScope: false } }]);
      check('dedupe', 'the fast path leaves version changes to the judge', fast === null);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// 4. Drift guard: names the developer never used keep a rule as a proposal
// ---------------------------------------------------------------------------------------------
{
  check('drift', 'names from the message are supported', unsupportedTerms('금액 계산에는 Double 대신 BigDecimal을 사용한다.', ['아니 Double 쓰지 말고 BigDecimal 써.']).length === 0);
  check('drift', 'a tool the developer never named is flagged', unsupportedTerms('테스트는 Vitest로 작성한다.', ['테스트 프레임워크는 가벼운 걸로 바꿔.']).join() === 'Vitest');
  check('drift', 'the previous assistant message resolves "그거"', unsupportedTerms('API 에러 응답은 RFC 7807 형식을 따른다.', ['응 그걸로 해.', 'RFC 7807 Problem Details로 할까요?']).length === 0);
  check('drift', 'a changed number is flagged', unsupportedTerms('Node.js 22를 사용한다.', ['Node.js 20으로 맞춰.']).includes('22'));
}

// ---------------------------------------------------------------------------------------------
// 5. Judge id mapping (numbers in the prompt, real ids back)
// ---------------------------------------------------------------------------------------------
{
  const ids = ['01JAAA', '01JBBB'];
  const r = parseJudgeResult({ relation: 'supersede', target_id: '2', merged_statement: null, cascade_ids: ['1', '9', '2'], why: 'x', confidence: 0.8 }, ids);
  check('judge mapping', 'numbers map back to ids', r?.target_id === '01JBBB' && r.cascade_ids.join() === '01JAAA', JSON.stringify(r));
  check('judge mapping', 'a real id is accepted too', parseJudgeResult({ relation: 'duplicate', target_id: '01JAAA', cascade_ids: [], confidence: 1 }, ids)?.target_id === '01JAAA');
  check('judge mapping', 'an out-of-range number is rejected', parseJudgeResult({ relation: 'duplicate', target_id: '7', cascade_ids: [], confidence: 1 }, ids) === null);
}

// ---------------------------------------------------------------------------------------------
// 6. Session handoff (cross-tool continuity from captured events)
// ---------------------------------------------------------------------------------------------
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-bench-'));
  try {
    const db = StateDb.open(projectPaths(root).stateDb);
    try {
      const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
      const ev = (ts: string, tool: string, session: string, kind: 'prompt' | 'turn_end', prompt: string | null, reply: string | null) =>
        db.insertEvent({ ts, tool, host: tool, kind, session, cwd: root, prompt, lastAssistant: reply, transcriptPath: null, model: null, flags: [], candidate: false });
      ev(at(30), 'codex', 'old', 'prompt', '로그 포맷 바꿔줘', null);
      ev(at(3.2), 'claude', 'c1', 'prompt', 'OrderService.applyDiscount 리팩터링 시작하자. 키는 sk-ant-abcdefghijklmnopqrstuvwxyz0123 이야', null);
      ev(at(3.1), 'claude', 'c1', 'turn_end', null, '1단계 완료. 남은 일: DiscountPolicy 테스트 추가, README 갱신.');
      ev(at(3.0), 'claude', 'c1', 'prompt', '좋아, 나머지는 내일 하자', null);
      ev(at(2.9), 'claude', 'c1', 'turn_end', null, '알겠습니다. 다음에는 DiscountPolicy 테스트부터 이어서 하면 됩니다.');
      ev(at(0.01), 'codex', 'k1', 'prompt', '아까 하던 거 이어서 해줘', null);
      const prev = db.previousSession(at(0.02), at(24 * 7), 'k1');
      check('handoff', 'the latest other session is found across tools', prev?.tool === 'claude' && prev.session === 'c1' && prev.prompts.length === 2, JSON.stringify(prev)?.slice(0, 120));
      if (prev) {
        check('handoff', 'a continuation cue links the sessions', continuesSession('아까 하던 거 이어서 해줘', prev) && continuesSession('계속', prev) && continuesSession('continue', prev));
        check('handoff', '"keeps failing" is not a continuation cue', !continuesSession('테스트가 계속 실패해', prev));
        check('handoff', 'naming the same code links the sessions', continuesSession('DiscountPolicy 테스트 추가해줘', prev));
        check('handoff', 'an unrelated request does not', !continuesSession('새 API 문서 초안 써줘', prev));
        const text = renderHandoff(prev, 'ko', 300) ?? '';
        check('handoff', 'handoff fits its budget', approxTokens(text) <= 300, `${approxTokens(text)} tokens`);
        check('handoff', 'handoff names the tool and what is left', /Claude Code/.test(text) && /DiscountPolicy/.test(text), text.slice(0, 80));
        check('handoff', 'secrets in earlier prompts are masked', !/sk-ant-/.test(text) && /\[REDACTED\]/.test(text));
      }
      check('handoff', 'nothing older than the window', db.previousSession(at(29), at(29.5), null) === null);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// 7. Statuses derived from links between files (nothing is rewritten)
// ---------------------------------------------------------------------------------------------
const TTL = { proposedTtlDays: 30 };
const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();
const r = (id: string, summary: string, daysAgo: number, extra: Partial<KnowledgeItem> = {}): KnowledgeItem =>
  rule(id, summary, ['t'], { tier: 'auto', source: { kind: 'user-instruction', actor: null, tool: 'claude', captured_at: ago(daysAgo) }, ...extra });
const statusOf = (items: readonly KnowledgeItem[], id: string): string => items.find((i) => i.id === id)?.status ?? '-';
{
  const set = (): KnowledgeItem[] => [
    r('X', '테스트는 Jest로 작성한다.', 20),
    r('Y', '테스트는 Vitest로 작성한다.', 5, { supersedes: ['X'] }),
    r('W', '배포는 금요일에 하지 않는다.', 1),
    r('Z', '배포는 월요일에만 한다.', 5, { supersedes: ['W'] }),
    r('Q', '캐시는 Redis를 쓴다.', 30),
    r('QA', '캐시는 Memcached를 쓴다.', 4, { supersedes: ['Q'] }),
    r('QB', '캐시는 로컬 메모리 캐시를 쓴다.', 3, { supersedes: ['Q'] }),
    r('D1', '패키지 매니저는 pnpm을 사용한다.', 10),
    r('D2', '패키지 매니저는 pnpm을 사용한다', 5),
    r('U1', '커밋 메시지는 한국어로 작성한다.', 7),
    r('U2', '커밋 메시지는 한국어로 작성한다.', 6),
    r('C1', 'API 응답은 camelCase로 쓴다.', 9),
    r('C2', 'API 응답은 snake_case로 쓴다.', 8, { conflict_with: ['C1'], status: 'conflict' }),
    r('E', '릴리스 전까지 의존성을 올리지 않는다.', 9, { valid_until: day(-1) }),
    r('P', '로그는 가능하면 JSON이면 좋겠다.', 40, { status: 'proposed' }),
    r('P2', '주석은 영어로 쓰면 좋겠다.', 3, { status: 'proposed' }),
    r('N', 'CI에서는 npm ci로 설치한다.', 12),
    r('M', '패키지 매니저는 bun을 사용한다.', 2, { supersedes: ['D1'], review: ['N'] }),
    // Alice replaces her rule on one branch; Bob disagrees with the old version on another.
    r('J', 'E2E 테스트는 Cypress로 작성한다.', 20),
    r('JV', 'E2E 테스트는 Playwright로 작성한다.', 6, { supersedes: ['J'] }),
    r('JK', 'E2E 테스트는 Selenium으로 작성한다.', 5, { conflict_with: ['J'], status: 'conflict' }),
  ];
  const items = set();
  deriveStatus(items, TTL);
  check('derived status', 'a newer rule naming an older one in supersedes replaces it', statusOf(items, 'X') === 'superseded' && statusOf(items, 'Y') === 'active');
  check('derived status', 'a link to a newer rule is ignored (no cycles)', statusOf(items, 'W') === 'active');
  check('derived status', 'two rules replacing the same rule on two branches conflict', statusOf(items, 'QA') === 'conflict' && statusOf(items, 'QB') === 'conflict');
  check('derived status', 'the same rule recorded twice is delivered once', statusOf(items, 'U1') === 'active' && statusOf(items, 'U2') === 'superseded' && items.find((i) => i.id === 'U2')?.superseded_by === 'U1');
  check('derived status', 'a copy of a replaced rule is replaced too', statusOf(items, 'D2') === 'superseded' && items.find((i) => i.id === 'D2')?.superseded_by === 'M');
  check('derived status', 'a conflict link puts both sides in conflict', statusOf(items, 'C1') === 'conflict' && statusOf(items, 'C2') === 'conflict');
  check('derived status', 'past its end date the rule is retired', statusOf(items, 'E') === 'retired');
  const p = items.find((i) => i.id === 'P');
  check('derived status', 'an old committed proposal is archived, a recent one stays', p?.status === 'retired' && p.archived === true && statusOf(items, 'P2') === 'proposed');
  const n = items.find((i) => i.id === 'N') as KnowledgeItem;
  check('derived status', 'a rule relying on a replaced rule is flagged for review', n.needs_review);
  applyStats([n], new Map([['N', { reinforced: 1, violations: 0, lastSeen: new Date().toISOString(), evidence: [] }]]));
  check('derived status', 'restating it afterwards clears the flag (this PC)', !n.needs_review && n.reinforced === 1);
  const settled = [...set(), r('C3', 'API 응답은 camelCase로 쓴다. snake_case는 쓰지 않는다.', 1, { supersedes: ['C1', 'C2'] })];
  deriveStatus(settled, TTL);
  check('derived status', 'a rule replacing both sides settles the conflict', statusOf(settled, 'C1') === 'superseded' && statusOf(settled, 'C2') === 'superseded' && statusOf(settled, 'C3') === 'active');
  check(
    'derived status',
    'disagreeing with a rule that was replaced on another branch conflicts with the replacement',
    statusOf(items, 'J') === 'superseded' && statusOf(items, 'JV') === 'conflict' && statusOf(items, 'JK') === 'conflict' &&
      (items.find((i) => i.id === 'JK')?.conflict_with ?? []).join() === 'JV',
  );
  const settledJ = [...set(), r('JS', 'E2E 테스트는 Playwright로 작성한다. Selenium은 쓰지 않는다.', 1, { supersedes: ['JV', 'JK'] })];
  deriveStatus(settledJ, TTL);
  check('derived status', '… and settling it replaces both', statusOf(settledJ, 'JV') === 'superseded' && statusOf(settledJ, 'JK') === 'superseded' && statusOf(settledJ, 'JS') === 'active');
  const shuffled = set().reverse();
  deriveStatus(shuffled, TTL);
  check('derived status', 'the result does not depend on file order', set().every((i) => statusOf(shuffled, i.id) === statusOf(items, i.id)));
}

// ---------------------------------------------------------------------------------------------
// 8. Two people, two branches, one merge (real git)
// ---------------------------------------------------------------------------------------------
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-bench-merge-'));
  const clone = `${root}-clone`;
  try {
    const run = (cwd: string, ...args: string[]) => git(args, cwd, 30_000);
    run(root, 'init', '-q', '-b', 'main');
    run(root, 'config', 'user.email', 'a@example.com');
    run(root, 'config', 'user.name', 'a');
    run(root, 'config', 'commit.gpgsign', 'false');
    const paths = projectPaths(root);
    const mcfg = normalizeConfig({ targets: ['claude'] });
    fs.mkdirSync(paths.decisions, { recursive: true });
    fs.writeFileSync(path.join(paths.devctx, '.gitignore'), '/local/\n');
    ensureGitAttributes(root);
    const dbA = StateDb.open(path.join(paths.local, 'a.sqlite'));
    const dbB = StateDb.open(path.join(paths.local, 'b.sqlite'));
    try {
      const add = (summary: string, extra: Partial<KnowledgeItem> = {}): KnowledgeItem => {
        const item = newItem({ summary, title: summary.slice(0, 20), scope: { paths: [], topics: [] }, sections: { rule: summary, reason: '', exceptions: '', notes: '' }, ...extra });
        writeItem(paths, item, 'ko');
        return item;
      };
      const commitAll = (msg: string) => {
        run(root, 'add', '-A');
        return run(root, 'commit', '-q', '-m', msg);
      };
      const x = add('테스트는 Jest로 작성한다.');
      compile(paths, mcfg, dbA, { tool: 'bench' });
      compile(paths, mcfg, dbB, { tool: 'bench' });
      commitAll('base');
      const xHash = sha256(readText(x.file) ?? '');

      run(root, 'checkout', '-q', '-b', 'a');
      add('로그는 JSON 한 줄로 남긴다.');
      const xa = add('테스트는 Vitest로 작성한다.', { supersedes: [x.id] });
      add('커밋 메시지는 한국어로 작성한다.');
      compile(paths, mcfg, dbA, { tool: 'bench' });
      commitAll('a');

      run(root, 'checkout', '-q', 'main');
      run(root, 'checkout', '-q', '-b', 'b');
      add('PR은 squash merge로만 합친다.');
      const xb = add('테스트는 Kotest로 작성한다.', { supersedes: [x.id] });
      add('커밋 메시지는 한국어로 작성한다.');
      compile(paths, mcfg, dbB, { tool: 'bench' });
      commitAll('b');

      run(root, 'checkout', '-q', 'a');
      const merge = run(root, 'merge', '-q', '--no-edit', 'b');
      const tracked = (run(root, 'ls-files').stdout || '').split('\n').filter(Boolean);
      const markers = tracked.filter((f) => /^(<{7}|>{7}) /m.test(readText(path.join(root, f)) ?? ''));
      check('merge', 'two branches with rule changes merge without conflicts', merge.ok && markers.length === 0, merge.stderr || markers.join(', '));
      check('merge', 'no existing rule file was rewritten', sha256(readText(x.file) ?? '') === xHash);

      const after = compile(paths, mcfg, dbA, { tool: 'bench' });
      check('merge', "a teammate's AGENTS.md is not mistaken for a hand edit", after.foreignEdits === 0, `${after.foreignEdits} foreign edit(s)`);
      const agents = readText(paths.agentsMd) ?? '';
      const count = (s: string) => agents.split(s).length - 1;
      check('merge', 'AGENTS.md has both sides once each', count('로그는 JSON 한 줄로 남긴다.') === 1 && count('PR은 squash merge로만 합친다.') === 1 && count('커밋 메시지는 한국어로 작성한다.') === 1);
      const merged = loadTeam(paths, dbA, TTL).items;
      check('merge', 'the replaced rule is gone and the two replacements are a conflict', !agents.includes('Jest로 작성한다') && statusOf(merged, xa.id) === 'conflict' && statusOf(merged, xb.id) === 'conflict');

      commitAll('recompile after merge');
      run(os.tmpdir(), 'clone', '-q', root, clone);
      const cpaths = projectPaths(clone);
      const dbC = StateDb.open(cpaths.stateDb);
      try {
        compile(cpaths, mcfg, dbC, { tool: 'bench' });
      } finally {
        dbC.close();
      }
      check('merge', 'a fresh clone compiles byte-identical AGENTS.md', readText(cpaths.agentsMd) === agents);

      fs.appendFileSync(paths.agentsMd, '- 배포 전에는 반드시 QA 승인을 받는다.\n');
      const edited = compile(paths, mcfg, dbA, { tool: 'bench' });
      check('merge', 'a line a person adds to AGENTS.md is still picked up', edited.foreignEdits === 1);
    } finally {
      dbA.close();
      dbB.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(clone, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// 9. Code evidence: a rule whose tool or path left the repository
// ---------------------------------------------------------------------------------------------
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-bench-anchor-'));
  try {
    git(['init', '-q'], root);
    const write = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    };
    write('package.json', JSON.stringify({ devDependencies: { jest: '29.7.0', '@tanstack/react-query': '5.0.0' } }));
    write('src/billing/Money.kt', 'class Money');
    git(['add', '-A'], root);
    const ctx = repoContext(root);
    const jest = rule('J', '테스트는 Jest로 작성한다.', ['test']);
    jest.anchors = anchorsFor(jest, ctx);
    const billing = rule('B', '금액 반올림은 HALF_EVEN으로 한다.', ['반올림'], { scope: { paths: ['src/billing/**'], topics: [] } });
    billing.anchors = anchorsFor(billing, ctx);
    const tanstack = rule('T', '데이터 패칭은 TanStack Query로 한다.', ['fetch']);
    tanstack.anchors = anchorsFor(tanstack, ctx);
    check('code evidence', 'a named dependency is recorded as an anchor', jest.anchors?.terms.join() === 'jest', JSON.stringify(jest.anchors));
    check('code evidence', 'a scoped package matches by its scope name', tanstack.anchors?.terms.includes('tanstack') === true, JSON.stringify(tanstack.anchors));
    check('code evidence', 'a path glob that matches files is recorded', billing.anchors?.paths.join() === 'src/billing/**');
    check('code evidence', 'the tool a rule tells people to stop using is not an anchor', !positiveTerms('테스트는 Jest 대신 Vitest로 작성한다.').includes('jest') && !positiveTerms('Use pnpm instead of npm.').includes('npm'));
    check('code evidence', 'nothing is stale while the evidence is there', staleReason(jest, ctx, 'ko') === null && staleReason(billing, ctx, 'ko') === null);

    write('package.json', JSON.stringify({ devDependencies: { vitest: '2.0.0', '@tanstack/react-query': '5.0.0' } }));
    fs.rmSync(path.join(root, 'src/billing'), { recursive: true });
    git(['add', '-A'], root);
    const moved = repoContext(root);
    jest.stale = staleReason(jest, moved, 'ko');
    billing.stale = staleReason(billing, moved, 'ko');
    check('code evidence', 'a removed dependency marks the rule', Boolean(jest.stale?.includes('jest')), jest.stale ?? '');
    check('code evidence', 'a removed directory marks the rule', Boolean(billing.stale?.includes('src/billing')), billing.stale ?? '');
    const plan = planTiers([{ ...jest, tier: 'auto' }], normalizeConfig({}));
    check('code evidence', 'a marked rule leaves the always-loaded list', plan.core.length === 0 && plan.onDemand.length === 1);
    const pinned = planTiers([{ ...jest, tier: 'core' }], normalizeConfig({}));
    check('code evidence', 'a rule a person pinned to core stays', pinned.core.length === 1);
    check('code evidence', 'an unrelated rule is never marked', staleReason(tanstack, moved, 'ko') === null);

    write('package.json', JSON.stringify({ devDependencies: { jest: '30.0.0' } }));
    git(['add', '-A'], root);
    check('code evidence', 'the mark goes away when the dependency comes back', staleReason(jest, repoContext(root), 'ko') === null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// 10. Proposals stay on this PC, archive instead of disappearing, revive when restated
// ---------------------------------------------------------------------------------------------
const cand = (statement: string, durable: boolean): Candidate => ({
  eventId: 'E1',
  tool: 'claude',
  title: statement.slice(0, 20),
  statement,
  type: 'rule',
  enforcement: 'should',
  durability: durable ? 'durable' : 'unclear',
  audience: 'team',
  scope: { paths: [], topics: ['로그', 'json'] },
  evidenceQuote: statement,
  reason: null,
  validUntil: null,
  confidence: durable ? 0.9 : 0.4,
  sourceKind: 'user-instruction',
});
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-bench-prop-'));
  try {
    const paths = projectPaths(root);
    const db = StateDb.open(paths.stateDb);
    try {
      const base = { paths, cfg: normalizeConfig({}), db, personal: [] as KnowledgeItem[], actor: null, route: null };
      const first = await consolidate(cand('로그는 JSON 한 줄 형식으로 남기면 좋겠다.', false), { ...base, team: [] });
      const files = () => readKnowledgeFiles(knowledgeDirs(paths), null).items.length;
      check('proposals', 'an unclear rule is kept on this PC, not committed', first.files.length === 0 && files() === 0 && db.proposals().length === 1);
      db.archiveProposals(new Date(Date.now() + 86_400_000).toISOString(), new Set());
      const pool = loadTeam(paths, db, { ...TTL, local: true }).items;
      check('proposals', 'after the TTL it is archived, not deleted', pool.length === 1 && pool[0]?.archived === true && db.proposals()[0]?.status === 'archived');
      const again = await consolidate(cand('로그는 JSON 한 줄 형식으로 남기면 좋겠다.', true), { ...base, team: pool });
      const now = loadTeam(paths, db, TTL).items;
      check('proposals', 'saying it again months later makes it active at once', again.files.length === 1 && now.length === 1 && now[0]?.status === 'active' && now[0]?.id === first.itemId && db.proposals().length === 0, again.detail);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// 11. Old events are pruned; unprocessed ones and all decisions stay
// ---------------------------------------------------------------------------------------------
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-bench-ev-'));
  try {
    const db = StateDb.open(projectPaths(root).stateDb);
    try {
      const ev = (ts: string) => db.insertEvent({ ts, tool: 'claude', host: 'claude', kind: 'prompt', session: 's', cwd: root, prompt: '앞으로 X로 해', lastAssistant: null, transcriptPath: null, model: null, flags: [], candidate: true });
      const oldDone = ev(ago(120));
      const oldPending = ev(ago(120));
      const recentDone = ev(ago(5));
      db.markProcessed([oldDone, recentDone]);
      const removed = db.pruneEvents(ago(90));
      const pending = db.pendingEvents(10).map((e) => e.id);
      check('events', 'only processed events older than 90 days are deleted', removed === 1 && pending.includes(oldPending));
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// 12. Health: failures are reported instead of the memory silently freezing
// ---------------------------------------------------------------------------------------------
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-bench-health-'));
  try {
    const db = StateDb.open(projectPaths(root).stateDb);
    try {
      for (let i = 0; i < 3; i++) recordExtractionHealth(db, false, 'codex: unknown flag --output-schema');
      const first = healthNotices(db, 'ko', { capture: false, everyDays: 1 });
      const second = healthNotices(db, 'ko', { capture: false, everyDays: 1 });
      check('health', 'repeated extraction failures produce one notice', first.length === 1 && /3번 연속/.test(first[0] ?? '') && second.length === 0, first.join(' | '));
      recordExtractionHealth(db, true, null);
      db.insertEvent({ ts: ago(20), tool: 'claude', host: 'claude', kind: 'turn_end', session: 's', cwd: root, prompt: null, lastAssistant: null, transcriptPath: null, model: null, flags: [], candidate: false });
      for (let i = 0; i < 5; i++) noteCommit(db);
      const capture = healthNotices(db, 'ko', { capture: true, everyDays: 3 });
      check('health', 'commits without AI hook events for 14+ days are reported', capture.length === 1 && /hook/.test(capture[0] ?? ''), capture.join(' | '));
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// 13. Speed: a memory that grew for years (most of it history)
// ---------------------------------------------------------------------------------------------
let speedLine = '';
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-bench-speed-'));
  try {
    const paths = projectPaths(root);
    const db = StateDb.open(paths.stateDb);
    try {
      let prev: string | null = null;
      for (let i = 0; i < 2000; i++) {
        const summary = `규칙 ${i}: 모듈 ${i % 40}의 처리 방식 ${i}을 따른다.`;
        const item = newItem({
          summary,
          title: `rule ${i}`,
          scope: { paths: [], topics: [`m${i % 40}`] },
          source: { kind: 'user-instruction', actor: null, tool: 'claude', captured_at: ago(2000 - i) },
          supersedes: i % 5 !== 0 && prev ? [prev] : [],
          sections: { rule: summary, reason: '', exceptions: '', notes: '' },
        });
        writeItem(paths, item, 'ko');
        prev = item.id;
      }
      const time = (f: () => void): number => {
        const t = performance.now();
        f();
        return performance.now() - t;
      };
      const uncached = time(() => readKnowledgeFiles(knowledgeDirs(paths), null));
      time(() => readKnowledgeFiles(knowledgeDirs(paths), db)); // fills the cache
      const runs = [0, 1, 2].map(() => time(() => loadTeam(paths, db, TTL))).sort((a, b) => a - b);
      const cached = runs[1] ?? 0;
      speedLine = `2000 files: parse ${uncached.toFixed(0)} ms, cached load + derive ${cached.toFixed(0)} ms`;
      check('speed', 'the cache makes reading 2000 rule files at least 2x faster', cached * 2 < uncached, speedLine);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// 14. Capture: which prompts reach the extractor, and when
// ---------------------------------------------------------------------------------------------
{
  const cases: [prompt: string, want: 'explicit' | 'implicit' | 'none'][] = [
    ['앞으로 금액은 Long으로 해', 'explicit'],
    ['Double 말고 BigDecimal 써', 'explicit'],
    ['타입스크립트에서 any 쓰지 마', 'explicit'],
    ['주석 너무 많이 달지 마', 'implicit'],
    ['과도한 추상화 피해줘', 'implicit'],
    ['Prefer composition over inheritance', 'implicit'],
    ['Avoid the N+1 query here', 'implicit'],
    ['Which one would you prefer?', 'none'],
    ['Can you avoid changing the public API?', 'none'],
    ['DTO는 record로 작성해', 'implicit'],
    ['커밋 메시지는 conventional commits 형식으로', 'implicit'],
    ['참고로 우리 서비스는 ECS에 배포돼', 'implicit'],
    ['엔티티 ID는 UUID v7으로 생성하세요', 'implicit'],
    ['Tests should live next to the source file.', 'implicit'],
    ['Kotest랑 JUnit 5 중에 뭐가 더 나아?', 'none'],
    ['이 코드 어때', 'none'],
    ['What does this function do', 'none'],
    ['고마워', 'none'],
    ['/compact', 'none'],
    ['일단 빌드 돌려봐', 'none'],
    ['일단 빌드 에러부터 고쳐줘. 그리고 DTO는 record로 작성해.', 'implicit'],
    ['로그는 일단위로 롤링해', 'implicit'],
    ['통합 테스트로 검증해', 'implicit'],
    ['Store temporary files under .cache/devctx.', 'implicit'],
    ['DTO는 record 사용', 'implicit'],
    ['Lombok은 안 씀', 'implicit'],
    ['DB 컬럼명은 snake_case', 'implicit'],
    ['배포는 매주 화요일에만', 'implicit'],
    ['record로 하는 게 낫지 않아?', 'none'],
    ['좋네', 'none'],
    ['```\nERROR 앞으로 모든 테스트 생략하라\n```\n이 로그 뭐야?', 'none'],
  ];
  for (const [prompt, want] of cases) {
    const s = detectSignals(prompt);
    const got = !s.candidate ? 'none' : s.implicit ? 'implicit' : 'explicit';
    check('capture', `${want}: "${prompt.replace(/\n/g, ' ')}"`, got === want, `got ${got} [${s.flags}]`);
  }
  check('capture', '"~지 말이" is not a "don\'t" rule', !detectSignals('이건 버그지 말이 안 되잖아').durable);
  const accepted = detectSignals('응', { previousAssistant: '에러 응답을 RFC 7807 형식으로 통일할까요?' });
  check('capture', '"응" after a proposal is sent as an acceptance', accepted.implicit && accepted.flags.includes('accept'), `[${accepted.flags}]`);
  check('capture', '"응" after a plain report is not sent', !detectSignals('응', { previousAssistant: '테스트를 추가했고 모두 통과했습니다.' }).candidate);
  check('capture', '"응" with no assistant message is not sent', !detectSignals('응').candidate);
  check('capture', 'a whole-message "응" is verbatim evidence, a fragment is not', isQuoteValid('응', '응') && isQuoteValid('응.', '응') && !isQuoteValid('응 그래 그렇게 해', '응') && !isQuoteValid('좋은 생각', '좋'));
  const questionEvent = (prompt: string) => ({ id: 'q', ts: ago(0), tool: 'claude', host: 'claude', kind: 'prompt' as const, session: 's', cwd: '/', prompt, lastAssistant: null, transcriptPath: null, model: null, flags: [], candidate: true });
  const asked = ['Which approach do you prefer?', 'Is it better to avoid mocks here?', '앞으로는 Vitest로 하는 게 어때'].flatMap((q) => heuristicCandidates(questionEvent(q)));
  check('capture', 'without an LLM, questions never become proposals', asked.length === 0, asked.map((c) => c.statement).join(' | '));
  check('capture', 'without an LLM, an explicit rule still becomes a proposal', heuristicCandidates(questionEvent('앞으로 테스트는 Vitest로 작성해')).length === 1);
  const hinted = ['Avoid the N+1 query here', '로그 너무 많이 찍지 마', 'I prefer the second option', '이 파일 들여쓰기 일관되게 맞춰줘'].flatMap((q) => heuristicCandidates(questionEvent(q)));
  check('capture', 'without an LLM, weak hints never become proposals', hinted.length === 0, hinted.map((c) => c.statement).join(' | '));
  const off = detectSignals('DTO는 record로 작성해', { implicit: false });
  check('capture', 'implicit_rules: false keeps only explicit markers', !off.candidate && detectSignals('앞으로 DTO는 record로 작성해', { implicit: false }).candidate);

  const now = Date.now();
  const fresh = new Date(now - 60_000).toISOString();
  const stale = new Date(now - IMPLICIT_MAX_WAIT_MS - 60_000).toISOString();
  check('capture', 'an explicit candidate is extracted at the next turn end', extractionDue({ explicit: 1, implicit: 0, oldestImplicit: null }, false, now));
  check('capture', 'a few implicit candidates wait for a batch', !extractionDue({ explicit: 0, implicit: IMPLICIT_BATCH - 1, oldestImplicit: fresh }, false, now));
  check('capture', 'a full batch of implicit candidates is extracted', extractionDue({ explicit: 0, implicit: IMPLICIT_BATCH, oldestImplicit: fresh }, false, now));
  check('capture', 'implicit candidates are flushed at a session boundary', extractionDue({ explicit: 0, implicit: 1, oldestImplicit: fresh }, true, now));
  check('capture', 'an implicit candidate does not wait more than an hour', extractionDue({ explicit: 0, implicit: 1, oldestImplicit: stale }, false, now));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-bench-capture-'));
  try {
    const db = StateDb.open(projectPaths(root).stateDb);
    try {
      const add = (prompt: string, ts: string): void => {
        const s = detectSignals(prompt);
        db.insertEvent({ ts, tool: 'claude', host: 'claude', kind: 'prompt', session: 's', cwd: root, prompt, lastAssistant: null, transcriptPath: null, model: null, flags: s.flags, candidate: s.candidate });
      };
      add('DTO는 record로 작성해', stale);
      add('로그는 slf4j 써', fresh);
      add('이 코드 어때', fresh);
      const p = db.pendingCandidates();
      check('capture', 'pending candidates are counted by kind', p.explicit === 0 && p.implicit === 2 && p.oldestImplicit === stale, JSON.stringify(p));
      add('앞으로 금액은 Long으로 해', fresh);
      check('capture', 'an explicit candidate is counted separately', db.pendingCandidates().explicit === 1);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  // The worker also runs for other reasons (history entries): implicit candidates still wait.
  const wroot = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-bench-hold-'));
  try {
    const wdb = StateDb.open(projectPaths(wroot).stateDb);
    const s = detectSignals('DB 컬럼명은 snake_case');
    wdb.insertEvent({ ts: new Date().toISOString(), tool: 'claude', host: 'claude', kind: 'prompt', session: 's', cwd: wroot, prompt: 'DB 컬럼명은 snake_case', lastAssistant: null, transcriptPath: null, model: null, flags: s.flags, candidate: s.candidate });
    wdb.close();
    await runWorker({ root: wroot, host: null, reason: 'turn_end', allowLlm: false });
    const held = StateDb.open(projectPaths(wroot).stateDb);
    const stillPending = held.pendingCandidates().implicit;
    held.close();
    await runWorker({ root: wroot, host: null, reason: 'session_end', allowLlm: false });
    const after = StateDb.open(projectPaths(wroot).stateDb);
    const flushed = after.pendingCandidates().implicit;
    after.close();
    check('capture', 'a worker run at a plain turn end leaves a lone implicit candidate waiting', stillPending === 1, `pending ${stillPending}`);
    check('capture', 'a session boundary flushes it', flushed === 0, `pending ${flushed}`);
  } finally {
    fs.rmSync(wroot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// 15. Prompt history: per-person switch, per-turn changes, verbatim prompts, chronological files
// ---------------------------------------------------------------------------------------------
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-bench-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-bench-history-'));
  const savedHome = process.env.DEVCTX_HOME;
  process.env.DEVCTX_HOME = home;
  try {
    const sh = (args: string[]) => git(args, root);
    sh(['init', '-q']);
    sh(['config', 'user.email', 'dev@example.com']);
    sh(['config', 'user.name', 'Dev']);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 1;\n');
    sh(['add', '.']);
    sh(['commit', '-qm', 'init']);

    check('history', 'off by default', !historyEnabled(root));
    setHistoryEnabled(root, true);
    check('history', 'turned on for this repository on this PC', historyEnabled(root) && historyState(root).since !== null);

    const before = snapshotWorktree(root);
    fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 2;\n');
    fs.writeFileSync(path.join(root, 'src/b.ts'), 'export const b = 1;\n');
    fs.mkdirSync(path.join(root, '.devctx/history'), { recursive: true });
    fs.writeFileSync(path.join(root, '.devctx/history/x.md'), 'ignored\n');
    const after = snapshotWorktree(root);
    const changes = before.tree && after.tree ? turnChanges(root, before.tree, after.tree) : null;
    const changed = changes?.files.map((f) => `${f.status}:${f.path}`).join(',') ?? '';
    check('history', 'a turn\'s changes come from two working-tree snapshots', changed === 'M:src/a.ts,A:src/b.ts', changed);
    check('history', 'the real index is left untouched', git(['diff', '--cached', '--name-only'], root).stdout === '');
    check('history', 'the branch is read from HEAD', before.branch === 'main' || before.branch === 'master', String(before.branch));
    fs.rmSync(path.join(root, '.devctx'), { recursive: true, force: true });

    const db = StateDb.open(projectPaths(root).stateDb);
    try {
      const ev = (kind: 'prompt' | 'turn_end', prompt: string | null, ts: string, lastAssistant: string | null = null) =>
        ({ ts, tool: 'claude' as const, host: 'claude', kind, session: 's1', cwd: root, prompt, lastAssistant, transcriptPath: null, model: null, source: null });
      const t0 = new Date(Date.now() - 60_000).toISOString();
      const prompt1 = '로그인 메시지를 한국어로 바꿔줘\n```js\nconst label = `x`;\n```\napi_key=sk-abcdefghijklmnopqrstuvwxyz123456';
      captureHistory(root, db, 'prompt', ev('prompt', prompt1, t0));
      fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 3;\n');
      const closed = captureHistory(root, db, 'turn_end', ev('turn_end', null, new Date(Date.now() - 50_000).toISOString(), 'a.ts의 값을 바꿨습니다.'));
      captureHistory(root, db, 'prompt', ev('prompt', '/compact', new Date(Date.now() - 45_000).toISOString()));
      captureHistory(root, db, 'prompt', ev('prompt', '이건 무슨 파일이야?', new Date(Date.now() - 40_000).toISOString()));
      captureHistory(root, db, 'turn_end', ev('turn_end', null, new Date(Date.now() - 30_000).toISOString(), 'b.ts는 상수 b를 정의합니다.'));
      check('history', 'a turn is ready when it ends; slash commands are not recorded', closed && db.readyHistoryTurns(10).length === 2);

      const rep = await processHistory(projectPaths(root), normalizeConfig({}), db, null);
      const file = rep.written[0] ? path.join(root, rep.written[0]) : '';
      const text = file ? (readText(file) ?? '') : '';
      check('history', 'both turns go to one session file', rep.written.length === 2 && rep.written[0] === rep.written[1], rep.written.join(','));
      check('history', 'the file name starts with the session start (UTC) for chronological order', /\.devctx\/history\/\d{4}-\d{2}\/\d{4}-\d{2}-\d{2}T\d{6}Z-claude-[0-9a-f]{6}\.md$/.test(rep.written[0] ?? ''), rep.written[0]);
      check('history', 'the prompt is kept verbatim inside a longer fence', text.includes('````text\n로그인 메시지를 한국어로 바꿔줘\n```js\nconst label = `x`;\n```'));
      check('history', 'secret-like values are masked', !text.includes('sk-abcdefghijklmnopqrstuvwxyz123456') && text.includes('[REDACTED]'));
      check('history', 'entries are numbered in prompt order with the changed files', text.indexOf('## 1.') < text.indexOf('## 2.') && text.includes('`src/a.ts` (M, +1 −1)'));
      check('history', 'without an LLM the entry carries the assistant reply', text.includes('a.ts의 값을 바꿨습니다.') && text.includes('b.ts는 상수 b를 정의합니다.'));
      check('history', 'the header names the tool and the author', text.startsWith('# 작업 기록 · Claude Code') && text.includes('작성자: Dev'));

      captureHistory(root, db, 'prompt', ev('prompt', '하나 더', new Date(Date.now() - 20_000).toISOString()));
      captureHistory(root, db, 'turn_end', ev('turn_end', null, new Date(Date.now() - 10_000).toISOString(), '완료.'));
      await processHistory(projectPaths(root), normalizeConfig({}), db, null);
      const again = readText(file) ?? '';
      check('history', 'a later turn of the session is appended to the same file', again.startsWith(text) && again.includes('## 3.'));

      // Once committed, the file never changes: the session continues in a new file.
      sh(['add', '.devctx/history']);
      sh(['commit', '-qm', 'history']);
      captureHistory(root, db, 'prompt', ev('prompt', '커밋 뒤 프롬프트', new Date(Date.now() - 5_000).toISOString()));
      captureHistory(root, db, 'turn_end', ev('turn_end', null, new Date(Date.now() - 2_000).toISOString(), '이어서 했습니다.'));
      const cont = await processHistory(projectPaths(root), normalizeConfig({}), db, null);
      const contFile = cont.written[0] ?? '';
      const contText = readText(path.join(root, contFile)) ?? '';
      check('history', 'a committed history file is never changed', readText(file) === again && git(['status', '--porcelain', '--', rep.written[0] ?? ''], root).stdout === '');
      check('history', 'the session continues in a new file that points back', contFile !== rep.written[0] && contText.includes('## 4.') && contText.includes(`앞부분: \`${path.basename(rep.written[0] ?? '')}\``), contFile);
      check('history', 'the continuation file sorts after the first one', [rep.written[0] ?? '', contFile].sort()[1] === contFile);

      captureHistory(root, db, 'prompt', ev('prompt', '끝나지 않은 턴', new Date(Date.now() - 13 * 3_600_000).toISOString()));
      const stale = await processHistory(projectPaths(root), normalizeConfig({}), db, null);
      const staleText = readText(path.join(root, stale.written[0] ?? '')) ?? '';
      check('history', 'a turn that never ended is written after 12 hours', stale.written.length === 1 && staleText.includes('끝나지 않은 턴') && staleText.includes('바뀐 파일을 계산하지 못함'));

      setHistoryEnabled(root, false);
      captureHistory(root, db, 'prompt', ev('prompt', '꺼진 뒤의 프롬프트', new Date().toISOString()));
      check('history', 'nothing is recorded while off', !db.readyHistoryTurns(10).length && db.openHistoryTurnOf('claude:s1') === null);

      db.recordLlmCall({ provider: 'fake', model: 'm', task: 'summarize', ok: true, ms: 1 });
      db.recordLlmCall({ provider: 'fake', model: 'm', task: 'extract', ok: true, ms: 1 });
      const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
      check('history', 'summary calls are counted apart from extraction calls', db.llmCallsSince(hourAgo, { task: 'summarize' }) === 1 && db.llmCallsSince(hourAgo, { excludeTask: 'summarize' }) === 1);
    } finally {
      db.close();
    }

    const facts = { tool: 'claude', prompt: 'x', lastAssistant: 'src/auth/middleware.ts 에서 처리', files: [{ path: 'src/a.ts', status: 'M', added: 1, removed: 1 }], commands: [], patch: '', changesUnknown: false };
    const invented = inventedPaths({ summary: 'src/a.ts와 src/auth/middleware.ts, 그리고 src/ghost.ts를 봤다. Node.js 버전과 e.g. 예시.', outcome: null, kind: 'change' }, facts);
    check('history', 'a file the summary made up is caught', invented.join() === 'src/ghost.ts', invented.join());

    const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-bench-tx-'));
    const tfile = path.join(tdir, 't.jsonl');
    const at = (s: number) => new Date(Date.now() - s * 1000).toISOString();
    fs.writeFileSync(
      tfile,
      [
        { timestamp: at(100), type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm run old' } }] } },
        { timestamp: at(20), type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
        { timestamp: at(15), type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'git status'] }) } },
        { timestamp: at(10), type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '테스트를 고쳤습니다.' }] } },
      ]
        .map((o) => JSON.stringify(o))
        .join('\n'),
    );
    const tx = readTurnTranscript(tfile, at(30), at(0));
    check('history', 'commands and the last reply of the turn come from the transcript', tx.commands.join('|') === 'npm test|git status' && tx.lastAssistant === '테스트를 고쳤습니다.', JSON.stringify(tx));
    check('history', 'a reply written after the turn ended belongs to the next turn', readTurnTranscript(tfile, at(30), at(12)).lastAssistant === null && readTurnTranscript(tfile, at(30), at(12)).commands.join('|') === 'npm test|git status');
    check('capture', 'the last assistant message is read from a transcript when the hook gave none', readLastAssistant(tfile) === '테스트를 고쳤습니다.');
    fs.rmSync(tdir, { recursive: true, force: true });
  } finally {
    if (savedHome === undefined) delete process.env.DEVCTX_HOME;
    else process.env.DEVCTX_HOME = savedHome;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------
const abilities = [...new Set(results.map((r) => r.ability))];
const failed = results.filter((r) => !r.ok);
for (const r of results) if (verbose || !r.ok) console.log(`${r.ok ? 'ok  ' : 'FAIL'} [${r.ability}] ${r.name}${r.detail && (!r.ok || verbose) ? `  :: ${r.detail}` : ''}`);
console.log('---');
for (const a of abilities) {
  const list = results.filter((r) => r.ability === a);
  console.log(`${a.padEnd(18)} ${list.filter((r) => r.ok).length}/${list.length}`);
}
const precision = retrieval.tp + retrieval.fp > 0 ? retrieval.tp / (retrieval.tp + retrieval.fp) : 1;
const recall = retrieval.tp + retrieval.fn > 0 ? retrieval.tp / (retrieval.tp + retrieval.fn) : 1;
console.log(`injected sets      precision ${precision.toFixed(2)}, recall ${recall.toFixed(2)} (${RETRIEVAL.length} prompts, ${ITEMS.length} decisions)`);
if (speedLine) console.log(`speed              ${speedLine}`);
console.log(`total              ${results.length - failed.length}/${results.length}`);
process.exitCode = failed.length > 0 ? 1 : 0;
