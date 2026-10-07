import { useState } from 'react'
import { Address, fromNano, toNano } from '@ton/core'
import { Addr, Badge, Btn, Card, Check, Field } from '../components/ui'
import { fromUnits, parseAddr, SavedSale, toUnits, useApp, useAsync } from '../lib/app'
import { FIXPRICE_V4R1_CODE_HASH_HEX } from '../contracts/getgemsCode'
import {
  addrHashKey,
  emptyJettonDict,
  jettonTransferBody,
  MIN_GAS,
  MIN_GAS_JETTON,
  nftTransferBody,
  randomQueryId,
  relaxedInternal,
  saleBuyBody,
  saleCancelBody,
  saleChangePriceBody,
  saleEmergencyBody,
  SALE_ERRORS,
} from '../lib/contracts'

export function SalesTab() {
  const { sales, addSale, fmt } = useApp()
  const [addr, setAddr] = useState('')
  return (
    <div>
      <Card title="Додати продаж за адресою">
        <div className="row end">
          <Field label="Адреса контракту nft-fixprice-sale-v4r1" hint="будь-який продаж v4r1, не тільки створений тут">
            <input value={addr} onChange={(e) => setAddr(e.target.value)} />
          </Field>
          <Btn
            kind="secondary"
            onClick={() => {
              const a = parseAddr(addr)
              if (!a) throw new Error('Невірна адреса')
              addSale({ address: fmt(a), nft: '', createdAt: Date.now() })
              setAddr('')
            }}
          >
            Додати
          </Btn>
        </div>
      </Card>
      {sales.length === 0 && <p className="muted center">Продажів ще немає. Створіть на вкладці «Виставити».</p>}
      {sales.map((s) => (
        <SaleCard key={s.address} saved={s} />
      ))}
      <ErrorCodes />
    </div>
  )
}

type SaleJetton = { master: Address; wallet: Address; balance: bigint }

function statusOf(d: { isComplete: boolean; nftOwnerAddress: Address | null; soldAt: number }) {
  if (!d.nftOwnerAddress && !d.isComplete) return { kind: 'warn' as const, text: 'Не ініціалізовано (чекає NFT)' }
  if (!d.isComplete) return { kind: 'ok' as const, text: 'Активний' }
  if (d.soldAt === 0) return { kind: 'info' as const, text: 'Скасовано' }
  return { kind: 'bad' as const, text: 'Продано' }
}

