import { describe, expect, test } from 'vitest'
import { SignError } from '../src/errors'
import { aesCmac, sbkHash, signRsaPss } from '../src/sign'
import { fromHex, toHex } from './fixtures'

// RFC 4493 §4 test vectors. Key K and messages M with expected AES-CMAC.
const KEY = fromHex('2b7e151628aed2a6abf7158809cf4f3c')
const M = fromHex(
  '6bc1bee22e409f96e93d7e117393172a' +
    'ae2d8a571e03ac9c9eb76fac45af8e51' +
    '30c81c46a35ce411e5fbc1191a0a52ef' +
    'f69f2445df4f9b17ad2b417be66c3710'
)

describe('aesCmac (RFC 4493 vectors)', () => {
  test('example 1: empty message', async () => {
    expect(toHex(await aesCmac(KEY, M.subarray(0, 0)))).toBe('bb1d6929e95937287fa37d129b756746')
  })

  test('example 2: 16-byte message', async () => {
    expect(toHex(await aesCmac(KEY, M.subarray(0, 16)))).toBe('070a16b46b4d4144f79bdd9dd04a287c')
  })

  test('example 3: 40-byte message', async () => {
    expect(toHex(await aesCmac(KEY, M.subarray(0, 40)))).toBe('dfa66747de9ae63030ca32611497c827')
  })

  test('example 4: 64-byte message', async () => {
    expect(toHex(await aesCmac(KEY, M.subarray(0, 64)))).toBe('51f0bebf7e3b9d92fc49741779363cfe')
  })

  test('rejects an invalid key length with SignError', async () => {
    await expect(aesCmac(new Uint8Array(15), new Uint8Array(0))).rejects.toThrow(SignError)
    await expect(aesCmac(new Uint8Array(15), new Uint8Array(0))).rejects.toThrow(
      /16\/24\/32 bytes, got 15/
    )
  })

  // Key chosen so AES(key, 0) has its MSB set: this forces the GF(2^128)
  // subkey-reduction branch (XOR with Rb=0x87). Goldens from openssl:
  //   openssl dgst -mac cmac -macopt cipher:aes-128-cbc -macopt hexkey:01000..00
  describe('subkey reduction branch (MSB of L set)', () => {
    const RB_KEY = fromHex('01000000000000000000000000000000')

    test('complete 16-byte block uses the reduced K1', async () => {
      const message = new TextEncoder().encode('libtegrarcm-16by')
      expect(toHex(await aesCmac(RB_KEY, message))).toBe('372d548248eaae41617527e20332aeaf')
    })

    test('empty message uses the twice-reduced K2', async () => {
      expect(toHex(await aesCmac(RB_KEY, new Uint8Array(0)))).toBe(
        'c96d4956f7fe903572c1b0b8f0d82d1e'
      )
    })
  })
})

describe('sbkHash (T210 zero-key SBK)', () => {
  // Golden generated with the exact tegrasign command:
  //   openssl dgst -mac cmac -macopt cipher:aes-128-cbc -macopt hexkey:00..00 -binary
  test('matches openssl zero-key AES-128 CMAC', async () => {
    const data = new TextEncoder().encode('libtegrarcm-cmac-golden')
    expect(toHex(await sbkHash(data))).toBe('f67f1901f00a1dac7ba0c00cdada444b')
  })
})

describe('signRsaPss', () => {
  test('produces a 256-byte signature WebCrypto verifies with a 32-byte salt', async () => {
    const { privateKey, publicKey } = await crypto.subtle.generateKey(
      {
        name: 'RSA-PSS',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256'
      },
      false,
      ['sign', 'verify']
    )

    const data = new Uint8Array([0x52, 0x43, 0x4d, 0x00])
    const signature = await signRsaPss(privateKey, data)

    expect(signature).toHaveLength(256)
    expect(
      await crypto.subtle.verify({ name: 'RSA-PSS', saltLength: 32 }, publicKey, signature, data)
    ).toBe(true)
  })
})
