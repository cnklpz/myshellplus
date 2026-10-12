// Catches render errors so a UI bug never leaves a blank window. SSH sessions live in Rust,
// so reloading the UI is always safe: terminals re-attach and replay their output.
import { Component, type ErrorInfo, type ReactNode } from "react";
import { logUiCrash } from "../lib/diag";

export function reloadUi() {
  location.reload();
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("UI crashed:", error);
    logUiCrash(error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <div className="crash-card">
          <div className="crash-title">界面出错了</div>
          <div className="muted">终端会话不受影响</div>
          <pre className="crash-msg selectable">{String(this.state.error?.message ?? this.state.error)}</pre>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn primary" onClick={reloadUi}>
              重新加载
            </button>
          </div>
        </div>
      </div>
    );
  }
}
