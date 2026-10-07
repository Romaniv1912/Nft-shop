// Builders for every message of the Getgems NFT FixPrice Sale v4r1 contract,
// plus helpers for the demo NFT (nft-single.fc) and demo jetton (token-contract).
// Contract source: https://github.com/getgems-io/nft-contracts/blob/main/packages/contracts/sources/nft-fixprice-sale-v4r1.fc
import {
  Address,
  beginCell,
  Builder,
  Cell,
  contractAddress,
  Dictionary,
  DictionaryValue,
  internal,
  Slice,
  StateInit,
  storeMessageRelaxed,
  storeStateInit,
  toNano,
} from '@ton/core'
import { keyPairFromSeed, sha256, sign, getSecureRandomBytes } from '@ton/crypto'
import { FIXPRICE_V4R1_CODE_BOC, NFT_SINGLE_CODE_BOC } from '../contracts/getgemsCode'
import { JETTON_MINTER_CODE_BOC, JETTON_WALLET_CODE_BOC } from '../contracts/jettonCode'

export const FIXPRICE_V4R1_CODE = Cell.fromBase64(FIXPRICE_V4R1_CODE_BOC)
export const NFT_SINGLE_CODE = Cell.fromBase64(NFT_SINGLE_CODE_BOC)
export const JETTON_MINTER_CODE = Cell.fromBase64(JETTON_MINTER_CODE_BOC)
export const JETTON_WALLET_CODE = Cell.fromBase64(JETTON_WALLET_CODE_BOC)

// ---- op codes (contracts/getgems/op-codes.fc) ----
export const OP = {
  FIX_PRICE_V4_DEPLOY_JETTON: 0xfb5dbf47,
  FIX_PRICE_V4_DEPLOY_BLANK: 0x664c0905,
  FIX_PRICE_V4_CHANGE_PRICE: 0xfd135f7b,
  FIX_PRICE_V4_CANCEL: 0x3,
  FIX_PRICE_V4_BUY: 0x2,
  EMERGENCY: 555,
  NFT_TRANSFER: 0x5fcc3d14,
  OWNERSHIP_ASSIGNED: 0x05138d91,
  JETTON_TRANSFER: 0x0f8a7ea5,
  JETTON_INTERNAL_TRANSFER: 0x178d4519,
  JETTON_MINT: 21,
} as const

// Gas constants from the contract: min_gas_amount() and min_gas_amount_jetton()
export const MIN_GAS = toNano('0.1')
export const MIN_GAS_JETTON = toNano('0.26')

export const SALE_ERRORS: Record<number, string> = {
  35: 'Невірний підпис deploy_jetton',
  350: 'У контракті немає публічного ключа',
  404: 'Продаж вже завершено або скасовано',
  405: 'Emergency: mode & 32 заборонено',
  406: 'Emergency: заборонено ±10 хв від моменту продажу',
  450: 'Недостатньо TON: потрібно price + 0.1',
  451: 'Комісії перевищують ціну',
  452: 'Жетон-гаманець не в workchain 0',
  457: 'Скасування: потрібно ≥ 0.1 TON',
  458: 'Скасувати може тільки власник або маркетплейс',
  459: 'Продаж за TON вимкнено (ціна = 0)',
  4501: 'Сума менша за ціну',
  500: 'Ініціалізувати може тільки сама NFT',
  501: 'Очікувався ownership_assigned',
  65535: 'Невідомий op',
}

export type JettonPrice = { price: bigint; jettonMaster: Address }

// Dictionary value: (Coins, MsgAddress) — key is the hash of the sale's jetton wallet address
export const JettonPriceValue: DictionaryValue<JettonPrice> = {
  serialize(src, builder) {
    builder.storeCoins(src.price).storeAddress(src.jettonMaster)
  },
  parse(slice) {
    return { price: slice.loadCoins(), jettonMaster: slice.loadAddress() }
  },
}

export function emptyJettonDict() {
  return Dictionary.empty(Dictionary.Keys.BigUint(256), JettonPriceValue)
}

