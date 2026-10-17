import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import App from './app'
import { ErrorBoundary } from './components/error-boundary'
import './styles/globals.css'
import { detectLocale, loadDictionary } from './lib/i18n'

// Start fetching the visitor's dictionary during module evaluation rather than
// from an effect, so the first paint is already in the right language.
void loadDictionary(detectLocale())

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>,
)