function SaleCard({ saved }: { saved: SavedSale }) {
  const { api, wallet, jettons, send, removeSale } = useApp()
  const sale = Address.parse(saved.address)

  const st = useAsync(async () => {
    const acc = await api.codeHash(sale)
    if (acc.state !== 'active') return { acc, data: null, nft: null, jw: {} as Record<string, boolean>, saleJettons: [] as SaleJetton[] }
    const data = await api.getSaleData(sale)
    let nft = null
    try { nft = await api.getNftData(data.nftAddress) } catch { /* ignore */ }
    // verify that each dict key really is this sale's jetton wallet for the master
    const jw: Record<string, boolean> = {}
    const saleJettons: SaleJetton[] = []
    for (const p of data.jettonPrices) {
      try {
        const w = await api.getJettonWallet(p.jettonMaster, sale)
        jw[p.walletHash.toString()] = addrHashKey(w) === p.walletHash
        saleJettons.push({ master: p.jettonMaster, wallet: w, balance: await api.getJettonBalance(w) })
      } catch {
        jw[p.walletHash.toString()] = false
      }
    }
    return { acc, data, nft, jw, saleJettons }
  }, [saved.address, api])

  const d = st.data?.data
  const acc = st.data?.acc
  const nft = st.data?.nft
  const status = d ? statusOf(d) : null
  const isSeller = !!(wallet && d?.nftOwnerAddress?.equals(wallet))
  const isMarketplace = !!(wallet && d?.marketplaceAddress.equals(wallet))
  const canEmergency = !!d && (d.isComplete || !d.nftOwnerAddress)
  const jettonInfo = (master: Address) => jettons.find((j) => Address.parse(j.master).equals(master))

  const [extra, setExtra] = useState('0')
  const [buyKind, setBuyKind] = useState<'empty' | 'op2'>('op2')
  const [cancelKind, setCancelKind] = useState<'op3' | 'text'>('op3')

  return (
    <Card
      title={
        <>
          {nft?.meta.name ?? 'Продаж'} <Addr a={sale} />{' '}
          {status && <Badge kind={status.kind}>{status.text}</Badge>}
          {acc && acc.state !== 'active' && <Badge kind="warn">{acc.state}</Badge>}
        </>
      }
      actions={
        <>
          <Btn kind="secondary" onClick={st.reload}>Оновити</Btn>
          <button className="link" onClick={() => removeSale(saved.address)}>прибрати</button>
        </>
      }
    >
      {st.loading && <p className="muted">Читаю контракт…</p>}
      {st.error && <p className="bad-text">{st.error}</p>}
      {acc && acc.state !== 'active' && (
        <p className="muted">Контракт ще не задеплоєно (або транзакція ще обробляється). Оновіть за кілька секунд.</p>
      )}

      {d && (
        <div className="sale">
          <div className="sale-left">
            {nft?.meta.image && <img className="preview" src={nft.meta.image} alt="" />}
            <h4>get_fix_price_data_v4</h4>
            <table className="kv">
              <tbody>
                <tr><td>is_complete</td><td>{String(d.isComplete)}</td></tr>
                <tr><td>created_at</td><td>{new Date(d.createdAt * 1000).toLocaleString()}</td></tr>
                <tr><td>marketplace_address</td><td><Addr a={d.marketplaceAddress} /> {isMarketplace && <Badge kind="info">ви</Badge>}</td></tr>
                <tr><td>nft_address</td><td><Addr a={d.nftAddress} /></td></tr>
                <tr><td>nft_owner_address</td><td><Addr a={d.nftOwnerAddress} /> {isSeller && <Badge kind="info">ви</Badge>}</td></tr>
                <tr><td>full_price</td><td>{d.fullPrice > 0n ? `${fromNano(d.fullPrice)} TON` : '0 (за TON не продається)'}</td></tr>
                <tr><td>fee</td><td>{d.feePercent}% → <Addr a={d.feeAddress} /></td></tr>
                <tr><td>royalty</td><td>{d.royaltyPercent}% → <Addr a={d.royaltyAddress} /></td></tr>
                <tr><td>sold_at</td><td>{d.soldAt ? new Date(d.soldAt * 1000).toLocaleString() : 0}</td></tr>
                <tr><td>sold_query_id</td><td>{d.soldQueryId.toString()}</td></tr>
                <tr><td>balance</td><td>{fromNano(acc!.balance)} TON</td></tr>
                <tr>
                  <td>jetton_price_dict</td>
                  <td>
                    {d.jettonPrices.length === 0 && 'порожній'}
                    {d.jettonPrices.map((p) => {
                      const j = jettonInfo(p.jettonMaster)
                      const ok = st.data?.jw[p.walletHash.toString()]
                      return (
                        <div key={p.walletHash.toString()}>
                          {j ? `${fromUnits(p.price, j.decimals)} ${j.symbol}` : `${p.price} (raw)`} · master <Addr a={p.jettonMaster} />{' '}
                          {ok === false && <Badge kind="bad">ключ ≠ jetton wallet продажу</Badge>}
                        </div>
                      )
                    })}
                  </td>
                </tr>
              </tbody>
            </table>

            <h4>Перевірки перед покупкою</h4>
            <ul className="checks">
              <Check ok={acc!.codeHash === FIXPRICE_V4R1_CODE_HASH_HEX}>хеш коду = еталонний v4r1</Check>
              <Check ok={!d.isComplete}>is_complete = 0</Check>
              <Check ok={!!d.nftOwnerAddress}>nft_owner_address заповнено (продаж ініціалізовано)</Check>
              <Check ok={nft ? !!nft.owner?.equals(sale) : null}>NFT належить контракту продажу</Check>
              <Check ok={[d.nftAddress, d.feeAddress, d.royaltyAddress, d.nftOwnerAddress].every((a) => !a || a.workChain === 0)}>
                адреси в workchain 0
              </Check>
              <Check ok={d.feePercent + d.royaltyPercent < 100}>fee + royalty &lt; 100%</Check>
            </ul>
          </div>

          <div className="sale-right">
            {/* ---------- init: transfer NFT ---------- */}
            {!d.nftOwnerAddress && !d.isComplete && (
              <div className="action">
                <h4>Ініціалізація</h4>
                <p className="muted">Передайте NFT на контракт — він отримає <code>ownership_assigned</code> і запише продавця.</p>
                <Btn
                  disabled={!wallet || !(nft?.owner && wallet && nft.owner.equals(wallet))}
                  onClick={() =>
                    send('Передача NFT на контракт продажу', [
                      {
                        to: d.nftAddress,
                        value: toNano('0.1'),
                        body: nftTransferBody({ queryId: randomQueryId(), newOwner: sale, responseTo: wallet, forwardAmount: toNano('0.02') }),
                      },
                    ])
                  }
                >
                  Передати NFT (0.1 TON)
                </Btn>
              </div>
            )}

            {/* ---------- buy ---------- */}
            {!d.isComplete && d.nftOwnerAddress && (
              <div className="action">
                <h4>Купити</h4>
                {d.fullPrice > 0n && (
                  <>
                    <div className="row">
                      <button className={`chip ${buyKind === 'op2' ? 'active' : ''}`} onClick={() => setBuyKind('op2')}>op 2 (buy)</button>
                      <button className={`chip ${buyKind === 'empty' ? 'active' : ''}`} onClick={() => setBuyKind('empty')}>порожнє тіло (op 0)</button>
                    </div>
                    <Field label="Додатково TON на газ" hint="контракт вимагає price + 0.1; надлишок повернеться разом з NFT">
                      <input value={extra} onChange={(e) => setExtra(e.target.value)} />
                    </Field>
                    <Btn
                      disabled={!wallet}
                      onClick={() =>
                        send(`Купівля NFT за ${fromNano(d.fullPrice)} TON`, [
                          {
                            to: sale,
                            value: d.fullPrice + MIN_GAS + toUnits(extra || '0', 9),
                            body: saleBuyBody(buyKind, randomQueryId()),
                          },
                        ])
                      }
                    >
                      Купити за {fromNano(d.fullPrice)} TON (+{fromNano(MIN_GAS + toUnits(extra || '0', 9))} газ)
                    </Btn>
                  </>
                )}
                {d.jettonPrices.map((p) => {
                  const j = jettonInfo(p.jettonMaster)
                  return (
                    <Btn
                      key={p.walletHash.toString()}
                      kind="secondary"
                      disabled={!wallet}
                      onClick={async () => {
                        if (!wallet) return
                        const myJettonWallet = await api.getJettonWallet(p.jettonMaster, wallet)
                        const bal = await api.getJettonBalance(myJettonWallet)
                        if (bal < p.price) throw new Error(`Недостатньо жетонів: маєте ${j ? fromUnits(bal, j.decimals) : bal}`)
                        await send(`Купівля NFT за ${j ? fromUnits(p.price, j.decimals) + ' ' + j.symbol : p.price + ' jetton'}`, [
                          {
                            to: myJettonWallet,
                            value: toNano('0.4'),
                            body: jettonTransferBody({
                              queryId: randomQueryId(),
                              amount: p.price,
                              destination: sale,
                              responseTo: wallet,
                              forwardTonAmount: toNano('0.3'), // contract requires ≥ 0.26 TON
                            }),
                          },
                        ])
                      }}
                    >
                      Купити за {j ? `${fromUnits(p.price, j.decimals)} ${j.symbol}` : `${p.price} (raw)`}
                    </Btn>
                  )
                })}
                <p className="muted small">
                  За жетони: jetton transfer на адресу продажу з forward_ton_amount ≥ {fromNano(MIN_GAS_JETTON)} TON.
                  Якщо жетон не в словнику / сума мала / продаж закритий — контракт поверне жетони. Платимо рівно ціну:
                  повернення переплати (mode 64) може не пройти через нестачу TON на контракті, тоді жетони залишаться на
                  jetton-гаманці продажу і їх забирає маркетплейс через op 555.
                </p>
              </div>
            )}

            {/* ---------- seller ---------- */}
            {!d.isComplete && d.nftOwnerAddress && (
              <ChangePrice sale={sale} current={d} enabled={isSeller} />
            )}

            {!d.isComplete && d.nftOwnerAddress && (
              <div className="action">
                <h4>Скасувати продаж {!(isSeller || isMarketplace) && <span className="muted small">(тільки власник або маркетплейс)</span>}</h4>
                <div className="row">
                  <button className={`chip ${cancelKind === 'op3' ? 'active' : ''}`} onClick={() => setCancelKind('op3')}>op 3</button>
                  <button className={`chip ${cancelKind === 'text' ? 'active' : ''}`} onClick={() => setCancelKind('text')}>коментар "cancel"</button>
                </div>
                <Btn
                  kind="danger"
                  disabled={!(isSeller || isMarketplace)}
                  onClick={() =>
                    send('Скасування продажу', [{ to: sale, value: toNano('0.12'), body: saleCancelBody(cancelKind, randomQueryId()) }])
                  }
                >
                  Скасувати і повернути NFT (0.12 TON)
                </Btn>
              </div>
            )}

            {/* ---------- marketplace emergency ---------- */}
            <Emergency sale={sale} nftAddress={d.nftAddress} owner={d.nftOwnerAddress} soldAt={d.soldAt} enabled={isMarketplace && canEmergency} canEmergency={canEmergency} saleJettons={st.data?.saleJettons ?? []} />
          </div>
        </div>
      )}
    </Card>
  )
}