export function addrHashKey(a: Address) {
  return BigInt('0x' + a.hash.toString('hex'))
}

export function randomQueryId() {
  return BigInt(Math.floor(Math.random() * 2 ** 52))
}

export function boc(c: Cell) {
  return c.toBoc().toString('base64')
}

export function stateInitBoc(si: StateInit) {
  return boc(beginCell().store(storeStateInit(si)).endCell())
}

function percentToInt(p: number) {
  const v = Math.round(p * 1000) // p in percent, stored as percent * 1000 (100% = 100000)
  if (v < 0 || v > 100000) throw new Error('Відсоток має бути від 0 до 100')
  return v
}

// ---------------- Sale contract ----------------

export type SaleConfig = {
  marketplaceAddress: Address // address stored in data (must be the deployer for deploy_jetton)
  nftAddress: Address
  nftOwnerAddress?: Address | null // set when deployed via Getgems deployer (no ownership_assigned)
  fullTonPrice: bigint
  feeAddress: Address
  feePercent: number // in %
  royaltyAddress: Address
  royaltyPercent: number // in %
  publicKey: Buffer | null
  createdAt: number
}

// storage: see buildNftFixPriceSaleV4R1Data in getgems repo
export function buildSaleData(cfg: SaleConfig) {
  return beginCell()
    .storeBit(false) // is_complete
    .storeAddress(cfg.marketplaceAddress)
    .storeAddress(cfg.nftOwnerAddress ?? null) // null → set later by ownership_assigned
    .storeCoins(cfg.fullTonPrice)
    .storeUint(0, 32) // sold_at
    .storeUint(0, 64) // sold_query_id
    .storeRef(
      beginCell()
        .storeAddress(cfg.feeAddress)
        .storeAddress(cfg.royaltyAddress)
        .storeUint(percentToInt(cfg.feePercent), 17)
        .storeUint(percentToInt(cfg.royaltyPercent), 17)
        .storeAddress(cfg.nftAddress)
        .storeUint(cfg.createdAt, 32)
        .endCell(),
    )
    .storeDict(null) // jetton dict is empty at deploy: address depends on data
    .storeMaybeBuffer(cfg.publicKey, 32)
    .endCell()
}

export function buildSaleStateInit(cfg: SaleConfig): { address: Address; init: StateInit } {
  const init: StateInit = { code: FIXPRICE_V4R1_CODE, data: buildSaleData(cfg) }
  return { address: contractAddress(0, init), init }
}

export async function newKeyPair() {
  return keyPairFromSeed(await getSecureRandomBytes(32))
}

// op deploy_blank: just deploys state init, no jetton prices
export function saleDeployBlankBody(queryId: bigint) {
  return beginCell().storeUint(OP.FIX_PRICE_V4_DEPLOY_BLANK, 32).storeUint(queryId, 64).endCell()
}

// op deploy_jetton: signed by one-time key whose public key is in data.
// Sets a new marketplace address and the jetton price dictionary.
export function saleDeployJettonBody(opts: {
  queryId: bigint
  newMarketplace: Address
  jettonDict: Dictionary<bigint, JettonPrice>
  secretKey: Buffer
}) {
  const signed = beginCell().storeAddress(opts.newMarketplace).storeDict(opts.jettonDict).endCell()
  const signature = sign(signed.hash(), opts.secretKey)
  return beginCell()
    .storeUint(OP.FIX_PRICE_V4_DEPLOY_JETTON, 32)
    .storeUint(opts.queryId, 64)
    .storeBuffer(signature, 64)
    .storeAddress(opts.newMarketplace)
    .storeDict(opts.jettonDict)
    .endCell()
}

// Buy with TON: op 0 (empty body) or op 2 (buy) + query_id
export function saleBuyBody(kind: 'empty' | 'op2', queryId: bigint) {
  if (kind === 'empty') return null
  return beginCell().storeUint(OP.FIX_PRICE_V4_BUY, 32).storeUint(queryId, 64).endCell()
}

