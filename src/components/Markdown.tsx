import { openUrl } from "@tauri-apps/plugin-opener";
import type { ReactNode } from "react";
import { errMsg } from "../lib/api";
import { toast } from "./ui";

/* Minimal Markdown renderer for AI output. Builds React elements directly (no innerHTML), so
   model output can never inject markup. Covers: headings, paragraphs, fenced code, lists (nested
   by indent), blockquotes, tables, hr, and inline code / bold / italic / strike / links. */

type Block =
  | { t: "h"; level: number; text: string }
  | { t: "p"; text: string }
  | { t: "code"; lang: string; text: string }
  | { t: "list"; ordered: boolean; start: number; items: { text: string; children: Block[] }[] }
  | { t: "quote"; children: Block[] }
  | { t: "table"; head: string[]; align: ("left" | "right" | "center" | undefined)[]; rows: string[][] }
  | { t: "hr" };

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const FENCE_RE = /^\s*(```|~~~)\s*([\w+-]*)/;

const splitRow = (l: string) =>
  l.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));

function parse(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push({ t: "code", lang: fence[2], text: body.join("\n") });
      continue;
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      out.push({ t: "h", level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push({ t: "quote", children: parse(body) });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) =>
        c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : undefined,
      );
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitRow(lines[i++]));
      out.push({ t: "table", head, align, rows });
      continue;
    }
    const li = LIST_RE.exec(line);
    if (li) {
      const base = li[1].length;
      const ordered = /\d/.test(li[2]);
      const items: { text: string; children: Block[] }[] = [];
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]);
        if (m && m[1].length <= base + 1) {
          if (/\d/.test(m[2]) !== ordered) break;
          i++;
          // Continuation / nested lines: anything indented deeper than the marker, or blank lines
          // followed by such indentation.
          const sub: string[] = [];
          while (i < lines.length) {
            const l = lines[i];
            const ind = l.length - l.trimStart().length;
            if (l.trim() && ind > base + 1) sub.push(l.slice(Math.min(ind, base + 2)));
            else if (!l.trim() && i + 1 < lines.length && lines[i + 1].trim() && lines[i + 1].length - lines[i + 1].trimStart().length > base + 1) sub.push("");
            else break;
            i++;
          }
          // Leading non-list continuation lines belong to the item's own text.
          let text = m[3];
          while (sub.length && sub[0].trim() && !LIST_RE.test(sub[0]) && !FENCE_RE.test(sub[0])) text += " " + sub.shift()!.trim();
          items.push({ text, children: parse(sub) });
        } else if (!lines[i].trim() && i + 1 < lines.length && LIST_RE.test(lines[i + 1])) {
          i++;
        } else break;
      }
      out.push({ t: "list", ordered, start: ordered ? parseInt(li[2], 10) : 1, items });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !FENCE_RE.test(lines[i]) &&
      !/^\s{0,3}#{1,6}\s/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !LIST_RE.test(lines[i])
    )
      para.push(lines[i++].trim());
    out.push({ t: "p", text: para.join("\n") });
  }
  return out;
}

const INLINE_RE = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*([^\s*][\s\S]*?)\*|(?<![\w])_([^\s_][\s\S]*?)_(?![\w])|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>)]+)/g;

function open(url: string) {
  if (!/^https?:\/\//i.test(url)) return;
  openUrl(url).catch((e) => toast(`无法打开链接：${errMsg(e)}`, "error"));
}

function inline(src: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of src.matchAll(INLINE_RE)) {
    const idx = m.index!;
    if (idx > last) out.push(src.slice(last, idx));
    last = idx + m[0].length;
    const key = k++;
    if (m[1]) out.push(<code key={key}>{m[2].trim()}</code>);
    else if (m[3] ?? m[4]) out.push(<strong key={key}>{inline(m[3] ?? m[4])}</strong>);
    else if (m[5]) out.push(<del key={key}>{inline(m[5])}</del>);
    else if (m[6] ?? m[7]) out.push(<em key={key}>{inline(m[6] ?? m[7])}</em>);
    else {
      const url = m[9] ?? m[10];
      out.push(
        <a key={key} href={url} title={url} onClick={(e) => (e.preventDefault(), open(url))}>
          {m[8] ? inline(m[8]) : url}
        </a>,
      );
    }
  }
  if (last < src.length) out.push(src.slice(last));
  // Soft line breaks inside a paragraph stay as line breaks (AI output relies on them).
  return out.flatMap((n, j): ReactNode[] =>
    typeof n === "string" ? n.split("\n").flatMap((s, x) => (x ? [<br key={`b${j}-${x}`} />, s] : [s])) : [n],
  );
}

function render(blocks: Block[]): ReactNode[] {
  return blocks.map((b, i) => {
    switch (b.t) {
      case "h": {
        const H = `h${Math.min(b.level + 2, 6)}` as "h3";
        return <H key={i}>{inline(b.text)}</H>;
      }
      case "p":
        return <p key={i}>{inline(b.text)}</p>;
      case "code":
        return (
          <pre key={i} className="mono">
            <code>{b.text}</code>
          </pre>
        );
      case "hr":
        return <hr key={i} />;
      case "quote":
        return <blockquote key={i}>{render(b.children)}</blockquote>;
      case "list": {
        const items = b.items.map((it, j) => (
          <li key={j}>
            {inline(it.text)}
            {render(it.children)}
          </li>
        ));
        return b.ordered ? (
          <ol key={i} start={b.start}>
            {items}
          </ol>
        ) : (
          <ul key={i}>{items}</ul>
        );
      }
      case "table":
        return (
          <div key={i} className="md-table">
            <table>
              <thead>
                <tr>
                  {b.head.map((c, j) => (
                    <th key={j} style={{ textAlign: b.align[j] }}>
                      {inline(c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j}>
                    {b.head.map((_, x) => (
                      <td key={x} style={{ textAlign: b.align[x] }}>
                        {inline(r[x] ?? "")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

export function Markdown(props: { text: string; className?: string }) {
  return <div className={props.className ? `md ${props.className}` : "md"}>{render(parse(props.text.replace(/\r\n?/g, "\n").split("\n")))}</div>;
}
