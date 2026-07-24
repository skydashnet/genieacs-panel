import React from 'react'
import ReactDOM from 'react-dom/client'
import CustomerPortal from './pages/customer-portal'
import './styles/globals.css'

const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches
document.documentElement.classList.toggle('dark', Boolean(prefersDark))

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CustomerPortal />
  </React.StrictMode>,
)
