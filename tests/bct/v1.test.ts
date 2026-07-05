import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
  bctSignedRange,
  BootMedium,
  patchBootLoaderInfo,
  serializeBct,
  signBct,
  T132_BCT_LAYOUT,
  T210_BCT_LAYOUT,
  type BootLoaderInfo
} from '../../src/bct/v1'
import { sbkHash } from '../../src/sign'
import { readUint32LE } from '../../src/utils/bytes'

const L = T210_BCT_LAYOUT

function golden(name: string): Uint8Array<ArrayBuffer> {
  const src = readFileSync(fileURLToPath(new URL(`../golden/${name}`, import.meta.url)))
  const out = new Uint8Array(src.length)
  out.set(src)
  return out
}

describe('serializeBct', () => {
  test('writes scalar header fields little-endian at their offsets', () => {
    const bct = serializeBct({
      bootDataVersion: 0x00210001,
      blockSizeLog2: 14,
      pageSizeLog2: 9,
      partitionSize: 0x400000,
      odmData: 0x80080105
    })

    expect(readUint32LE(bct, L.bootDataVersionOffset)).toBe(0x00210001)
    expect(readUint32LE(bct, L.blockSizeLog2Offset)).toBe(14)
    expect(readUint32LE(bct, L.pageSizeLog2Offset)).toBe(9)
    expect(readUint32LE(bct, L.partitionSizeOffset)).toBe(0x400000)
    expect(readUint32LE(bct, L.odmDataOffset)).toBe(0x80080105)
  })

  test('places each SDRAM set on the stride and leaves NumSdramSets 0 (matches tegrabct)', () => {
    const bct = serializeBct({
      bootDataVersion: 1,
      blockSizeLog2: 14,
      pageSizeLog2: 9,
      partitionSize: 0,
      sdram: [{ raw: new Uint8Array([0xaa, 0xbb]) }, { raw: new Uint8Array([0xcc, 0xdd]) }]
    })

    // tegrabct writes the SDRAM data but never the count field — see PROTOCOL.md.
    expect(readUint32LE(bct, L.numSdramSetsOffset)).toBe(0)
    expect(bct[L.sdramSetsOffset]).toBe(0xaa)
    // second set is positioned one stride later, not packed contiguously
    expect(bct[L.sdramSetsOffset + L.sdramSetStride]).toBe(0xcc)
  })

  test('sets the boot device type and params block', () => {
    const bct = serializeBct({
      bootDataVersion: 1,
      blockSizeLog2: 14,
      pageSizeLog2: 9,
      partitionSize: 0,
      bootDevice: { medium: BootMedium.SpiFlash, raw: new Uint8Array([1, 2, 3, 4]) }
    })

    expect(readUint32LE(bct, L.devTypeOffset)).toBe(BootMedium.SpiFlash)
    expect(Array.from(bct.subarray(L.deviceParamsOffset, L.deviceParamsOffset + 4))).toEqual([
      1, 2, 3, 4
    ])
  })

  test('writes secureDebugControl and the unique chip id when provided', () => {
    const uid = new Uint8Array(16).fill(0xc1)
    const bct = serializeBct({
      bootDataVersion: 1,
      blockSizeLog2: 14,
      pageSizeLog2: 9,
      partitionSize: 0,
      secureDebugControl: 0x10,
      uniqueChipId: uid
    })

    expect(readUint32LE(bct, L.secureDebugControlOffset)).toBe(0x10)
    expect(bct.slice(L.uniqueChipIdOffset, L.uniqueChipIdOffset + 16)).toEqual(uid)
  })

  test('copies a template first, then patches structured fields over it', () => {
    const template = new Uint8Array(L.size).fill(0x55)
    const bct = serializeBct(
      { bootDataVersion: 7, blockSizeLog2: 0, pageSizeLog2: 0, partitionSize: 0 },
      { template }
    )
    expect(bct.length).toBe(L.size)
    expect(readUint32LE(bct, L.bootDataVersionOffset)).toBe(7)
    // untouched template byte survives
    expect(bct[L.uniqueChipIdOffset]).toBe(0x55)
  })
})

