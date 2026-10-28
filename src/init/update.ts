import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.ts';
import { readJson } from '../util/fsx.ts';
import { git } from '../util/git.ts';
import { projectPaths } from '../util/paths.ts';
import { gitHooksPresent } from './githooks.ts';
import { installedPackage, installKey, isGitSource, npmSpecVersion, packageCli, readToolsLock, versionsDir, type ToolsLock } from './shim.ts';

/** What a project moves to. */
export interface UpdateTarget {
  source: string;
  /** Known before installing (release tag, npm version, local checkout); null for a branch head. */
  version: string | null;
  /** How it was found, for the output. */
  via: string;
}

export interface Installed {
  cli: string;
  version: string;
}

export function isLocalSource(source: string): boolean {
  return path.isAbsolute(source) || /^(\.\/|\.\.\/|~\/)/.test(source);
}

function localDir(root: string, source: string): string {
  return path.resolve(root, source.replace(/^~(?=\/)/, os.homedir()));
}

/**
 * The URLs `git ls-remote` takes for a git source as npm reads it (the `#ref` dropped). Hosted
 * shortcuts are tried over https first and then ssh, the order npm clones them in (a private
 * repository reached with an ssh key only works over ssh).
 */
export function gitRemoteUrls(source: string): string[] {
  const s = source.trim().replace(/#.*$/, '');
  const hosted = /^(github|gitlab|bitbucket):(.+)$/.exec(s) ?? (/^[\w.-]+\/[\w.-]+$/.test(s) ? [s, 'github', s] : null);
  if (hosted) {
    const host = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' }[hosted[1] as 'github' | 'gitlab' | 'bitbucket'];
    const repo = (hosted[2] as string).replace(/\.git$/, '');
    return [`https://${host}/${repo}.git`, `git@${host}:${repo}.git`];
  }
  return [s.replace(/^git\+/, '')];
}

/** `git ls-remote` over the first URL that answers (never waiting for a password or host-key prompt). */
function lsRemote(urls: string[], args: string[], root: string): { url: string; out: string } {
  const env: Record<string, string> = process.env.GIT_SSH_COMMAND ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
  let error = '';
  for (const url of urls) {
    const r = git(['ls-remote', ...args, url], root, 60_000, env);
    if (r.ok) return { url, out: r.stdout };
    error = `git ls-remote ${url} failed: ${lastLine(r.stderr) || `exit ${r.code}`}`;
  }
  throw new Error(error);
}

/**
 * Newest release tag (`v1.2.3` or `1.2.3`, no pre-releases) in `git ls-remote --tags` output, with
 * the commit it points at (an annotated tag's `^{}` line).
 */
export function latestReleaseTag(lsRemote: string): { tag: string; version: string; sha: string } | null {
  const direct = new Map<string, string>();
  const peeled = new Map<string, string>();
  for (const line of lsRemote.split('\n')) {
    const m = /^([0-9a-f]{40})\s+refs\/tags\/(.+?)(\^\{\})?$/.exec(line.trim());
    if (m) (m[3] ? peeled : direct).set(m[2] as string, m[1] as string);
  }
  let best: { tag: string; parts: number[]; sha: string } | null = null;
  const newer = (a: number[], b: number[]): boolean => (a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!) > 0;
  for (const [tag, sha] of direct) {
    const v = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag);
    if (!v) continue;
    const parts = [Number(v[1]), Number(v[2]), Number(v[3])];
    if (!best || newer(parts, best.parts)) best = { tag, parts, sha: peeled.get(tag) ?? sha };
  }
  return best ? { tag: best.tag, version: best.parts.join('.'), sha: best.sha } : null;
}

/** `@scope/devctx@1.2.3` -> `@scope/devctx`. */
export function npmName(spec: string): string {
  const s = spec.trim();
  const at = s.indexOf('@', s.startsWith('@') ? 1 : 0);
  return at > 0 ? s.slice(0, at) : s;
}

function npmBin(): string {
  const next = path.join(path.dirname(process.execPath), 'npm');
  return fs.existsSync(next) ? next : 'npm';
}

function lastLine(text: string): string {
  return text.trim().split('\n').filter(Boolean).slice(-3).join(' | ');
}

function packageVersion(dir: string): string | null {
  return readJson<{ version?: string }>(path.join(dir, 'package.json'), {}).version ?? null;
}

