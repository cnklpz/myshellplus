import type { SearchAddon } from "@xterm/addon-search";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SEARCH_DECORATIONS } from "./config";

export function SearchBox(props: { search: SearchAddon; onClose: () => void }) {
  const { search } = props;
  const [q, setQ] = useState("");
  const [caseSensitive, setCase] = useState(false);
  const [res, setRes] = useState<{ index: number; count: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const sub = search.onDidChangeResults((e) => setRes({ index: e.resultIndex, count: e.resultCount }));
    return () => {
      sub.dispose();
      search.clearDecorations();
    };
  }, [search]);

  const opts = (incremental: boolean) => ({ caseSensitive, incremental, decorations: SEARCH_DECORATIONS });

  useEffect(() => {
    if (!q) {
      search.clearDecorations();
      setRes(null);
      return;
    }
    search.findNext(q, opts(true));
  }, [q, caseSensitive, search]);

  const next = () => q && search.findNext(q, opts(false));
  const prev = () => q && search.findPrevious(q, opts(false));

  return (
    <div
      className="term-search"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          props.onClose();
        } else if (e.key === "Enter") {
          e.preventDefault();
          e.shiftKey ? prev() : next();
        }
      }}
    >
      <input
        ref={inputRef}
        className="input sm"
        placeholder="搜索"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <span className="term-search-count num faint">
        {q ? (res ? (res.count === 0 ? "无结果" : `${res.index >= 0 ? res.index + 1 : "?"}/${res.count}`) : "") : ""}
      </span>
      <button className={"icon-btn term-search-case" + (caseSensitive ? " active" : "")} title="区分大小写" onClick={() => setCase(!caseSensitive)}>
        Aa
      </button>
      <button className="icon-btn" title="上一个 (Shift+Enter)" onClick={prev}>
        <ChevronUp />
      </button>
      <button className="icon-btn" title="下一个 (Enter)" onClick={next}>
        <ChevronDown />
      </button>
      <button className="icon-btn" title="关闭 (Esc)" onClick={props.onClose}>
        <X />
      </button>
    </div>
  );
}
