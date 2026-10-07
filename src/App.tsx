import { useState } from 'react'
import { TonConnectButton } from '@tonconnect/ui-react'
import { useApp } from './lib/app'
import { MintTab } from './tabs/MintTab'
import { JettonsTab } from './tabs/JettonsTab'
import { CreateSaleTab } from './tabs/CreateSaleTab'
import { SalesTab } from './tabs/SalesTab'
import { LogTab } from './tabs/LogTab'

const TABS = [
  ['mint', 'NFT'],
  ['jettons', 'Жетони'],
  ['create', 'Виставити'],
  ['sales', 'Продажі'],
  ['log', 'Журнал'],
] as const
type Tab = (typeof TABS)[number][0]

export default function App() {
  const { network, setNetwork, walletNetworkMismatch, apiKey, setApiKey, sales } = useApp()
  const [tab, setTab] = useState<Tab>('mint')
  const [sellNft, setSellNft] = useState('')
  const [showSettings, setShowSettings] = useState(false)

  return (
    <div className="app">
      <header>
        <div className="brand">
          <b>NFT Shop</b>
          <span className="muted">Getgems FixPrice Sale v4r1 demo</span>
        </div>
        <div className="row">
          <div className="net-switch">
            {(['testnet', 'mainnet'] as const).map((n) => (
              <button key={n} className={network === n ? 'active' : ''} onClick={() => setNetwork(n)}>
                {n}
              </button>
            ))}
          </div>
          {network === 'testnet' && (
            <a className="btn secondary" href="https://t.me/testgiver_ton_bot" target="_blank" rel="noreferrer">
              🚰 Тестові TON
            </a>
          )}
          <button className="btn secondary" onClick={() => setShowSettings((v) => !v)} title="Налаштування API">⚙</button>
          <TonConnectButton />
        </div>
      </header>

      {showSettings && (
        <div className="banner">
          <label className="field">
            <span>toncenter.com API key ({network}) — необов’язково, без ключа ліміт ~1 запит/с</span>
            <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="отримати в @tonapibot" />
          </label>
        </div>
      )}
      {network === 'mainnet' && <div className="banner warn">Ви в mainnet — всі транзакції з реальними TON.</div>}
      {walletNetworkMismatch && (
        <div className="banner bad">
          Гаманець підключено до іншої мережі, ніж обрано ({network}). Перемкніть мережу в гаманці або перепідключіть його.
        </div>
      )}

      <nav className="tabs">
        {TABS.map(([id, label]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {label}
            {id === 'sales' && sales.length > 0 && <span className="count">{sales.length}</span>}
          </button>
        ))}
      </nav>

      <main>
        {tab === 'mint' && <MintTab onSell={(a) => { setSellNft(a); setTab('create') }} />}
        {tab === 'jettons' && <JettonsTab />}
        {tab === 'create' && <CreateSaleTab nft={sellNft} onCreated={() => setTab('sales')} />}
        {tab === 'sales' && <SalesTab />}
        {tab === 'log' && <LogTab />}
      </main>

      <footer className="muted">
        Контракт:{' '}
        <a href="https://github.com/getgems-io/nft-contracts#nft-fixprice-sale-v4r1fc" target="_blank" rel="noreferrer">
          getgems-io/nft-contracts · nft-fixprice-sale-v4r1.fc
        </a>{' '}
        · дані читаються напряму з блокчейну через toncenter, без API Getgems
      </footer>
    </div>
  )
}
