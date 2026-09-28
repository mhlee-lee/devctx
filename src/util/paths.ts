import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ProjectPaths {
  root: string;
  devctx: string;
  config: string;
  toolsLock: string;
  shim: string;
  knowledge: string;
  preamble: string;
  decisions: string;
  context: string;
  runbooks: string;
  lessons: string;
  local: string;
  stateDb: string;
  log: string;
  workerLock: string;
  agentsMd: string;
}

export function projectPaths(root: string): ProjectPaths {
  const devctx = path.join(root, '.devctx');
  const knowledge = path.join(devctx, 'knowledge');
  const local = path.join(devctx, 'local');
  return {
    root,
    devctx,
    config: path.join(devctx, 'config.yaml'),
    toolsLock: path.join(devctx, 'tools.lock'),
    shim: path.join(devctx, 'bin', 'devctx'),
    knowledge,
    preamble: path.join(knowledge, 'preamble.md'),
    decisions: path.join(knowledge, 'decisions'),
    context: path.join(knowledge, 'context'),
    runbooks: path.join(knowledge, 'runbooks'),
    lessons: path.join(knowledge, 'lessons'),
    local,
    stateDb: path.join(local, 'state.sqlite'),
    log: path.join(local, 'devctx.log'),
    workerLock: path.join(local, 'worker.lock'),
    agentsMd: path.join(root, 'AGENTS.md'),
  };
}

/** Walks up from `start` to the directory that holds `.devctx/config.yaml`. */
export function findProjectRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.devctx', 'config.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Machine-level data directory (never inside a repository). */
export function machineDir(): string {
  if (process.env.DEVCTX_HOME) return path.resolve(process.env.DEVCTX_HOME);
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'devctx');
}

export function personalDir(): string {
  return path.join(machineDir(), 'personal');
}

/** Root of the installed devctx package (works from both src/ and dist/). */
export function packageRoot(): string {
  return path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
}

export function toPosixRelative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}
