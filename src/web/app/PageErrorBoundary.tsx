/** Keeps a crashing page from blanking the whole window; the rest of the shell stays usable. */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button } from '../components/Button'
import { pushTestError } from '../lib/testHooks'
import { Placeholder } from './Placeholder'

interface State {
  error: Error | null
}

export class PageErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    pushTestError(error)
    console.error('[vesper] page crashed', error, info.componentStack)
  }

  override componentDidUpdate(prev: { resetKey: string }): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <Placeholder title="Something went wrong here">
        This page hit an unexpected error. Your chats are safe.
        <span style={{ display: 'block', marginTop: 16 }}>
          <Button icon={<RotateCcw />} onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
        </span>
      </Placeholder>
    )
  }
}
