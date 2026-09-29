# Third-party notices

## Code index

`src/codeindex/extract/specs.ts` adapts the per-language node-type tables of
[codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) (`internal/cbm/lang_specs.c`,
`extract_defs.c`). The WebAssembly tree-sitter approach follows [Graft](https://github.com/trailhq/Graft)
(`src/graph/generic.ts`). No code from either project is copied verbatim.

```
MIT License

Copyright (c) 2025 DeusData

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

```
MIT License

Copyright (c) 2026 Context Graph Engine contributors

(Graft; same terms as above.)
```

## tree-sitter grammars

`vendor/grammars/*.wasm.br` are brotli-compressed WebAssembly builds of 36 tree-sitter grammars.
Source package or repository, version, license and sha256 of each are in
`vendor/grammars/MANIFEST.json`; the license texts are in `vendor/grammars/licenses/`. Most are MIT;
Elixir, Erlang and HCL are Apache-2.0, Dart is ISC, Clojure is CC0-1.0.

## web-tree-sitter

`web-tree-sitter` (npm dependency), MIT, Copyright (c) 2018-2024 Max Brunsfeld.
