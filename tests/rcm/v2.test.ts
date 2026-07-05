import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
  appletLoadAddress,
  Chip,
  RcmOpcode,
  RcmVersion,
  T194RcmOpcode,
  T234RcmOpcode
} from '../../src/constants'
import {
  buildT186DownloadMessage,
  buildT194DownloadMessage,
  buildT194RcmMessage,
  buildT234DownloadMessage,
  buildT234RcmMessage,
  buildT264DownloadMessage,
  t186MessageSize,
  t186SecureRange,
  t194MessageSize,
  t194SecureRange,
  t234MessageSize,
  t234SecureRange,
  t264MessageSize,
  t264SecureRange
} from '../../src/rcm'
import { sbkHash } from '../../src/sign'

function golden(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`../golden/${name}`, import.meta.url))))
}

describe('t186MessageSize', () => {
  // Empirically confirmed against tegrarcm_v2 --listrcm for chip 0x18:
  // payload 0 -> 1472 (0x5c0), payload 256 -> 1728 (0x6c0).
  test('is payloadOffset(0x5b0) + payload + 0x80 marker, aligned up to 16', () => {
    expect(t186MessageSize(0)).toBe(0x5c0)
    expect(t186MessageSize(256)).toBe(0x6c0)
    // a 16-multiple payload still forces a fresh 16-byte block for the marker
    expect(t186MessageSize(16)).toBe(0x5d0)
    // non-multiple pads to the next boundary
    expect(t186MessageSize(100)).toBe(0x620)
  })
})

describe('buildT186RcmMessage (byte-exact vs tegrarcm_v2 golden)', () => {
  test('download message matches t186_rcm_1.rcm (256-byte 0xAA payload)', () => {
    const payload = new Uint8Array(256).fill(0xaa)
    const msg = buildT186DownloadMessage(payload)
    // t186_rcm_1.rcm is the unsigned download message tegrarcm_v2 emits for
    //   --chip 0x18 --download rcm <256 bytes of 0xAA> 0 0
    expect(msg).toEqual(golden('t186_rcm_1.rcm'))
  })

  test('places fields at the verified offsets', () => {
    const payload = new Uint8Array(256).fill(0xaa)
    const msg = buildT186DownloadMessage(payload)
    const view = new DataView(msg.buffer)
    expect(view.getUint32(0x000, true)).toBe(msg.length) // LengthInsecure
    expect(view.getUint32(0x540, true)).toBe(RcmOpcode.DownloadExecute)
    expect(view.getUint32(0x544, true)).toBe(msg.length) // LengthSecure
    expect(view.getUint32(0x548, true)).toBe(256) // PayloadLength
    expect(view.getUint32(0x54c, true)).toBe(0x00180001) // RcmVersion
    expect(view.getUint32(0x550, true)).toBe(0x40020000) // EntryAddress (applet default)
    expect(view.getUint32(0x5a4, true)).toBe(0x80) // fixed field
    expect(msg.subarray(0x5b0, 0x5b0 + 256)).toEqual(payload)
    expect(msg[0x5b0 + 256]).toBe(0x80) // ISO-7816 marker after payload
  })

  test('SBK CMAC over the secure range matches tegrasign_v2 (zero key)', async () => {
    // `tegrasign_v2 --key <16 zero bytes> --list` over t186_rcm_1.rcm writes this
    // to rcm_1.hash, an AES-128 CMAC over [0x520, end). Confirms t186SecureRange
    // and the CMAC path reproduce the real tool byte-for-byte.
    const hash = await sbkHash(t186SecureRange(golden('t186_rcm_1.rcm')))
    expect(Buffer.from(hash).toString('hex')).toBe('7082667f021ebda1891b4dc54db54b1b')
  })
})

describe('t194MessageSize', () => {
  // Empirically confirmed against tegrarcm_v2 --chip 0x19: total is exactly
  // header + payload — no ISO 0x80 marker and no 16-byte alignment, unlike
  // both T210 and T186 (payload 1 -> 1969 bytes, an odd length).
  test('is payloadOffset(0x7b0) + payload, unpadded', () => {
    expect(t194MessageSize(0)).toBe(0x7b0)
    expect(t194MessageSize(1)).toBe(0x7b1)
    expect(t194MessageSize(100)).toBe(0x814)
    expect(t194MessageSize(256)).toBe(0x8b0)
  })
})

describe('buildT194RcmMessage (byte-exact vs tegrarcm_v2 golden, chip 0x19)', () => {
  test('download message matches t194_rcm_1.rcm (256-byte 0xAA payload)', async () => {
    const payload = new Uint8Array(256).fill(0xaa)
    expect(await buildT194DownloadMessage(payload)).toEqual(golden('t194_rcm_1.rcm'))
  })

  test('download message matches t194_rcm_p1.rcm (1-byte payload, odd total)', async () => {
    expect(await buildT194DownloadMessage(new Uint8Array([0xcc]))).toEqual(
      golden('t194_rcm_p1.rcm')
    )
  })

  test('version-query message matches t194_rcm_0.rcm (empty payload, entry 0)', async () => {
    // tegrarcm_v2 leaves EntryAddress 0 for the query message (it only
    // substitutes the applet address for downloads), so pass entryAddress: 0.
    const msg = await buildT194RcmMessage({
      opcode: T194RcmOpcode.QueryBootRomVersion,
      payload: new Uint8Array(0),
      entryAddress: 0
    })
    expect(msg).toEqual(golden('t194_rcm_0.rcm'))
  })

  test('secure range is the 256-byte signed header [0x6b0, 0x7b0)', () => {
    // rcm_list.xml reports offset=1712 length=256 for every T194 message:
    // signing covers only the secure header; the payload is bound through
    // its SHA-256 at 0x6dc inside that header.
    const m = golden('t194_rcm_1.rcm')
    const range = t194SecureRange(m)
    expect(range.byteOffset - m.byteOffset).toBe(0x6b0)
    expect(range.length).toBe(0x100)
  })
})