function ChangePrice({ sale, current, enabled }: { sale: Address; current: { fullPrice: bigint; jettonPrices: { price: bigint; jettonMaster: Address }[] }; enabled: boolean }) {
  const { jettons, api, send } = useApp()
  const [ton, setTon] = useState(fromNano(current.fullPrice))
  const [jp, setJp] = useState<Record<string, string>>(() => {
    const o: Record<string, string> = {}
    for (const j of jettons) {
      const p = current.jettonPrices.find((x) => x.jettonMaster.equals(Address.parse(j.master)))
      if (p) o[j.master] = fromUnits(p.price, j.decimals)
    }
    return o
  })
  return (
    <div className="action">
      <h4>Змінити ціну (change_price) {!enabled && <span className="muted small">(тільки nft_owner)</span>}</h4>
      <Field label="Нова ціна в TON (0 = вимкнути)"><input value={ton} onChange={(e) => setTon(e.target.value)} /></Field>
      {jettons.map((j) => (
        <Field key={j.master} label={`Ціна в ${j.symbol}`} hint="порожньо = прибрати">
          <input value={jp[j.master] ?? ''} onChange={(e) => setJp({ ...jp, [j.master]: e.target.value })} />
        </Field>
      ))}
      <p className="muted small">Увага: change_price повністю замінює словник цін у жетонах.</p>
      <Btn
        kind="secondary"
        disabled={!enabled}
        onClick={async () => {
          const dict = emptyJettonDict()
          for (const j of jettons) {
            if (!(jp[j.master] ?? '').trim()) continue
            const master = Address.parse(j.master)
            const w = await api.getJettonWallet(master, sale)
            dict.set(addrHashKey(w), { price: toUnits(jp[j.master], j.decimals), jettonMaster: master })
          }
          await send('Зміна ціни', [
            { to: sale, value: toNano('0.05'), body: saleChangePriceBody(randomQueryId(), toUnits(ton || '0', 9), dict) },
          ])
        }}
      >
        Змінити ціну
      </Btn>
    </div>
  )
}

