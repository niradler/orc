import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorReport } from "@/components/ErrorReport";
import { isStaleBuildError, reloadForStaleBuild } from "@/lib/app-errors";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Uncaught render error:", error, info.componentStack);
    // A chunk the deploy replaced is recoverable; the reload picks up the new build.
    if (isStaleBuildError(error)) reloadForStaleBuild();
  }

  handleReload = () => {
    this.setState({ error: null });
    window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const stale = isStaleBuildError(error);
    return (
      <ErrorReport
        error={error}
        testId="app-error"
        title={stale ? "ORC was updated" : "Something went wrong"}
        hint={
          stale
            ? "This tab is running an older version. Reload to load the current one."
            : "Reload the page. If this keeps happening, the details below are what to report."
        }
        onReload={this.handleReload}
      />
    );
  }
}
