import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, readText } from '../util/fsx.ts';
import { packageRoot } from '../util/paths.ts';

export interface ToolsLock {
  version: string;
  source: string;
}

export function packageInfo(): { name: string; version: string } {
  const pkg = readJson<{ name?: string; version?: string }>(path.join(packageRoot(), 'package.json'), {});
  return { name: pkg.name ?? 'devctx', version: pkg.version ?? '0.0.0' };
}

/**
 * Where teammates' shims install devctx from. A local checkout is recorded as a path (works on
 * this machine only); an installed package as `<name>@<version>`.
 */
export function defaultSource(): string {
  const root = packageRoot();
  if (root.split(path.sep).includes('node_modules')) {
    const { name, version } = packageInfo();
    return `${name}@${version}`;
  }
  return root;
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

/**
 * What the committed shim finds on this PC. `devctx doctor` may itself run from a global install,
 * so it checks the hooks' own path: an install that npm refused shows up here, not as "ok".
 */
export function shimStatus(root: string): ShimStatus {
  const lock = readToolsLock(path.join(root, '.devctx', 'tools.lock'));
  const status: ShimStatus = { lock, cli: null, installedVersion: null, failed: null, installing: false };
  if (!lock) return status;
  const target = path.join(dataDir(), 'versions', installKey(lock));
  const inModules = (base: string): string[] => {
    const out = [path.join(base, 'devctx')];
    try {
      for (const scope of fs.readdirSync(base)) if (scope.startsWith('@')) out.push(path.join(base, scope, 'devctx'));
    } catch {
      // not installed
    }
    return out;
  };
  const pkgs = [
    ...inModules(path.join(target, 'node_modules')),
    ...(lock.source && fs.existsSync(lock.source) && fs.statSync(lock.source).isDirectory() ? [lock.source] : []),
  ];
  for (const pkg of pkgs) {
    const cli = [path.join(pkg, 'dist', 'cli.js'), path.join(pkg, 'src', 'cli.ts')].find((f) => fs.existsSync(f));
    if (cli) {
      status.cli = cli;
      status.installedVersion = readJson<{ version?: string }>(path.join(pkg, 'package.json'), {}).version ?? null;
      break;
    }
  }
  if (!status.cli) {
    const local = path.join(root, 'node_modules', 'devctx', 'dist', 'cli.js');
    if (fs.existsSync(local)) status.cli = local;
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
  const git = /^(github:|gitlab:|bitbucket:|git\+|git:\/\/|git@|https?:\/\/[^#]*\.git(#|$))/.test(s) || /^[\w.-]+\/[\w.-]+(#.*)?$/.test(s);
  if (git) {
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
# .devctx/tools.lock. Hook calls (AI tools and git hooks) never fail, print errors or block.
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
  [ "$quiet" = 1 ] && hook_fallback "$@"
  echo "devctx: node >= 22.13 not found" >&2
  exit 1
fi

cli=""
# src/cli.ts runs through Node's type stripping: npm 12 blocks the "prepare" build of git
# installs, so an installed package may ship sources without dist/.
for c in "\${DEVCTX_CLI:-}" \\
  "$data/versions/$key/node_modules/devctx/dist/cli.js" \\
  "$data/versions/$key"/node_modules/@*/devctx/dist/cli.js \\
  "$data/versions/$key/node_modules/devctx/src/cli.ts" \\
  "$data/versions/$key"/node_modules/@*/devctx/src/cli.ts \\
  "$source/dist/cli.js" \\
  "$source/src/cli.ts" \\
  "$root/node_modules/devctx/dist/cli.js"; do
  if [ -n "$c" ] && [ -f "$c" ]; then cli="$c"; break; fi
done

if [ -z "$cli" ]; then
  installable=1
  if [ -z "$source" ] || [ -d "$source" ]; then installable=0; fi
  # A local path that is missing here (e.g. someone else's checkout) can't be installed either;
  # without this every hook call would spawn a failing npm install.
  case "$source" in /*|./*|../*) [ -e "$source" ] || installable=0 ;; esac
  if [ "$installable" = 0 ]; then
    [ "$quiet" = 1 ] && hook_fallback "$@"
    echo "devctx: CLI not found. Set devctx_source in .devctx/tools.lock to an npm spec or git URL" >&2
    exit 1
  fi
  npm_bin="$(dirname "$node_bin")/npm"
  [ -x "$npm_bin" ] || npm_bin=npm
  target="$data/versions/$key"
  log="$target.install.log"
  failed="$target.install-failed"
  busy="$target.installing"
  # npm 12 refuses git sources unless allowed; older npm only warns about the unknown flag.
  do_install() {
    mkdir -p "$target" && "$npm_bin" install --prefix "$target" --no-save --no-audit --no-fund --allow-git=all "$source"
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
    # Hooks: a failed install is retried after an hour, not on every hook call and commit.
    if [ -f "$failed" ] && [ -n "$(find "$failed" -mmin -60 2>/dev/null)" ]; then hook_fallback "$@"; fi
    # First run on this machine: install in the background, a later call uses it.
    if take_lock; then
      ( if do_install >"$log" 2>&1; then rm -f "$failed"; else date >"$failed"; fi; rmdir "$busy" 2>/dev/null ) </dev/null >/dev/null 2>&1 &
    fi
    hook_fallback "$@"
  fi
  # A command run by a person installs now (also right after a failure: that is the retry).
  if ! take_lock; then
    echo "devctx: $source is being installed in the background; try again in a minute" >&2
    exit 1
  fi
  if do_install >&2; then rm -f "$failed"; rmdir "$busy" 2>/dev/null; else date >"$failed"; rmdir "$busy" 2>/dev/null; exit 1; fi
  for c in "$target/node_modules/devctx/dist/cli.js" "$target"/node_modules/@*/devctx/dist/cli.js \\
    "$target/node_modules/devctx/src/cli.ts" "$target"/node_modules/@*/devctx/src/cli.ts; do
    [ -f "$c" ] && cli="$c" && break
  done
  [ -n "$cli" ] || { echo "devctx: installed package has no dist/cli.js or src/cli.ts" >&2; exit 1; }
fi

case "$cli" in
  *.ts) exec "$node_bin" --experimental-strip-types --disable-warning=ExperimentalWarning "$cli" "$@" ;;
esac
exec "$node_bin" --disable-warning=ExperimentalWarning "$cli" "$@"
`;
}