function Emergency({
  sale, nftAddress, owner, soldAt, enabled, canEmergency, saleJettons,
}: { sale: Address; nftAddress: Address; owner: Address | null; soldAt: number; enabled: boolean; canEmergency: boolean; saleJettons: SaleJetton[] }) {
  const { wallet, send, fmt, jettons } = useApp()
  const [to, setTo] = useState('')
  const inWindow = soldAt !== 0 && Math.abs(Date.now() / 1000 - soldAt) < 600
  return (
    <div className="action emergency">
      <h4>Маркетплейс: op 555 (аварійне повідомлення)</h4>
      <p className="muted small">
        Доступно тільки адресі маркетплейсу і тільки коли продаж завершено/скасовано або не ініціалізовано. Контракт
        надсилає довільне повідомлення від свого імені (mode &amp; 32 заборонено, ±10 хв від продажу заборонено).
        {!canEmergency && ' Зараз продаж активний — op 555 недоступний.'}
        {inWindow && ' Зараз діє 10-хвилинне вікно після продажу.'}
      </p>
      <Field label="Отримувач" hint="порожньо = ваш гаманець">
        <input value={to} onChange={(e) => setTo(e.target.value)} placeholder={owner ? fmt(owner) : wallet ? fmt(wallet) : ''} />
      </Field>
      <div className="row">
        <Btn
          kind="secondary"
          disabled={!enabled || inWindow}
          onClick={() => {
            const dest = to ? parseAddr(to) : wallet
            if (!dest || !wallet) throw new Error('Невірна адреса')
            const q = randomQueryId()
            const inner = relaxedInternal({
              to: nftAddress,
              value: 0n,
              bounce: true,
              body: nftTransferBody({ queryId: q, newOwner: dest, responseTo: wallet, forwardAmount: 0n }),
            })
            return send('op 555: повернути NFT з контракту', [
              { to: sale, value: toNano('0.1'), body: saleEmergencyBody(q, 64, inner) }, // mode 64: carry incoming value
            ])
          }}
        >
          Забрати NFT з контракту
        </Btn>
        <Btn
          kind="secondary"
          disabled={!enabled || inWindow}
          onClick={() => {
            const dest = to ? parseAddr(to) : wallet
            if (!dest) throw new Error('Невірна адреса')
            const inner = relaxedInternal({ to: dest, value: 0n })
            return send('op 555: вивести баланс контракту', [
              { to: sale, value: toNano('0.02'), body: saleEmergencyBody(randomQueryId(), 128, inner) }, // mode 128: whole balance
            ])
          }}
        >
          Вивести весь баланс TON
        </Btn>
        {saleJettons.filter((j) => j.balance > 0n).map((j) => {
          const info = jettons.find((x) => Address.parse(x.master).equals(j.master))
          const label = info ? `${fromUnits(j.balance, info.decimals)} ${info.symbol}` : `${j.balance} (raw)`
          return (
            <Btn
              key={j.wallet.toRawString()}
              kind="secondary"
              disabled={!enabled || inWindow}
              title="Наприклад, жетони переплати, які контракт не зміг повернути"
              onClick={() => {
                const dest = to ? parseAddr(to) : wallet
                if (!dest || !wallet) throw new Error('Невірна адреса')
                const q = randomQueryId()
                const inner = relaxedInternal({
                  to: j.wallet,
                  value: 0n,
                  bounce: true,
                  body: jettonTransferBody({ queryId: q, amount: j.balance, destination: dest, responseTo: wallet, forwardTonAmount: 0n }),
                })
                return send('op 555: забрати жетони з контракту', [{ to: sale, value: toNano('0.1'), body: saleEmergencyBody(q, 64, inner) }])
              }}
            >
              Забрати {label}
            </Btn>
          )
        })}
      </div>
    </div>
  )
}

function ErrorCodes() {
  return (
    <Card title="Коди помилок контракту">
      <table className="table small">
        <tbody>
          {Object.entries(SALE_ERRORS).map(([k, v]) => (
            <tr key={k}><td><code>{k}</code></td><td>{v}</td></tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}