// Cancel: op 3 + query_id, or text comment "cancel"
export function saleCancelBody(kind: 'op3' | 'text', queryId: bigint) {
  if (kind === 'text') return beginCell().storeUint(0, 32).storeStringTail('cancel').endCell()
  return beginCell().storeUint(OP.FIX_PRICE_V4_CANCEL, 32).storeUint(queryId, 64).endCell()
}

export function saleChangePriceBody(queryId: bigint, newTonPrice: bigint, dict: Dictionary<bigint, JettonPrice>) {
  return beginCell()
    .storeUint(OP.FIX_PRICE_V4_CHANGE_PRICE, 32)
    .storeUint(queryId, 64)
    .storeCoins(newTonPrice)
    .storeDict(dict.size ? dict : null)
    .endCell()
}

// op 555: marketplace sends arbitrary message from the sale contract
// (only when sale is complete or not initialized). mode & 32 is forbidden.
export function saleEmergencyBody(queryId: bigint, mode: number, msg: Cell) {
  return beginCell()
    .storeUint(OP.EMERGENCY, 32)
    .storeUint(queryId, 64)
    .storeRef(beginCell().storeUint(mode, 8).storeRef(msg).endCell())
    .endCell()
}

export function relaxedInternal(opts: { to: Address; value: bigint; bounce?: boolean; body?: Cell }) {
  return beginCell()
    .store(storeMessageRelaxed(internal({ to: opts.to, value: opts.value, bounce: opts.bounce ?? false, body: opts.body })))
    .endCell()
}

export type SaleData = {
  isComplete: boolean
  createdAt: number
  marketplaceAddress: Address
  nftAddress: Address
  nftOwnerAddress: Address | null
  fullPrice: bigint
  feeAddress: Address | null
  feePercent: number // %
  royaltyAddress: Address | null
  royaltyPercent: number // %
  soldAt: number
  soldQueryId: bigint
  jettonPrices: { walletHash: bigint; price: bigint; jettonMaster: Address }[]
}

// ---------------- NFT ----------------

export function nftTransferBody(opts: {
  queryId: bigint
  newOwner: Address
  responseTo: Address | null
  forwardAmount: bigint
  rawForwardPayload?: Cell // stored as-is (no Either bit), as the Getgems deployer expects
}) {
  const b = beginCell()
    .storeUint(OP.NFT_TRANSFER, 32)
    .storeUint(opts.queryId, 64)
    .storeAddress(opts.newOwner)
    .storeAddress(opts.responseTo)
    .storeBit(false) // custom_payload
    .storeCoins(opts.forwardAmount)
  if (opts.rawForwardPayload) b.storeSlice(opts.rawForwardPayload.beginParse())
  else b.storeBit(false) // forward_payload in-place, empty
  return b.endCell()
}

// ---------------- Getgems deployer ----------------
// sources/deployer/deployer.fc in getgems-io/nft-contracts. The seller transfers the NFT to the
// deployer; ownership_assigned carries (do_sale, ^sale_state_init, ^sale_deploy_body). The deployer
// deploys the sale (it becomes `marketplace_address` in data, so it may send deploy_jetton) and
// forwards the NFT to it.
export const GETGEMS_DEPLOYER = {
  mainnet: 'EQAIFunALREOeQ99syMbO6sSzM_Fa1RsPD5TBoS0qVeKQ-AR',
  testnet: 'EQDZwUjVjK__PvChXCvtCMshBT1hrPKMwzRhyTAtonUbL2M3',
} as const
export const OP_DEPLOYER_DO_SALE = 0x0fe0ede

export function deployerDoSalePayload(saleInit: StateInit, saleDeployBody: Cell) {
  return beginCell()
    .storeUint(OP_DEPLOYER_DO_SALE, 32)
    .storeRef(beginCell().store(storeStateInit(saleInit)).endCell())
    .storeRef(saleDeployBody)
    .endCell()
}

