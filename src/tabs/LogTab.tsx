import { Btn, Card } from '../components/ui'
import { useApp } from '../lib/app'

export function LogTab() {
  const { logs, clearLogs, explorer } = useApp()
  return (
    <Card title="Журнал транзакцій" actions={<Btn kind="secondary" onClick={clearLogs}>Очистити</Btn>}>
      {logs.length === 0 && <p className="muted">Порожньо.</p>}
      <div className="log">
        {logs.map((l, i) => (
          <div key={i} className={`log-item ${l.status}`}>
            <div className="row">
              <b>{l.status === 'sent' ? '✔' : '✘'} {l.title}</b>
              <span className="muted small">{new Date(l.time).toLocaleString()}</span>
              {l.to && <a href={explorer(l.to)} target="_blank" rel="noreferrer">tonviewer ↗</a>}
            </div>
            <pre>{l.detail}</pre>
          </div>
        ))}
      </div>
    </Card>
  )
}
