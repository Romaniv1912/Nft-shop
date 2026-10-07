import { ReactNode, useState } from 'react'
import { Address } from '@ton/core'
import { useApp } from '../lib/app'

export function Card({ title, children, actions }: { title?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && (
        <div className="card-head">
          {title && <h3>{title}</h3>}
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  )
}

export function Addr({ a, short = true }: { a: Address | null | undefined; short?: boolean }) {
  const { fmt, explorer } = useApp()
  if (!a) return <span className="muted">addr_none</span>
  const s = fmt(a)
  return (
    <a className="addr" href={explorer(a)} target="_blank" rel="noreferrer" title={s}>
      {short ? `${s.slice(0, 6)}…${s.slice(-6)}` : s}
    </a>
  )
}

export function Btn({
  onClick,
  children,
  kind = 'primary',
  disabled,
  title,
}: {
  onClick: () => unknown | Promise<unknown>
  children: ReactNode
  kind?: 'primary' | 'secondary' | 'danger'
  disabled?: boolean
  title?: string
}) {
  const [busy, setBusy] = useState(false)
  const { log } = useApp()
  return (
    <button
      className={`btn ${kind}`}
      disabled={disabled || busy}
      title={title}
      onClick={async () => {
        setBusy(true)
        try {
          await onClick()
        } catch (e) {
          const msg = String((e as Error)?.message ?? e)
          log({ title: 'Помилка', status: 'error', detail: msg })
          alert(msg)
        } finally {
          setBusy(false)
        }
      }}
    >
      {busy ? '…' : children}
    </button>
  )
}

export function Badge({ kind, children }: { kind: 'ok' | 'warn' | 'bad' | 'info'; children: ReactNode }) {
  return <span className={`badge ${kind}`}>{children}</span>
}

export function Check({ ok, children }: { ok: boolean | null; children: ReactNode }) {
  return (
    <li className={ok === null ? 'muted' : ok ? 'ok-text' : 'bad-text'}>
      {ok === null ? '…' : ok ? '✔' : '✘'} {children}
    </li>
  )
}
