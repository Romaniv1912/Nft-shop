// End-to-end check of all message builders against the real contract code in @ton/sandbox.
import { describe, it, expect, beforeAll } from 'vitest'
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox'
import { Address, Cell, StateInit, TupleBuilder, toNano } from '@ton/core'
import { Api } from '../src/lib/toncenter'
import {
  addrHashKey, buildJettonMinter, buildNftSingle, buildSaleStateInit, emptyJettonDict, jettonMintBody,
  jettonTransferBody, newKeyPair, nftTransferBody, relaxedInternal, saleBuyBody, saleCancelBody,
  saleChangePriceBody, saleDeployBlankBody, saleDeployJettonBody, saleEmergencyBody, FIXPRICE_V4R1_CODE,
  deployerDoSalePayload,
} from '../src/lib/contracts'
import { beginCell, contractAddress } from '@ton/core'
import { compileFunc } from '@ton-community/func-js'
import { readFileSync } from 'node:fs'
import { crc32 } from 'node:zlib'
import { FIXPRICE_V4R1_CODE_HASH_HEX } from '../src/contracts/getgemsCode'

class SandboxApi extends Api {
  constructor(private bc: Blockchain) { super('testnet', '') }
  override async runGet(address: Address, method: string, args?: TupleBuilder) {
    const r = await this.bc.runGetMethod(address, method, args?.build() ?? [])
    if (r.exitCode !== 0 && r.exitCode !== 1) throw new Error(`${method}: exit ${r.exitCode}`)
    return r.stackReader
  }
}


type Match = { from?: Address; to?: Address; success?: boolean; exitCode?: number; value?: bigint }
function findTx(txs: any[], m: Match) {
  return txs.find((tx) => {
    const info = tx.inMessage?.info
    if (!info || info.type !== 'internal') return false
    const d = tx.description
    const success = d.type === 'generic' && d.computePhase.type === 'vm' && d.computePhase.success && d.actionPhase?.success !== false
    const exitCode = d.computePhase?.type === 'vm' ? d.computePhase.exitCode : undefined
    return (!m.from || info.src.equals(m.from)) && (!m.to || info.dest.equals(m.to)) &&
      (m.success === undefined || success === m.success) && (m.exitCode === undefined || exitCode === m.exitCode) &&
      (m.value === undefined || info.value.coins === m.value)
  })
}
const expectTx = (txs: any[], m: Match) => expect(findTx(txs, m), JSON.stringify(m, (_, v) => (typeof v === 'bigint' ? v.toString() : v))).toBeTruthy()

let bc: Blockchain
let api: SandboxApi
let seller: SandboxContract<TreasuryContract>
let buyer: SandboxContract<TreasuryContract>
let market: SandboxContract<TreasuryContract>
let feeWallet: SandboxContract<TreasuryContract>
let jettonMaster: Address

const send = (from: SandboxContract<TreasuryContract>, to: Address, value: bigint, body?: Cell | null, init?: StateInit) =>
  from.send({ to, value, body: body ?? undefined, init, bounce: true })

async function mintNft(name: string) {
  const nft = await buildNftSingle({ owner: seller.address, name, description: 'd', image: 'https://x/y.png', royaltyPercent: 10, royaltyAddress: seller.address })
  await send(seller, nft.address, toNano('0.1'), null, nft.init)
  return nft.address
}

async function jettonBalance(owner: Address) {
  return api.getJettonBalance(await api.getJettonWallet(jettonMaster, owner))
}

async function createSale(nft: Address, opts: { tonPrice: bigint; jettonPrice?: bigint; transfer?: boolean }) {
  const kp = opts.jettonPrice ? await newKeyPair() : null
  const { address, init } = buildSaleStateInit({
    marketplaceAddress: kp ? seller.address : market.address,
    nftAddress: nft, fullTonPrice: opts.tonPrice,
    feeAddress: feeWallet.address, feePercent: 5,
    royaltyAddress: seller.address, royaltyPercent: 10,
    publicKey: kp?.publicKey ?? null, createdAt: Math.floor(Date.now() / 1000),
  })
  let body
  if (kp) {
    const dict = emptyJettonDict()
    dict.set(addrHashKey(await api.getJettonWallet(jettonMaster, address)), { price: opts.jettonPrice!, jettonMaster })
    body = saleDeployJettonBody({ queryId: 1n, newMarketplace: market.address, jettonDict: dict, secretKey: kp.secretKey })
  } else {
    body = saleDeployBlankBody(1n)
  }
  const r = await send(seller, address, toNano('0.05'), body, init)
  expectTx(r.transactions, { to: address, success: true })
  if (opts.transfer !== false) {
    await send(seller, nft, toNano('0.1'), nftTransferBody({ queryId: 1n, newOwner: address, responseTo: seller.address, forwardAmount: toNano('0.02') }))
  }
  return address
}