describe('bootloader table', () => {
  test('writes seven u32 fields then the 16-byte hash', () => {
    const bct = serializeBct({
      bootDataVersion: 1,
      blockSizeLog2: 14,
      pageSizeLog2: 9,
      partitionSize: 0,
      bootLoaders: [
        {
          version: 1,
          startBlock: 2,
          startPage: 3,
          length: 0x1000,
          loadAddress: 0x40010000,
          entryPoint: 0x40010000,
          attribute: 0,
          cryptoHash: new Uint8Array(16).fill(0xab)
        }
      ]
    })

    const base = L.bootLoaderTableOffset
    expect(readUint32LE(bct, L.bootLoadersUsedOffset)).toBe(1)
    expect(readUint32LE(bct, base + 0)).toBe(1)
    expect(readUint32LE(bct, base + 12)).toBe(0x1000)
    expect(readUint32LE(bct, base + 16)).toBe(0x40010000)
    expect(bct[base + 28]).toBe(0xab)
  })

  test('patchBootLoaderInfo updates one entry in place', () => {
    const bct = new Uint8Array(L.size)
    patchBootLoaderInfo(bct, 1, {
      version: 9,
      startBlock: 0,
      startPage: 0,
      length: 0x2000,
      loadAddress: 0,
      entryPoint: 0,
      attribute: 0
    })

    const base = L.bootLoaderTableOffset + L.bootLoaderInfoStride
    expect(readUint32LE(bct, base + 0)).toBe(9)
    expect(readUint32LE(bct, base + 12)).toBe(0x2000)
  })
})

describe('T210 layout (tegrabct-verified offsets)', () => {
  test('matches the reference tool field table', () => {
    expect(L.size).toBe(0x2800)
    expect(L.signedFrom).toBe(0x510)
    expect(L.odmDataOffset).toBe(0x508)
    expect(L.uniqueChipIdOffset).toBe(0x520)
    expect(L.blockSizeLog2Offset).toBe(0x534)
    expect(L.pageSizeLog2Offset).toBe(0x538)
    expect(L.partitionSizeOffset).toBe(0x53c)
    expect(L.devTypeOffset).toBe(0x544)
    expect(L.bootLoadersUsedOffset).toBe(0x232c)
    expect(L.bootLoaderTableOffset).toBe(0x2330)
    expect(L.bootLoaderInfoStride).toBe(0x12c)
  })

  test('rejects an over-long unique chip id', () => {
    expect(() =>
      serializeBct({
        bootDataVersion: 1,
        blockSizeLog2: 14,
        pageSizeLog2: 9,
        partitionSize: 0,
        uniqueChipId: new Uint8Array(17)
      })
    ).toThrow(/uniqueChipId must be 16 bytes/)
  })
})

describe('T132 layout offsets', () => {
  test('matches Tegra132 BCT structures', () => {
    const L132 = T132_BCT_LAYOUT
    expect(L132.size).toBe(0x2200)
    expect(L132.signedFrom).toBe(0x6b0)
    expect(L132.signedTo).toBe(0x2200)
    expect(L132.cryptoHashOffset).toBe(0x6b0)
    expect(L132.uniqueChipIdOffset).toBe(0x6c0)
    expect(L132.bootDataVersionOffset).toBe(0x6d0)
    expect(L132.blockSizeLog2Offset).toBe(0x6d4)
    expect(L132.pageSizeLog2Offset).toBe(0x6d8)
    expect(L132.partitionSizeOffset).toBe(0x6dc)
    expect(L132.odmDataOffset).toBe(0x6a8)
    expect(L132.secureDebugControlOffset).toBe(0x21e4)
    expect(L132.devTypeOffset).toBe(0x6e4)
    expect(L132.deviceParamsOffset).toBe(0x6f4)
    expect(L132.numSdramSetsOffset).toBe(0x7f4)
    expect(L132.sdramSetsOffset).toBe(0x7f8)
    expect(L132.sdramSetStride).toBe(0x4d4)
    expect(L132.maxSdramSets).toBe(4)
    expect(L132.bootLoadersUsedOffset).toBe(0x1b48)
    expect(L132.bootLoaderTableOffset).toBe(0x1b4c)
    expect(L132.bootLoaderInfoStride).toBe(0x12c)
    expect(L132.maxBootLoaders).toBe(4)
    expect(L132.numParamSetsOffset).toBe(0x6e0)
    expect(L132.reservedPadOffset).toBe(0x2200 - 2)
  })
})

