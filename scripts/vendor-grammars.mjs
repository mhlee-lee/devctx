#!/usr/bin/env node
// Re-creates vendor/grammars/ (brotli-compressed tree-sitter wasm + licenses + MANIFEST.json).
//
//   node scripts/vendor-grammars.mjs            # grammars whose npm package ships a .wasm
//   node scripts/vendor-grammars.mjs --build    # also build the others (needs `tree-sitter` CLI >= 0.25 on PATH;
//                                               # it downloads wasi-sdk into ~/.cache/tree-sitter on first use)
//
// Maintainer tool only: devctx itself never downloads or builds grammars.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const DEST = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'vendor', 'grammars');
const BUILD = process.argv.includes('--build');

// wasm: file shipped in the package; build: build from the package or repository sources (subdir if any).
const GRAMMARS = [
  { id: 'java', npm: 'tree-sitter-java@0.23.5', wasm: 'tree-sitter-java.wasm' },
  { id: 'kotlin', npm: '@tree-sitter-grammars/tree-sitter-kotlin@1.1.0', wasm: 'tree-sitter-kotlin.wasm' },
  { id: 'go', npm: 'tree-sitter-go@0.25.0', wasm: 'tree-sitter-go.wasm' },
  { id: 'python', npm: 'tree-sitter-python@0.25.0', wasm: 'tree-sitter-python.wasm' },
  { id: 'javascript', npm: 'tree-sitter-javascript@0.25.0', wasm: 'tree-sitter-javascript.wasm' },
  { id: 'typescript', npm: 'tree-sitter-typescript@0.23.2', wasm: 'tree-sitter-typescript.wasm' },
  { id: 'tsx', npm: 'tree-sitter-typescript@0.23.2', wasm: 'tree-sitter-tsx.wasm' },
  { id: 'rust', npm: 'tree-sitter-rust@0.24.0', wasm: 'tree-sitter-rust.wasm' },
  { id: 'c', npm: 'tree-sitter-c@0.24.1', wasm: 'tree-sitter-c.wasm' },
  { id: 'cpp', npm: 'tree-sitter-cpp@0.23.4', wasm: 'tree-sitter-cpp.wasm' },
  { id: 'csharp', npm: 'tree-sitter-c-sharp@0.23.5', wasm: 'tree-sitter-c_sharp.wasm' },
  { id: 'ruby', npm: 'tree-sitter-ruby@0.23.1', wasm: 'tree-sitter-ruby.wasm' },
  { id: 'php', npm: 'tree-sitter-php@0.24.2', wasm: 'tree-sitter-php.wasm' },
  { id: 'scala', npm: 'tree-sitter-scala@0.24.0', wasm: 'tree-sitter-scala.wasm' },
  { id: 'bash', npm: 'tree-sitter-bash@0.25.1', wasm: 'tree-sitter-bash.wasm' },
  { id: 'lua', npm: '@tree-sitter-grammars/tree-sitter-lua@0.4.1', wasm: 'tree-sitter-lua.wasm' },
  { id: 'haskell', npm: 'tree-sitter-haskell@0.23.1', wasm: 'tree-sitter-haskell.wasm' },
  { id: 'ocaml', npm: 'tree-sitter-ocaml@0.24.2', wasm: 'tree-sitter-ocaml.wasm' },
  { id: 'julia', npm: 'tree-sitter-julia@0.23.1', wasm: 'tree-sitter-julia.wasm' },
  { id: 'zig', npm: '@tree-sitter-grammars/tree-sitter-zig@1.1.2', wasm: 'tree-sitter-zig.wasm' },
  { id: 'elixir', npm: 'tree-sitter-elixir@0.3.5', wasm: 'tree-sitter-elixir.wasm' },
  { id: 'objc', npm: 'tree-sitter-objc@3.0.2', wasm: 'tree-sitter-objc.wasm' },
  { id: 'solidity', npm: 'tree-sitter-solidity@1.2.13', wasm: 'tree-sitter-solidity.wasm' },
  { id: 'hcl', npm: '@tree-sitter-grammars/tree-sitter-hcl@1.2.0', wasm: 'tree-sitter-hcl.wasm' },
  { id: 'groovy', npm: 'tree-sitter-groovy@0.1.2', wasm: 'tree-sitter-groovy.wasm', licenseRepo: 'murtaza64/tree-sitter-groovy' },
  { id: 'powershell', npm: 'tree-sitter-powershell@0.26.4', wasm: 'tree-sitter-powershell.wasm', licenseRepo: 'airbus-cert/tree-sitter-powershell' },
  { id: 'swift', npm: 'tree-sitter-swift@0.7.1', build: '.' },
  { id: 'dart', npm: 'tree-sitter-dart@1.0.0', build: '.', licenseRepo: 'UserNobody14/tree-sitter-dart' },
  { id: 'perl', npm: 'tree-sitter-perl@2.0.0', build: '.', licenseRepo: 'tree-sitter-perl/tree-sitter-perl' },
  { id: 'elm', npm: '@elm-tooling/tree-sitter-elm@5.9.4', build: '.', licenseRepo: 'elm-tooling/tree-sitter-elm' },
  { id: 'sql', npm: '@derekstride/tree-sitter-sql@0.3.11', build: '.', licenseRepo: 'DerekStride/tree-sitter-sql' },
  { id: 'fsharp', npm: 'tree-sitter-fsharp@0.3.12', build: 'fsharp', licenseRepo: 'ionide/tree-sitter-fsharp' },
  { id: 'clojure', git: 'https://github.com/sogaiu/tree-sitter-clojure', rev: 'e43eff80d17cf34852dcd92ca5e6986d23a7040f', license: 'CC0-1.0', licenseFile: 'COPYING.txt', build: '.' },
  { id: 'r', git: 'https://github.com/r-lib/tree-sitter-r', rev: '58a22794466c0fc15b0d3b40531db751593721e8', license: 'MIT', licenseFile: 'LICENSE', build: '.' },
  { id: 'erlang', git: 'https://github.com/WhatsApp/tree-sitter-erlang', rev: '6ba4c762eb3065495e3db85697ffeecdf364ce35', license: 'Apache-2.0', licenseFile: 'LICENSE', build: '.' },
];

