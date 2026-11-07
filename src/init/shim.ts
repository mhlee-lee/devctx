import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, readText } from '../util/fsx.ts';
import { git } from '../util/git.ts';
import { packageRoot } from '../util/paths.ts';

export interface ToolsLock {
  version: string;
  source: string;
}

export function packageInfo(): { name: string; version: string } {
  const pkg = readJson<{ name?: string; version?: string }>(path.join(packageRoot(), 'package.json'), {});
  return { name: pkg.name ?? 'devctx', version: pkg.version ?? '0.0.0' };
}

/** Turn a remote into an npm git spec, keeping the exact commit (also for npx installs). */
function pinnedGitSource(remote: string, sha: string): string | null {
  if (!/^[0-9a-f]{40}$/i.test(sha) || /^git\+file:/.test(remote)) return null;
  const hosted = /^(?:git\+)?(?:https?:\/\/|ssh:\/\/git@|git@)(github\.com|gitlab\.com|bitbucket\.org)[/:](.+?)(?:\.git)?$/.exec(remote);
  if (hosted) {
    const host = { 'github.com': 'github', 'gitlab.com': 'gitlab', 'bitbucket.org': 'bitbucket' }[hosted[1]!];
    return `${host}:${hosted[2]}#${sha}`;
  }
  if (/^(github:|gitlab:|bitbucket:|git\+|git:\/\/)/.test(remote)) return `${remote}#${sha}`;
  if (/^(https?|ssh):\/\//.test(remote)) return `git+${remote}#${sha}`;
  const ssh = /^([^@\s]+@[^:\s]+):(.+)$/.exec(remote);
  return ssh ? `git+ssh://${ssh[1]}/${ssh[2]}#${sha}` : null;
}

/**
 * Pin the package, never the temporary npx directory. Git installs keep their resolved commit;
 * registry installs keep their exact version. An unidentifiable private package needs --source.
 */
export function defaultSource(root = packageRoot()): string {
  const pkg = readJson<{ name?: string; version?: string; private?: boolean; _resolved?: string }>(path.join(root, 'package.json'), {});
  let modules = root;
  while (path.basename(modules) !== 'node_modules' && path.dirname(modules) !== modules) modules = path.dirname(modules);
  if (path.basename(modules) === 'node_modules') {
    const entry = path.relative(path.dirname(modules), root).split(path.sep).join('/');
    const provenance = [pkg._resolved];
    for (const file of [path.join(modules, '.package-lock.json'), path.join(path.dirname(modules), 'package-lock.json')]) {
      const lock = readJson<{ packages?: Record<string, { resolved?: string }> }>(file, {});
      provenance.push(lock.packages?.[entry]?.resolved);
    }
    const resolved = provenance.find((s) => s && isGitSource(s));
    if (resolved) {
      const source = sourcePinProblem(resolved) === null ? pinnedGitSource(resolved.replace(/#.*$/, ''), resolved.slice(resolved.indexOf('#') + 1)) : null;
      if (source) return source;
    } else if (!pkg.private && pkg.name && pkg.version) {
      return `${pkg.name}@${pkg.version}`;
    }
  } else {
    const top = git(['rev-parse', '--show-toplevel'], root);
    if (top.ok && fs.realpathSync(top.stdout) === fs.realpathSync(root)) {
      const remote = git(['remote', 'get-url', 'origin'], root);
      const head = git(['rev-parse', 'HEAD'], root);
      const source = remote.ok && head.ok ? pinnedGitSource(remote.stdout, head.stdout) : null;
      if (source) return source;
    }
  }
  throw new Error('Cannot determine a portable devctx package source. Run devctx init --source <git URL with commit SHA or exact npm version>. For local development, pass --source <checkout path> explicitly.');
}

export function renderToolsLock(lock: ToolsLock): string {
  return `# devctx 실행 파일 고정 (Git으로 공유). clone만 하면 .devctx/bin/devctx가 이 버전을 찾거나 설치한다.
devctx_version: ${lock.version}
# 바뀌지 않는 위치로 고정한다: 정확한 npm 버전(@scope/devctx@1.2.3) 또는 커밋 SHA를 붙인 git URL
# (github:owner/repo#<40자리 SHA>). 이 머신의 로컬 경로는 이 PC에서만 동작한다
devctx_source: ${lock.source}
`;
}

export function parseToolsLock(text: string | null): ToolsLock | null {
  if (!text) return null;
  const get = (key: string): string =>
    (text.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))?.[1] ?? '').replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim();
  const version = get('devctx_version');
  const source = get('devctx_source');
  return version || source ? { version, source } : null;
}

export function readToolsLock(file: string): ToolsLock | null {
  return parseToolsLock(readText(file));
}

export interface ShimStatus {
  lock: ToolsLock | null;
  /** The CLI this PC's hooks run (same search as the shim, without DEVCTX_CLI), or null. */
  cli: string | null;
  /** `version` of the package that CLI belongs to. */
  installedVersion: string | null;
  /** The last background install failed: when, and the end of its log. */
  failed: { at: string; log: string } | null;
  installing: boolean;
}

/** The shim's install directory name (same rule as `key=` in the shim). */
export function installKey(lock: ToolsLock): string {
  const safe = Array.from(Buffer.from(lock.source, 'utf8'), (b) => (/[A-Za-z0-9.-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : '_')).join('');
  return `${lock.version}-${safe.length > 120 ? `${safe.slice(0, 60)}${safe.slice(-60)}` : safe}`;
}

/** `name@1.2.3` (exact version only) -> `1.2.3`. */
export function npmSpecVersion(source: string): string | null {
  return source.match(/^(?:@[^/@\s]+\/)?[^/@\s]+@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/)?.[1] ?? null;
}

function dataDir(): string {
  if (process.env.DEVCTX_HOME) return path.resolve(process.env.DEVCTX_HOME);
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'devctx');
}

/** Where the shim installs each (version, source): `<dir>/<installKey>`. */
export function versionsDir(): string {
  return path.join(dataDir(), 'versions');
}

/** `dist/cli.js` (built) or else `src/cli.ts` (type stripping) of a devctx package directory. */
export function packageCli(pkg: string): string | null {
  return [path.join(pkg, 'dist', 'cli.js'), path.join(pkg, 'src', 'cli.ts')].find((f) => fs.existsSync(f)) ?? null;
}

/** The built npx package, or a legacy install under `<prefix>/node_modules`. */
export function installedPackage(prefix: string): string | null {
  const base = path.join(prefix, 'node_modules');
  // npx owns the install. Only this PC's pointer to its cache is kept here; never in tools.lock.
  const runtime = readText(path.join(prefix, 'runtime'))?.trim();
  const candidates = [...(runtime ? [runtime] : []), path.join(base, 'devctx')];
  try {
    for (const scope of fs.readdirSync(base)) if (scope.startsWith('@')) candidates.push(path.join(base, scope, 'devctx'));
  } catch {
    // not installed
  }
  return candidates.find((pkg) => fs.existsSync(path.join(pkg, 'dist', 'cli.js'))) ?? null;
}

/** Reuse the npx package that is already running init, so the first hook can capture immediately. */
export function rememberRuntime(lock: ToolsLock, root = packageRoot()): void {
  if (!root.split(path.sep).includes('node_modules') || !fs.existsSync(path.join(root, 'dist', 'cli.js'))) return;
  const target = path.join(versionsDir(), installKey(lock));
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'runtime'), `${root}\n`);
}

