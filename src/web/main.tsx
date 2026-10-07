/**
 * Web client entry — the same bundle runs in the Electron window and in any browser (desktop, phone). It talks to
 * the server only over REST (/api) and one WebSocket (/ws); `window.vesperDesktop` exists only in the desktop window.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter/wght.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import './styles/tokens.css'
import './styles/global.css'
import { App } from './app/App'
import { applyCachedAppearance } from './app/appearance'
import { boot } from './app/boot'
import './lib/commands'

applyCachedAppearance()

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
void boot()
