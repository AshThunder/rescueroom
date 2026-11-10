import { Component, type ReactNode } from 'react';
import { ErrorState } from './ui';

export class Boundary extends Component<{ children: ReactNode }, { err: string | null }> {
  state = { err: null as string | null };
  static getDerivedStateFromError(e: Error) {
    return { err: e.message };
  }
  render() {
    if (this.state.err) return <div className="card"><ErrorState error={`This view crashed: ${this.state.err}`} onRetry={() => this.setState({ err: null })} /></div>;
    return this.props.children;
  }
}
