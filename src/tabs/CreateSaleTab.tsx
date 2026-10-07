import { useEffect, useState } from 'react'
import { Address, toNano } from '@ton/core'
import { Addr, Badge, Btn, Card, Field } from '../components/ui'
import { Msg, parseAddr, toUnits, useApp, useAsync } from '../lib/app'
import {
  addrHashKey,
  buildSaleStateInit,
  deployerDoSalePayload,
  GETGEMS_DEPLOYER,
  emptyJettonDict,
  newKeyPair,
  nftTransferBody,
  randomQueryId,
  saleDeployBlankBody,
  saleDeployJettonBody,
  stateInitBoc,
} from '../lib/contracts'

// Getgems marketplace parameters from https://github.com/getgems-io/nft-contracts#readme (mainnet)
const GETGEMS_MAINNET = {
  marketplace: 'EQBYTuYbLf8INxFtD8tQeNk5ZLy-nAX9ahQbG_yl1qQ-GEMS',
  feeAddress: 'EQCjk1hh952vWaE9bRguFkAhDAL5jj3xj9p0uPWrFBq_GEMS',
  feePercent: 5,
}
// Getgems testnet marketplace parameters
const GETGEMS_TESTNET = {
  marketplace: 'kQBZp2tZ9WUZQP8AgL2gUHkdJQe-8NyAcFksn3L7dcZxYJkN',
  feeAddress: 'kQC1kDpUayI56PGs1s54n3z7CtDQ6Bl3Uscf_GQ1H01OeQX6',
  feePercent: 5,
}

