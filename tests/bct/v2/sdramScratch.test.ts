import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { T186_SDRAM_SCRATCH } from '../../../src/bct/v2/data/t186SdramScratch'
import { packSdramScratch } from '../../../src/bct/v2/sdramScratch'

function golden(name: string): Uint8Array<ArrayBuffer> {
  const src = readFileSync(fileURLToPath(new URL(`../../golden/${name}`, import.meta.url)))
  const out = new Uint8Array(src.length)
  out.set(src)
  return out
}

const layout = T186_SDRAM_SCRATCH

// The `[0x5670, 0x7cc0)` region of the MB1-BCT is four `0x994`-byte boot-scratch
// blocks, one per SDRAM param set, bit-packed from the set by
// NvTegraT18xPackSdramParams. packSdramScratch reproduces all four byte-for-byte
// from the packed SDRAM sets in the P2771 golden. See PROTOCOL.md.
describe('T186 packed SDRAM boot-scratch (vs P2771 golden)', () => {
  const mb1Bct = golden('t186_p2771_mb1.bct')
  const SDRAM = 0xbb0
  const SDRAM_STRIDE = 0x12b0
  const SCRATCH = 0x5670
  const SCRATCH_STRIDE = 0x994

  for (let i = 0; i < 4; i++) {
    test(`set ${i} packs byte-exact to its 0x994 scratch block`, () => {
      const set = mb1Bct.subarray(SDRAM + i * SDRAM_STRIDE, SDRAM + (i + 1) * SDRAM_STRIDE)
      const packed = packSdramScratch(new Uint8Array(set), layout)
      expect(packed).toEqual(
        mb1Bct.subarray(SCRATCH + i * SCRATCH_STRIDE, SCRATCH + (i + 1) * SCRATCH_STRIDE)
      )
    })
  }

  test('rejects an SDRAM set smaller than one param instance', () => {
    expect(() => packSdramScratch(new Uint8Array(0x100), layout)).toThrow(/need \d+ to pack/)
  })
})
