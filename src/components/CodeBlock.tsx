import {
  Fragment,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Check, Copy } from 'lucide-react';
import type { Components } from 'react-markdown';
import { highlightCode, type TokenSpan } from '../highlight/highlighter';

/**
 * Markdown fenced code block: shiki highlight with the same lazy language
 * loading as diffs, a language tag, and a copy button. Tokens swap in
 * asynchronously — plain text renders until they arrive, so streaming code
 * (an unclosed fence mid-chunk) never flashes empty.
 */
export function CodeBlock({ lang, code }: { lang: string | null; code: string }) {
  const [lines, setLines] = useState<TokenSpan[][] | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!lang) return undefined;
    let cancelled = false;
    void highlightCode(lang, code).then((result) => {
      if (!cancelled) setLines(result);
    });
    return () => {
      cancelled = true;
    };
  }, [lang, code]);

  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => {
        copyTimer.current = null;
        setCopied(false);
      }, 1500);
    } catch (err) {
      console.error('[panda/codeblock] clipboard write failed', err);
    }
  };

  return (
    <div className="md-codeblock">
      <div className="md-codeblock-header">
        <span className="md-codeblock-lang">{lang ?? ''}</span>
        <button
          type="button"
          onClick={() => void copy()}
          className="md-codeblock-copy"
          aria-label="复制代码"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      <pre>
        {lines
          ? lines.map((spans, i) => (
              <Fragment key={i}>
                {spans.map((token, j) => (
                  <span
                    key={j}
                    style={token.color ? { color: token.color } : undefined}
                  >
                    {token.value}
                  </span>
                ))}
                {i < lines.length - 1 ? '\n' : undefined}
              </Fragment>
            ))
          : code}
      </pre>
    </div>
  );
}

/** Flattens react-markdown's code element children back into raw text. */
function toText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(toText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return toText(node.props.children);
  return '';
}

/**
 * Shared react-markdown renderer overrides. react-markdown emits fenced
 * blocks as <pre><code class="language-x">text</code></pre>; we lift the
 * info-string tag and text out into CodeBlock. Module-level const so the
 * memoized paragraph renderers keep stable props.
 */
export const markdownComponents: Components = {
  pre: ({ children }) => {
    const child = Array.isArray(children) ? children[0] : children;
    if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
      const lang = /^language-(.+)$/.exec(child.props.className ?? '')?.[1] ?? null;
      return <CodeBlock lang={lang} code={toText(child.props.children)} />;
    }
    return <pre>{children}</pre>;
  },
};