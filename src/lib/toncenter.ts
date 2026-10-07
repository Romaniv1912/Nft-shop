// Minimal blockchain access through public toncenter.com endpoints (no Getgems API).
// v2 (through @ton/ton TonClient) — get-methods and account state;
// v3 indexer — list of NFTs and jetton wallets of an owner.
import { Address, Cell, Dictionary, TupleBuilder } from '@ton/core'
import { TonClient } from '@ton/ton'
import { JettonPriceValue, SaleData, parseContent } from './contracts'

export type Network = 'testnet' | 'mainnet'

const BASE: Record<Network, string> = {
  testnet: 'https://testnet.toncenter.com',
  mainnet: 'https://toncenter.com',
}

// toncenter without API key allows ~1 rps; serialize all calls
let queue: Promise<unknown> = Promise.resolve()
let lastCall = 0

function throttled<T>(fn: () => Promise<T>, apiKey: string): Promise<T> {
  const gap = apiKey ? 120 : 1100
  const run = async () => {
    const wait = lastCall + gap - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    for (let attempt = 0; ; attempt++) {
      lastCall = Date.now()
      try {
        return await fn()
      } catch (e) {
        const msg = String((e as Error)?.message ?? e)
        if (attempt < 3 && /429|rate|limit|timeout|network/i.test(msg)) {
          await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)))
          continue
        }
        throw e
      }
    }
  }
  const p = queue.then(run, run)
  queue = p.catch(() => undefined)
  return p
}

export class Api {
  readonly client: TonClient
  constructor(readonly network: Network, readonly apiKey: string) {
    this.client = new TonClient({ endpoint: `${BASE[network]}/api/v2/jsonRPC`, apiKey: apiKey || undefined })
  }

  private t<T>(fn: () => Promise<T>) {
    return throttled(fn, this.apiKey)
  }