/** A git URL or a hosted-git shortcut (`github:owner/repo`, `owner/repo`), as npm reads `devctx_source`. */
export function isGitSource(source: string): boolean {
  const s = source.trim();
  return /^(github:|gitlab:|bitbucket:|git\+|git:\/\/|git@|https?:\/\/[^#]*\.git(#|$))/.test(s) || /^[\w.-]+\/[\w.-]+(#.*)?$/.test(s);
}

/**
 * What the committed shim finds on this PC. `devctx doctor` may itself run from a global install,
 * so it checks the hooks' own path: an install that npm refused shows up here, not as "ok".
 */
export function shimStatus(root: string): ShimStatus {
  const lock = readToolsLock(path.join(root, '.devctx', 'tools.lock'));
  const status: ShimStatus = { lock, cli: null, installedVersion: null, failed: null, installing: false };
  if (!lock) return status;
  const target = path.join(versionsDir(), installKey(lock));
  const local = lock.source && fs.existsSync(lock.source) && fs.statSync(lock.source).isDirectory() && packageCli(lock.source) ? lock.source : null;
  const pkg = installedPackage(target) ?? local;
  if (pkg) {
    status.cli = packageCli(pkg);
    status.installedVersion = readJson<{ version?: string }>(path.join(pkg, 'package.json'), {}).version ?? null;
  }
  const failedFile = `${target}.install-failed`;
  if (!status.cli && fs.existsSync(failedFile)) {
    const log = (readText(`${target}.install.log`) ?? '').trim().split('\n').slice(-4).join(' | ');
    status.failed = { at: fs.statSync(failedFile).mtime.toISOString(), log };
  }
  status.installing = fs.existsSync(`${target}.installing`);
  return status;
}

/**
 * Why a `devctx_source` is not pinned to fixed content (null when it is). Teammates' machines
 * install and run whatever the source points at when a hook first runs, so it should name
 * immutable content: an exact npm version, or a git URL with a full commit SHA. A branch or tag
 * can be moved to other code after the team reviewed it.
 */
export function sourcePinProblem(source: string): string | null {
  const s = source.trim();
  if (!s || /^(\/|\.\/|\.\.\/|~)/.test(s)) return null; // local paths are reported separately
  if (isGitSource(s)) {
    const ref = s.includes('#') ? s.slice(s.indexOf('#') + 1) : '';
    if (/^[0-9a-f]{40}$/i.test(ref.replace(/^commit[:=]/, ''))) return null;
    return ref ? `git ref "${ref}" can be moved; pin a full commit SHA (#<40-hex>)` : 'git source without a ref follows the default branch; pin a full commit SHA (#<40-hex>)';
  }
  const at = s.lastIndexOf('@');
  const version = at > 0 ? s.slice(at + 1) : '';
  if (/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) return null;
  return version ? `npm version "${version}" is a tag or range; pin an exact version (name@x.y.z)` : 'npm spec without a version installs the latest release; pin an exact version (name@x.y.z)';
}

/**
 * POSIX shim committed at `.devctx/bin/devctx`. It finds node (IDEs launched from the Dock often
 * lack the shell PATH) and the pinned CLI; on a fresh clone it installs the pinned version in the
 * background. In hook mode it never fails or blocks the AI tool.
 */
export function renderShim(): string {
  return `#!/bin/sh
# devctx shim (generated by "devctx init", commit it). Runs the devctx version pinned in
# .devctx/tools.lock. npx owns the installs. Hooks never block; failures warn at most daily.
quiet=0
case "\${1:-}" in hook|git-hook) quiet=1 ;; esac
if [ "\${1:-}" = "hook" ] && [ -n "\${DEVCTX_INTERNAL:-}" ]; then exit 0; fi

hook_fallback() {
  # Cursor's beforeSubmitPrompt expects {"continue": true}.
  case " $* " in *" --tool cursor "*"--event prompt"*) printf '{"continue":true}' ;; esac
  exit 0
}

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." 2>/dev/null && pwd)
lock="$root/.devctx/tools.lock"
version=$(sed -n 's/^devctx_version:[[:space:]]*//p' "$lock" 2>/dev/null | sed 's/[[:space:]][[:space:]]*#.*$//' | tr -d '"'"'"'\\r ')
source=$(sed -n 's/^devctx_source:[[:space:]]*//p' "$lock" 2>/dev/null | sed 's/[[:space:]][[:space:]]*#.*$//' | tr -d '"'"'"'\\r')
data="\${DEVCTX_HOME:-\${XDG_DATA_HOME:-$HOME/.local/share}/devctx}"
# One install per (version, source): a new commit SHA with an unchanged package version still
# gets its own copy instead of reusing the old one. A long source keeps both ends (the SHA is last).
key_src=$(printf '%s' "$source" | LC_ALL=C tr -c 'A-Za-z0-9.-' '_')
if [ "\${#key_src}" -gt 120 ]; then
  key_src="$(printf '%s' "$key_src" | cut -c1-60)$(printf '%s' "$key_src" | tail -c 60)"
fi
key="$version-$key_src"
target="$data/versions/$key"
log="$target.install.log"
failed="$target.install-failed"
busy="$target.installing"
warned="$target.warned"

warn_failure() {
  [ -f "$failed" ] || return 0
  if [ -f "$warned" ] && [ -n "$(find "$warned" -mmin -1440 2>/dev/null)" ]; then return 0; fi
  echo "devctx: automatic capture is unavailable in $root. Run devctx doctor; details: $log" >&2
  date >"$warned" 2>/dev/null
}

runtime_failure() {
  message="$1"; shift
  mkdir -p "$data/versions" 2>/dev/null
  if [ "$(cat "$log" 2>/dev/null)" != "$message" ]; then
    printf '%s\\n' "$message" >"$log" 2>/dev/null
    date >"$failed" 2>/dev/null
    rm -f "$warned" 2>/dev/null
  fi
  if [ "$quiet" = 1 ]; then warn_failure; hook_fallback "$@"; fi
  echo "devctx: $message" >&2
  exit 1
}

# node:sqlite without a flag: Node 22.13+, 23.4+ or 24+. A binary that passed is remembered by path.
node_ok() {
  [ -x "$1" ] || return 1
  [ "$(cat "$data/node-ok" 2>/dev/null)" = "2:$1" ] && return 0
  v=$("$1" -v 2>/dev/null) || return 1
  v=\${v#v}; major=\${v%%.*}; rest=\${v#*.}; minor=\${rest%%.*}
  case "$major$minor" in ''|*[!0-9]*) return 1 ;; esac
  if [ "$major" -ge 24 ] || { [ "$major" -eq 23 ] && [ "$minor" -ge 4 ]; } || { [ "$major" -eq 22 ] && [ "$minor" -ge 13 ]; }; then
    mkdir -p "$data" 2>/dev/null && printf '2:%s' "$1" > "$data/node-ok" 2>/dev/null
    return 0
  fi
  return 1
}

find_node() {
  if c=$(command -v node 2>/dev/null) && node_ok "$c"; then echo "$c"; return 0; fi
  # IDEs launched from the Dock often lack the shell PATH. nvm: newest first by number, not by
  # name (v9 < v22, v22.9 < v22.13).
  if [ -d "$HOME/.nvm/versions/node" ]; then
    for v in $(ls "$HOME/.nvm/versions/node" 2>/dev/null | sed -n 's/^v\\([0-9][0-9.]*\\)$/\\1/p' | sort -t. -k1,1nr -k2,2nr -k3,3nr); do
      if node_ok "$HOME/.nvm/versions/node/v$v/bin/node"; then echo "$HOME/.nvm/versions/node/v$v/bin/node"; return 0; fi
    done
  fi
  for n in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node" /usr/bin/node; do
    if node_ok "$n"; then echo "$n"; return 0; fi
  done
  return 1
}

if ! node_bin=$(find_node); then
  runtime_failure "node >= 22.13 not found" "$@"
fi

cli=""
runtime=$(cat "$target/runtime" 2>/dev/null)
for c in "\${DEVCTX_CLI:-}" \\
  "\${runtime:+$runtime/dist/cli.js}" \\
  "$data/versions/$key/node_modules/devctx/dist/cli.js" \\
  "$data/versions/$key"/node_modules/@*/devctx/dist/cli.js \\
  "$source/dist/cli.js" \\
  "$source/src/cli.ts"; do
  if [ -n "$c" ] && [ -f "$c" ]; then cli="$c"; break; fi
done

if [ -z "$cli" ]; then
  installable=1
  if [ -z "$source" ] || [ -d "$source" ]; then installable=0; fi
  # A local path that is missing here (e.g. someone else's checkout) can't be installed either;
  # without this every hook call would spawn a failing npm install.
  case "$source" in /*|./*|../*) [ -e "$source" ] || installable=0 ;; esac
  if [ "$installable" = 0 ]; then
    runtime_failure "CLI not found at $source. Run devctx init --source <git URL with commit SHA or exact npm version> to repair .devctx/tools.lock" "$@"
  fi
  npm_bin="$(dirname "$node_bin")/npm"
  [ -x "$npm_bin" ] || npm_bin=npm
  # npm exec is npx. Use a separate prefix so the project's dependencies or a global devctx
  # cannot satisfy the requested package. npx keeps the actual package in its own cache.
  do_install() {
    mkdir -p "$target" || return 1
    npx_cli=$(PATH="$(dirname "$node_bin"):$PATH" "$npm_bin" exec --prefix "$target" --yes --no-audit --no-fund --allow-git=all --package "$source" --call 'command -v devctx') || return 1
    npx_cli=$(printf '%s\\n' "$npx_cli" | tail -n 1)
    npx_pkg=$("$node_bin" -e 'const fs = require("node:fs"), p = require("node:path"); console.log(p.dirname(p.dirname(fs.realpathSync(process.argv[1]))))' "$npx_cli") || return 1
    [ -f "$npx_pkg/dist/cli.js" ] || { echo "npx package has no dist/cli.js (its prepare build did not run)" >&2; return 1; }
    printf '%s\\n' "$npx_pkg" >"$target/runtime"
  }
  # One install at a time. A lock left by an install that was killed (sleep, reboot) is taken
  # over after 30 minutes and recreated, so its age starts again.
  take_lock() {
    mkdir -p "$data/versions" 2>/dev/null
    mkdir "$busy" 2>/dev/null && return 0
    [ -n "$(find "$busy" -maxdepth 0 -mmin +30 2>/dev/null)" ] || return 1
    rmdir "$busy" 2>/dev/null
    mkdir "$busy" 2>/dev/null
  }
  if [ "$quiet" = 1 ]; then
    warn_failure
    # Hooks: a failed install is retried after an hour, not on every hook call and commit.
    if [ -f "$failed" ] && [ -n "$(find "$failed" -mmin -60 2>/dev/null)" ]; then hook_fallback "$@"; fi
    # First run on this machine: install in the background, a later call uses it.
    if take_lock; then
      ( if do_install >"$log" 2>&1; then rm -f "$failed" "$warned"; else date >"$failed"; fi; rmdir "$busy" 2>/dev/null ) </dev/null >/dev/null 2>&1 &
    fi
    hook_fallback "$@"
  fi
  # A command run by a person installs now (also right after a failure: that is the retry).
  if ! take_lock; then
    echo "devctx: $source is being installed in the background; try again in a minute" >&2
    exit 1
  fi
  if do_install >"$log" 2>&1; then rm -f "$failed" "$warned"; rmdir "$busy" 2>/dev/null; else date >"$failed"; rmdir "$busy" 2>/dev/null; cat "$log" >&2; exit 1; fi
  runtime=$(cat "$target/runtime" 2>/dev/null)
  cli="$runtime/dist/cli.js"
fi

rm -f "$failed" "$warned" 2>/dev/null
case "$cli" in
  *.ts) exec "$node_bin" --experimental-strip-types --disable-warning=ExperimentalWarning "$cli" "$@" ;;
esac
exec "$node_bin" --disable-warning=ExperimentalWarning "$cli" "$@"
`;
}
