import { Fragment, type ReactNode } from 'react';

/** Parsed Markdown: a small, safe subset (headings, lists, code, paragraphs, bold, inline code, links). Never HTML. */
export type Inline = { t: 'text'; v: string } | { t: 'bold'; v: string } | { t: 'code'; v: string } | { t: 'link'; v: string; href: string };
export type Block =
  | { t: 'heading'; level: number; inline: Inline[] }
  | { t: 'list'; items: Inline[][] }
  | { t: 'code'; v: string }
  | { t: 'p'; inline: Inline[] };

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  for (const part of s.split(INLINE)) {
    if (!part) continue;
    let m: RegExpExecArray | null;
    if ((m = /^\*\*([^*]+)\*\*$/.exec(part))) out.push({ t: 'bold', v: m[1] });
    else if ((m = /^`([^`]+)`$/.exec(part))) out.push({ t: 'code', v: m[1] });
    else if ((m = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part))) out.push({ t: 'link', v: m[1], href: m[2] });
    else out.push({ t: 'text', v: part });
  }
  return out;
}

export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = [];
  let list: Inline[][] = [];
  let code: string[] | null = null;
  const flush = () => { if (list.length) { blocks.push({ t: 'list', items: list }); list = []; } };
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (line.trimStart().startsWith('```')) {
      if (code) { blocks.push({ t: 'code', v: code.join('\n') }); code = null; } else { flush(); code = []; }
      continue;
    }
    if (code) { code.push(line); continue; }
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) { list.push(parseInline(li[1])); continue; }
    flush();
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) blocks.push({ t: 'heading', level: h[1].length, inline: parseInline(h[2]) });
    else if (line.trim()) blocks.push({ t: 'p', inline: parseInline(line) });
  }
  flush();
  if (code) blocks.push({ t: 'code', v: code.join('\n') });
  return blocks;
}

function renderInline(parts: Inline[]): ReactNode[] {
  return parts.map((p, i) => {
    switch (p.t) {
      case 'bold': return <strong key={i} className="font-semibold">{p.v}</strong>;
      case 'code': return <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{p.v}</code>;
      case 'link': return <a key={i} href={p.href} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2 hover:text-primary">{p.v}</a>;
      default: return <Fragment key={i}>{p.v}</Fragment>;
    }
  });
}

/** Renders Markdown (release notes) with React elements only: nothing is ever injected as HTML. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="space-y-2 text-sm leading-relaxed break-words">
      {parseMarkdown(text).map((b, i) => {
        switch (b.t) {
          case 'heading': return <h4 key={i} className={b.level <= 2 ? 'pt-1 text-base font-semibold' : 'pt-1 text-sm font-semibold'}>{renderInline(b.inline)}</h4>;
          case 'list': return <ul key={i} className="list-disc space-y-1 pl-5">{b.items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}</ul>;
          case 'code': return <pre key={i} className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">{b.v}</pre>;
          default: return <p key={i}>{renderInline(b.inline)}</p>;
        }
      })}
    </div>
  );
}
