import { Component, type ReactNode } from "react";

/** A screen that fails to draw says so, with the reason, instead of leaving a blank page. Edits are kept on this computer, so nothing is lost. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error("Screen failed to draw:", error); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page" role="alert" style={{ maxWidth: 640, margin: "48px auto", background: "var(--paper)", border: "1px solid var(--line-strong)" }}>
        <h4 style={{ marginTop: 0 }}>This screen could not be drawn</h4>
        <p className="muted">Your edits are saved on this computer as you make them, so nothing has been lost. This usually means the web app and the server are on different versions.</p>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 11 }}>{this.state.error.message}</pre>
        <button className="btn primary" onClick={() => window.location.reload()}>Reload</button>{" "}
        <a className="btn" style={{ textDecoration: "none" }} href="#/" onClick={() => this.setState({ error: null })}>Tender Register</a>
      </div>
    );
  }
}