describe('validation errors', () => {
  const base = { bootDataVersion: 1, blockSizeLog2: 14, pageSizeLog2: 9, partitionSize: 0 }
  const blInfo = {
    version: 0,
    startBlock: 0,
    startPage: 0,
    length: 0,
    loadAddress: 0,
    entryPoint: 0,
    attribute: 0
  }

  test('rejects more SDRAM sets than the layout holds', () => {
    const sdram = Array.from({ length: 5 }, () => ({ raw: new Uint8Array(1) }))
    expect(() => serializeBct({ ...base, sdram })).toThrow(/too many SDRAM sets: 5 > 4/)
  })

  test('rejects an SDRAM set wider than the stride', () => {
    const sdram = [{ raw: new Uint8Array(L.sdramSetStride + 1) }]
    expect(() => serializeBct({ ...base, sdram })).toThrow(/exceeds stride/)
  })

  test('rejects more bootloaders than the table holds', () => {
    const bootLoaders = Array.from({ length: 5 }, () => blInfo)
    expect(() => serializeBct({ ...base, bootLoaders })).toThrow(/too many bootloaders: 5 > 4/)
  })

  test('rejects a wrong-size bootloader cryptoHash', () => {
    expect(() =>
      serializeBct({ ...base, bootLoaders: [{ ...blInfo, cryptoHash: new Uint8Array(15) }] })
    ).toThrow(/cryptoHash must be 16 bytes/)
  })

  test('rejects boot device params that overflow the BCT', () => {
    expect(() =>
      serializeBct({
        ...base,
        bootDevice: { medium: BootMedium.Sdmmc, raw: new Uint8Array(L.size) }
      })
    ).toThrow(/overflows the BCT/)
  })

  test('patchBootLoaderInfo rejects an out-of-range index', () => {
    expect(() => patchBootLoaderInfo(new Uint8Array(L.size), 4, blInfo)).toThrow(
      /index 4 exceeds max 4/
    )
  })

  test('patchBootLoaderInfo rejects a buffer too small for the entry', () => {
    expect(() =>
      patchBootLoaderInfo(new Uint8Array(L.bootLoaderTableOffset + 16), 0, blInfo)
    ).toThrow(/overflows the BCT/)
  })

  test('serializeBct rejects a template smaller than the BCT', () => {
    expect(() => serializeBct(base, { template: new Uint8Array(L.size - 1) })).toThrow(
      /smaller than the 10240-byte BCT/
    )
  })

  test('bctSignedRange rejects a buffer too short for the signed range', () => {
    // subarray() would silently clamp; the guard must throw instead.
    expect(() => bctSignedRange(new Uint8Array(L.signedTo - 1))).toThrow(/too short/)
  })

  test('signBct rejects a truncated BCT instead of signing a clamped range', async () => {
    await expect(signBct(new Uint8Array(L.signedTo - 1))).rejects.toThrow(/too short/)
  })
})

describe('signBct', () => {
  test('writes a 16-byte CMAC to the crypto-hash offset', async () => {
    const bct = new Uint8Array(L.size)
    const hash = await signBct(bct)
    expect(hash.length).toBe(16)
    expect(Array.from(bct.subarray(0, 16))).toEqual(Array.from(hash))
  })
})

