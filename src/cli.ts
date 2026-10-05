#!/usr/bin/env node
import path from 'node:path';
import { compile } from './compile/compile.ts';
import { loadConfig } from './config.ts';
import { runDoctor } from './doctor.ts';
import { runGitHook } from './githook-run.ts';
import { runHook } from './hooks/entry.ts';
import { runInit } from './init/init.ts';
import { uninstall } from './init/uninstall.ts';
import { packageInfo } from './init/shim.ts';
import type { KnowledgeItem } from './knowledge/types.ts';
import { applyCachedStale, loadPersonal, loadTeam } from './knowledge/view.ts';
import { codeStatus, EXIT_MEMORY_CAPPED, indexPass, refreshIndex } from './codeindex/service.ts';
import { NOISY_GRAMMARS } from './codeindex/languages.ts';
import { CODE_TOOLS, codeTool, parseToolArgs, usageLine } from './codeindex/tools-meta.ts';
import { agentAccessStatus } from './init/access.ts';
import { describeRoutes, qualifyProvider, type Qualification } from './llm/router.ts';
import { SUITE_TASKS, type SuiteTask } from './llm/suite.ts';
import { StateDb } from './state/db.ts';
import { isHookKind, isToolId, TOOL_IDS, type ToolId } from './types.ts';
import { gitToplevel } from './util/git.ts';
import { findProjectRoot, projectPaths } from './util/paths.ts';
import { runWorker } from './worker.ts';
import { explainPrompt, memoryLog } from './explain.ts';
import { historyState, setHistoryEnabled, setSwitch, switchState } from './history/toggle.ts';
import { approveProposal, discardProposal, listProposals, resolveConflict } from './memory/manual.ts';
import type { ApplyResult } from './memory/consolidate.ts';
import { confirmedProposal, relationLabel, statusLabel } from './memory/labels.ts';
import { HISTORY_DIR, localTime } from './history/writer.ts';

interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