export function CreateSaleTab({ nft, onCreated }: { nft: string; onCreated: () => void }) {
  const { wallet, api, fmt, jettons, send, addSale, network } = useApp()
  const [nftStr, setNftStr] = useState(nft)
  useEffect(() => setNftStr(nft), [nft])
  const nftAddr = parseAddr(nftStr)

  const [tonPrice, setTonPrice] = useState('1')
  const [jPrices, setJPrices] = useState<Record<string, string>>({})
  const [marketplace, setMarketplace] = useState('')
  const [feeAddr, setFeeAddr] = useState('')
  const [feePct, setFeePct] = useState('5')
  const [preset, setPreset] = useState<'getgems' | 'own' | 'custom'>('getgems')
  const [copyFrom, setCopyFrom] = useState('')

  const getgems = useAsync(
    async () =>
      network === 'mainnet'
        ? GETGEMS_MAINNET
        : GETGEMS_TESTNET,
    [network],
  )

  useEffect(() => {
    if (preset === 'getgems' && getgems.data) {
      setMarketplace(fmt(Address.parse(getgems.data.marketplace)))
      setFeeAddr(fmt(Address.parse(getgems.data.feeAddress)))
      setFeePct(String(getgems.data.feePercent))
    }
    if (preset === 'own') {
      setMarketplace('')
      setFeeAddr('')
      setFeePct('5')
    }
  }, [preset, getgems.data, fmt])

  async function copyFromSale() {
    const a = parseAddr(copyFrom)
    if (!a) throw new Error('Невірна адреса продажу')
    const d = await api.getSaleData(a)
    setPreset('custom')
    setMarketplace(fmt(d.marketplaceAddress))
    setFeeAddr(d.feeAddress ? fmt(d.feeAddress) : '')
    setFeePct(String(d.feePercent))
  }
  const [royaltyAddr, setRoyaltyAddr] = useState('')
  const [royaltyPct, setRoyaltyPct] = useState('0')
  const [deployMode, setDeployMode] = useState<'deployer' | 'auto' | 'blank' | 'jetton'>('deployer')
  const [withTransfer, setWithTransfer] = useState(true)

  const nftInfo = useAsync(async () => {
    if (!nftAddr) return null
    const d = await api.getNftData(nftAddr)
    const royalty = await api.getRoyalty(nftAddr, d.collection)
    return { ...d, royalty }
  }, [nftStr, api])

  useEffect(() => {
    const r = nftInfo.data?.royalty
    if (r) {
      setRoyaltyPct(String(Number(r.percent.toFixed(3))))
      setRoyaltyAddr(fmt(r.address))
    }
  }, [nftInfo.data, fmt])

  const selectedJettons = jettons.filter((j) => (jPrices[j.master] ?? '').trim() !== '')
  const mode = deployMode === 'auto' ? (selectedJettons.length ? 'jetton' : 'blank') : deployMode
  const modeLabel = { deployer: 'через деплойер Getgems', jetton: 'deploy_jetton', blank: 'deploy_blank' }[mode]
  const isOwner = !!(wallet && nftInfo.data?.owner?.equals(wallet))

  async function create() {
    if (!wallet) throw new Error('Підключіть гаманець')
    if (!nftAddr) throw new Error('Невірна адреса NFT')
    if (preset === 'getgems' && !getgems.data) throw new Error('Параметри Getgems ще не завантажені — оновіть пресет')
    const mp = marketplace ? parseAddr(marketplace) : wallet
    const fee = feeAddr ? parseAddr(feeAddr) : wallet
    const roy = royaltyAddr ? parseAddr(royaltyAddr) : wallet
    if (!mp || !fee || !roy) throw new Error('Невірна адреса маркетплейсу / комісії / роялті')
    const feePercent = Number(feePct)
    const royaltyPercent = Number(royaltyPct)
    if (feePercent + royaltyPercent >= 100) throw new Error('Комісія + роялті мають бути < 100%')
    const fullTonPrice = toUnits(tonPrice || '0', 9)
    if (mode === 'blank' && selectedJettons.length)
      throw new Error('deploy_blank не встановлює ціни в жетонах. Оберіть deploy_jetton або додайте їх пізніше через change_price.')
    if (fullTonPrice === 0n && selectedJettons.length === 0) throw new Error('Вкажіть ціну в TON або хоча б в одному жетоні')

    const viaDeployer = mode === 'deployer'
    const deployer = Address.parse(GETGEMS_DEPLOYER[network])
    if (viaDeployer && !isOwner) throw new Error('NFT має належати підключеному гаманцю')
    const keyPair = mode === 'jetton' || viaDeployer ? await newKeyPair() : null
    const { address: sale, init } = buildSaleStateInit({
      // deploy_jetton must be sent by the marketplace stored in data: our wallet, or the Getgems deployer
      marketplaceAddress: viaDeployer ? deployer : mode === 'jetton' ? wallet : mp,
      // via deployer the NFT is forwarded without ownership_assigned, so the seller is set right away
      nftOwnerAddress: viaDeployer ? wallet : null,
      nftAddress: nftAddr,
      fullTonPrice,
      feeAddress: fee,
      feePercent,
      royaltyAddress: roy,
      royaltyPercent,
      publicKey: keyPair?.publicKey ?? null,
      createdAt: Math.floor(Date.now() / 1000),
    })

    const queryId = randomQueryId()
    let body
    if (keyPair) {
      const dict = emptyJettonDict()
      for (const j of selectedJettons) {
        const master = Address.parse(j.master)
        const saleJettonWallet = await api.getJettonWallet(master, sale)
        dict.set(addrHashKey(saleJettonWallet), { price: toUnits(jPrices[j.master], j.decimals), jettonMaster: master })
      }
      body = saleDeployJettonBody({ queryId, newMarketplace: mp, jettonDict: dict, secretKey: keyPair.secretKey })
    } else {
      body = saleDeployBlankBody(queryId)
    }

    const msgs: Msg[] = viaDeployer
      ? [{
          // one message, like getgems.io: NFT → deployer → (deploy sale + forward NFT to it)
          to: nftAddr,
          value: toNano('0.25'),
          body: nftTransferBody({
            queryId, newOwner: deployer, responseTo: wallet, forwardAmount: toNano('0.2'),
            rawForwardPayload: deployerDoSalePayload(init, body),
          }),
        }]
      : [{ to: sale, value: toNano('0.05'), init: stateInitBoc(init), body }]
    if (!viaDeployer && withTransfer) {
      msgs.push({
        to: nftAddr,
        value: toNano('0.1'),
        body: nftTransferBody({ queryId, newOwner: sale, responseTo: wallet, forwardAmount: toNano('0.02') }),
      })
    }
    const ok = await send(`Створення продажу (${modeLabel})`, msgs)
    if (ok) {
      addSale({ address: fmt(sale), nft: fmt(nftAddr), createdAt: Date.now() })
      onCreated()
    }
  }

  return (
    <div className="grid2">
      <Card title="Виставити NFT на продаж">
        <Field label="Адреса NFT">
          <input value={nftStr} onChange={(e) => setNftStr(e.target.value)} placeholder="EQ… / kQ…" />
        </Field>
        {nftAddr && (
          <div className="info">
            {nftInfo.loading && <span className="muted">Читаю get_nft_data…</span>}
            {nftInfo.error && <span className="bad-text">{nftInfo.error}</span>}
            {nftInfo.data && (
              <>
                {nftInfo.data.meta.image && <img className="thumb" src={nftInfo.data.meta.image} alt="" />}
                <div>
                  <b>{nftInfo.data.meta.name ?? 'NFT'}</b>
                  <div>Власник: <Addr a={nftInfo.data.owner} /> {isOwner ? <Badge kind="ok">це ви</Badge> : <Badge kind="warn">не ви</Badge>}</div>
                  <div>Колекція: <Addr a={nftInfo.data.collection} /></div>
                  <div>Роялті NFT: {nftInfo.data.royalty ? `${nftInfo.data.royalty.percent}%` : 'немає'}</div>
                </div>
              </>
            )}
          </div>
        )}

        <h4>Ціни</h4>
        <Field label="Ціна в TON" hint="0 — продаж за TON вимкнено (тільки жетони)">
          <input value={tonPrice} onChange={(e) => setTonPrice(e.target.value)} />
        </Field>
        {jettons.length === 0 && <p className="muted">Немає жетонів — додайте їх на вкладці «Жетони».</p>}
        {jettons.map((j) => (
          <Field key={j.master} label={`Ціна в ${j.symbol}`} hint="порожньо — не приймати цей жетон">
            <input value={jPrices[j.master] ?? ''} onChange={(e) => setJPrices({ ...jPrices, [j.master]: e.target.value })} />
          </Field>
        ))}

        <h4>Маркетплейс, комісія, роялті</h4>
        <div className="row">
          <button className={`chip ${preset === 'getgems' ? 'active' : ''}`} onClick={() => { setPreset('getgems'); getgems.reload() }}>Getgems</button>
          <button className={`chip ${preset === 'own' ? 'active' : ''}`} onClick={() => setPreset('own')}>Мій гаманець</button>
        </div>
        {preset === 'getgems' && (
          <p className="muted small">
            {getgems.loading && 'Читаю параметри Getgems…'}
            {getgems.error && <span className="bad-text">Не вдалося прочитати параметри Getgems: {getgems.error}</span>}
            {getgems.data && (
              <>
                Маркетплейс і комісія {getgems.data.feePercent}% — як у Getgems ({network}). Контракт
                деплоїть ваш гаманець, а маркетплейсом стає Getgems. Скасувати продаж зможете ви як продавець; op 555 буде
                доступний лише Getgems. Getgems показує ціни тільки в підтримуваних ним жетонах.
              </>
            )}
          </p>
        )}
        <div className="row end">
          <Field label="Або скопіювати маркетплейс і комісію з будь-якого продажу v4r1">
            <input value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)} placeholder="адреса контракту продажу" />
          </Field>
          <Btn kind="secondary" onClick={copyFromSale}>Скопіювати</Btn>
        </div>
        <div className="row">
          <Field label="Адреса маркетплейсу" hint="може скасувати продаж і виконувати op 555. Порожньо = ваш гаманець">
            <input value={marketplace} onChange={(e) => { setPreset('custom'); setMarketplace(e.target.value) }} placeholder={wallet ? fmt(wallet) : ''} />
          </Field>
        </div>
        <div className="row">
          <Field label="Адреса комісії" hint="порожньо = ваш гаманець">
            <input value={feeAddr} onChange={(e) => { setPreset('custom'); setFeeAddr(e.target.value) }} placeholder={wallet ? fmt(wallet) : ''} />
          </Field>
          <Field label="Комісія, %"><input value={feePct} onChange={(e) => { setPreset('custom'); setFeePct(e.target.value) }} /></Field>
        </div>
        <div className="row">
          <Field label="Адреса роялті" hint="підставляється з royalty_params NFT">
            <input value={royaltyAddr} onChange={(e) => setRoyaltyAddr(e.target.value)} placeholder={wallet ? fmt(wallet) : ''} />
          </Field>
          <Field label="Роялті, %"><input value={royaltyPct} onChange={(e) => setRoyaltyPct(e.target.value)} /></Field>
        </div>

        <h4>Деплой</h4>
        <div className="row">
          {(['deployer', 'auto', 'blank', 'jetton'] as const).map((m) => (
            <button key={m} className={`chip ${deployMode === m ? 'active' : ''}`} onClick={() => setDeployMode(m)}>
              {m === 'deployer' ? 'деплойер Getgems' : m === 'auto' ? 'напряму (авто)' : m === 'blank' ? 'deploy_blank' : 'deploy_jetton'}
            </button>
          ))}
        </div>
        {mode === 'deployer' ? (
          <p className="muted small">
            Як на getgems.io: одне повідомлення — NFT передається на деплойер Getgems (<Addr a={Address.parse(GETGEMS_DEPLOYER[network])} />)
            з payload <code>do_sale</code> (state init + підписаний <code>deploy_jetton</code>). Деплойер розгортає продаж і пересилає
            на нього NFT. Продавець записаний у data одразу, маркетплейсом стає адреса з поля вище. 0.25 TON, надлишок повернеться.
          </p>
        ) : (
          <label className="checkbox">
            <input type="checkbox" checked={withTransfer} onChange={(e) => setWithTransfer(e.target.checked)} />
            Одразу передати NFT на контракт продажу (2 повідомлення в одній транзакції)
          </label>
        )}
        <Btn disabled={!wallet || !nftAddr} onClick={create}>
          Створити продаж ({modeLabel})
        </Btn>
      </Card>

      <Card title="Як це працює">
        <ol className="steps">
          <li>
            Застосунок формує <b>state init</b> контракту <code>nft-fixprice-sale-v4r1</code>: ціна в TON, адреси
            комісії/роялті/NFT, <code>nft_owner_address = addr_none</code>, порожній словник жетонів.
          </li>
          <li>
            <b>deploy_blank</b> (<code>0x664c0905</code>) — просто деплой. Продаж тільки за TON, жетони можна додати пізніше
            через <code>change_price</code>.
          </li>
          <li>
            <b>deploy_jetton</b> (<code>0xfb5dbf47</code>) — у data кладеться одноразовий ed25519 публічний ключ, а в
            повідомленні — підписані <i>нова адреса маркетплейсу</i> та <i>словник цін у жетонах</i>. Ключ словника —
            хеш адреси jetton-гаманця <u>самого контракту продажу</u>, тому його можна порахувати лише після обчислення
            адреси продажу. Деплоїти має адреса, що записана як маркетплейс у data (ваш гаманець).
          </li>
          <li>
            Передача NFT на контракт → NFT надсилає <code>ownership_assigned</code> → контракт записує
            <code> nft_owner_address</code> = попередній власник. Відтепер продаж активний.
          </li>
          <li>
            Якщо щось пішло не так (NFT прийшла раніше за деплой тощо) — маркетплейс може повернути NFT через{' '}
            <b>op 555</b> на вкладці «Продажі».
          </li>
        </ol>
        <p className="muted">Газ: деплой 0.05 TON, передача NFT 0.1 TON (з них 0.02 forward на контракт), надлишок повертається.</p>
      </Card>
    </div>
  )
}