// Validates the layout constants against a real tegrabct-generated BCT for the
// Jetson Nano P3448 board (base gen + --updatedevparam/--updateblinfo, run under
// docker linux/386 — see PROTOCOL.md). This pins sdramSetStride, the header
// scalars and the NvBootDevType encoding byte-exactly; the self-referential
// offset asserts above cannot catch a wrong stride or enum value.
describe('T210 BCT layout vs real tegrabct output', () => {
  const bct = golden('t210_p3448.bct')

  test('size and signed section match tegrabct --listbct (offset 1296, len 8944)', () => {
    expect(bct.length).toBe(L.size)
    expect(L.signedFrom).toBe(0x510)
    expect(L.signedTo).toBe(0x2800)
    expect(bctSignedRange(bct).length).toBe(8944)
  })

  test('header scalars land at their offsets', () => {
    expect(readUint32LE(bct, L.bootDataVersionOffset)).toBe(0x00210001)
    expect(readUint32LE(bct, L.blockSizeLog2Offset)).toBe(14)
    expect(readUint32LE(bct, L.pageSizeLog2Offset)).toBe(9)
    expect(readUint32LE(bct, L.partitionSizeOffset)).toBe(0x1000000)
    // eMMC board -> NvBootDevType_Sdmmc == 4.
    expect(readUint32LE(bct, L.devTypeOffset)).toBe(BootMedium.Sdmmc)
    expect(BootMedium.Sdmmc).toBe(4)
    expect(BootMedium.SpiFlash).toBe(3)
  })

  test('SDRAM sets sit at sdramSetsOffset on the verified stride', () => {
    // NvBootMemoryType_LpDdr4 == 3 is the first field of each NvBootSdramParams.
    expect(bct[L.sdramSetsOffset]).toBe(3)
    // EmcBctSpare4 (0x7001bc68) is a distinctive marker 0x30 into each set;
    // its four occurrences fix the stride exactly.
    const marker = 0x7001bc68
    for (let i = 0; i < L.maxSdramSets; i++) {
      const at = L.sdramSetsOffset + i * L.sdramSetStride + 0x30
      expect(readUint32LE(bct, at)).toBe(marker)
    }
    // The four sets end exactly where the bootloader table region begins.
    expect(L.sdramSetsOffset + L.maxSdramSets * L.sdramSetStride).toBe(L.bootLoadersUsedOffset)
    // ...yet tegrabct leaves NumSdramSets at 0 despite the 4 sets present — the
    // field the tool never populates (see serializeBct + PROTOCOL.md).
    expect(readUint32LE(bct, L.numSdramSetsOffset)).toBe(0)
  })

  test('sbkHash matches openssl AES-128-CMAC over the signed range', async () => {
    const hash = await sbkHash(bctSignedRange(bct))
    expect(Buffer.from(hash).toString('hex')).toBe('ff4331ddf33b992bdcdb314fc11e0932')
  })

  // The base gen + `--updateblinfo` flow populates two bootloader entries in the
  // P3448 golden (both the primary and its redundant copy). Reproducing that
  // region byte-for-byte pins the 7-field order, the 0x12c stride and the
  // bootLoadersUsed count against the real tool — not just self-referential
  // offsets. Hashes/signatures are zero here (zero-key base gen, no PKC fusing).
  const GOLDEN_BOOTLOADERS: BootLoaderInfo[] = [
    {
      version: 1,
      startBlock: 0x40,
      startPage: 0,
      length: 0x28cf0,
      loadAddress: 0x40010000,
      entryPoint: 0x40010000,
      attribute: 0
    },
    {
      version: 1,
      startBlock: 0x98,
      startPage: 0,
      length: 0x28cf0,
      loadAddress: 0x40010000,
      entryPoint: 0x40010000,
      attribute: 0
    }
  ]
  const tableEnd = L.bootLoaderTableOffset + GOLDEN_BOOTLOADERS.length * L.bootLoaderInfoStride

  test('serializeBct reproduces the real bootloader table byte-for-byte', () => {
    expect(readUint32LE(bct, L.bootLoadersUsedOffset)).toBe(GOLDEN_BOOTLOADERS.length)
    const ours = serializeBct({
      bootDataVersion: 0,
      blockSizeLog2: 0,
      pageSizeLog2: 0,
      partitionSize: 0,
      bootLoaders: GOLDEN_BOOTLOADERS
    })
    // [bootLoadersUsed .. end of the last entry] — only the table lives here.
    expect(ours.subarray(L.bootLoadersUsedOffset, tableEnd)).toEqual(
      bct.subarray(L.bootLoadersUsedOffset, tableEnd)
    )
  })

  test('patchBootLoaderInfo reproduces each entry in place against the golden', () => {
    const buf = new Uint8Array(L.size)
    GOLDEN_BOOTLOADERS.forEach((info, i) => patchBootLoaderInfo(buf, i, info))
    expect(buf.subarray(L.bootLoaderTableOffset, tableEnd)).toEqual(
      bct.subarray(L.bootLoaderTableOffset, tableEnd)
    )
  })
})