// Field-level characterization of the same goldens (kept alongside the
// byte-exact builder checks as documentation of the T194 layout).
describe('T194 RCM golden layout (reference fixture, chip 0x19)', () => {
  const u32 = (m: Uint8Array, o: number) =>
    new DataView(m.buffer, m.byteOffset, m.byteLength).getUint32(o, true)

  test('download message (rcm_1): fields at the T194 offsets', () => {
    const m = golden('t194_rcm_1.rcm')
    expect(m.length).toBe(0x8b0) // 0x7b0 header + 256 payload, no marker/padding
    expect(u32(m, 0x000)).toBe(m.length) // LengthInsecure
    expect(u32(m, 0x6d0)).toBe(5) // Opcode — download is 5 on T194 (4 on T210/T186)
    expect(u32(m, 0x6d4)).toBe(m.length) // LengthSecure
    expect(u32(m, 0x6d8)).toBe(256) // PayloadLength
    expect(u32(m, 0x6fc)).toBe(RcmVersion.V194) // 0x00190001
    expect(u32(m, 0x700)).toBe(appletLoadAddress(Chip.T194)) // 0x40020000 substituted for entry 0
    expect(m.subarray(0x7b0, 0x7b0 + 256)).toEqual(new Uint8Array(256).fill(0xaa))
  })

  test('version-query message (rcm_0): header-only, opcode 7', () => {
    const m = golden('t194_rcm_0.rcm')
    expect(m.length).toBe(0x7b0) // header only, zero payload
    expect(u32(m, 0x6d0)).toBe(7) // query opcode (also 7 on T186; 6 on T210)
    expect(u32(m, 0x6d8)).toBe(0) // PayloadLength
    expect(u32(m, 0x6fc)).toBe(RcmVersion.V194)
  })
})

describe('t234MessageSize', () => {
  test('is payloadOffset(0x7b0) + payload, unpadded', () => {
    expect(t234MessageSize(0)).toBe(0x7b0)
    expect(t234MessageSize(256)).toBe(0x8b0)
  })
})

describe('t264MessageSize', () => {
  test('is payloadOffset(0x7b0) + payload, unpadded', () => {
    expect(t264MessageSize(0)).toBe(0x7b0)
    expect(t264MessageSize(256)).toBe(0x8b0)
  })
})

describe('buildT234RcmMessage / buildT264RcmMessage validation', () => {
  const u32 = (m: Uint8Array, o: number) =>
    new DataView(m.buffer, m.byteOffset, m.byteLength).getUint32(o, true)

  test('buildT234DownloadMessage constructs valid packet', async () => {
    const payload = new Uint8Array(256).fill(0xaa)
    const msg = await buildT234DownloadMessage(payload)
    expect(msg.length).toBe(0x8b0)
    expect(u32(msg, 0x000)).toBe(msg.length)
    expect(u32(msg, 0x6d0)).toBe(5) // DownloadExecute opcode
    expect(u32(msg, 0x6d8)).toBe(256)
    expect(u32(msg, 0x6fc)).toBe(RcmVersion.V234)
    expect(u32(msg, 0x700)).toBe(appletLoadAddress(Chip.T234))
    expect(t234SecureRange(msg).length).toBe(0x100)
  })

  test('buildT264DownloadMessage constructs valid packet', async () => {
    const payload = new Uint8Array(256).fill(0xaa)
    const msg = await buildT264DownloadMessage(payload)
    expect(msg.length).toBe(0x8b0)
    expect(u32(msg, 0x000)).toBe(msg.length)
    expect(u32(msg, 0x6d0)).toBe(5) // DownloadExecute opcode
    expect(u32(msg, 0x6d8)).toBe(256)
    expect(u32(msg, 0x6fc)).toBe(RcmVersion.V264)
    expect(u32(msg, 0x700)).toBe(appletLoadAddress(Chip.T264))
    expect(t264SecureRange(msg).length).toBe(0x100)
  })

  test('buildT234RcmMessage version query constructs valid packet', async () => {
    const msg = await buildT234RcmMessage({
      opcode: T234RcmOpcode.QueryBootRomVersion,
      payload: new Uint8Array(0),
      entryAddress: 0
    })
    expect(msg.length).toBe(0x7b0)
    expect(u32(msg, 0x6d0)).toBe(7) // QueryBootRomVersion opcode
    expect(u32(msg, 0x6d8)).toBe(0)
    expect(u32(msg, 0x6fc)).toBe(RcmVersion.V234)
    expect(u32(msg, 0x700)).toBe(0)
  })

  test('T234 and T264 messages differ only at version and header hash fields', async () => {
    const payload = new Uint8Array(256).fill(0xaa)
    const msg234 = await buildT234DownloadMessage(payload)
    const msg264 = await buildT264DownloadMessage(payload)

    expect(msg234.length).toBe(msg264.length)
    expect(msg234).not.toEqual(msg264)
    expect(msg234[0x6fe]).not.toBe(msg264[0x6fe]) // version diff byte (0x23 vs 0x26)

    for (let i = 0; i < msg234.length; i++) {
      const isHeaderHash = i >= 0x4c4 && i < 0x4e4
      const isVersion = i >= 0x6fc && i < 0x700

      if (!isHeaderHash && !isVersion) {
        expect(msg234[i]).toBe(msg264[i])
      }
    }
  })
})