// TEP-64 on-chain metadata
export async function buildOnchainContent(data: Record<string, string>) {
  const dict = Dictionary.empty(Dictionary.Keys.Buffer(32), Dictionary.Values.Cell())
  for (const [k, v] of Object.entries(data)) {
    if (v === '') continue
    dict.set(await sha256(k), beginCell().storeUint(0, 8).storeStringTail(v).endCell())
  }
  return beginCell().storeUint(0, 8).storeDict(dict).endCell()
}

const META_KEYS = ['name', 'description', 'image', 'symbol', 'decimals', 'uri']
export async function parseContent(content: Cell): Promise<Record<string, string>> {
  const s = content.beginParse()
  const prefix = s.loadUint(8)
  if (prefix === 1) return { uri: s.loadStringTail() }
  if (prefix !== 0) return {}
  const dict = s.loadDict(Dictionary.Keys.Buffer(32), Dictionary.Values.Cell())
  const out: Record<string, string> = {}
  for (const k of META_KEYS) {
    const v = dict.get(await sha256(k))
    if (!v) continue
    const vs = v.beginParse()
    if (vs.remainingBits >= 8 && vs.preloadUint(8) === 0) vs.loadUint(8)
    out[k] = vs.loadStringTail()
  }
  return out
}

export async function buildNftSingle(opts: {
  owner: Address
  name: string
  description: string
  image: string
  royaltyPercent: number
  royaltyAddress: Address
}) {
  const content = await buildOnchainContent({
    name: opts.name,
    description: opts.description,
    image: opts.image,
    // makes every minted NFT address unique
    nonce: (await getSecureRandomBytes(8)).toString('hex'),
  })
  const royalty = beginCell()
    .storeUint(Math.round(opts.royaltyPercent * 10), 16) // numerator
    .storeUint(1000, 16) // denominator
    .storeAddress(opts.royaltyAddress)
    .endCell()
  const data = beginCell()
    .storeAddress(opts.owner)
    .storeAddress(opts.owner) // editor
    .storeRef(content)
    .storeRef(royalty)
    .endCell()
  const init: StateInit = { code: NFT_SINGLE_CODE, data }
  return { address: contractAddress(0, init), init }
}

// ---------------- Jetton ----------------

export async function buildJettonMinter(opts: {
  admin: Address
  name: string
  symbol: string
  decimals: number
  description: string
  image: string
}) {
  const content = await buildOnchainContent({
    name: opts.name,
    symbol: opts.symbol,
    decimals: String(opts.decimals),
    description: opts.description,
    image: opts.image,
  })
  const data = beginCell()
    .storeCoins(0)
    .storeAddress(opts.admin)
    .storeRef(content)
    .storeRef(JETTON_WALLET_CODE)
    .endCell()
  const init: StateInit = { code: JETTON_MINTER_CODE, data }
  return { address: contractAddress(0, init), init }
}

export function jettonMintBody(opts: { queryId: bigint; to: Address; amount: bigint; responseTo: Address }) {
  const masterMsg = beginCell()
    .storeUint(OP.JETTON_INTERNAL_TRANSFER, 32)
    .storeUint(opts.queryId, 64)
    .storeCoins(opts.amount)
    .storeAddress(null) // from
    .storeAddress(opts.responseTo)
    .storeCoins(0) // forward_ton_amount
    .storeBit(false)
    .endCell()
  return beginCell()
    .storeUint(OP.JETTON_MINT, 32)
    .storeUint(opts.queryId, 64)
    .storeAddress(opts.to)
    .storeCoins(toNano('0.05')) // TON for wallet deploy
    .storeRef(masterMsg)
    .endCell()
}

export function jettonTransferBody(opts: {
  queryId: bigint
  amount: bigint
  destination: Address
  responseTo: Address
  forwardTonAmount: bigint
}) {
  return beginCell()
    .storeUint(OP.JETTON_TRANSFER, 32)
    .storeUint(opts.queryId, 64)
    .storeCoins(opts.amount)
    .storeAddress(opts.destination)
    .storeAddress(opts.responseTo)
    .storeBit(false) // custom_payload
    .storeCoins(opts.forwardTonAmount)
    .storeBit(false) // forward_payload in-place, empty
    .endCell()
}

export type { Builder, Slice }
