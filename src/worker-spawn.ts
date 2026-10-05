import { spawn } from 'node:child_process';
import { cliEntry } from './util/paths.ts';

/**
 * Starts `devctx worker` detached so the hook returns immediately. The worker takes a lock, so
 * extra spawns while one is running exit right away.
 */
export function spawnWorker(root: string, reason: string, host: string | null): void {
  const entry = cliEntry();
  if (!entry || process.env.DEVCTX_NO_SPAWN === '1') return;
  const args = [
    ...process.execArgv.filter((a) => !a.startsWith('--inspect')),
    entry,
    'worker',
    '--root',
    root,
    '--reason',
    reason,
  ];
  if (host) args.push('--host', host);
  try {
    const child = spawn(process.execPath, args, {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, DEVCTX_WORKER: '1' },
    });
    child.unref();
  } catch {
    // The next hook or session start retries; events are already stored.
  }
}
