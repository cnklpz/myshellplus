import { BookText, File, Folder, History, LoaderCircle, ScrollText, Sparkles, SquareTerminal } from "lucide-react";
import type { Suggestion } from "../../lib/api";
import type { PopupState } from "./predictor";

const ICONS: Record<Suggestion["source"], typeof History> = {
  history: History,
  snippet: ScrollText,
  command: SquareTerminal,
  builtin: BookText,
  path: File,
  ai: Sparkles,
};

const LABELS: Record<Suggestion["source"], string> = {
  history: "历史",
  snippet: "命令片段",
  command: "服务器命令",
  builtin: "常用",
  path: "路径",
  ai: "AI",
};

export function PredictPopup(props: { state: PopupState; onPick: (i: number) => void; onHover: (i: number) => void }) {
  const { items, selected, input, aiLoading, nl, left, top, bottom } = props.state;
  const active = nl ? Math.max(0, selected) : selected;
  return (
    <div
      className="predict"
      style={{ left, top, bottom }}
      // keep keyboard focus in the terminal
      onMouseDown={(e) => e.preventDefault()}
    >
      {items.map((s, i) => {
        const Icon = s.dir ? Folder : (ICONS[s.source] ?? History);
        const prefix = s.command.startsWith(input) ? input : "";
        return (
          <div
            key={s.source + s.command}
            className={"predict-row" + (i === active ? " selected" : "") + (s.source === "ai" ? " ai" : "")}
            title={LABELS[s.source]}
            onMouseEnter={() => props.onHover(i)}
            onClick={() => props.onPick(i)}
          >
            <Icon className="predict-icon" />
            <span className="predict-cmd mono ellipsis">
              {prefix && <span className="predict-typed">{prefix}</span>}
              {s.command.slice(prefix.length)}
            </span>
            {s.description && <span className="predict-desc ellipsis">{s.description}</span>}
            {nl && i === active && <kbd className="predict-key">Enter</kbd>}
          </div>
        );
      })}
      {aiLoading && (
        <div className="predict-row loading">
          <LoaderCircle className="predict-icon spin" />
          <span className="predict-cmd faint">{nl ? "生成命令…" : "预测中…"}</span>
        </div>
      )}
    </div>
  );
}
