import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
  parseMb1NvHeader,
  serializeMb1NvHeader,
  T234_MB1_NV_HEADER_LAYOUT,
  T264_COMPONENT_MAGICS
} from '../../../src/bct/v2/mb1NvHeader'
import { BctError } from '../../../src/errors'

function golden(name: string): Uint8Array<ArrayBuffer> {
  const src = readFileSync(fileURLToPath(new URL(`../../golden/${name}`, import.meta.url)))
  const out = new Uint8Array(src.length)
  out.set(src)
  return out
}

async function sha512(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-512', data))
}

describe('T234 MB1 NV header (tegrahost_v2 --addmb1nvheader, chip 0x23, synthetic 256-byte 0xAA payload)', () => {
  const file = golden('t234_mb1_nvheader.bin')
  const payload = new Uint8Array(256).fill(0xaa)

  test('total size is header (0x2000) + payload', () => {
    expect(file.length).toBe(T234_MB1_NV_HEADER_LAYOUT.headerSize + payload.length)
  })

  test('parses stage0/stage1 descriptors and the trailing payload', () => {
    const header = parseMb1NvHeader(file)
    expect(Buffer.from(header.payload).equals(Buffer.from(payload))).toBe(true)
    for (const component of [header.stage0, header.stage1]) {
      expect(component.magic).toBe('MB1B')
      expect(component.payloadSize).toBe(payload.length)
      expect(component.loadAddress).toBe(0x50000000)
      expect(component.secondAddress).toBe(0x50000000)
      expect(component.flagBytes).toEqual(new Uint8Array([1, 1]))
    }
  })

  test('embedded SHA-512 digest matches the payload', async () => {
    const header = parseMb1NvHeader(file)
    expect(header.stage1.sha512Digest).toEqual(await sha512(payload))
    expect(header.stage0.sha512Digest).toEqual(await sha512(payload))
  })

  test('rejects a file shorter than the fixed header size', () => {
    expect(() => parseMb1NvHeader(file.subarray(0, 100))).toThrow(/shorter than/)
  })

  test('rejects a file with a bad outer magic', () => {
    const corrupt = file.slice()
    corrupt[0] = 0x00
    expect(() => parseMb1NvHeader(corrupt)).toThrow(BctError)
  })
})

// T264 (chip 0x26) produced from a different synthetic payload (512 bytes,
// 0x33 fill) - every offset is identical to the T234 golden despite the
// different chip id and payload, which is what justifies treating
// T234_MB1_NV_HEADER_LAYOUT as shared rather than per-chip.
describe('T264 MB1 NV header (tegrahost_v2 --addmb1nvheader, chip 0x26, synthetic 512-byte 0x33 payload)', () => {
  const file = golden('t264_mb1_nvheader.bin')
  const payload = new Uint8Array(512).fill(0x33)

  test('total size is header (0x2000) + payload', () => {
    expect(file.length).toBe(T234_MB1_NV_HEADER_LAYOUT.headerSize + payload.length)
  })

  test('parses byte-identically to the T234 layout', () => {
    const header = parseMb1NvHeader(file)
    expect(Buffer.from(header.payload).equals(Buffer.from(payload))).toBe(true)
    expect(header.stage1.magic).toBe('MB1B')
    expect(header.stage1.payloadSize).toBe(payload.length)
    expect(header.stage1.loadAddress).toBe(0x50000000)
  })

  test('embedded SHA-512 digest matches the payload', async () => {
    const header = parseMb1NvHeader(file)
    expect(header.stage1.sha512Digest).toEqual(await sha512(payload))
  })
})

// The real tool gives a *different* load/second address per recognized
// `--magicid`: PSCB gets 0x00120000/0x00120400, unlike MB1B's
// 0x50000000/0x50000000 — this is what proves secondAddress is a genuinely
// distinct field, not a copy of loadAddress that just happened to match in
// the MB1B goldens above.
describe('T234 MB1 NV header — magicid PSCB (chip 0x23, 64-byte payload)', () => {
  const file = golden('t234_mb1_nvheader_pscb.bin')
  const payload = new Uint8Array(64).fill(0x22)

  test('gets PSCB-specific addresses, distinct from each other', () => {
    const header = parseMb1NvHeader(file)
    expect(header.stage1.magic).toBe('PSCB')
    expect(header.stage1.payloadSize).toBe(payload.length)
    expect(header.stage1.loadAddress).toBe(0x00120000)
    expect(header.stage1.secondAddress).toBe(0x00120400)
    expect(header.stage1.flagBytes).toEqual(new Uint8Array([1, 1]))
  })
})

// T264's Fill chain hardcodes PSCB's loadAddress as 0x110000, NOT the T234
// value 0x120000 (secondAddress 0x120400 is shared). This is the one place
// the two chips' address tables genuinely diverge, so it gets its own golden
// and its own constant (T264_COMPONENT_MAGICS).
describe('T264 MB1 NV header — magicid PSCB (chip 0x26, 64-byte payload)', () => {
  const file = golden('t264_mb1_nvheader_pscb.bin')
  const payload = new Uint8Array(64).fill(0x44)

  test('gets T264-specific PSCB loadAddress 0x110000, distinct from T234', () => {
    const header = parseMb1NvHeader(file)
    for (const component of [header.stage0, header.stage1]) {
      expect(component.magic).toBe('PSCB')
      expect(component.payloadSize).toBe(payload.length)
      expect(component.loadAddress).toBe(0x00110000)
      expect(component.secondAddress).toBe(0x00120400)
      expect(component.flagBytes).toEqual(new Uint8Array([1, 1]))
    }
    expect(header.stage1.loadAddress).toBe(T264_COMPONENT_MAGICS.PSCB!.loadAddress)
    expect(header.stage1.secondAddress).toBe(T264_COMPONENT_MAGICS.PSCB!.secondAddress)
  })
})

