import React from 'react'
import ReactDOM from 'react-dom/client'
import CustomerPortal from './pages/customer-portal'
import ReferralPage from './pages/referral'
import { LanguageProvider } from './contexts/language-context'
import './styles/globals.css'
import { detectLocale, loadDictionary } from './lib/i18n'

// Start fetching the visitor's dictionary during module evaluation rather than
// from an effect, so the first paint is already in the right language.
void loadDictionary(detectLocale())

const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches
document.documentElement.classList.toggle('dark', Boolean(prefersDark))

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LanguageProvider>
      {window.location.pathname.replace(/\/+$/, '') === '/indique' ? <ReferralPage /> : <CustomerPortal />}
    </LanguageProvider>
  </React.StrictMode>,
)
