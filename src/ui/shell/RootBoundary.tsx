import { Component, type ErrorInfo, type ReactNode } from "react";
import { forgetLastPlan } from "../state";

export const RELOAD = "Reload";
export const OPEN_WITHOUT_PLAN = "Open without the last plan";

interface Props {
  reload(): void;
  children: ReactNode;
}

interface State {
  error: unknown;
  failed: boolean;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class RootBoundary extends Component<Props, State> {
  state: State = { error: null, failed: false };

  static getDerivedStateFromError(error: unknown): State {
    return { error, failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const openWithout = (): void => {
      forgetLastPlan();
      this.props.reload();
    };
    return (
      <div className="app">
        <main className="start-failed">
          <p className="start-bad">{messageOf(this.state.error)}</p>
          <div className="start-actions">
            <button type="button" className="button-primary" onClick={this.props.reload}>
              {RELOAD}
            </button>
            <button type="button" onClick={openWithout}>
              {OPEN_WITHOUT_PLAN}
            </button>
          </div>
        </main>
      </div>
    );
  }
}
