import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

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
  }

  handleReload = () => {
    this.setState({ error: null });
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center min-h-screen gap-4 p-8 text-center">
          <p className="text-error font-label text-sm uppercase tracking-widest">
            Something went wrong
          </p>
          <pre className="max-w-xl overflow-auto rounded bg-muted p-4 text-left text-xs text-muted-foreground">
            {this.state.error.message}
          </pre>
          <Button variant="outline" size="sm" onClick={this.handleReload} className="text-xs">
            RELOAD
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
