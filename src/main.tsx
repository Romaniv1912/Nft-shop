import './polyfills'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { TonConnectUIProvider } from '@tonconnect/ui-react'
import { AppProvider } from './lib/app'
import App from './App'
import './styles.css'

const manifestUrl =
  import.meta.env.VITE_TONCONNECT_MANIFEST_URL ?? new URL('tonconnect-manifest.json', window.location.href).toString()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TonConnectUIProvider manifestUrl={manifestUrl}>
      <AppProvider>
        <App />
      </AppProvider>
    </TonConnectUIProvider>
  </StrictMode>,
)