/** Flags that never take a value: `remember --no-llm "rule"` must keep "rule" as the argument. */
const BOOLEAN_FLAGS = new Set([
  'no-llm',
  'all',
  'check',
  'force',
  'no-code-index',
  'no-git-hooks',
  'refresh',
  'pass',
  'help',
  'global',
  'discard',
  'yes',
  'keep-history',
  ...CODE_TOOLS.flatMap((t) => t.args.filter((a) => a.type === 'boolean').map((a) => a.name.replace(/_/g, '-'))),
]);

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--') && !BOOLEAN_FLAGS.has(arg.slice(2))) {
        flags.set(arg.slice(2), next);
        i++;
      } else {
        flags.set(arg.slice(2), true);
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function flag(args: Args, name: string): string | null {
  const v = args.flags.get(name);
  return typeof v === 'string' ? v : null;
}

function has(args: Args, name: string): boolean {
  return args.flags.has(name);
}

function resolveRoot(args: Args): string {
  const explicit = flag(args, 'root');
  if (explicit) return path.resolve(explicit);
  const found = findProjectRoot(process.cwd());
  if (!found) throw new Error('devctx is not initialized here (run "devctx init" in the repository root)');
  return found;
}

function writeAndExit(text: string | null): void {
  if (text) process.stdout.write(text, () => process.exit(0));
  else process.exit(0);
}

const HELP = `devctx — project decision memory for AI coding tools

사용법:
  devctx init [--tools claude,codex,copilot,cursor,kiro] [--source <npm|git|path>] [--lang ko|en]
              [--no-code-index] [--no-git-hooks] [--force]
  devctx status                  기록된 결정 목록
  devctx code [status]           코드 인덱스 상태, 저장소 언어, 스킬·사전 허용 설치 상태
  devctx code index              지금 색인 (바뀐 파일만 다시 파싱)
  devctx code <도구> [인자...]    코드 인덱스 조회 (AI 도구는 스킬 devctx-code로 같은 명령을 쓴다)
                                 예: devctx code search_symbols OrderService
                                 도구: ${CODE_TOOLS.map((t) => t.name).join(' ')}
  devctx doctor                  연결 상태 점검 (LLM 호출 없음)
  devctx compile [--check]       이 PC의 규칙 목록(.devctx/rules.md)과 도구별 경로 규칙 파일 다시 만들기 (--check: 변경 여부만 확인)
  devctx models [--refresh] [--host <tool>]
                                 작업(추출/판정/요약)별로 쓰는 모델, 후보 비용 순위와 평가 결과
  devctx models --qualify <provider> [--task extract|judge|summarize|all] [--limit N]
                                 싼 후보부터 요구사항 평가를 돌려 통과하는 첫 모델을 찾는다
  devctx history [on|off] [--discard]
                                 프롬프트 히스토리 (프롬프트 원문 + 작업 요약을 .devctx/history/에 기록)
                                 켜짐/꺼짐 상태와 최근 기록. 켜고 끄는 것은 이 PC에서 이 저장소에만 적용
                                 off --discard: 켜져 있을 때 보냈지만 아직 쓰지 않은 항목도 버린다
  devctx why "<프롬프트>" [--all]  그 프롬프트에 hook이 어떤 결정을 왜 붙이는지 (점수, 제외 이유, 직전 세션 연결)
  devctx recall "<단어>" [--days N] [--limit N]
                                 이전 작업 찾기: 이 PC의 지난 요청·응답, 히스토리, 대체된 결정과 이유 (LLM 없음)
                                 AI 도구는 스킬로 같은 검색을 쓴다: devctx code search_history "<단어>"
  devctx log [--limit N]         자동으로 바뀐 결정 기록 (추가·보강·대체·충돌·만료와 판정 이유)
  devctx remember "<규칙>"        직접 기록. 명시적으로 남긴 규칙이라 바로 확정된다 (LLM이 없어도)
  devctx approve [<ID>]          이 PC에만 있는 확인 대기 규칙 목록 / 확정 (결정 파일로 저장)
  devctx discard <ID>            확인 대기 규칙 버리기
  devctx resolve <ID>            충돌 정리: 고른 규칙만 남기고 상대 규칙은 대체 (ID는 devctx status의 6자리)
  devctx capture [on|off] [--global]
                                 내 프롬프트를 규칙 후보로 분석할지 (기본 켜짐, 이 PC 설정). 꺼도 규칙은 전달된다
  devctx worker [--no-llm]       대기 중인 이벤트 처리 (보통 hook이 자동 실행)
  devctx purge                   이 PC에 저장된 프롬프트·AI 응답 원문 지우기 (.devctx/local/state.sqlite. 결정 파일은 그대로)
  devctx uninstall [--yes] [--keep-history]
                                 이 저장소에서 devctx 제거. --yes 없이 실행하면 지울 것만 보여준다

내부용: devctx hook --tool <tool> --event <event>, devctx git-hook <name>
`;

/** One line per stored result of `devctx remember`: what happened and what to do next. */
function describeApplied(a: ApplyResult, ko: boolean): string {
  const id = a.itemId ? a.itemId.slice(-6) : '-';
  const text = a.summary ? `: ${a.summary}` : '';
  if (a.relation === 'dropped') return `${ko ? '기록 안 함' : 'not recorded'} (${a.detail})`;
  if (a.status === 'proposed' && a.detail.startsWith('held: ')) {
    const why = a.detail.slice(6);
    return ko
      ? `보류 ${id}${text}\n  규칙 문장이 AI의 다른 지시를 무시하게 하거나 역할 태그를 흉내 낸다: ${why}. 이 PC에만 두고 어디에도 전달하지 않는다. 문장을 바꿔 다시 기록한다`
      : `held ${id}${text}\n  The text ${why}. Kept on this PC only and never delivered; reword it and record it again`;
  }
  if (a.status === 'active' && a.relation === 'duplicate' && confirmedProposal(a.detail)) {
    return ko
      ? `확정 ${id}${text}\n  이 PC에서 확인 대기였던 규칙이 결정 파일이 되었다 (다음 커밋에 함께 올라간다)`
      : `confirmed ${id}${text}\n  The proposal kept on this PC is now a decision file (goes out with your next commit)`;
  }
  if (a.status === 'proposed') {
    return ko
      ? `확인 대기 ${id}${text}\n  이 PC에만 있다. 확정: devctx approve ${id}`
      : `proposed ${id}${text}\n  Kept on this PC only. Approve: devctx approve ${id}`;
  }
  if (a.status === 'conflict') {
    const other = a.targetId ? a.targetId.slice(-6) : '?';
    return ko
      ? `충돌 ${id}${text}\n  기존 규칙 ${other}와 다르다(다른 사람이 만든 규칙은 자동으로 바꾸지 않는다). 정리: devctx resolve ${id} 또는 devctx resolve ${other}`
      : `conflict ${id}${text}\n  Differs from ${other} (someone else's rule is never replaced silently). Settle: devctx resolve ${id} or devctx resolve ${other}`;
  }
  const label: Record<string, [string, string]> = {
    new: ['저장됨 (적용 중)', 'stored (in force)'],
    duplicate: ['이미 있는 규칙 (적용 중)', 'already recorded (in force)'],
    refine: ['보강됨', 'refined'],
    supersede: ['대체함', 'replaced'],
  };
  const [k, e] = label[a.relation] ?? [a.relation, a.relation];
  const target = a.targetId && a.targetId !== a.itemId ? (ko ? ` (이전 ${a.targetId.slice(-6)})` : ` (was ${a.targetId.slice(-6)})`) : '';
  return `${ko ? k : e} ${id}${text}${target}`;
}

/** The lines of HELP for one command (the whole text for an unknown one). */
function commandHelp(cmd: string): string {
  const lines = HELP.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!(lines[i] ?? '').startsWith(`  devctx ${cmd}`)) continue;
    out.push(lines[i] as string);
    while (/^ {6,}\S/.test(lines[i + 1] ?? '')) out.push(lines[++i] as string);
  }
  return out.length > 0 ? `사용법:\n${out.join('\n')}` : HELP;
}