/**
 * The newest devctx where `source` comes from: the newest release tag of a git source (pinned to
 * its commit, so the lock stays immutable) or its default branch while there is no tag yet, the
 * latest npm version, or a local checkout as it is now.
 */
export function resolveLatest(source: string, root: string): UpdateTarget {
  // Passed to git and npm as an argument: never let a value from tools.lock read as an option.
  if (/^-/.test(source.trim()) || gitRemoteUrls(source).some((u) => u.startsWith('-'))) throw new Error(`invalid devctx_source: ${source}`);
  if (isLocalSource(source)) {
    const dir = localDir(root, source);
    const version = packageVersion(dir);
    if (!version || !packageCli(dir)) throw new Error(`${source} is not a devctx checkout (no package.json with dist/cli.js or src/cli.ts)`);
    return { source, version, via: '로컬 checkout' };
  }
  if (isGitSource(source)) {
    const base = source.trim().replace(/#.*$/, '');
    const tags = lsRemote(gitRemoteUrls(source), ['--tags'], root);
    const release = latestReleaseTag(tags.out);
    if (release) return { source: `${base}#${release.sha}`, version: release.version, via: `릴리스 ${release.tag}` };
    const head = lsRemote([tags.url], [], root);
    const sha = head.out.split('\n').map((l) => /^([0-9a-f]{40})\s+HEAD$/.exec(l.trim())?.[1]).find(Boolean);
    if (!sha) throw new Error(`git ls-remote ${tags.url}: no HEAD`);
    return { source: `${base}#${sha}`, version: null, via: '기본 브랜치의 최신 커밋, 릴리스 태그 없음' };
  }
  const name = npmName(source);
  const r = spawnSync(npmBin(), ['view', name, 'version'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  const version = r.status === 0 ? r.stdout.trim().split('\n').pop()?.trim() : '';
  if (!version) throw new Error(`npm view ${name} version failed: ${lastLine(r.stderr ?? '') || `exit ${r.status}`}`);
  return { source: `${name}@${version}`, version, via: `npm ${name}@latest` };
}

/** A source given with `--source`: used as written. */
export function givenTarget(source: string, root: string): UpdateTarget {
  if (/^-/.test(source.trim())) throw new Error(`invalid --source: ${source}`);
  if (isLocalSource(source)) return { ...resolveLatest(source, root), via: '--source' };
  return { source, version: npmSpecVersion(source), via: '--source' };
}

/** Already on `target`: same source, and the same version when it is known up front. */
export function isCurrent(lock: ToolsLock, target: UpdateTarget): boolean {
  return lock.source === target.source && (target.version === null || target.version === lock.version);
}

/**
 * Puts `target` where the shim looks for it (`<versions>/<version>-<source>`), so hooks find it as
 * soon as tools.lock names it. npm installs into a staging directory first: the version (part of
 * the directory name) of a git commit is known only from its package.json.
 */
export function installTarget(target: UpdateTarget, root: string): Installed {
  if (isLocalSource(target.source)) {
    const dir = localDir(root, target.source);
    const cli = packageCli(dir);
    const version = packageVersion(dir);
    if (!cli || !version) throw new Error(`${target.source} is not a devctx checkout`);
    return { cli, version };
  }
  const versions = versionsDir();
  // Node never strips types under node_modules: an install runs only from a built dist/cli.js.
  const found = (dir: string): Installed | null => {
    const pkg = installedPackage(dir);
    const version = pkg ? packageVersion(pkg) : null;
    const cli = pkg ? path.join(pkg, 'dist', 'cli.js') : '';
    return pkg && version && fs.existsSync(cli) ? { cli, version } : null;
  };
  if (target.version) {
    const have = found(path.join(versions, installKey({ version: target.version, source: target.source })));
    if (have) return have;
  }
  fs.mkdirSync(versions, { recursive: true });
  const staging = path.join(versions, `.update-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(staging);
  try {
    // npm 12 refuses git sources unless allowed; older npm only warns about the unknown flag.
    const r = spawnSync(npmBin(), ['install', '--prefix', staging, '--no-save', '--no-audit', '--no-fund', '--allow-git=all', target.source], {
      cwd: staging,
      encoding: 'utf8',
      timeout: 600_000,
    });
    const staged = found(staging);
    if (r.status !== 0) throw new Error(`npm install ${target.source} failed: ${lastLine(`${r.stderr ?? ''}\n${r.error?.message ?? ''}`) || `exit ${r.status}`}`);
    if (!staged) {
      throw new Error(
        installedPackage(staging)
          ? `${target.source} installed without dist/cli.js: npm did not run its "prepare" build (npm 12 blocks it for git sources unless allowed), and Node cannot run src/cli.ts from node_modules`
          : `npm installed ${target.source} but no devctx package was found`,
      );
    }
    const final = path.join(versions, installKey({ version: staged.version, source: target.source }));
    if (!found(final)) {
      fs.rmSync(final, { recursive: true, force: true });
      fs.renameSync(staging, final);
      fs.rmSync(`${final}.install-failed`, { force: true });
    }
    const done = found(final);
    if (!done) throw new Error(`installed ${target.source} but found no devctx CLI in ${final}`);
    return done;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Re-runs `init` with the new devctx itself, so tools.lock, the shim, hook commands and skills are
 * the ones that version writes. The project's own choices are kept: its tools (config `targets`)
 * and whether git hooks are wanted.
 */
export function applyTarget(root: string, installed: Installed, source: string): { code: number; stdout: string; stderr: string } {
  const cfg = loadConfig(projectPaths(root));
  const args = ['init', '--root', root, '--source', source, '--tools', cfg.targets.join(',')];
  if (!cfg.git.auto_install_hooks && !gitHooksPresent(root)) args.push('--no-git-hooks');
  const node = installed.cli.endsWith('.ts') ? ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'] : ['--disable-warning=ExperimentalWarning'];
  const r = spawnSync(process.execPath, [...node, installed.cli, ...args], { cwd: root, encoding: 'utf8', timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: `${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}` };
}

export interface UpdateResult {
  root: string;
  status: 'updated' | 'current' | 'available' | 'failed';
  from: ToolsLock | null;
  to: UpdateTarget | null;
  /** Version written to tools.lock (updated) or the one a check found. */
  version: string | null;
  error?: string;
}

export interface UpdateOptions {
  /** Pin this source instead of looking up the newest one. */
  source: string | null;
  /** Report what would change without installing or writing anything. */
  check: boolean;
  print: (line: string) => void;
  /** Shared across projects: one lookup per source and one install per target. */
  cache?: { latest: Map<string, UpdateTarget>; installed: Map<string, Installed> };
}

/** Moves one project to the newest devctx (or `opts.source`). Never throws: failures are a result. */
export function updateProject(root: string, opts: UpdateOptions): UpdateResult {
  const lock = readToolsLock(projectPaths(root).toolsLock);
  const result: UpdateResult = { root, status: 'failed', from: lock, to: null, version: null };
  const { print } = opts;
  try {
    if (!lock?.source) throw new Error('.devctx/tools.lock has no devctx_source (run "devctx init" first)');
    print(`  현재  ${lock.version || '?'}  ${lock.source}`);
    const key = isLocalSource(lock.source) ? localDir(root, lock.source) : lock.source.replace(/#.*$/, '');
    let target = opts.source ? givenTarget(opts.source, root) : opts.cache?.latest.get(key);
    if (!target) {
      target = resolveLatest(lock.source, root);
      opts.cache?.latest.set(key, target);
    }
    result.to = target;
    result.version = target.version;
    if (isCurrent(lock, target)) {
      print(`  최신이다 (${target.via})`);
      result.status = 'current';
      return result;
    }
    print(`  최신  ${target.version ?? '?'}  ${target.source}  (${target.via})`);
    if (opts.check) {
      result.status = 'available';
      return result;
    }
    const cacheKey = isLocalSource(target.source) ? localDir(root, target.source) : target.source;
    let installed = opts.cache?.installed.get(cacheKey);
    if (!installed) {
      if (!isLocalSource(target.source)) print(`  설치  ${target.source}`);
      installed = installTarget(target, root);
      opts.cache?.installed.set(cacheKey, installed);
    }
    result.version = installed.version;
    const run = applyTarget(root, installed, target.source);
    for (const line of run.stdout.trimEnd().split('\n')) if (line) print(line);
    if (run.code !== 0) throw new Error(`devctx ${installed.version} init exited with ${run.code}: ${lastLine(run.stderr)}`);
    result.status = 'updated';
  } catch (error) {
    result.status = 'failed';
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}
