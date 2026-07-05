import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
  assembleBrBct,
  parseT186DevParams,
  patchBrBctOdmData,
  T186_BR_BCT_LAYOUT
} from '../../../src/bct/v2/brBct'
import { readUint32LE } from '../../../src/utils/bytes'

function golden(name: string): Uint8Array<ArrayBuffer> {
  const src = readFileSync(fileURLToPath(new URL(`../../golden/${name}`, import.meta.url)))
  const out = new Uint8Array(src.length)
  out.set(src)
  return out
}

function goldenText(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../golden/${name}`, import.meta.url)), 'utf8')
}

describe('T186 BR-BCT (tegrabct_v2 --brbct, P2771/quill)', () => {
  const brBct = golden('t186_p2771_br.bct')

  test('size matches the real tegrabct_v2 output', () => {
    expect(brBct.length).toBe(T186_BR_BCT_LAYOUT.size)
  })

  test('signed range sits at the tegrabct_v2 --listbct offset/length (1664/1920)', () => {
    expect(T186_BR_BCT_LAYOUT.signedFrom).toBe(1664)
    expect(T186_BR_BCT_LAYOUT.signedTo - T186_BR_BCT_LAYOUT.signedFrom).toBe(1920)
  })

  test('patchBrBctOdmData writes a little-endian u32 at odmDataOffset', () => {
    const bct = brBct.slice()
    patchBrBctOdmData(bct, 0x1098000)
    expect(readUint32LE(bct, T186_BR_BCT_LAYOUT.odmDataOffset)).toBe(0x1098000)
  })

  test('patchBrBctOdmData rejects a wrong-size buffer', () => {
    expect(() => patchBrBctOdmData(new Uint8Array(10), 0)).toThrow(/must be .* bytes/)
  })

  test('assembleBrBct rebuilds the golden byte-for-byte from emmc.cfg', () => {
    const devParams = parseT186DevParams(goldenText('t186_emmc.cfg'))
    expect(devParams.blockSize).toBe(16384)
    expect(devParams.pageSize).toBe(512)
    // the P2771/P3636 goldens carry odmData 0 (flash.sh patches it at send time)
    expect(assembleBrBct({ devParams })).toEqual(brBct)
  })

  test('parseT186DevParams throws on a cfg missing a required field', () => {
    expect(() => parseT186DevParams('PartitionSize = 1;\n')).toThrow(/missing BlockSize/)
  })
})