beforeAll(async () => {
  bc = await Blockchain.create()
  api = new SandboxApi(bc)
  seller = await bc.treasury('seller')
  buyer = await bc.treasury('buyer')
  market = await bc.treasury('market')
  feeWallet = await bc.treasury('fee')
  const m = await buildJettonMinter({ admin: seller.address, name: 'Demo USD', symbol: 'dUSD', decimals: 6, description: '', image: '' })
  jettonMaster = m.address
  await send(seller, m.address, toNano('0.15'), jettonMintBody({ queryId: 1n, to: buyer.address, amount: 1_000_000_000n, responseTo: seller.address }), m.init)
})

describe('fixprice v4r1 demo builders', () => {
  it('code hash matches reference', () => {
    expect(FIXPRICE_V4R1_CODE.hash().toString('hex')).toBe(FIXPRICE_V4R1_CODE_HASH_HEX)
  })

  it('mints nft-single with onchain metadata and royalty, and a jetton', async () => {
    const nft = await mintNft('Demo NFT')
    const d = await api.getNftData(nft)
    expect(d.owner?.equals(seller.address)).toBe(true)
    expect(d.meta.name).toBe('Demo NFT')
    expect(await api.getRoyalty(nft, null)).toMatchObject({ percent: 10 })
    expect(await jettonBalance(buyer.address)).toBe(1_000_000_000n)
    const meta = await api.getJettonMeta(jettonMaster)
    expect(meta.meta).toMatchObject({ symbol: 'dUSD', decimals: '6' })
  })

  it('deploy_jetton + transfer, then buy with jettons', async () => {
    const nft = await mintNft('J')
    const sale = await createSale(nft, { tonPrice: 0n, jettonPrice: 100_000_000n })
    const d = await api.getSaleData(sale)
    expect(d.marketplaceAddress.equals(market.address)).toBe(true)
    expect(d.nftOwnerAddress?.equals(seller.address)).toBe(true)
    expect(d.jettonPrices).toHaveLength(1)
    expect(d.feePercent).toBe(5)
    expect(d.royaltyPercent).toBe(10)

    // TON buy is disabled (459)
    const r0 = await send(buyer, sale, toNano('1'), saleBuyBody('op2', 5n))
    expectTx(r0.transactions, { to: sale, success: false, exitCode: 459 })

    const bw = await api.getJettonWallet(jettonMaster, buyer.address)
    await send(buyer, bw, toNano('0.4'), jettonTransferBody({ queryId: 7n, amount: 100_000_000n, destination: sale, responseTo: buyer.address, forwardTonAmount: toNano('0.3') }))
    expect((await api.getNftData(nft)).owner?.equals(buyer.address)).toBe(true)
    const after = await api.getSaleData(sale)
    expect(after.isComplete).toBe(true)
    expect(after.soldQueryId).toBe(7n)
    expect(await jettonBalance(seller.address)).toBe(95_000_000n) // 85 to seller + 10% royalty (royalty address is the seller too)
    expect(await jettonBalance(feeWallet.address)).toBe(5_000_000n)
    expect(await jettonBalance(buyer.address)).toBe(1_000_000_000n - 100_000_000n)
  })

  it('deploy_blank, buy for TON with op 2 and with empty body', async () => {
    for (const kind of ['op2', 'empty'] as const) {
      const nft = await mintNft('T' + kind)
      const sale = await createSale(nft, { tonPrice: toNano('1') })
      const low = await send(buyer, sale, toNano('1.05'), saleBuyBody(kind, 3n))
      expectTx(low.transactions, { to: sale, success: false, exitCode: 450 })
      const feeBefore = await feeWallet.getBalance()
      const r = await send(buyer, sale, toNano('1.1'), saleBuyBody(kind, 3n))
      expectTx(r.transactions, { from: sale, to: feeWallet.address, value: toNano('0.05') })
      expectTx(r.transactions, { from: sale, to: seller.address, value: toNano('0.85') })
      expect((await feeWallet.getBalance()) > feeBefore).toBe(true)
      expect((await api.getNftData(nft)).owner?.equals(buyer.address)).toBe(true)
    }
  })

  it('cancel via op 3 (seller) and via "cancel" comment (marketplace)', async () => {
    for (const [who, kind] of [[() => seller, 'op3'], [() => market, 'text']] as const) {
      const nft = await mintNft('C' + kind)
      const sale = await createSale(nft, { tonPrice: toNano('1') })
      const stranger = await send(buyer, sale, toNano('0.12'), saleCancelBody(kind, 1n))
      expectTx(stranger.transactions, { to: sale, success: false })
      await send(who(), sale, toNano('0.12'), saleCancelBody(kind, 1n))
      const d = await api.getSaleData(sale)
      expect(d.isComplete).toBe(true)
      expect(d.soldAt).toBe(0)
      expect((await api.getNftData(nft)).owner?.equals(seller.address)).toBe(true)
    }
  })

  it('change_price sets TON and jetton prices', async () => {
    const nft = await mintNft('P')
    const sale = await createSale(nft, { tonPrice: toNano('1') })
    const dict = emptyJettonDict()
    dict.set(addrHashKey(await api.getJettonWallet(jettonMaster, sale)), { price: 5n, jettonMaster })
    const bad = await send(buyer, sale, toNano('0.05'), saleChangePriceBody(1n, toNano('2'), dict))
    expectTx(bad.transactions, { to: sale, success: false, exitCode: 65535 })
    await send(seller, sale, toNano('0.05'), saleChangePriceBody(1n, toNano('2'), dict))
    const d = await api.getSaleData(sale)
    expect(d.fullPrice).toBe(toNano('2'))
    expect(d.jettonPrices[0].price).toBe(5n)
  })

  it('op 555: rescue NFT from uninitialized sale and withdraw balance after sale', async () => {
    const nft = await mintNft('E')
    // NFT transferred before deploy -> contract never gets initialized
    const { address: sale, init } = buildSaleStateInit({
      marketplaceAddress: market.address, nftAddress: nft, fullTonPrice: toNano('1'),
      feeAddress: feeWallet.address, feePercent: 5, royaltyAddress: seller.address, royaltyPercent: 0,
      publicKey: null, createdAt: 1,
    })
    await send(seller, nft, toNano('0.1'), nftTransferBody({ queryId: 1n, newOwner: sale, responseTo: seller.address, forwardAmount: toNano('0.02') }))
    await send(seller, sale, toNano('0.05'), saleDeployBlankBody(1n), init)
    expect((await api.getSaleData(sale)).nftOwnerAddress).toBeNull()
    expect((await api.getNftData(nft)).owner?.equals(sale)).toBe(true)

    const inner = relaxedInternal({ to: nft, value: 0n, bounce: true, body: nftTransferBody({ queryId: 2n, newOwner: seller.address, responseTo: market.address, forwardAmount: 0n }) })
    const notMarket = await send(seller, sale, toNano('0.1'), saleEmergencyBody(2n, 64, inner))
    expectTx(notMarket.transactions, { to: sale, success: false })
    await send(market, sale, toNano('0.1'), saleEmergencyBody(2n, 64, inner))
    expect((await api.getNftData(nft)).owner?.equals(seller.address)).toBe(true)

    // withdraw whole balance with mode 128
    const r = await send(market, sale, toNano('0.02'), saleEmergencyBody(3n, 128, relaxedInternal({ to: market.address, value: 0n })))
    expectTx(r.transactions, { from: sale, to: market.address })
    expect((await bc.getContract(sale)).balance).toBe(0n)
    // mode 32 (destroy) is forbidden
    const d32 = await send(market, sale, toNano('0.02'), saleEmergencyBody(4n, 128 + 32, relaxedInternal({ to: market.address, value: 0n })))
    expectTx(d32.transactions, { to: sale, success: false, exitCode: 405 })
  })
  it('Getgems deployer flow: one NFT transfer deploys and initializes the sale (both deployer versions)', async () => {
    // v1: compiled code from DeployerLocal.ts (storage = owner address)
    const v1 = Cell.fromBase64(readFileSync('tests/fixtures/deployer-v1.base64', 'utf8').trim())
    // v2: sources/deployer/deployer.fc (storage = allowed code hashes dict + owner)
    const src = (f: string) => readFileSync(`contracts/getgems/${f}`, 'utf8')
    const compiled = await compileFunc({
      targets: ['deployer/deployer.fc'],
      sources: { 'deployer/deployer.fc': src('deployer/deployer.fc'), 'stdlib.fc': src('stdlib.fc'), 'op-codes.fc': src('op-codes.fc') },
    })
    if (compiled.status === 'error') throw new Error(compiled.message)
    const v2 = Cell.fromBase64(compiled.codeBoc)

    for (const [name, code, data] of [
      ['v1', v1, beginCell().storeAddress(market.address).endCell()],
      ['v2', v2, beginCell().storeDict(null).storeAddress(market.address).endCell()],
    ] as const) {
      const init = { code, data }
      const deployer = contractAddress(0, init)
      await send(market, deployer, toNano('0.05'), beginCell().storeUint(1, 32).endCell(), init)
      if (name === 'v2') {
        const r = await send(market, deployer, toNano('0.05'), beginCell().storeUint(crc32('add_sale_code_hash'), 32).storeUint(0, 64)
          .storeBuffer(FIXPRICE_V4R1_CODE.hash()).endCell())
        expectTx(r.transactions, { to: deployer, success: true })
      }

      const nft = await mintNft('D' + name)
      const kp = await newKeyPair()
      const { address: sale, init: saleInit } = buildSaleStateInit({
        marketplaceAddress: deployer, nftAddress: nft, nftOwnerAddress: seller.address, fullTonPrice: toNano('1'),
        feeAddress: feeWallet.address, feePercent: 5, royaltyAddress: seller.address, royaltyPercent: 10,
        publicKey: kp.publicKey, createdAt: Math.floor(Date.now() / 1000),
      })
      const dict = emptyJettonDict()
      dict.set(addrHashKey(await api.getJettonWallet(jettonMaster, sale)), { price: 7n, jettonMaster })
      const body = saleDeployJettonBody({ queryId: 1n, newMarketplace: market.address, jettonDict: dict, secretKey: kp.secretKey })
      const r = await send(seller, nft, toNano('0.25'), nftTransferBody({
        queryId: 11n, newOwner: deployer, responseTo: seller.address, forwardAmount: toNano('0.2'),
        rawForwardPayload: deployerDoSalePayload(saleInit, body),
      }))
      expectTx(r.transactions, { to: deployer, success: true })
      expectTx(r.transactions, { from: deployer, to: sale, success: true, value: toNano('0.02') })

      const d = await api.getSaleData(sale)
      expect(d.marketplaceAddress.equals(market.address)).toBe(true)
      expect(d.nftOwnerAddress?.equals(seller.address)).toBe(true)
      expect(d.jettonPrices).toHaveLength(1)
      expect((await api.getNftData(nft)).owner?.equals(sale)).toBe(true)

      await send(buyer, sale, toNano('1.1'), saleBuyBody('op2', 1n))
      expect((await api.getNftData(nft)).owner?.equals(buyer.address)).toBe(true)
    }
  })

  // keep last: moves blockchain time forward
  it('jetton overpay tail can get stuck; marketplace rescues it with op 555 after 10 min', async () => {
    const nft = await mintNft('J2')
    const sale = await createSale(nft, { tonPrice: 0n, jettonPrice: 10_000_000n })
    const bw = await api.getJettonWallet(jettonMaster, buyer.address)
    const before = await jettonBalance(buyer.address)
    await send(buyer, bw, toNano('0.4'), jettonTransferBody({ queryId: 8n, amount: 30_000_000n, destination: sale, responseTo: buyer.address, forwardTonAmount: toNano('0.3') }))
    expect((await api.getNftData(nft)).owner?.equals(buyer.address)).toBe(true)
    const stuck = await jettonBalance(sale)
    expect(stuck).toBe(20_000_000n) // overpaid tail was not returned
    expect(before - (await jettonBalance(buyer.address))).toBe(30_000_000n)

    const saleJw = await api.getJettonWallet(jettonMaster, sale)
    const inner = relaxedInternal({ to: saleJw, value: 0n, bounce: true, body: jettonTransferBody({ queryId: 9n, amount: stuck, destination: buyer.address, responseTo: market.address, forwardTonAmount: 0n }) })
    const early = await send(market, sale, toNano('0.1'), saleEmergencyBody(9n, 64, inner))
    expectTx(early.transactions, { to: sale, success: false, exitCode: 406 })
    bc.now = Math.floor(Date.now() / 1000) + 700
    await send(market, sale, toNano('0.1'), saleEmergencyBody(9n, 64, inner))
    expect(await jettonBalance(sale)).toBe(0n)
    expect(before - (await jettonBalance(buyer.address))).toBe(10_000_000n)
  })
})
