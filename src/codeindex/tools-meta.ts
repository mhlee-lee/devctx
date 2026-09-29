/**
 * The `devctx code` tools as data: names, arguments and one-line summaries. Kept free of index
 * imports so the skill writer (init, session hooks) can render them without loading a parser.
 */

export interface ToolArg {
  name: string;
  /** Placeholder shown in usage lines. */
  hint: string;
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
}

export interface CodeTool {
  name: string;
  summary: { ko: string; en: string };
  /** The first argument can be given positionally; the rest as `--flag value`. */
  args: ToolArg[];
  example: string;
}

export const CODE_TOOLS: readonly CodeTool[] = [
  {
    name: 'search_symbols',
    summary: {
      ko: '이름·단어로 클래스, 함수, 메서드, 컴포넌트 같은 선언을 찾는다 (camelCase·snake_case 인식). 결과는 path:line.',
      en: 'Find classes, functions, methods, components and other declarations by name or words (camelCase and snake_case aware). Returns path:line.',
    },
    args: [
      { name: 'query', hint: '<name | Class.method | words>', type: 'string', required: true },
      { name: 'kind', hint: 'class|interface|function|method|component|struct|enum|module|type', type: 'string' },
      { name: 'path', hint: '<dir | file | glob>', type: 'string' },
      { name: 'limit', hint: '20', type: 'number' },
    ],
    example: 'search_symbols "order repository save"',
  },
  {
    name: 'get_symbol',
    summary: {
      ko: '심볼 하나의 전부: 시그니처, 문서, 코드, 멤버, 상위·하위 타입, 사용처와 사용하는 것, 그 파일에 걸린 팀 결정.',
      en: 'Everything about one symbol: signature, doc, code, members, super/subtypes, who references it and what it uses, plus team decisions for its file.',
    },
    args: [
      { name: 'target', hint: '<Name | Class.method | path:line | path#Name>', type: 'string', required: true },
      { name: 'include_code', hint: 'true|false', type: 'string' },
    ],
    example: 'get_symbol OrderService.place',
  },
  {
    name: 'trace_calls',
    summary: {
      ko: '호출 관계: 누가 부르는지(callers), 무엇을 부르는지(callees), 여러 단계. 인터페이스 메서드의 구현도 보여준다.',
      en: 'Call graph around a symbol: callers, callees or both, several hops deep. Also lists implementations of interface methods.',
    },
    args: [
      { name: 'target', hint: '<Name | Class.method | path:line>', type: 'string', required: true },
      { name: 'direction', hint: 'callers|callees|both', type: 'string' },
      { name: 'depth', hint: '1-5', type: 'number' },
    ],
    example: 'trace_calls OrderService.place --direction both',
  },
  {
    name: 'file_outline',
    summary: {
      ko: '파일 하나의 구조: import와 모든 선언(줄 범위, 시그니처). 파일 전체를 읽지 않아도 된다.',
      en: 'Structure of one file: imports and every declaration with line ranges and signatures, without reading the whole file.',
    },
    args: [{ name: 'path', hint: '<file path from the repository root>', type: 'string', required: true }],
    example: 'file_outline src/orders/service.ts',
  },
  {
    name: 'repo_overview',
    summary: {
      ko: '저장소(또는 디렉터리) 지도: 언어, 주요 디렉터리, 많이 참조되는 심볼, 진입점, 타입 계층.',
      en: 'Map of the repository or a directory: languages, main directories, most referenced symbols, entry points and type hierarchies.',
    },
    args: [{ name: 'path', hint: '<dir>', type: 'string' }],
    example: 'repo_overview',
  },
  {
    name: 'change_impact',
    summary: {
      ko: '지금 변경의 영향: git diff에서 바뀐 심볼, 깨질 수 있는 호출자(여러 단계), 닿는 테스트, 해당 경로의 팀 결정.',
      en: 'Impact of the current changes: symbols changed in git diff, callers that may break (multi-hop), tests that reach them, team decisions for the paths.',
    },
    args: [
      { name: 'base', hint: 'HEAD|staged|<revision>', type: 'string' },
      { name: 'depth', hint: '1-4', type: 'number' },
    ],
    example: 'change_impact --base main',
  },
  {
    name: 'search_text',
    summary: {
      ko: '모든 추적 파일에서 정확한 텍스트·정규식 검색 (문자열, 주석, 설정). 심볼 검색이 맞지 않을 때 쓴다.',
      en: 'Exact text or regex search over every tracked file (strings, comments, config, any language). Use when a symbol search is not the right tool.',
    },
    args: [
      { name: 'pattern', hint: '<text>', type: 'string', required: true },
      { name: 'regex', hint: '', type: 'boolean' },
      { name: 'path', hint: '<dir | glob>', type: 'string' },
      { name: 'ignore_case', hint: '', type: 'boolean' },
      { name: 'limit', hint: '50', type: 'number' },
    ],
    example: 'search_text "ORDER_TIMEOUT"',
  },
];

export function codeTool(name: string): CodeTool | undefined {
  return CODE_TOOLS.find((t) => t.name === name || t.name === name.replace(/-/g, '_'));
}

export function usageLine(t: CodeTool, command = 'devctx code'): string {
  const [first, ...rest] = t.args;
  const head = first ? (first.required ? ` ${first.hint}` : ` [${first.hint}]`) : '';
  const flags = rest.map((a) => (a.type === 'boolean' ? ` [--${a.name.replace(/_/g, '-')}]` : ` [--${a.name.replace(/_/g, '-')} ${a.hint}]`)).join('');
  return `${command} ${t.name}${head}${flags}`;
}

/**
 * `devctx code <tool> <first arg words…> [--flag value]` to tool arguments. Positional words join
 * into the first argument, so an unquoted `search_symbols order service` still works.
 */
export function parseToolArgs(t: CodeTool, positional: readonly string[], flags: ReadonlyMap<string, string | true>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const words = [...positional];
  for (const [k, v] of flags) {
    if (k === 'root') continue;
    const name = k.replace(/-/g, '_');
    const spec = t.args.find((a) => a.name === name);
    if (spec?.type === 'boolean') {
      if (v === true || v === 'true') out[name] = true;
      else if (v === 'false') out[name] = false;
      else {
        // `--regex "a.*b"`: a switch takes no value, the word after it is the positional argument.
        out[name] = true;
        words.push(v);
      }
    } else if (spec?.type === 'number' && typeof v === 'string' && /^\d+$/.test(v)) out[name] = Number(v);
    else out[name] = v;
  }
  const first = t.args[0];
  if (first && words.length > 0 && out[first.name] === undefined) out[first.name] = words.join(' ');
  return out;
}
