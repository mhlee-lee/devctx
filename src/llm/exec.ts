import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
  error?: string;
}

const MAX_OUTPUT = 8 * 1024 * 1024;

/** Directories GUI-launched IDEs often miss from PATH (nvm, ~/.local/bin, Homebrew, ...). */
function extraBinDirs(): string[] {
  const home = os.homedir();
  const dirs = [
    path.dirname(process.execPath),
    path.join(home, '.local', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.cursor', 'bin'),
    path.join(home, '.kiro', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ];
  const nvm = path.join(home, '.nvm', 'versions', 'node');
  try {
    for (const v of fs.readdirSync(nvm).sort().reverse()) dirs.push(path.join(nvm, v, 'bin'));
  } catch {
    // no nvm
  }
  return dirs;
}

export function findBinary(names: readonly string[]): string | null {
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean), ...extraBinDirs()];
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = path.join(dir, name + ext);
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          if (fs.statSync(candidate).isFile()) return candidate;
        } catch {
          // keep looking
        }
      }
    }
  }
  return null;
}

/**
 * Runs a CLI without a shell. Child processes get DEVCTX_INTERNAL=1 so any devctx hook they
 * trigger exits immediately (no recursive capture), and stdin is closed.
 */
export function runProcess(
  cmd: string,
  args: readonly string[],
  opts: { cwd: string; timeoutMs: number; env?: Record<string, string> },
): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, ms: Date.now() - started, ...(error ? { error } : {}) });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, [...args], {
        cwd: opts.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, DEVCTX_INTERNAL: '1', NO_COLOR: '1', FORCE_COLOR: '0', ...opts.env },
      });
    } catch (error) {
      finish(null, (error as Error).message);
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, opts.timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString('utf8');
    });
    child.on('error', (error) => finish(null, error.message));
    child.on('close', (code) => finish(code));
  });
}

/** An empty scratch directory so the child CLI loads no project config or project hooks. */
export function tempWorkdir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `devctx-${prefix}-`));
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}
