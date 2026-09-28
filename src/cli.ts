#!/usr/bin/env node
import path from 'node:path';
import { compile } from './compile/compile.ts';
import { loadConfig } from './config.ts';
import { runDoctor } from './doctor.ts';
import { runGitHook } from './githook-run.ts';
import { runHook } from './hooks/entry.ts';
import { runInit } from './init/init.ts';
import { packageInfo } from './init/shim.ts';
import { loadItems, loadPersonalItems } from './knowledge/store.ts';
import { describeRoutes, qualifyProvider, type Qualification } from './llm/router.ts';
import { SUITE_TASKS, type SuiteTask } from './llm/suite.ts';
import { StateDb } from './state/db.ts';
import { isHookKind, isToolId, TOOL_IDS, type ToolId } from './types.ts';
import { gitToplevel } from './util/git.ts';
import { findProjectRoot, projectPaths } from './util/paths.ts';
import { runWorker } from './worker.ts';

interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

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
      if (next !== undefined && !next.startsWith('--')) {
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
  devctx init [--tools claude,codex,copilot,cursor,kiro] [--source <npm|git|path>] [--lang ko|en] [--no-git-hooks] [--force]
  devctx status                  기록된 결정 목록
  devctx doctor                  연결 상태 점검 (LLM 호출 없음)
  devctx compile [--check]       AGENTS.md와 도구별 규칙 파일 재생성 (--check: 변경 여부만 확인)
  devctx models [--refresh] [--host <tool>]
                                 작업(추출/판정)별로 쓰는 모델, 후보 비용 순위와 평가 결과
  devctx models --qualify <provider> [--task extract|judge|all] [--limit N]
                                 싼 후보부터 요구사항 평가를 돌려 통과하는 첫 모델을 찾는다
  devctx remember "<규칙>"        hook이 없는 환경에서 직접 기록 (같은 추출·정리 과정을 거침)
  devctx worker [--no-llm]       대기 중인 이벤트 처리 (보통 hook이 자동 실행)

내부용: devctx hook --tool <tool> --event <event>, devctx git-hook <name>
`;

async function main(argv: string[]): Promise<number> {
  const [cmd = 'help', ...rest] = argv;
  const args = parseArgs(rest);

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
      if (root) runGitHook(name, root);
      return 0;
    }

    case 'init': {
      const root = flag(args, 'root') ? path.resolve(flag(args, 'root') as string) : (gitToplevel(process.cwd()) ?? process.cwd());
      const toolList = (flag(args, 'tools') ?? TOOL_IDS.join(','))
        .split(',')
        .map((t) => t.trim())
        .filter(isToolId) as ToolId[];
      const report = runInit({
        root,
        tools: toolList.length > 0 ? toolList : [...TOOL_IDS],
        source: flag(args, 'source'),
        language: flag(args, 'lang') === 'en' ? 'en' : 'ko',
        gitHooks: !has(args, 'no-git-hooks'),
        force: has(args, 'force'),
      });
      console.log(`devctx init: ${report.root}`);
      for (const h of report.hookFiles) console.log(`  hook  ${h.action.padEnd(9)} ${h.file}`);
      if (report.gitHooks) {
        console.log(`  git   installed: ${report.gitHooks.installed.join(', ') || '-'}; present: ${report.gitHooks.present.join(', ') || '-'}`);
      }
      for (const f of report.compile.changed) console.log(`  gen   ${f}`);
      for (const n of report.notes) console.log(`  note  ${n}`);
      for (const w of report.compile.warnings) console.log(`  warn  ${w}`);
      console.log('\n커밋하면 팀원도 clone만으로 같은 규칙과 hook을 쓴다: .devctx/ AGENTS.md와 도구별 hook 파일');
      return 0;
    }

    case 'worker': {
      const report = await runWorker({
        root: resolveRoot(args),
        host: flag(args, 'host'),
        reason: flag(args, 'reason') ?? 'manual',
        allowLlm: !has(args, 'no-llm'),
      });
      if (process.env.DEVCTX_WORKER === '1') return 0;
      if (report.skipped) console.log(`skipped: ${report.skipped}`);
      console.log(`events ${report.processed}, candidates ${report.candidates}, retired ${report.retired}`);
      for (const a of report.applied) console.log(`  ${a.relation.padEnd(9)} ${a.itemId ?? '-'}${a.targetId ? ` (target ${a.targetId})` : ''}`);
      for (const f of report.compiled?.changed ?? []) console.log(`  gen   ${f}`);
      for (const e of report.errors) console.log(`  error ${e}`);
      return report.errors.length > 0 && report.applied.length === 0 && report.processed > 0 ? 1 : 0;
    }

    case 'compile': {
      const root = resolveRoot(args);
      const paths = projectPaths(root);
      const cfg = loadConfig(paths);
      if (has(args, 'check')) {
        const res = compile(paths, cfg, null, { check: true });
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
        const res = compile(paths, cfg, db, { tool: 'cli' });
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
        if (taskFlag !== 'all' && !(SUITE_TASKS as readonly string[]).includes(taskFlag)) throw new Error(`unknown task: ${taskFlag} (extract | judge | all)`);
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
        for (const task of SUITE_TASKS) console.log(`  ${task.padEnd(7)} -> ${r.selected[task] ?? 'no qualified model yet (the background worker evaluates candidates)'}`);
        console.log(`  ${'est/call'.padStart(9)}  ${'measured'.padStart(9)}  tier    ${'extract'.padEnd(12)} ${'judge'.padEnd(12)} candidate`);
        const allowed = r.models.filter((m) => m.auto);
        const shown = allowed.slice(0, 12);
        for (const m of shown) {
          const est = m.estimate.unit === 'usd' ? `$${m.estimate.cost.toFixed(4)}` : `x${m.estimate.cost.toFixed(4)}`;
          const real = m.measuredUsd === null ? '-' : `$${m.measuredUsd.toFixed(4)}`;
          console.log(
            `  ${`${est}${m.estimate.known ? '' : '~'}`.padStart(9)}  ${real.padStart(9)}  ${m.estimate.tier.padEnd(6)}  ${verdict(m.qualification.extract).padEnd(12)} ${verdict(m.qualification.judge).padEnd(12)} ${m.key}`,
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

    case 'status': {
      const paths = projectPaths(resolveRoot(args));
      const { items, errors } = loadItems(paths);
      const order = ['active', 'conflict', 'proposed', 'superseded', 'retired'];
      for (const status of order) {
        const list = items.filter((i) => i.status === status);
        if (list.length === 0) continue;
        console.log(`[${status}] ${list.length}`);
        for (const i of list) {
          const scope = i.scope.paths.length > 0 ? `  (${i.scope.paths.join(', ')})` : '';
          const extra = [i.reinforced > 0 ? `x${i.reinforced + 1}` : '', i.violations > 0 ? `violations ${i.violations}` : '', i.needs_review ? 'review' : '']
            .filter(Boolean)
            .join(' ');
          console.log(`  ${i.id.slice(-6)} ${i.enforcement.padEnd(6)} ${i.summary}${scope}${extra ? `  [${extra}]` : ''}`);
        }
      }
      const personal = loadPersonalItems().items.filter((i) => i.status === 'active');
      if (personal.length > 0) {
        console.log(`[personal] ${personal.length}`);
        for (const i of personal) console.log(`  ${i.id.slice(-6)} ${i.summary}`);
      }
      for (const e of errors) console.log(`unreadable: ${e.file}: ${e.error}`);
      if (items.length === 0 && personal.length === 0) console.log('아직 기록된 결정이 없다.');
      return 0;
    }

    case 'remember': {
      const text = args.positional.join(' ').trim();
      if (!text) throw new Error('usage: devctx remember "<rule>"');
      const root = resolveRoot(args);
      const paths = projectPaths(root);
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
          flags: ['remember', 'durable'],
          candidate: true,
        });
      } finally {
        db.close();
      }
      const report = await runWorker({ root, host: flag(args, 'host'), reason: 'remember', allowLlm: !has(args, 'no-llm') });
      for (const a of report.applied) console.log(`${a.relation} ${a.itemId ?? '-'}${a.targetId ? ` (target ${a.targetId})` : ''}`);
      if (report.applied.length === 0) console.log('기록할 규칙을 찾지 못했다.');
      for (const e of report.errors) console.log(`error ${e}`);
      return 0;
    }

    case 'version':
    case '--version':
    case '-v':
      console.log(packageInfo().version);
      return 0;

    default:
      console.log(HELP);
      return cmd === 'help' || cmd === '--help' || cmd === '-h' ? 0 : 1;
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
