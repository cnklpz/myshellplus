import { BookText, History, LoaderCircle, ScrollText, Sparkles } from "lucide-react";
import type { Suggestion } from "../../lib/api";
import type { PopupState } from "./predictor";

const ICONS: Record<Suggestion["source"], typeof History> = {
  history: History,
  snippet: ScrollText,
  builtin: BookText,
  ai: Sparkles,
};

const LABELS: Record<Suggestion["source"], string> = {
  history: "历史",
  snippet: "片段",
  builtin: "常用",
  ai: "AI",
};

export function PredictPopup(props: { state: PopupState; onPick: (i: number) => void; onHover: (i: number) => void }) {
  const { items, selected, input, aiLoading, left, top, bottom } = props.state;
  return (
    <div
      className="predict"
      style={{ left, top, bottom }}
      // keep keyboard focus in the terminal
      onMouseDown={(e) => e.preventDefault()}
    >
      {items.map((s, i) => {
        const Icon = ICONS[s.source] ?? History;
        const prefix = s.command.startsWith(input) ? input : "";
        return (
          <div
            key={s.source + s.command}
            className={"predict-row" + (i === selected ? " selected" : "") + (s.source === "ai" ? " ai" : "")}
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
          </div>
        );
      })}
      {aiLoading && (
        <div className="predict-row loading">
          <LoaderCircle className="predict-icon spin" />
          <span className="predict-cmd faint">AI 预测中…</span>
        </div>
      )}
      <div className="predict-foot">
        <span><kbd>↑↓</kbd> 选择</span>
        <span><kbd>Tab</kbd> <kbd>→</kbd> 接受</span>
        <span><kbd>Esc</kbd> 关闭</span>
        <span className="spacer" />
        <span><kbd>Ctrl+Space</kbd> AI</span>
      </div>
    </div>
  );
}
