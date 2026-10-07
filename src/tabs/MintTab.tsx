import { useState } from 'react'
import { toNano } from '@ton/core'
import { Addr, Btn, Card, Field } from '../components/ui'
import { parseAddr, useApp, useAsync } from '../lib/app'
import { buildNftSingle, stateInitBoc } from '../lib/contracts'

export function MintTab({ onSell }: { onSell: (nft: string) => void }) {
  const { wallet, send, fmt, api } = useApp()
  const [name, setName] = useState('Demo NFT #1')
  const [description, setDescription] = useState('NFT для демонстрації контракту Getgems FixPrice v4r1')
  const [image, setImage] = useState('https://picsum.photos/seed/ton-demo/512')
  const [royalty, setRoyalty] = useState('5')
  const [royaltyAddr, setRoyaltyAddr] = useState('')
  const [minted, setMinted] = useState<string | null>(null)

  const nfts = useAsync(async () => (wallet ? api.listNfts(wallet) : []), [wallet, api])

  return (
    <div className="grid2">
      <Card title="Змінтити NFT">
        <p className="muted">
          Деплой одиночної NFT за стандартним контрактом Getgems <code>nft-single.fc</code> (TEP-62) з on-chain
          метаданими (TEP-64) та роялті. Власник і редактор — ваш гаманець.
        </p>
        <Field label="Назва">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Опис">
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="URL зображення">
          <input value={image} onChange={(e) => setImage(e.target.value)} />
        </Field>
        {image && <img className="preview" src={image} alt="" />}
        <div className="row">
          <Field label="Роялті, %">
            <input value={royalty} onChange={(e) => setRoyalty(e.target.value)} />
          </Field>
          <Field label="Адреса роялті" hint="порожньо = ваш гаманець">
            <input value={royaltyAddr} placeholder={wallet ? fmt(wallet) : ''} onChange={(e) => setRoyaltyAddr(e.target.value)} />
          </Field>
        </div>
        <Btn
          disabled={!wallet}
          onClick={async () => {
            if (!wallet) return
            const ra = royaltyAddr ? parseAddr(royaltyAddr) : wallet
            if (!ra) throw new Error('Невірна адреса роялті')
            const r = Number(royalty)
            if (!(r >= 0 && r <= 100)) throw new Error('Роялті 0..100%')
            const nft = await buildNftSingle({ owner: wallet, name, description, image, royaltyPercent: r, royaltyAddress: ra })
            const ok = await send(`Мінт NFT «${name}»`, [{ to: nft.address, value: toNano('0.1'), init: stateInitBoc(nft.init) }])
            if (ok) setMinted(fmt(nft.address))
          }}
        >
          {wallet ? 'Змінтити (0.1 TON)' : 'Спочатку підключіть гаманець'}
        </Btn>
        {minted && (
          <p>
            NFT: <Addr a={parseAddr(minted)} short={false} /> — з’явиться в мережі за ~10-20 с.{' '}
            <Btn kind="secondary" onClick={() => onSell(minted)}>Виставити на продаж →</Btn>
          </p>
        )}
      </Card>

      <Card title="Мої NFT" actions={<Btn kind="secondary" onClick={nfts.reload}>Оновити</Btn>}>
        {!wallet && <p className="muted">Підключіть гаманець.</p>}
        {nfts.loading && wallet && <p className="muted">Завантаження…</p>}
        {nfts.error && <p className="bad-text">{nfts.error}</p>}
        {nfts.data && nfts.data.length === 0 && <p className="muted">NFT не знайдено (індексатор може запізнюватись).</p>}
        <div className="nft-list">
          {nfts.data?.map((n) => (
            <div key={n.address.toRawString()} className="nft-item">
              {n.image ? <img src={n.image} alt="" /> : <div className="noimg">NFT</div>}
              <div>
                <b>{n.name || 'Без назви'}</b>
                <div><Addr a={n.address} /></div>
              </div>
              <Btn kind="secondary" onClick={() => onSell(fmt(n.address))}>Продати</Btn>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
