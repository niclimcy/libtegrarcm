import { AES_BLOCK_SIZE } from './constants'
import { SignError } from './errors'

/** RSA-PSS salt length used by tegrasign (`rsa_pss_saltlen:-1` == digest length). */
const RSA_PSS_SALT_LENGTH = 32 // SHA-256 digest size

const RB = 0x87 // GF(2^128) reduction constant for CMAC subkey generation

/** Encrypt a single 16-byte block with AES in ECB mode via WebCrypto's AES-CBC
 * (iv = 0, first block only; PKCS7 padding beyond the block is discarded). */
async function aesEcbBlock(
  key: CryptoKey,
  block: Uint8Array<ArrayBuffer>
): Promise<Uint8Array<ArrayBuffer>> {
  const iv = new Uint8Array(AES_BLOCK_SIZE)
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, block))
  return out.subarray(0, AES_BLOCK_SIZE)
}

/** One-bit left shift of a big-endian 16-byte value. */
function shiftLeft(input: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(input.length)
  let carry = 0
  for (let i = input.length - 1; i >= 0; i--) {
    const value = (input[i]! << 1) | carry
    out[i] = value & 0xff
    carry = value >> 8
  }
  return out
}

function xor(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i]! ^ b[i]!
  return out
}

/** Derive the CMAC subkeys K1/K2 from L = AES(0). */
function deriveSubkey(l: Uint8Array): Uint8Array<ArrayBuffer> {
  const shifted = shiftLeft(l)
  if ((l[0] ?? 0) & 0x80) {
    const last = shifted.length - 1
    shifted[last] = (shifted[last] ?? 0) ^ RB
  }
  return shifted
}

/**
 * AES-CMAC (RFC 4493). WebCrypto has no CMAC primitive, so this builds it on
 * top of AES-CBC — the hash used by Tegra RCM/BCT zero-key (SBK) signing.
 */
export async function aesCmac(
  keyBytes: Uint8Array<ArrayBuffer>,
  message: Uint8Array
): Promise<Uint8Array<ArrayBuffer>> {
  if (keyBytes.length !== 16 && keyBytes.length !== 24 && keyBytes.length !== 32) {
    throw new SignError(`AES-CMAC key must be 16/24/32 bytes, got ${keyBytes.length}`)
  }
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, [
    'encrypt'
  ])

  const l = await aesEcbBlock(key, new Uint8Array(AES_BLOCK_SIZE))
  const k1 = deriveSubkey(l)
  const k2 = deriveSubkey(k1)

  const complete = message.length > 0 && message.length % AES_BLOCK_SIZE === 0
  const blockCount = Math.max(1, Math.ceil(message.length / AES_BLOCK_SIZE))
  const lastStart = (blockCount - 1) * AES_BLOCK_SIZE

  // Build the final block: last block XOR K1 (complete) or padded XOR K2.
  let lastBlock: Uint8Array<ArrayBuffer>
  if (complete) {
    lastBlock = xor(message.subarray(lastStart), k1)
  } else {
    const padded = new Uint8Array(AES_BLOCK_SIZE)
    padded.set(message.subarray(lastStart))
    padded[message.length - lastStart] = 0x80
    lastBlock = xor(padded, k2)
  }

  // CBC-MAC over blocks 1..n-1 followed by the transformed final block.
  const buffer = new Uint8Array(blockCount * AES_BLOCK_SIZE)
  buffer.set(message.subarray(0, lastStart))
  buffer.set(lastBlock, lastStart)

  const iv = new Uint8Array(AES_BLOCK_SIZE)
  const cbc = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, buffer))
  return cbc.subarray(lastStart, lastStart + AES_BLOCK_SIZE)
}

/**
 * Tegra SBK hash for default-fused (zero-key) devices: AES-128 CMAC with an
 * all-zero key. This is what tegrasign computes for the T210 RCM/BCT SBK path
 * (`openssl dgst -mac cmac -macopt cipher:aes-128-cbc -macopt hexkey:00..00`).
 */
export function sbkHash(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return aesCmac(new Uint8Array(16), data)
}

/**
 * RSA-PSS signature over SHA-256(data), matching tegrasign's PKC path
 * (SHA-256 digest, salt length == digest length). `privateKey` must be an
 * RSA-PSS CryptoKey with the 'sign' usage.
 */
export async function signRsaPss(
  privateKey: CryptoKey,
  data: Uint8Array<ArrayBuffer>
): Promise<Uint8Array<ArrayBuffer>> {
  const sig = await crypto.subtle.sign(
    { name: 'RSA-PSS', saltLength: RSA_PSS_SALT_LENGTH },
    privateKey,
    data
  )
  return new Uint8Array(sig)
}
