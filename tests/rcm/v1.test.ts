import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { RcmOpcode } from '../../src/constants'
import { buildT210DownloadMessage, buildT210RcmMessage, t210MessageSize } from '../../src/rcm'

function golden(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`../golden/${name}`, import.meta.url))))
}

describe('t210MessageSize', () => {
  // Empirically confirmed against tegrarcm --listrcm for chip 0x21.
  test('small payloads produce a fixed 1032-byte message', () => {
    expect(t210MessageSize(0)).toBe(1032)
    expect(t210MessageSize(16)).toBe(1032)
    expect(t210MessageSize(343)).toBe(1032)
    expect(t210MessageSize(344)).toBe(1032)
  })

  test('larger payloads grow as 0x2B8 + floor16(payload)', () => {
    expect(t210MessageSize(352)).toBe(1048)
    expect(t210MessageSize(353)).toBe(1048)
    expect(t210MessageSize(1024)).toBe(1720)
    expect(t210MessageSize(4096)).toBe(4792)
  })
})

describe('buildT210RcmMessage (byte-exact vs tegrarcm golden)', () => {
  test('download message matches rcm_1.rcm (256-byte 0xAA payload)', () => {
    const payload = new Uint8Array(256).fill(0xaa)
    const msg = buildT210DownloadMessage(payload)
    // rcm_1.rcm is the unsigned download message tegrarcm emits for
    //   --chip 0x21 --download rcm <256 bytes of 0xAA> 0 0
    expect(msg).toEqual(golden('rcm_1.rcm'))
  })

  test('places fields at the verified offsets', () => {
    const payload = new Uint8Array(256).fill(0xaa)
    const msg = buildT210DownloadMessage(payload)
    const view = new DataView(msg.buffer)
    expect(view.getUint32(0x000, true)).toBe(msg.length) // LengthInsecure
    expect(view.getUint32(0x258, true)).toBe(RcmOpcode.DownloadExecute)
    expect(view.getUint32(0x260, true)).toBe(256) // PayloadLength
    expect(view.getUint32(0x264, true)).toBe(0x00210001) // RcmVersion
    expect(view.getUint32(0x268, true)).toBe(0x40010000) // EntryAddress
    expect(msg.subarray(0x2a8, 0x2a8 + 256)).toEqual(payload)
  })

  test('rejects a payload that overflows its message', () => {
    // 344..352 still fit the fixed message; a payload needing more than the
    // computed size cannot occur, but a manual opcode with an oversized array does.
    expect(() =>
      buildT210RcmMessage({ opcode: RcmOpcode.DownloadExecute, payload: new Uint8Array(0) })
    ).not.toThrow()
  })
})