/** `--tools`: every name must be a known tool (a typo must not install all five). */
function parseTools(args: Args): ToolId[] {
  if (!has(args, 'tools')) return [...TOOL_IDS];
  const requested = (flag(args, 'tools') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  const unknown = requested.filter((t) => !isToolId(t));
  if (requested.length === 0 || unknown.length > 0) {
    const guess = unknown.map((u) => TOOL_IDS.find((id) => id.startsWith(u.slice(0, 3).toLowerCase()))).filter(Boolean);
    throw new Error(
      `${requested.length === 0 ? '--tools에 도구 이름이 없다' : `알 수 없는 도구: ${unknown.join(', ')}`} (가능: ${TOOL_IDS.join(', ')})${guess.length > 0 ? `. 혹시 ${guess.join(', ')}?` : ''}`,
    );
  }
  return [...new Set(requested)] as ToolId[];
}

async function main(argv: string[]): Promise<number> {
  const [cmd = 'help', ...rest] = argv;
  const args = parseArgs(rest);
  // `--help` only shows help: it must never run the command (`init --help` used to install,
  // `history on --help` to turn recording on). `code <tool> --help` has its own text below.
  const wantsHelp = rest.includes('--help') || rest.includes('-h');
  if (wantsHelp && cmd !== 'hook' && cmd !== 'git-hook' && !(cmd === 'code' && codeTool(args.positional[0] ?? ''))) {
    console.log(commandHelp(cmd));
    return 0;
  }

  switch (cmd) {
    case 'hook': {
      // Never fails: the AI tool must not be blocked by devctx.
      const tool = flag(args, 'tool');
      const event = flag(args, 'event');
      if (!isToolId(tool) || !isHookKind(event)) {
        writeAndExit(null);
        return 0;
      }
      writeAndExit(await runHook(tool, event));
      return 0;
    }

    case 'git-hook': {
      const name = args.positional[0] ?? '';
      const root = gitToplevel(process.cwd());
      if (root) for (const notice of runGitHook(name, root)) process.stderr.write(`${notice}\n`);
      return 0;
    }

    case 'init': {
      const root = flag(args, 'root') ? path.resolve(flag(args, 'root') as string) : (gitToplevel(process.cwd()) ?? process.cwd());
      const tools = parseTools(args);
      const lang = flag(args, 'lang') ?? 'ko';
      if (lang !== 'ko' && lang !== 'en') throw new Error(`--lang은 ko 또는 en이다 (받은 값: ${lang})`);
      if (has(args, 'source') && !flag(args, 'source')) throw new Error('--source에 설치 위치가 없다 (예: --source github:mhlee-lee/devctx#<커밋 SHA>)');
      const report = runInit({
        root,
        tools,
        source: flag(args, 'source'),
        language: lang,
        gitHooks: !has(args, 'no-git-hooks'),
        force: has(args, 'force'),
        codeIndex: !has(args, 'no-code-index'),
      });
      console.log(`devctx init: ${report.root}`);
      for (const h of report.hookFiles) console.log(`  hook  ${h.action.padEnd(9)} ${h.file}`);
      for (const a of report.accessFiles) if (a.action !== 'unchanged') console.log(`  skill ${a.action.padEnd(9)} ${a.file}`);
      if (report.gitHooks) {
        console.log(`  git   installed: ${report.gitHooks.installed.join(', ') || '-'}; present: ${report.gitHooks.present.join(', ') || '-'}`);
      }
      for (const f of report.compile.changed) console.log(`  gen   ${f}`);
      for (const n of report.notes) console.log(`  note  ${n}`);
      for (const w of report.compile.warnings) console.log(`  warn  ${w}`);
      if (report.commitPaths.length > 0) {
        console.log('\n커밋하면 팀원도 clone만으로 같은 규칙, hook, 스킬을 쓴다:');
        console.log(`  git add -A -- ${report.commitPaths.join(' ')}`);
        console.log('  git commit -m "chore: devctx 설정"');
      }
      return 0;
    }

    case 'code-mcp':
      // Registered by earlier versions; the session hook removes those MCP entries.
      process.stderr.write('devctx: the code index MCP server was replaced by the devctx-code skill (run "devctx init" to update the tool configs)\n');
      return 1;

    case 'code': {
      const sub = args.positional[0] ?? 'status';
      const root = resolveRoot(args);
      const paths = projectPaths(root);
      const cfg = loadConfig(paths);
      if (sub !== 'status' && sub !== 'search_history' && !cfg.code_index.enabled) throw new Error('the code index is off (code_index.enabled: false)');
      if (sub === 'index' && has(args, 'pass')) {
        // Internal: one memory-capped pass; the parent starts another while this exits 3.
        const res = await indexPass(root, cfg);
        process.exit(res.error ? 1 : res.memoryCapped ? EXIT_MEMORY_CAPPED : 0);
      }
      if (sub === 'index') {
        const started = Date.now();
        const res = await refreshIndex(root, cfg);
        if (!res) return 0;
        if (res.error) {
          console.log(`FAIL ${res.error}`);
          return 1;
        }
        console.log(`ok  ${res.files} source files, ${res.parsed} parsed${res.removed ? `, ${res.removed} removed` : ''}, ${res.failed} failed  ${Math.round((Date.now() - started) / 100) / 10}s`);
        return 0;
      }
      const tool = codeTool(sub);
      if (tool) {
        if (has(args, 'help') || args.positional.includes('-h')) {
          console.log(`${usageLine(tool)}\n${tool.summary[cfg.language]}`);
          return 0;
        }
        // Loaded only here: hooks share this entry point and must not load the parser stack.
        const { runCodeTool } = await import('./codeindex/tools.ts');
        writeAndExit(`${await runCodeTool(root, tool.name, parseToolArgs(tool, args.positional.slice(1), args.flags))}\n`);
        return 0;
      }
      if (sub !== 'status') throw new Error(`usage: devctx code [status|index|${CODE_TOOLS.map((t) => t.name).join('|')}]`);
      const st = codeStatus(root, cfg);
      if (!st.enabled) {
        console.log('code index: off (code_index.enabled: false)');
        return 0;
      }
      const m = st.meta;
      console.log(
        `index     ${m.exists ? `${m.parsed} of ${m.files} source files parsed${m.failed ? `, ${m.failed} failed` : ''}; synced ${m.syncedAt ? m.syncedAt.slice(0, 16).replace('T', ' ') : '-'}` : 'not built yet (built in the background at the next session, or run "devctx code index")'}${st.indexing ? '  (indexing now)' : st.stale ? '  -> refresh pending' : ''}`,
      );
      console.log(`store     .devctx/local/code.sqlite ${Math.round(st.dbBytes / 1024)} KB`);
      if (m.syntax.length > 0) {
        // A few files with syntax errors are normal (work in progress); most files of one language
        // having them points at a grammar that no longer matches the language version.
        console.log('syntax    files the parser had to recover from syntax errors (symbols there may be incomplete):');
        for (const s of m.syntax) console.log(`  ${s.lang.padEnd(12)} ${s.files}/${s.total}  e.g. ${s.examples.join(', ')}${NOISY_GRAMMARS.has(s.lang) ? '  (this grammar flags valid code too; symbols are still read)' : ''}`);
      }
      const access = agentAccessStatus(root, cfg.targets, { enabled: true, preapprove: cfg.code_index.preapprove, language: cfg.language });
      console.log(`skill     ${access.map((x) => `${x.file}${x.ok ? '' : ' (missing or outdated)'}`).join(', ') || '-'}`);
      for (const x of access) if (!x.ok && x.hint) console.log(`  ${x.file}: ${x.hint}`);
      console.log('languages');
      if (st.languages.length === 0) console.log('  (no source files detected)');
      for (const l of st.languages) console.log(`  ${(l.grammar ? 'indexed' : 'text only').padEnd(9)} ${l.label.padEnd(16)} ${String(l.files).padStart(6)} files`);
      return 0;
    }

    case 'worker': {
      const workerRoot = resolveRoot(args);
      const report = await runWorker({
        root: workerRoot,
        host: flag(args, 'host'),
        reason: flag(args, 'reason') ?? 'manual',
        allowLlm: !has(args, 'no-llm'),
      });
      if (process.env.DEVCTX_WORKER === '1') return 0;
      if (report.skipped) console.log(`skipped: ${report.skipped}`);
      console.log(`events ${report.processed}, candidates ${report.candidates}, retired ${report.retired}`);
      const wl = loadConfig(projectPaths(workerRoot)).language;
      for (const a of report.applied) {
        const state = a.status ? ` · ${statusLabel(a.status, wl)}` : '';
        console.log(`  ${relationLabel(a.relation, wl, a.detail)}${state}  ${a.itemId ? a.itemId.slice(-6) : '-'}${a.summary ? ` "${a.summary}"` : ''}`);
      }
      for (const f of report.compiled?.changed ?? []) console.log(`  gen   ${f}`);
      for (const e of report.errors) console.log(`  error ${e}`);
      return report.errors.length > 0 && report.applied.length === 0 && report.processed > 0 ? 1 : 0;
    }

    case 'compile': {
      const root = resolveRoot(args);
      const paths = projectPaths(root);
      const cfg = loadConfig(paths);
      if (has(args, 'check')) {
        const res = compile(paths, cfg, null, { check: true, manual: true });
        for (const w of res.warnings) console.log(`warn  ${w}`);
        if (res.drift.length > 0) {
          console.log(`out of date: ${res.drift.join(', ')}`);
          return 1;
        }
        console.log('up to date');
        return 0;
      }
      const db = StateDb.open(paths.stateDb);
      try {
        const res = compile(paths, cfg, db, { tool: 'cli', manual: true });
        for (const f of res.changed) console.log(`gen     ${f}`);
        for (const f of res.removed) console.log(`removed ${f}`);
        for (const w of res.warnings) console.log(`warn    ${w}`);
        if (res.changed.length + res.removed.length === 0) console.log('up to date');
      } finally {
        db.close();
      }
      return 0;
    }

    case 'doctor': {
      const checks = await runDoctor(resolveRoot(args), flag(args, 'host'));
      const mark = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' } as const;
      for (const c of checks) console.log(`${mark[c.level]}  ${c.name.padEnd(16)} ${c.detail}`);
      return checks.some((c) => c.level === 'fail') ? 1 : 0;
    }

    case 'models': {
      const root = findProjectRoot(process.cwd());
      const cfg = loadConfig(projectPaths(root ?? process.cwd()));
      const target = flag(args, 'qualify');
      if (target) {
        if (!isToolId(target)) throw new Error(`unknown provider: ${target}`);
        const taskFlag = flag(args, 'task') ?? 'all';
        if (taskFlag !== 'all' && !(SUITE_TASKS as readonly string[]).includes(taskFlag)) throw new Error(`unknown task: ${taskFlag} (${SUITE_TASKS.join(' | ')} | all)`);
        const tasks = taskFlag === 'all' ? SUITE_TASKS : [taskFlag as SuiteTask];
        const limit = Math.max(1, Math.min(40, Number(flag(args, 'limit') ?? 3) || 3));
        const db = root ? StateDb.open(projectPaths(root).stateDb) : null;
        try {
          for (const task of tasks) {
            console.log(`[${task}] ${target}: cheapest candidates first, until one meets every requirement`);
            const results = await qualifyProvider(cfg, target, task, limit, db, (r) => {
              const verdict = r.blocked ? `blocked (${r.blocked})` : r.pass ? 'PASS' : 'fail';
              const cost = r.avgCostUsd === null ? '' : `  $${r.avgCostUsd.toFixed(4)}/call`;
              console.log(`  ${verdict.padEnd(6)} ${r.key}  ${r.score}${cost}`);
              for (const d of r.details) console.log(`         ${d}`);
            });
            if (results.length === 0) console.log('  nothing to evaluate (not installed, or the cheapest passing candidate is already known)');
          }
        } finally {
          db?.close();
        }
        return 0;
      }
      const reports = await describeRoutes(cfg, flag(args, 'host'), { refresh: has(args, 'refresh') });
      const verdict = (q: Qualification | null | undefined): string => (q ? `${q.status} ${q.score}/${q.total}` : '-');
      for (const r of reports) {
        const blocked = r.blocked ? `  [skipped until ${r.blocked.until.slice(0, 16)}Z: ${r.blocked.kind}]` : '';
        console.log(`${r.provider}: ${r.bin ? `${r.bin} (${r.version ?? '?'})` : 'not installed'}${blocked}`);
        if (!r.bin) continue;
        for (const task of SUITE_TASKS) console.log(`  ${task.padEnd(9)} -> ${r.selected[task] ?? 'no qualified model yet (the background worker evaluates candidates)'}`);
        console.log(`  ${'est/call'.padStart(9)}  ${'measured'.padStart(9)}  tier    ${SUITE_TASKS.map((t) => t.padEnd(12)).join(' ')} candidate`);
        const allowed = r.models.filter((m) => m.auto);
        const shown = allowed.slice(0, 12);
        for (const m of shown) {
          const est = m.estimate.unit === 'usd' ? `$${m.estimate.cost.toFixed(4)}` : `x${m.estimate.cost.toFixed(4)}`;
          const real = m.measuredUsd === null ? '-' : `$${m.measuredUsd.toFixed(4)}`;
          console.log(
            `  ${`${est}${m.estimate.known ? '' : '~'}`.padStart(9)}  ${real.padStart(9)}  ${m.estimate.tier.padEnd(6)}  ${SUITE_TASKS.map((t) => verdict(m.qualification[t]).padEnd(12)).join(' ')} ${m.key}`,
          );
        }
        if (allowed.length > shown.length) console.log(`  ... ${allowed.length - shown.length} more candidates (pricier)`);
        const aboveTier = r.models.length - allowed.length;
        if (aboveTier > 0) console.log(`  ... ${aboveTier} above max_tier ${cfg.llm.max_tier} (used only when pinned)`);
      }
      console.log('\nest/call: expected cost of one call incl. CLI overhead and reasoning effort (~ = price guessed from the name; Kiro: credits)');
      console.log('measured: mean cost of real calls so far. A candidate is used only after passing every requirement of the task.');
      return 0;
    }

    case 'history': {
      const root = resolveRoot(args);
      const cfg = loadConfig(projectPaths(root));
      const ko = cfg.language === 'ko';
      const sub = args.positional[0] ?? 'status';
      if (sub === 'on' || sub === 'off') {
        const st = setHistoryEnabled(root, sub === 'on');
        if (st.enabled) {
          console.log(ko ? '히스토리 기록: 켜짐 (이 PC에서 이 저장소)' : 'Prompt history: on (this repository on this PC)');
          console.log(
            ko
              ? `- 프롬프트 원문과 작업 요약이 ${HISTORY_DIR}/에 세션마다 파일 하나로 저장되고, 커밋할 때 함께 올라간다.\n- 키·토큰 같은 비밀값 형태는 가린다. 요약은 턴마다 저비용 LLM 한 번(history.max_calls_per_hour 이내).\n- 끄기: devctx history off`
              : `- Prompts (verbatim) and a summary of each turn go to ${HISTORY_DIR}/, one file per session, and ride along with your commits.\n- Secret-like values are masked. One low-cost LLM call per turn summarizes the work (within history.max_calls_per_hour).\n- Turn off: devctx history off`,
          );
        } else {
          console.log(ko ? '히스토리 기록: 꺼짐. 이미 쓴 기록은 그대로 둔다.' : 'Prompt history: off. Entries already written stay.');
          // Prompts sent while it was on and not written yet would still be written later.
          const hdb = StateDb.open(projectPaths(root).stateDb);
          try {
            const c = hdb.historyCounts();
            const pending = c.open + c.ready;
            if (has(args, 'discard')) {
              const n = hdb.discardPendingHistory();
              console.log(ko ? `- 아직 파일에 쓰지 않은 ${n}개 항목을 버렸다.` : `- Dropped ${n} entr(ies) not written yet.`);
            } else if (pending > 0) {
              console.log(
                ko
                  ? `- 켜져 있을 때 보낸 프롬프트 ${pending}개는 아직 파일에 쓰지 않았고, 곧 기록된다. 남기지 않으려면: devctx history off --discard`
                  : `- ${pending} prompt(s) sent while it was on are not written yet and will be. To drop them: devctx history off --discard`,
              );
            }
          } finally {
            hdb.close();
          }
        }
        return 0;
      }
      if (sub !== 'status') throw new Error('usage: devctx history [on|off]');
      const st = historyState(root);
      const since = st.since ? ` (${localTime(st.since).slice(0, 16)}${ko ? '부터' : ' since'})` : '';
      console.log(`${ko ? '히스토리 기록' : 'Prompt history'}: ${st.enabled ? (ko ? '켜짐' : 'on') : ko ? '꺼짐' : 'off'}${since}  ${ko ? '(이 PC 설정, 바꾸기: devctx history on|off)' : '(this PC; change with devctx history on|off)'}`);
      const db = StateDb.open(projectPaths(root).stateDb);
      try {
        const c = db.historyCounts();
        console.log(
          ko
            ? `저장 위치: ${HISTORY_DIR}/  기록한 세션 ${c.sessions}개, 항목 ${c.done}개, 정리 대기 ${c.ready}개, 진행 중 ${c.open}개`
            : `Location: ${HISTORY_DIR}/  sessions ${c.sessions}, entries ${c.done}, waiting to be written ${c.ready}, in progress ${c.open}`,
        );
        const recent = db.recentHistoryTurns(Math.max(1, Math.min(50, Number(flag(args, 'limit') ?? 5) || 5)));
        if (recent.length > 0) console.log(ko ? '최근:' : 'Recent:');
        for (const t of recent) {
          const first = t.prompt.replace(/\s+/g, ' ').trim();
          const where = t.file ?? (t.state === 'open' ? (ko ? '(진행 중)' : '(in progress)') : ko ? '(정리 대기)' : '(waiting)');
          console.log(`  ${localTime(t.promptTs).slice(0, 16)}  ${t.tool.padEnd(7)} "${first.length > 40 ? `${first.slice(0, 39)}…` : first}"  ${where}`);
        }
      } finally {
        db.close();
      }
      return 0;
    }

    case 'status': {
      const paths = projectPaths(resolveRoot(args));
      const cfg = loadConfig(paths);
      const db = StateDb.open(paths.stateDb);
      try {
        const hist = historyState(paths.root);
        console.log(`[history] ${hist.enabled ? 'on' : 'off'}  (${cfg.language === 'ko' ? '프롬프트 히스토리, 이 PC 설정: devctx history' : 'prompt history, this PC: devctx history'})`);
        const cap = switchState(paths.root, 'capture');
        console.log(`[capture] ${cap.enabled ? 'on' : 'off'}  (${cfg.language === 'ko' ? '내 프롬프트 분석, 이 PC 설정: devctx capture' : 'analyze my prompts, this PC: devctx capture'})`);
        const opts = { proposedTtlDays: cfg.memory.proposed_ttl_days, local: true };
        const { items, errors } = loadTeam(paths, db, opts);
        applyCachedStale(db, items);
        const groups: [string, (i: KnowledgeItem) => boolean][] = [
          ['held (not delivered: the text poses as a chat role or overrides instructions; reword the file)', (i) => Boolean(i.held) && (i.status === 'active' || i.status === 'conflict')],
          ['active', (i) => i.status === 'active' && !i.held],
          ['conflict (settle: devctx resolve <id>)', (i) => i.status === 'conflict' && !i.held],
          ['proposed (this PC only; confirm: devctx approve <id>)', (i) => i.status === 'proposed'],
          ['archived (restating makes them active)', (i) => Boolean(i.archived)],
          ['superseded', (i) => i.status === 'superseded'],
          ['retired', (i) => i.status === 'retired' && !i.archived],
        ];
        for (const [label, test] of groups) {
          const list = items.filter(test);
          if (list.length === 0) continue;
          console.log(`[${label}] ${list.length}`);
          for (const i of list) {
            const scope = i.scope.paths.length > 0 ? `  (${i.scope.paths.join(', ')})` : '';
            const extra = [
              i.held ?? '',
              i.reinforced > 0 ? `x${i.reinforced + 1}` : '',
              i.violations > 0 ? `violations ${i.violations}` : '',
              i.needs_review ? 'review' : '',
              i.stale ?? '',
              i.status === 'superseded' && i.superseded_by ? `by ${i.superseded_by.slice(-6)}` : '',
              i.valid_until && i.status !== 'superseded' ? `until ${i.valid_until}` : '',
            ]
              .filter(Boolean)
              .join(' ');
            console.log(`  ${i.id.slice(-6)} ${i.enforcement.padEnd(6)} ${i.summary}${scope}${extra ? `  [${extra}]` : ''}`);
          }
        }
        const personal = loadPersonal(db, opts).items.filter((i) => i.status === 'active');
        if (personal.length > 0) {
          console.log(`[personal] ${personal.length}`);
          for (const i of personal) console.log(`  ${i.id.slice(-6)} ${i.summary}`);
        }
        for (const e of errors) console.log(`unreadable: ${e.file}: ${e.error}`);
        if (items.length === 0 && personal.length === 0) console.log('아직 기록된 결정이 없다.');
      } finally {
        db.close();
      }
      return 0;
    }

    case 'why': {
      const prompt = args.positional.join(' ').trim();
      if (!prompt) throw new Error('usage: devctx why "<prompt>"');
      const root = resolveRoot(args);
      console.log(explainPrompt(root, prompt, has(args, 'all')));
      return 0;
    }

    case 'recall': {
      const query = args.positional.join(' ').trim();
      if (!query) throw new Error('usage: devctx recall "<words>" [--days N] [--limit N]');
      const num = (name: string): number | undefined => {
        const v = flag(args, name);
        if (v === null) return undefined;
        if (!/^\d+$/.test(v)) throw new Error(`--${name} needs a number (got ${JSON.stringify(v)})`);
        return Number(v);
      };
      const root = resolveRoot(args);
      const { searchHistory } = await import('./recall.ts');
      console.log(searchHistory(root, query, { days: num('days'), limit: num('limit') }));
      return 0;
    }

    case 'log': {
      const root = resolveRoot(args);
      const limit = Math.max(1, Math.min(500, Number(flag(args, 'limit') ?? 20) || 20));
      console.log(memoryLog(root, limit));
      return 0;
    }

    case 'remember': {
      const text = args.positional.join(' ').trim();
      if (!text) throw new Error('usage: devctx remember "<rule>"');
      const root = resolveRoot(args);
      const paths = projectPaths(root);
      const ko = loadConfig(paths).language === 'ko';
      const db = StateDb.open(paths.stateDb);
      try {
        db.insertEvent({
          ts: new Date().toISOString(),
          tool: 'cli',
          host: 'cli',
          kind: 'prompt',
          session: null,
          cwd: root,
          prompt: text,
          lastAssistant: null,
          transcriptPath: null,
          model: null,
          flags: ['remember', 'durable', 'remember-cmd'],
          candidate: true,
        });
      } finally {
        db.close();
      }
      const report = await runWorker({ root, host: flag(args, 'host'), reason: 'remember', allowLlm: !has(args, 'no-llm') });
      for (const a of report.applied) console.log(describeApplied(a, ko));
      if (report.skipped) console.log(ko ? `지금은 처리하지 못했다 (${report.skipped}). 다음 실행 때 기록된다.` : `Not processed now (${report.skipped}); the next run records it.`);
      else if (report.applied.length === 0) console.log(ko ? '기록할 규칙을 찾지 못했다.' : 'No rule found to record.');
      for (const e of report.errors) console.log(`error ${e}`);
      return 0;
    }

    case 'approve':
    case 'discard':
    case 'resolve': {
      const root = resolveRoot(args);
      const paths = projectPaths(root);
      const cfg = loadConfig(paths);
      const ko = cfg.language === 'ko';
      const id = args.positional[0];
      const db = StateDb.open(paths.stateDb);
      try {
        if (!id) {
          if (cmd !== 'approve') throw new Error(`usage: devctx ${cmd} <id>`);
          const list = listProposals(db);
          if (list.length === 0) console.log(ko ? '확인 대기 중인 규칙이 없다.' : 'No proposals waiting.');
          else console.log(ko ? '확인 대기 (이 PC에만 있음, 확정하면 결정 파일로 저장되어 팀과 공유):' : 'Proposals (this PC only; approving stores a decision file the team shares):');
          for (const i of list) console.log(`  ${i.id.slice(-6)}  ${i.audience === 'personal' ? (ko ? '[개인] ' : '[personal] ') : ''}${i.summary}${i.archived ? (ko ? '  (보관됨)' : '  (archived)') : ''}`);
          if (list.length > 0) console.log(ko ? '확정: devctx approve <ID>   버리기: devctx discard <ID>' : 'Approve: devctx approve <id>   Drop: devctx discard <id>');
          return 0;
        }
        if (cmd === 'discard') {
          const item = discardProposal(db, id);
          console.log(`${ko ? '버림' : 'dropped'} ${item.id.slice(-6)}: ${item.summary}`);
          return 0;
        }
        const res: { item: KnowledgeItem; file: string; replaced?: string[] } =
          cmd === 'approve' ? approveProposal(paths, cfg, db, id) : resolveConflict(paths, cfg, db, id);
        compile(paths, cfg, db, { tool: 'cli' });
        const rel = path.relative(root, res.file);
        console.log(`${ko ? '확정' : 'active'} ${res.item.id.slice(-6)}: ${res.item.summary}`);
        const others = (res.replaced ?? []).slice(1).map((r) => r.slice(-6)).join(', ');
        if (others) console.log(ko ? `  대체한 규칙: ${others}` : `  replaces: ${others}`);
        if (res.item.audience === 'team') {
          console.log(ko ? `  ${rel} — 다음 커밋에 함께 올라간다 (pre-commit hook)` : `  ${rel}: goes out with your next commit (pre-commit hook)`);
        }
      } finally {
        db.close();
      }
      return 0;
    }

    case 'capture': {
      const root = resolveRoot(args);
      const ko = loadConfig(projectPaths(root)).language === 'ko';
      const sub = args.positional[0] ?? 'status';
      if (sub === 'on' || sub === 'off') setSwitch(root, 'capture', sub === 'on', { global: has(args, 'global') });
      else if (sub !== 'status') throw new Error('usage: devctx capture [on|off] [--global]');
      const st = switchState(root, 'capture');
      const where = st.global ? (ko ? '이 PC의 모든 저장소' : 'every repository on this PC') : ko ? '이 PC에서 이 저장소' : 'this repository on this PC';
      console.log(`${ko ? '내 프롬프트 분석' : 'Prompt capture'}: ${st.enabled ? (ko ? '켜짐' : 'on') : ko ? '꺼짐' : 'off'} (${where})`);
      console.log(
        st.enabled
          ? ko
            ? '- 프롬프트에서 프로젝트 규칙 후보를 찾아 저비용 LLM으로 정리한다(내 AI CLI 쿼터 사용). 끄기: devctx capture off'
            : '- Prompts are scanned for project rules and summarized by a low-cost LLM (your AI CLI quota). Turn off: devctx capture off'
          : ko
            ? '- 프롬프트를 분석하지 않는다(LLM 호출 없음). 팀 규칙은 그대로 전달되고, devctx remember로 직접 남길 수 있다. 켜기: devctx capture on'
            : '- Prompts are not analyzed (no LLM calls). Team rules are still delivered; devctx remember records one directly. Turn on: devctx capture on',
      );
      return 0;
    }

    case 'purge': {
      const root = resolveRoot(args);
      const paths = projectPaths(root);
      const ko = loadConfig(paths).language === 'ko';
      const db = StateDb.open(paths.stateDb);
      try {
        const r = db.purgePromptText();
        console.log(
          ko
            ? `지웠다: hook 기록 ${r.events}개의 프롬프트·응답 원문, 파일에 쓰기 전 히스토리 ${r.turns}개, 세션 이어가기 정보.\n- 아직 규칙으로 정리하지 않은 프롬프트도 지워져 그 안의 규칙은 기록되지 않는다.\n- 결정 파일, 확인 대기 규칙, 이미 쓴 .devctx/history/ 파일은 그대로다.`
            : `Erased: prompt and reply text of ${r.events} hook event(s), ${r.turns} history entr(ies) not written yet, session hand-off state.\n- Prompts not analyzed yet are gone too, so rules in them are not recorded.\n- Decision files, proposals and written .devctx/history/ files stay.`,
        );
      } finally {
        db.close();
      }
      return 0;
    }

    case 'uninstall': {
      const root = flag(args, 'root') ? path.resolve(flag(args, 'root') as string) : (gitToplevel(process.cwd()) ?? process.cwd());
      const ko = loadConfig(projectPaths(root)).language === 'ko';
      const apply = has(args, 'yes');
      const report = uninstall(root, { apply, keepHistory: has(args, 'keep-history') });
      if (report.steps.length === 0) {
        console.log(ko ? '이 저장소에 devctx가 설치되어 있지 않다.' : 'devctx is not installed in this repository.');
        return 0;
      }
      console.log(apply ? (ko ? 'devctx를 제거했다:' : 'Removed devctx:') : ko ? '제거할 것 (실행하려면 devctx uninstall --yes):' : 'Would remove (run devctx uninstall --yes):');
      for (const s of report.steps) {
        const verb = s.action === 'remove' ? (ko ? '삭제' : 'remove') : ko ? '수정' : 'edit';
        console.log(`  ${verb.padEnd(6)} ${s.target}${s.note ? `  (${s.note})` : ''}`);
      }
      if (apply && report.commitPaths.length > 0) {
        console.log(ko ? '\n팀원에게도 반영하려면 커밋한다:' : '\nCommit it so the team gets it too:');
        console.log(`  git add -A -- ${report.commitPaths.join(' ')}`);
        console.log(`  git commit -m "${ko ? 'chore: devctx 제거' : 'chore: remove devctx'}"`);
      }
      if (apply) {
        console.log(
          ko
            ? '- 이 PC의 공용 데이터(개인 선호, 모델 평가, 설치본)는 ~/.local/share/devctx/에 남아 있다. 다른 저장소에서 쓰지 않으면 지워도 된다.'
            : '- Data shared by every repository on this PC (personal preferences, model evaluations, installs) stays in ~/.local/share/devctx/.',
        );
      }
      return 0;
    }

    case 'version':
    case '--version':
    case '-v':
      console.log(packageInfo().version);
      return 0;

    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;

    default:
      console.error(`devctx: 알 수 없는 명령 "${cmd}" (unknown command). 사용법: devctx help`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (process.argv[2] === 'hook') process.exit(0);
    console.error(`devctx: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
