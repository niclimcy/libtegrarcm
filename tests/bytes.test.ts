import { describe, expect, test } from 'vitest'
import {
  alignUp,
  concatBytes,
  decodeCString,
  encodeAscii,
  packUint32sLE,
  readUint32BE,
  readUint32LE
} from '../src/utils/bytes'

describe('encodeAscii', () => {
  test('encodes one byte per char with no terminator', () => {
    expect(encodeAscii('GSHV')).toEqual(new Uint8Array([0x47, 0x53, 0x48, 0x56]))
  })
})

describe('decodeCString', () => {
  test('stops at the first NUL', () => {
    expect(decodeCString(new Uint8Array([0x41, 0x50, 0x58, 0, 0x58]))).toBe('APX')
  })

  test('decodes the whole buffer when no NUL is present', () => {
    expect(decodeCString(new Uint8Array([0x47, 0x53, 0x48, 0x56]))).toBe('GSHV')
  })
})

describe('packUint32sLE', () => {
  test('packs little-endian and zero-pads to padTo', () => {
    const packed = packUint32sLE([0x210001], 16)
    expect(packed).toHaveLength(16)
    expect(new DataView(packed.buffer).getUint32(0, true)).toBe(0x210001)
    expect(packed.slice(4)).toEqual(new Uint8Array(12))
  })
})

describe('readUint32LE / readUint32BE', () => {
  test('reads with the requested endianness at an offset', () => {
    const buf = new Uint8Array([0, 0, 0, 0, 0x00, 0x00, 0x21, 0x00])
    expect(readUint32LE(buf, 4)).toBe(0x00210000)
    expect(readUint32BE(buf, 4)).toBe(0x00002100)
  })

  test('honors a non-zero byteOffset subarray window', () => {
    const backing = new Uint8Array([0xff, 0xff, 0x78, 0x56, 0x34, 0x12])
    const view = backing.subarray(2)
    expect(readUint32LE(view, 0)).toBe(0x12345678)
  })
})

describe('concatBytes', () => {
  test('joins chunks in order', () => {
    expect(concatBytes([new Uint8Array([1, 2]), new Uint8Array([3])])).toEqual(
      new Uint8Array([1, 2, 3])
    )
  })
})

describe('alignUp', () => {
  test('rounds up to the alignment', () => {
    expect(alignUp(0, 16)).toBe(0)
    expect(alignUp(1, 16)).toBe(16)
    expect(alignUp(16, 16)).toBe(16)
    expect(alignUp(17, 16)).toBe(32)
  })
})
