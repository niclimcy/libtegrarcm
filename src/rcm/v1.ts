import { Chip, RcmOpcode, RcmVersion } from '../constants'
import { buildRcmMessage, RcmLayout, RcmMessageOptions, secureRange } from './shared'

/**
 * v1 RCM framing — the `tegrarcm` (pre-`_v2`) tools: T124/T132/T210. A single
 * flat message with a `0x2A8`-byte header.
 *
 * T210 layout (see tests/golden/ and PROTOCOL.md):
 *
 *   0x000  u32   LengthInsecure   total message length
 *   0x004..0x237  RSA modulus + PSS signature + object hash (filled by signing)
 *   0x238  u8[16] RandomAesBlock  start of the signed region (zero pre-sign)
 *   0x258  u32   Opcode
 *   0x25C  u32   LengthSecure     == LengthInsecure
 *   0x260  u32   PayloadLength
 *   0x264  u32   RcmVersion       0x00210001
 *   0x268  u32   EntryAddress
 *   0x2A0  u32   0x00000080       fixed field
 *   0x2A8  ...   payload (zero-padded to the message size)
 */
const T210 = {
  headerSize: 0x2a8,
  offPayload: 0x2a8,
  fixedMessageSize: 0x408
} as const

/** Byte offset of the payload within a built T210 RCM frame (i.e. its header size). */
export const T210_PAYLOAD_OFFSET = T210.offPayload

/** Total T210 message size for a payload (matches tegrarcm's allocation). */
export function t210MessageSize(payloadLength: number): number {
  if (payloadLength + T210.headerSize <= 0x3ff) return T210.fixedMessageSize
  return 0x2b8 + (payloadLength & ~0x0f)
}

const T210_RCM_LAYOUT: RcmLayout = {
  secureOffset: 0x238,
  offLengthInsecure: 0x000,
  offOpcode: 0x258,
  offLengthSecure: 0x25c,
  offPayloadLength: 0x260,
  offRcmVersion: 0x264,
  offEntryAddress: 0x268,
  offFixed80: 0x2a0,
  offPayload: T210.offPayload,
  version: RcmVersion.V210,
  chip: Chip.T210,
  messageSize: t210MessageSize
}

const T124_RCM_LAYOUT: RcmLayout = {
  ...T210_RCM_LAYOUT,
  version: (Chip.T124 << 16) | 1,
  chip: Chip.T124
}

const T132_RCM_LAYOUT: RcmLayout = {
  ...T210_RCM_LAYOUT,
  version: (Chip.T132 << 16) | 1,
  chip: Chip.T132
}

export function buildT210RcmMessage(options: RcmMessageOptions): Uint8Array<ArrayBuffer> {
  return buildRcmMessage(T210_RCM_LAYOUT, options)
}

export function buildT124RcmMessage(options: RcmMessageOptions): Uint8Array<ArrayBuffer> {
  return buildRcmMessage(T124_RCM_LAYOUT, options)
}

export function buildT132RcmMessage(options: RcmMessageOptions): Uint8Array<ArrayBuffer> {
  return buildRcmMessage(T132_RCM_LAYOUT, options)
}

/** The byte range covered by the RCM signature/hash: [0x238, end). */
export function t210SecureRange(message: Uint8Array): Uint8Array {
  return secureRange(T210_RCM_LAYOUT, message)
}

/** Build a download-and-execute message carrying an applet/bootloader. */
export function buildT210DownloadMessage(payload: Uint8Array): Uint8Array<ArrayBuffer> {
  return buildT210RcmMessage({ opcode: RcmOpcode.DownloadExecute, payload })
}
