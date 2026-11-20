import { useEffect, useRef, useState } from 'react'
import { CommandChat } from './components/CommandChat'
import { WhatsAppPanel } from './components/WhatsAppPanel'
import { StoreProvider, useStore } from './store'

function AppLock() {
  const { appLocked, unlockApp } = useStore()
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  if (!appLocked) return null
  return (
    <form
      className="app-lock"
      onSubmit={(event) => {
        event.preventDefault()
        if (!unlockApp(pin)) {
          setError('PIN incorreto')
          return
        }
        setPin('')
        setError('')
      }}
    >
      <strong>Chat Zap travado</strong>
      <input
        value={pin}
        onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 4))}
        inputMode="numeric"
        autoFocus
        placeholder="PIN de 4 dígitos"
      />
      {error ? <em>{error}</em> : null}
      <button type="submit">Abrir</button>
    </form>
  )
}

/**
 * Asks before anything that changes WhatsApp for real (send, delete, rename…). A centered dialog
 * over a dimmed screen: the old thin bar at the bottom was easy to miss, so sends silently waited.
 */
function ConfirmBar() {
  const { pendingCommand, confirmPending, cancelPending } = useStore()
  // Focus the dialog, not the Confirmar button: a quick double Enter must not confirm unread.
  const dialogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!pendingCommand) return
    dialogRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelPending()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pendingCommand, cancelPending])
  if (!pendingCommand) return null
  return (
    <div className="confirm-overlay" onClick={cancelPending}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-text"
        onClick={(event) => event.stopPropagation()}
      >
        <strong id="confirm-title">Confirmar</strong>
        <p id="confirm-text">{pendingCommand.label}</p>
        <span className="confirm-note">Isso mexe no seu WhatsApp de verdade.</span>
        <div className="confirm-actions">
          <button type="button" className="confirm-cancel" onClick={cancelPending}>
            Cancelar
          </button>
          <button type="button" className="confirm-ok" onClick={confirmPending}>
            Confirmar
          </button>
        </div>
      </div>
    </div>
  )
}

export function App() {
  return (
    <StoreProvider>
      <div className="app">
        <WhatsAppPanel />
        <CommandChat />
        <ConfirmBar />
        <AppLock />
      </div>
    </StoreProvider>
  )
}
