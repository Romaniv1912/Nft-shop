// Verifies that embedded contract code matches reference hashes.
import { readFileSync } from 'node:fs'
import { Cell } from '@ton/core'
const src = readFileSync(new URL('../src/contracts/getgemsCode.ts', import.meta.url), 'utf8')
const get = (name) => src.match(new RegExp(`${name} = '([^']+)'`))[1]
const saleHash = Cell.fromBase64(get('FIXPRICE_V4R1_CODE_BOC')).hash().toString('hex')
const ref = get('FIXPRICE_V4R1_CODE_HASH_HEX')
console.log('fixprice v4r1:', saleHash, saleHash === ref ? 'OK' : 'MISMATCH')
console.log('nft-single   :', Cell.fromBase64(get('NFT_SINGLE_CODE_BOC')).hash().toString('hex'))
if (saleHash !== ref) process.exit(1)