function untar(buf) {
  const files = new Map();
  let off = 0;
  let longName = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    let name = str(0, 100);
    const prefix = str(345, 500);
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const body = buf.subarray(off + 512, off + 512 + size);
    if (type === 'x') longName = /path=([^\n]+)/.exec(body.toString('utf8'))?.[1] ?? null;
    else if (type === '0' || type === '\0') {
      files.set(longName ?? name, body);
      longName = null;
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'devctx-grammars-'));
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

function fromNpm(g) {
  const tgz = sh('npm', ['pack', g.npm, '--silent', '--pack-destination', work], work).trim().split('\n').pop();
  const buf = fs.readFileSync(path.join(work, tgz));
  const files = untar(zlib.gunzipSync(buf));
  const pkg = JSON.parse(files.get('package/package.json').toString('utf8'));
  const lic = [...files.keys()].find((f) => /^package\/(LICENSE|LICENCE|COPYING)(\.\w+)?$/i.test(f));
  let license = lic ? files.get(lic).toString('utf8') : null;
  if (!license && g.licenseRepo) license = sh('curl', ['-fsSL', `https://raw.githubusercontent.com/${g.licenseRepo}/HEAD/LICENSE`], work);
  let wasm = g.wasm ? files.get(`package/${g.wasm}`) : null;
  if (!wasm && g.build) {
    const dir = path.join(work, g.id);
    fs.mkdirSync(dir, { recursive: true });
    sh('tar', ['xzf', path.join(work, tgz), '-C', dir], work);
    wasm = build(path.join(dir, 'package', g.build));
  }
  return { wasm, license, spdx: pkg.license, source: `npm:${g.npm}` };
}

function fromGit(g) {
  const dir = path.join(work, g.id);
  sh('git', ['clone', '--quiet', g.git, dir], work);
  sh('git', ['checkout', '--quiet', g.rev], dir);
  return { wasm: build(path.join(dir, g.build)), license: fs.readFileSync(path.join(dir, g.licenseFile), 'utf8'), spdx: g.license, source: `git:${g.git}#${g.rev}` };
}

function build(dir) {
  if (!BUILD) return null;
  // Regenerate old parsers (ABI < 13 does not load in web-tree-sitter 0.27).
  const parser = path.join(dir, 'src', 'parser.c');
  const abi = fs.existsSync(parser) ? Number(/#define LANGUAGE_VERSION (\d+)/.exec(fs.readFileSync(parser, 'utf8'))?.[1] ?? 0) : 0;
  if (abi < 13) sh('tree-sitter', ['generate'], dir);
  const out = path.join(dir, 'out.wasm');
  sh('tree-sitter', ['build', '--wasm', '-o', out, '.'], dir);
  return fs.readFileSync(out);
}

fs.mkdirSync(path.join(DEST, 'licenses'), { recursive: true });
const manifest = [];
for (const g of GRAMMARS) {
  const r = g.git ? fromGit(g) : fromNpm(g);
  if (!r.wasm) {
    console.log(`skip ${g.id}: needs --build`);
    continue;
  }
  if (!r.license) throw new Error(`no license text for ${g.id}`);
  const br = zlib.brotliCompressSync(r.wasm, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: r.wasm.length } });
  fs.writeFileSync(path.join(DEST, `${g.id}.wasm.br`), br);
  fs.writeFileSync(path.join(DEST, 'licenses', `${g.id}.txt`), r.license);
  manifest.push({
    id: g.id,
    source: r.source,
    wasm: g.wasm ? 'shipped by the package' : 'built with tree-sitter-cli (wasi-sdk)',
    license: r.spdx,
    sha256: crypto.createHash('sha256').update(r.wasm).digest('hex'),
    bytes: r.wasm.length,
  });
  console.log(`${g.id.padEnd(11)} ${String(r.wasm.length).padStart(9)} -> ${String(br.length).padStart(8)}`);
}
if (manifest.length === GRAMMARS.length) fs.writeFileSync(path.join(DEST, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
else console.log('MANIFEST.json kept (not every grammar was rebuilt; run with --build)');
fs.rmSync(work, { recursive: true, force: true });
