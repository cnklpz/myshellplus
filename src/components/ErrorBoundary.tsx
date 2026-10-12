// Catches render errors so a UI bug never leaves a blank window. SSH sessions live in Rust,
// so reloading the UI is always safe: terminals re-attach and replay their output.
import { Component, type ReactNode } from "react";

export function reloadUi() {
  location.reload();
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("UI crashed:", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <div className="crash-card">
          <div className="crash-title">界面出错了</div>
          <div className="crash-sub">连接和终端会话不受影响，重新加载即可恢复。</div>
          <pre className="crash-msg selectable">{String(this.state.error?.message ?? this.state.error)}</pre>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn primary" onClick={reloadUi}>
              重新加载界面
            </button>
          </div>
        </div>
      </div>
    );
  }
}
