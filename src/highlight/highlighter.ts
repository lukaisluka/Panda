import type { HighlighterCore } from 'shiki/core';

/**
 * Fine-grained shiki integration: core only + the JavaScript regex engine,
 * theme and languages lazy-loaded as async chunks on first use. Highlighting
 * is cosmetic — any failure degrades to plain rendering but is logged so the
 * next occurrence stays diagnosable.
 */

export type TokenSpan = { value: string; color?: string };

const THEME = 'vitesse-dark';

/** Per-language async imports; the set we are willing to bundle as chunks. */
const LANG_IMPORTS: Record<string, () => Promise<unknown>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  less: () => import('shiki/langs/less.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  fish: () => import('shiki/langs/fish.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  scala: () => import('shiki/langs/scala.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
};

/** File extension → shiki language id; unmapped extensions render unhighlighted. */
const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  py: 'python', pyi: 'python',
  rs: 'rust', go: 'go', java: 'java', rb: 'ruby', php: 'php',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cxx: 'cpp',
  cs: 'csharp', swift: 'swift', kt: 'kotlin',
  css: 'css', scss: 'scss', less: 'less',
  html: 'html', htm: 'html', vue: 'vue', svelte: 'svelte',
  md: 'markdown', markdown: 'markdown',
  yml: 'yaml', yaml: 'yaml', toml: 'toml',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'fish',
  sql: 'sql', xml: 'xml', graphql: 'graphql', gql: 'graphql',
  dart: 'dart', scala: 'scala', lua: 'lua',
};

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedLangs = new Set<string>();
const cache = new Map<string, TokenSpan[][]>();
const CACHE_LIMIT = 64;

function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
    ]);
    return createHighlighterCore({
      themes: [import('shiki/themes/vitesse-dark.mjs')],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  })();
  return highlighterPromise;
}

/**
 * Highlights `code` (whole file) into one TokenSpan[] per line, or null when
 * the extension is unknown, the code is empty, or highlighting fails.
 */
export async function highlightLines(path: string, code: string): Promise<TokenSpan[][] | null> {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const lang = LANG_BY_EXT[ext];
  const importLang = lang ? LANG_IMPORTS[lang] : undefined;
  if (!lang || !importLang || code === '') return null;

  const cacheKey = `${lang}\u0000${code}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const highlighter = await getHighlighter();
    if (!loadedLangs.has(lang)) {
      await highlighter.loadLanguage((await importLang()) as Parameters<
        HighlighterCore['loadLanguage']
      >[0]);
      loadedLangs.add(lang);
    }
    const { tokens } = highlighter.codeToTokens(code, { lang, theme: THEME });
    const lines = tokens.map((line) => line.map((t) => ({ value: t.content, color: t.color })));
    if (cache.size >= CACHE_LIMIT) {
      const oldest = cache.keys().next();
      if (!oldest.done && oldest.value !== undefined) cache.delete(oldest.value);
    }
    cache.set(cacheKey, lines);
    return lines;
  } catch (err) {
    console.error(`[panda/highlight] failed to highlight ${path} as ${lang}`, err);
    return null;
  }
}