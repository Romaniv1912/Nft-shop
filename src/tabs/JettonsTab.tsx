import { useState } from 'react'
import { Address, toNano } from '@ton/core'
import { Addr, Btn, Card, Field } from '../components/ui'
import { fromUnits, parseAddr, toUnits, useApp, useAsync } from '../lib/app'
import { buildJettonMinter, jettonMintBody, randomQueryId, stateInitBoc } from '../lib/contracts'

const PRESETS = [
  { name: 'Demo USD', symbol: 'dUSD', decimals: 6, image: 'https://picsum.photos/seed/dusd/256', supply: '100000' },
  { name: 'Demo Gem', symbol: 'GEM', decimals: 9, image: 'https://picsum.photos/seed/gem/256', supply: '1000000' },
]

export function JettonsTab() {
  const { wallet, send, api, jettons, addJetton, removeJetton, fmt, network } = useApp()
  const [form, setForm] = useState(PRESETS[0])
  const [addAddr, setAddAddr] = useState('')

  const balances = useAsync(async () => {
    if (!wallet) return {} as Record<string, bigint>
    const out: Record<string, bigint> = {}
    for (const j of jettons) {
      try {
        const w = await api.getJettonWallet(Address.parse(j.master), wallet)
        out[j.master] = await api.getJettonBalance(w)
      } catch {
        out[j.master] = 0n
      }
    }
    return out
  }, [wallet, api, jettons.length])

  async function createJetton() {
    if (!wallet) return
    const m = await buildJettonMinter({ admin: wallet, ...form, description: `${form.name} — демо-жетон для тесту продажу NFT` })
    const amount = toUnits(form.supply, form.decimals)
    const ok = await send(`Створення жетона ${form.symbol}`, [
      {
        to: m.address,
        value: toNano('0.15'),
        init: stateInitBoc(m.init),
        body: jettonMintBody({ queryId: randomQueryId(), to: wallet, amount, responseTo: wallet }),
      },
    ])
    if (ok) addJetton({ master: fmt(m.address), symbol: form.symbol, name: form.name, decimals: form.decimals, own: true })
  }

  return (
    <div className="grid2">
      <Card title="Створити демо-жетон">
        <p className="muted">
          Деплой стандартного jetton-minter (TEP-74, <code>ton-blockchain/token-contract</code>) з вашим гаманцем як
          адміном і одразу мінт усієї емісії вам. Так можна протестувати покупку NFT за жетони у {network}.
        </p>
        <p className="muted small">
          У jetton-wallet зменшено резерв газу (0.015 → 0.01 TON): контракт продажу додає до кожного переказу жетонів лише
          0.04 TON, а оригінальний референсний гаманець вимагає більше. Сучасні жетони (USD₮ тощо) працюють без змін.
        </p>
        <div className="row">
          {PRESETS.map((p) => (
            <button key={p.symbol} className={`chip ${form.symbol === p.symbol ? 'active' : ''}`} onClick={() => setForm(p)}>
              {p.symbol}
            </button>
          ))}
        </div>
        <div className="row">
          <Field label="Назва"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Символ"><input value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })} /></Field>
        </div>
        <div className="row">
          <Field label="Decimals"><input type="number" value={form.decimals} onChange={(e) => setForm({ ...form, decimals: Number(e.target.value) })} /></Field>
          <Field label="Емісія"><input value={form.supply} onChange={(e) => setForm({ ...form, supply: e.target.value })} /></Field>
        </div>
        <Field label="URL зображення"><input value={form.image} onChange={(e) => setForm({ ...form, image: e.target.value })} /></Field>
        <Btn disabled={!wallet} onClick={createJetton}>Створити і змінтити (0.15 TON)</Btn>
      </Card>

      <Card title="Жетони для цін" actions={<Btn kind="secondary" onClick={balances.reload}>Оновити баланси</Btn>}>
        <p className="muted">Ці жетони можна обрати як валюту при виставленні NFT на продаж.</p>
        <table className="table">
          <thead>
            <tr><th>Жетон</th><th>Master</th><th>Мій баланс</th><th /></tr>
          </thead>
          <tbody>
            {jettons.map((j) => (
              <tr key={j.master}>
                <td><b>{j.symbol}</b> <span className="muted">{j.name} · {j.decimals} dec</span></td>
                <td><Addr a={parseAddr(j.master)} /></td>
                <td>{balances.data?.[j.master] !== undefined ? fromUnits(balances.data[j.master], j.decimals) : '…'}</td>
                <td className="row">
                  {j.own && wallet && <MintMore master={j.master} decimals={j.decimals} />}
                  <button className="link" onClick={() => removeJetton(j.master)}>✕</button>
                </td>
              </tr>
            ))}
            {jettons.length === 0 && (
              <tr><td colSpan={4} className="muted">Поки порожньо — створіть демо-жетон або додайте існуючий.</td></tr>
            )}
          </tbody>
        </table>
        <div className="row end">
          <Field label="Додати існуючий жетон (адреса jetton master)">
            <input value={addAddr} onChange={(e) => setAddAddr(e.target.value)} />
          </Field>
          <Btn
            kind="secondary"
            onClick={async () => {
              const a = parseAddr(addAddr)
              if (!a) throw new Error('Невірна адреса')
              const { meta, admin } = await api.getJettonMeta(a)
              addJetton({
                master: fmt(a),
                symbol: meta.symbol ?? '???',
                name: meta.name ?? '',
                decimals: meta.decimals ? Number(meta.decimals) : 9,
                own: !!(wallet && admin?.equals(wallet)),
              })
              setAddAddr('')
            }}
          >
            Додати
          </Btn>
        </div>
      </Card>
    </div>
  )
}

function MintMore({ master, decimals }: { master: string; decimals: number }) {
  const { wallet, send } = useApp()
  return (
    <Btn
      kind="secondary"
      title="Домінтити собі (ви адмін)"
      onClick={async () => {
        const v = prompt('Скільки домінтити?', '1000')
        if (!v || !wallet) return
        await send('Мінт жетонів', [
          {
            to: Address.parse(master),
            value: toNano('0.1'),
            body: jettonMintBody({ queryId: randomQueryId(), to: wallet, amount: toUnits(v, decimals), responseTo: wallet }),
          },
        ])
      }}
    >
      + мінт
    </Btn>
  )
}
