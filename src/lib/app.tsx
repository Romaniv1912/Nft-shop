import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { Address, Cell, fromNano } from '@ton/core'
import { CHAIN, useTonAddress, useTonConnectUI, useTonWallet } from '@tonconnect/ui-react'
import { Api, Network } from './toncenter'
import { boc } from './contracts'

// ---------- localStorage helpers ----------
function load<T>(key: string, def: T): T {
  try {
    const v = localStorage.getItem(key)
    return v ? (JSON.parse(v) as T) : def
  } catch {
    return def
  }
}
function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch { /* ignore */ }
}

function usePersisted<T>(key: string, def: T) {
  const [v, setV] = useState<T>(() => load(key, def))
  useEffect(() => setV(load(key, def)), [key]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = useCallback((n: T | ((p: T) => T)) => {
    setV((prev) => {
      const next = typeof n === 'function' ? (n as (p: T) => T)(prev) : n
      save(key, next)
      return next
    })
  }, [key])
  return [v, set] as const
}

export type KnownJetton = { master: string; symbol: string; name: string; decimals: number; own?: boolean }
export type SavedSale = { address: string; nft: string; createdAt: number; note?: string }
export type LogEntry = { time: number; title: string; status: 'sent' | 'error'; detail: string; to?: string }

// Well-known jettons. On testnet, create your own demo jettons on the "Жетони" tab.
const PRESET_JETTONS: Record<Network, KnownJetton[]> = {
  mainnet: [
    { master: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', symbol: 'USD₮', name: 'Tether USD', decimals: 6 },
    { master: 'EQAvlWFDxGF2lXm67y4yzC17wYKD9A0guwPkMs1gOsM__NOT', symbol: 'NOT', name: 'Notcoin', decimals: 9 },
  ],
  testnet: [
    // VAT — coin offered by testnet.getgems.io (decimals are re-read from the chain on load)
    { master: 'kQCS5aGrvaF7T-xFlr3uLa_U5FATJagurEvok3BF4kJE7nyn', symbol: 'VAT', name: 'VAT', decimals: 9 },
  ],
}

export type Msg = { to: Address; value: bigint; body?: Cell | null; init?: string }

type Ctx = {
  network: Network
  setNetwork: (n: Network) => void
  apiKey: string
  setApiKey: (k: string) => void
  api: Api
  wallet: Address | null
  walletNetworkMismatch: boolean
  fmt: (a: Address | null | undefined, opts?: { bounceable?: boolean }) => string
  explorer: (a: Address | string) => string
  jettons: KnownJetton[]
  addJetton: (j: KnownJetton) => void
  removeJetton: (master: string) => void
  sales: SavedSale[]
  addSale: (s: SavedSale) => void
  removeSale: (address: string) => void
  logs: LogEntry[]
  log: (e: Omit<LogEntry, 'time'>) => void
  clearLogs: () => void
  send: (title: string, msgs: Msg[]) => Promise<boolean>
}

const AppCtx = createContext<Ctx>(null as unknown as Ctx)
export const useApp = () => useContext(AppCtx)

export function AppProvider({ children }: { children: ReactNode }) {
  const [network, setNetwork] = usePersisted<Network>('network', 'testnet')
  const [apiKey, setApiKey] = usePersisted<string>(`apiKey:${network}`, '')
  const [ownJettons, setOwnJettons] = usePersisted<KnownJetton[]>(`jettons:${network}`, [])
  const [sales, setSales] = usePersisted<SavedSale[]>(`sales:${network}`, [])
  const [logs, setLogs] = usePersisted<LogEntry[]>(`logs:${network}`, [])

  const [tonConnectUI] = useTonConnectUI()
  const tcWallet = useTonWallet()
  const rawAddress = useTonAddress(false)
  const wallet = useMemo(() => (rawAddress ? Address.parse(rawAddress) : null), [rawAddress])
  const expectedChain = network === 'testnet' ? CHAIN.TESTNET : CHAIN.MAINNET
  const walletNetworkMismatch = !!tcWallet && tcWallet.account.chain !== expectedChain

  const api = useMemo(() => new Api(network, apiKey), [network, apiKey])

  // verify symbol/decimals of preset jettons on-chain so prices are shown in correct units
  const [presetMeta, setPresetMeta] = useState<Record<string, Partial<KnownJetton>>>({})
  useEffect(() => {
    let alive = true
    for (const j of PRESET_JETTONS[network]) {
      api.getJettonMeta(Address.parse(j.master)).then(
        ({ meta }) => {
          if (!alive) return
          const upd: Partial<KnownJetton> = {}
          if (meta.decimals && !Number.isNaN(Number(meta.decimals))) upd.decimals = Number(meta.decimals)
          if (meta.symbol) upd.symbol = meta.symbol
          if (meta.name) upd.name = meta.name
          setPresetMeta((m) => ({ ...m, [j.master]: upd }))
        },
        () => undefined,
      )
    }
    return () => {
      alive = false
    }
  }, [network, api])

  const fmt = useCallback(
    (a: Address | null | undefined, opts?: { bounceable?: boolean }) =>
      a ? a.toString({ testOnly: network === 'testnet', bounceable: opts?.bounceable ?? true, urlSafe: true }) : '—',
    [network],
  )
  const explorer = useCallback(
    (a: Address | string) =>
      `https://${network === 'testnet' ? 'testnet.' : ''}tonviewer.com/${typeof a === 'string' ? a : fmt(a)}`,
    [network, fmt],
  )

  const jettons = useMemo(() => {
    const presets = PRESET_JETTONS[network].map((j) => ({ ...j, ...presetMeta[j.master] }))
    const all = [...presets, ...ownJettons]
    const seen = new Set<string>()
    return all.filter((j) => {
      const k = Address.parse(j.master).toRawString()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  }, [network, ownJettons, presetMeta])

  const log = useCallback((e: Omit<LogEntry, 'time'>) => setLogs((l) => [{ ...e, time: Date.now() }, ...l].slice(0, 200)), [setLogs])

  const send = useCallback(
    async (title: string, msgs: Msg[]) => {
      if (!wallet) {
        await tonConnectUI.openModal()
        return false
      }
      if (walletNetworkMismatch) {
        alert(`Гаманець підключено не до ${network}. Перемкніть мережу у гаманці або в застосунку.`)
        return false
      }
      const detail = msgs
        .map((m) => `→ ${fmt(m.to)}  ${fromNano(m.value)} TON${m.init ? ' +stateInit' : ''}${m.body ? ` body:${boc(m.body).slice(0, 24)}…` : ''}`)
        .join('\n')
      try {
        await tonConnectUI.sendTransaction({
          validUntil: Math.floor(Date.now() / 1000) + 600,
          network: expectedChain,
          messages: msgs.map((m) => ({
            address: fmt(m.to),
            amount: m.value.toString(),
            payload: m.body ? boc(m.body) : undefined,
            stateInit: m.init,
          })),
        })
        log({ title, status: 'sent', detail, to: fmt(msgs[0].to) })
        return true
      } catch (e) {
        log({ title, status: 'error', detail: `${detail}\n${(e as Error).message ?? e}` })
        return false
      }
    },
    [wallet, walletNetworkMismatch, tonConnectUI, network, expectedChain, fmt, log],
  )

  const value: Ctx = {
    network,
    setNetwork,
    apiKey,
    setApiKey,
    api,
    wallet,
    walletNetworkMismatch,
    fmt,
    explorer,
    jettons,
    addJetton: (j) => setOwnJettons((l) => [...l.filter((x) => x.master !== j.master), j]),
    removeJetton: (m) => setOwnJettons((l) => l.filter((x) => x.master !== m)),
    sales,
    addSale: (s) => setSales((l) => [s, ...l.filter((x) => x.address !== s.address)]),
    removeSale: (a) => setSales((l) => l.filter((x) => x.address !== a)),
    logs,
    log,
    clearLogs: () => setLogs([]),
    send,
  }
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>
}

// ---------- small utils ----------
export function parseAddr(s: string): Address | null {
  try {
    return Address.parse(s.trim())
  } catch {
    return null
  }
}

export function toUnits(v: string, decimals: number): bigint {
  const s = v.trim().replace(',', '.')
  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') throw new Error(`Невірне число: ${v}`)
  const [i, f = ''] = s.split('.')
  if (f.length > decimals) throw new Error(`Забагато знаків після коми (макс ${decimals})`)
  return BigInt(i || '0') * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0')
}

export function fromUnits(v: bigint, decimals: number): string {
  const neg = v < 0n
  const a = neg ? -v : v
  const base = 10n ** BigInt(decimals)
  const f = (a % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${a / base}${f ? '.' + f : ''}`
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ loading: boolean; data?: T; error?: string }>({ loading: true })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    setState((s) => ({ ...s, loading: true, error: undefined }))
    fn().then(
      (data) => alive && setState({ loading: false, data }),
      (e) => alive && setState({ loading: false, error: String(e?.message ?? e) }),
    )
    return () => {
      alive = false
    }
  }, [...deps, tick]) // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, reload: () => setTick((t) => t + 1) }
}