// An unrecognized magic id leaves loadAddress/secondAddress/flagBytes at
// their zero-filled defaults, and copies its own bytes into `magic` verbatim
// (no chip-specific default) — confirmed against the real tool, not just
// disassembly.
describe('T234 MB1 NV header — unrecognized magicid (chip 0x23, 64-byte payload)', () => {
  const file = golden('t234_mb1_nvheader_unrecognized.bin')
  const payload = new Uint8Array(64).fill(0x22)

  test('leaves addresses and flagBytes zero', () => {
    const header = parseMb1NvHeader(file)
    expect(header.stage1.magic).toBe('XXXX')
    expect(header.stage1.payloadSize).toBe(payload.length)
    expect(header.stage1.loadAddress).toBe(0)
    expect(header.stage1.secondAddress).toBe(0)
    expect(header.stage1.flagBytes).toEqual(new Uint8Array([0, 0]))
  })
})

// TSEC is recognized by the stage0 copy-vs-generic gate (~12 names in
// NvTegraHostAppendT23xHeader) but NOT by the separate loadAddress table
// (~6 names) — proving those two gates are independent. If they were the
// same gate, TSEC (unrecognized by the address table) would fall back to
// the generic stage0 path like "unrecognized magicid" above; instead stage0
// still faithfully mirrors stage1 (both zero, since TSEC gets no hardcoded
// address either) because TSEC IS in the copy-trigger list.
describe('T234 MB1 NV header — magicid TSEC (chip 0x23, 48-byte payload)', () => {
  const file = golden('t234_mb1_nvheader_tsec.bin')
  const payload = new Uint8Array(48).fill(0x11)

  test('gets zero addresses (unrecognized by the address table) but stage0 still mirrors stage1 (recognized by the copy gate)', () => {
    const header = parseMb1NvHeader(file)
    for (const component of [header.stage0, header.stage1]) {
      expect(component.magic).toBe('TSEC')
      expect(component.payloadSize).toBe(payload.length)
      expect(component.loadAddress).toBe(0)
      expect(component.secondAddress).toBe(0)
      expect(component.flagBytes).toEqual(new Uint8Array([0, 0]))
    }
  })
})

// serializeMb1NvHeader is the pure-TS replacement for
// `tegrahost_v2 --addmb1nvheader <file> nvidia-rsa` (unsigned dev path). It
// must produce byte-identical output to the real tool, so it is validated
// against every committed golden — covering both chips, addressed and
// flags-only and unrecognized magic ids, and several payload sizes.
describe('serializeMb1NvHeader — byte-identical to tegrahost_v2 --addmb1nvheader', () => {
  const cases: { name: string; chip: number; magic: string; size: number; fill: number }[] = [
    { name: 't234_mb1_nvheader.bin', chip: 0x23, magic: 'MB1B', size: 256, fill: 0xaa },
    { name: 't264_mb1_nvheader.bin', chip: 0x26, magic: 'MB1B', size: 512, fill: 0x33 },
    { name: 't234_mb1_nvheader_pscb.bin', chip: 0x23, magic: 'PSCB', size: 64, fill: 0x22 },
    { name: 't264_mb1_nvheader_pscb.bin', chip: 0x26, magic: 'PSCB', size: 64, fill: 0x44 },
    { name: 't234_mb1_nvheader_tsec.bin', chip: 0x23, magic: 'TSEC', size: 48, fill: 0x11 },
    { name: 't234_mb1_nvheader_unrecognized.bin', chip: 0x23, magic: 'XXXX', size: 64, fill: 0x22 }
  ]

  for (const c of cases) {
    test(`rebuilds ${c.name} (chip ${c.chip.toString(16)}, ${c.magic}) byte-for-byte`, async () => {
      const payload = new Uint8Array(c.size).fill(c.fill)
      const built = await serializeMb1NvHeader(payload, { magic: c.magic, chip: c.chip })
      expect(Buffer.from(built).equals(Buffer.from(golden(c.name)))).toBe(true)
    })
  }

  test('round-trips through parseMb1NvHeader', async () => {
    const payload = new Uint8Array(128).fill(0x5a)
    const built = await serializeMb1NvHeader(payload, { magic: 'PSCB', chip: 0x26 })
    const parsed = parseMb1NvHeader(built)
    expect(Buffer.from(parsed.payload).equals(Buffer.from(payload))).toBe(true)
    expect(parsed.stage1.magic).toBe('PSCB')
    expect(parsed.stage1.loadAddress).toBe(0x00110000)
    expect(parsed.stage0.loadAddress).toBe(0x00110000)
  })

  test('rejects an out-of-range magic id', async () => {
    await expect(serializeMb1NvHeader(new Uint8Array(16), { magic: 'TOOLONG' })).rejects.toThrow(
      /1-4 chars/
    )
  })
})

// Two real, factory-signed mb1_{t234,t264}_prod.bin images (R39.2.0 BSP; not
// committed here — proprietary NVIDIA firmware) confirmed every offset above
// (magic/payloadSize/sha512Digest, and the der_str/IV/auth-tag fields with
// genuinely non-zero encrypted content) but showed loadAddress/secondAddress
// and flagBytes values that do NOT match tegrahost_v2's own hardcoded
// creation-time defaults for a recognized MB1B component — e.g. the real
// T264 image's loadAddress was 0x7fec0000, not this table's 0x50000000, even
// though a synthetic --addmb1nvheader run on the same tool reproduces
// 0x50000000 exactly. So some later, unlocated pipeline step overwrites
// these two fields in a real signed image — see mb1NvHeader.ts.
