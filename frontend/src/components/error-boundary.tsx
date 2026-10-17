import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * The last thing between an exception during render and a black page.
 *
 * Without a boundary, React unmounts the whole tree when any component throws
 * while rendering, and what the operator sees is `#root` empty on a dark
 * background — no message, no button, nothing that says whether the panel is
 * down or their browser is. That is exactly what a temporal-dead-zone slip in
 * `SidebarContent` produced for every authenticated route: a black page, with
 * the only explanation in a console nobody opens.
 *
 * This sits ABOVE every provider, deliberately, so it still stands when a
 * provider is what threw — and that is also why its text is fixed rather than
 * translated: the dictionary loader is one of the things that may not be there.
 * Two languages, the deployment's own and the fallback, is the whole
 * vocabulary a crash screen needs.
 */
type State = { error: Error | null }

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The console is still the place the stack is read from; the screen only
    // has to say that there is one.
    console.error('Uncaught render error:', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    const isPortuguese = (navigator.language || '').toLowerCase().startsWith('pt')
    return (
      <div role="alert" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '2rem 1rem', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ width: '100%', maxWidth: '32rem', minWidth: 0, textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>
            {isPortuguese ? 'O painel encontrou um erro e não conseguiu abrir esta tela.' : 'The panel hit an error and could not open this screen.'}
          </h1>
          <p style={{ opacity: 0.8, marginBottom: '1.25rem', fontSize: '0.9rem' }}>
            {isPortuguese
              ? 'Recarregar costuma resolver. Se voltar a acontecer, avise quem administra o painel e informe o horário.'
              : 'Reloading usually fixes it. If it happens again, tell whoever runs the panel and note the time.'}
          </p>
          <button type="button" onClick={() => window.location.reload()} style={{ padding: '0.6rem 1.2rem', borderRadius: '0.5rem', border: '1px solid currentColor', background: 'transparent', color: 'inherit', cursor: 'pointer' }}>
            {isPortuguese ? 'Recarregar' : 'Reload'}
          </button>
          <pre style={{ marginTop: '1.5rem', textAlign: 'left', fontSize: '0.75rem', opacity: 0.6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {String(this.state.error?.message || this.state.error)}
          </pre>
        </div>
      </div>
    )
  }
}
