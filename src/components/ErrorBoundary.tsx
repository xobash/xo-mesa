import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * Catches render/runtime errors anywhere in the tree so a single bug shows a
 * recoverable panel instead of a blank window. Your notes on disk are never
 * touched by a UI crash.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("Mesa crashed:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <div className="crash-card">
          <div className="crash-mark">✦</div>
          <h1>Something went wrong</h1>
          <p>
            Mesa hit an unexpected error. Your notes on disk are safe — try
            reloading.
          </p>
          <button className="btn primary" onClick={() => location.reload()}>
            Reload
          </button>
          <button
            className="btn"
            onClick={() => this.setState({ error: null })}
          >
            Dismiss
          </button>
          <pre className="crash-detail">
            {this.state.error.message}
            {"\n"}
            {this.state.error.stack?.split("\n").slice(0, 6).join("\n")}
          </pre>
        </div>
      </div>
    );
  }
}