  async v3<T = any>(path: string, params: Record<string, string | number>): Promise<T> {
    const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))
    return this.t(async () => {
      const res = await fetch(`${BASE[this.network]}/api/v3/${path}?${q}`, {
        headers: this.apiKey ? { 'X-API-Key': this.apiKey } : {},
      })
      if (!res.ok) throw new Error(`toncenter ${res.status}: ${await res.text()}`)
      return res.json()
    })
  }

  runGet(address: Address, method: string, args?: TupleBuilder) {
    return this.t(async () => {
      const r = await this.client.runMethodWithError(address, method, args?.build() ?? [])
      if (r.exit_code !== 0 && r.exit_code !== 1) throw new Error(`${method}: exit code ${r.exit_code}`)
      return r.stack
    })
  }

  getState(address: Address) {
    return this.t(() => this.client.getContractState(address))
  }

  async getSaleData(sale: Address): Promise<SaleData> {
    const s = await this.runGet(sale, 'get_fix_price_data_v4')
    const isComplete = s.readBigNumber() !== 0n
    const createdAt = s.readNumber()
    const marketplaceAddress = s.readAddress()
    const nftAddress = s.readAddress()
    const nftOwnerAddress = s.readAddressOpt()
    const fullPrice = s.readBigNumber()
    const feeAddress = s.readAddressOpt()
    const feePercent = s.readNumber() / 1000
    const royaltyAddress = s.readAddressOpt()
    const royaltyPercent = s.readNumber() / 1000
    const soldAt = s.readNumber()
    const soldQueryId = s.readBigNumber()
    const dictCell = s.readCellOpt()
    const jettonPrices: SaleData['jettonPrices'] = []
    if (dictCell) {
      const d = dictCell.beginParse().loadDictDirect(Dictionary.Keys.BigUint(256), JettonPriceValue)
      for (const [walletHash, v] of d) jettonPrices.push({ walletHash, ...v })
    }
    return {
      isComplete, createdAt, marketplaceAddress, nftAddress, nftOwnerAddress, fullPrice,
      feeAddress, feePercent, royaltyAddress, royaltyPercent, soldAt, soldQueryId, jettonPrices,
    }
  }

  async getNftData(nft: Address) {
    const s = await this.runGet(nft, 'get_nft_data')
    const init = s.readBigNumber() !== 0n
    const index = s.readBigNumber()
    const collection = s.readAddressOpt()
    const owner = s.readAddressOpt()
    const content = s.readCellOpt()
    let meta: Record<string, string> = {}
    if (content && !collection) {
      try { meta = await parseContent(content) } catch { /* ignore */ }
    }
    return { init, index, collection, owner, meta }
  }

  // royalty_params() of nft-single, or of the collection for collection items
  async getRoyalty(nft: Address, collection: Address | null) {
    for (const a of [nft, collection]) {
      if (!a) continue
      try {
        const s = await this.runGet(a, 'royalty_params')
        const factor = s.readNumber()
        const base = s.readNumber()
        const address = s.readAddressOpt()
        if (base > 0 && address) return { percent: (factor / base) * 100, address }
      } catch { /* not supported */ }
    }
    return null
  }

  async getJettonWallet(master: Address, owner: Address) {
    const b = new TupleBuilder()
    b.writeAddress(owner)
    const s = await this.runGet(master, 'get_wallet_address', b)
    return s.readAddress()
  }

  async getJettonBalance(wallet: Address) {
    try {
      const s = await this.runGet(wallet, 'get_wallet_data')
      return s.readBigNumber()
    } catch {
      return 0n
    }
  }

  async getJettonMeta(master: Address) {
    const s = await this.runGet(master, 'get_jetton_data')
    const totalSupply = s.readBigNumber()
    s.readBigNumber() // mintable
    const admin = s.readAddressOpt()
    const content = s.readCell()
    let meta: Record<string, string> = {}
    try { meta = await parseContent(content) } catch { /* ignore */ }
    if (meta.uri && (!meta.symbol || !meta.decimals)) {
      try {
        const r = await fetch(meta.uri.replace(/^ipfs:\/\//, 'https://ipfs.io/ipfs/'))
        meta = { ...(await r.json()), ...meta }
      } catch { /* ignore */ }
    }
    return { totalSupply, admin, meta }
  }

  async listNfts(owner: Address) {
    const r = await this.v3('nft/items', { owner_address: owner.toRawString(), limit: 100 })
    const meta = r.metadata ?? {}
    return (r.nft_items ?? []).map((it: any) => {
      const info = meta[it.address]?.token_info?.[0] ?? {}
      return {
        address: Address.parse(it.address),
        name: info.name ?? it.content?.name ?? '',
        image: info.image ?? info.extra?._image_medium ?? it.content?.image ?? '',
        collection: it.collection_address ? Address.parse(it.collection_address) : null,
      }
    }) as { address: Address; name: string; image: string; collection: Address | null }[]
  }

  async listJettonWallets(owner: Address) {
    const r = await this.v3('jetton/wallets', { owner_address: owner.toRawString(), limit: 100 })
    const meta = r.metadata ?? {}
    return (r.jetton_wallets ?? []).map((w: any) => {
      const info = meta[w.jetton]?.token_info?.[0] ?? {}
      return {
        wallet: Address.parse(w.address),
        master: Address.parse(w.jetton),
        balance: BigInt(w.balance),
        symbol: info.symbol ?? '',
        name: info.name ?? '',
        decimals: info.extra?.decimals !== undefined ? Number(info.extra.decimals) : undefined,
      }
    }) as { wallet: Address; master: Address; balance: bigint; symbol: string; name: string; decimals?: number }[]
  }

  async codeHash(address: Address) {
    const st = await this.getState(address)
    return {
      state: st.state,
      balance: st.balance,
      codeHash: st.code ? Cell.fromBoc(st.code)[0].hash().toString('hex') : null,
    }
  }
}
