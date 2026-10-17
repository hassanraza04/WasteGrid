import { Component, type ErrorInfo, type ReactNode } from "react";

interface ReportErrorBoundaryProperties {
  children: ReactNode;
}

interface ReportErrorBoundaryState {
  hasError: boolean;
}

export class ReportErrorBoundary extends Component<
  ReportErrorBoundaryProperties,
  ReportErrorBoundaryState
> {
  public state: ReportErrorBoundaryState = { hasError: false };

  public static getDerivedStateFromError(): ReportErrorBoundaryState {
    return { hasError: true };
  }

  public componentDidCatch(_error: Error, _errorInfo: ErrorInfo): void {}

  public render(): ReactNode {
    if (this.state.hasError) {
      return (
        <main>
          <p role="alert">We could not load report information.</p>
          <button type="button" onClick={() => this.setState({ hasError: false })}>
            Try again
          </button>
        </main>
      );
    }

    return this.props.children;
  }
}
