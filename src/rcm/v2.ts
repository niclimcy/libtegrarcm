import {
  appletLoadAddress,
  Chip,
  RCM_MESSAGE_ALIGNMENT,
  RcmOpcode,
  RcmVersion,
  T194RcmOpcode,
  T234RcmOpcode,
  T264RcmOpcode
} from '../constants'
import { RcmError } from '../errors'
import { alignUp } from '../utils/bytes'
import { buildRcmMessage, RcmLayout, RcmMessageOptions, secureRange } from './shared'

/**
 * v2 RCM framing — the `tegrarcm_v2` tools (T186/T194/T234/T264).
 *
 * T186 shares T210's flat field structure at a larger `0x520` header, while the
 * v2-extended chips (T194/T234/T264) share a distinct, larger format with
 * embedded SHA-256 fields.
 *
 * T186 layout (see tests/golden/t186_rcm_*.rcm and PROTOCOL.md):
 *
 *   0x000  u32    LengthInsecure   total message length
 *   0x004..0x51F  RSA modulus + PSS signature + object hash (filled by signing)
 *   0x520  u8[16] RandomAesBlock   start of the signed region (zero pre-sign)
 *   0x540  u32    Opcode
 *   0x544  u32    LengthSecure     == LengthInsecure
 *   0x548  u32    PayloadLength
 *   0x54C  u32    RcmVersion       0x00180001
 *   0x550  u32    EntryAddress
 *   0x5A4  u32    0x00000080       fixed field
 *   0x5B0  ...    payload (0x80 marker after data, zero-padded to 16)
 */
const T186 = {
  offPayload: 0x5b0
} as const

/** Byte offset of the payload within a built T186 RCM frame (i.e. its header size). */
export const T186_PAYLOAD_OFFSET = T186.offPayload

/** Total T186 message size for a payload (matches tegrarcm_v2's allocation):
 * the 0x80 ISO-7816 marker after the payload, then zero-pad to a 16-byte
 * boundary. Unlike T210 there is no fixed small-message floor. */
export function t186MessageSize(payloadLength: number): number {
  return alignUp(T186.offPayload + payloadLength + 1, RCM_MESSAGE_ALIGNMENT)
}

/** `NvTegraT18xRcmMapOpCode`: the version query is wire opcode 7 (logical 6);
 * download-and-execute stays 4. Other opcodes pass through unremapped — their
 * T186 wire values are unobserved (see PROTOCOL.md). */
export function t186WireOpcode(opcode: RcmOpcode): number {
  return opcode === RcmOpcode.QueryBootRomVersion ? 7 : opcode
}

const T186_RCM_LAYOUT: RcmLayout = {
  secureOffset: 0x520,
  offLengthInsecure: 0x000,
  offOpcode: 0x540,
  offLengthSecure: 0x544,
  offPayloadLength: 0x548,
  offRcmVersion: 0x54c,
  offEntryAddress: 0x550,
  offFixed80: 0x5a4,
  offPayload: T186.offPayload,
  version: RcmVersion.V186,
  chip: Chip.T186,
  messageSize: t186MessageSize,
  wireOpcode: t186WireOpcode
}

export function buildT186RcmMessage(options: RcmMessageOptions): Uint8Array<ArrayBuffer> {
  return buildRcmMessage(T186_RCM_LAYOUT, options)
}

/** The byte range covered by the T186 RCM signature/hash: [0x520, end). */
export function t186SecureRange(message: Uint8Array): Uint8Array {
  return secureRange(T186_RCM_LAYOUT, message)
}

/** Build a T186 download-and-execute message carrying an applet/bootloader. */
export function buildT186DownloadMessage(payload: Uint8Array): Uint8Array<ArrayBuffer> {
  return buildT186RcmMessage({ opcode: RcmOpcode.DownloadExecute, payload })
}

/**
 * v2-extended RCM message layout (T194 / T234 / T264)
 * (see tests/golden/t194_rcm_*.rcm and PROTOCOL.md).
 * A distinct, larger layout than T186's, with two SHA-256 fields computed at
 * build time; signing covers only the 256-byte secure header [0x6b0, 0x7b0)
 * — the payload is bound via its digest at 0x6dc. All multi-byte fields little-endian.
 *
 *   0x000  u32    LengthInsecure   total message length
 *   0x004..       RSA/key + object-hash region (filled by signing)
 *   0x4c4  u8[32] SHA-256 over the secure header [0x6b0, 0x7b0)
 *   0x6d0  u32    Opcode           wire encoding (download = 5, query = 7)
 *   0x6d4  u32    LengthSecure     == LengthInsecure
 *   0x6d8  u32    PayloadLength
 *   0x6dc  u8[32] SHA-256 of the payload (zero when empty)
 *   0x6fc  u32    RcmVersion       V194 / V234 / V264
 *   0x700  u32    EntryAddress
 *   0x798  u32    0x80000000       fixed field
 *   0x7b0  ...    payload (no ISO-7816 marker, no alignment padding)
 */
const V2_EXTENDED_SECURE_OFFSET = 0x6b0
const V2_EXTENDED_OFF_HEADER_HASH = 0x4c4
const V2_EXTENDED_OFF_OPCODE = 0x6d0
const V2_EXTENDED_OFF_LENGTH_SECURE = 0x6d4
const V2_EXTENDED_OFF_PAYLOAD_LENGTH = 0x6d8
const V2_EXTENDED_OFF_PAYLOAD_HASH = 0x6dc
const V2_EXTENDED_OFF_RCM_VERSION = 0x6fc
const V2_EXTENDED_OFF_ENTRY_ADDRESS = 0x700
const V2_EXTENDED_OFF_FIXED_80 = 0x798
const V2_EXTENDED_OFF_PAYLOAD = 0x7b0

interface V2ExtendedRcmMessageOptions {
  opcode: number
  payload: Uint8Array
  entryAddress?: number | undefined
  version: number
  chip: Chip
}

async function buildV2ExtendedRcmMessage(
  options: V2ExtendedRcmMessageOptions
): Promise<Uint8Array<ArrayBuffer>> {
  const { opcode, payload, version, chip } = options
  const size = V2_EXTENDED_OFF_PAYLOAD + payload.length
  const entryAddress = options.entryAddress ?? appletLoadAddress(chip)

  const msg = new Uint8Array(size)
  const view = new DataView(msg.buffer)
  view.setUint32(0x000, size, true)
  view.setUint32(V2_EXTENDED_OFF_OPCODE, opcode, true)
  view.setUint32(V2_EXTENDED_OFF_LENGTH_SECURE, size, true)
  view.setUint32(V2_EXTENDED_OFF_PAYLOAD_LENGTH, payload.length, true)
  view.setUint32(V2_EXTENDED_OFF_RCM_VERSION, version, true)
  view.setUint32(V2_EXTENDED_OFF_ENTRY_ADDRESS, entryAddress, true)
  view.setUint32(V2_EXTENDED_OFF_FIXED_80, 0x80000000, true)
  msg.set(payload, V2_EXTENDED_OFF_PAYLOAD)

  if (payload.length > 0) {
    const payloadCopy = new Uint8Array(payload)
    msg.set(
      new Uint8Array(await crypto.subtle.digest('SHA-256', payloadCopy)),
      V2_EXTENDED_OFF_PAYLOAD_HASH
    )
  }
  // Header hash last — its input [0x6b0, 0x7b0) includes the payload hash.
  const header = msg.slice(V2_EXTENDED_SECURE_OFFSET, V2_EXTENDED_OFF_PAYLOAD)
  msg.set(
    new Uint8Array(await crypto.subtle.digest('SHA-256', header)),
    V2_EXTENDED_OFF_HEADER_HASH
  )
  return msg
}

// T194 exports
export const T194_PAYLOAD_OFFSET = V2_EXTENDED_OFF_PAYLOAD

export function t194MessageSize(payloadLength: number): number {
  return V2_EXTENDED_OFF_PAYLOAD + payloadLength
}

export type T194RcmMessageOptions = {
  opcode: T194RcmOpcode
  payload: Uint8Array
  entryAddress?: number
}

export async function buildT194RcmMessage(
  options: T194RcmMessageOptions
): Promise<Uint8Array<ArrayBuffer>> {
  return buildV2ExtendedRcmMessage({
    opcode: options.opcode,
    payload: options.payload,
    entryAddress: options.entryAddress,
    version: RcmVersion.V194,
    chip: Chip.T194
  })
}

export function t194SecureRange(message: Uint8Array): Uint8Array {
  return message.subarray(V2_EXTENDED_SECURE_OFFSET, V2_EXTENDED_OFF_PAYLOAD)
}

export function buildT194DownloadMessage(payload: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return buildT194RcmMessage({ opcode: T194RcmOpcode.DownloadExecute, payload })
}

export function t194WireOpcode(opcode: RcmOpcode): T194RcmOpcode {
  switch (opcode) {
    case RcmOpcode.DownloadExecute:
      return T194RcmOpcode.DownloadExecute
    case RcmOpcode.QueryBootRomVersion:
      return T194RcmOpcode.QueryBootRomVersion
    default:
      throw new RcmError(`T194 wire opcode for logical RCM opcode ${opcode} is unknown`)
  }
}

// T234 exports
export const T234_PAYLOAD_OFFSET = V2_EXTENDED_OFF_PAYLOAD

export function t234MessageSize(payloadLength: number): number {
  return V2_EXTENDED_OFF_PAYLOAD + payloadLength
}

export type T234RcmMessageOptions = {
  opcode: T234RcmOpcode
  payload: Uint8Array
  entryAddress?: number
}

export async function buildT234RcmMessage(
  options: T234RcmMessageOptions
): Promise<Uint8Array<ArrayBuffer>> {
  return buildV2ExtendedRcmMessage({
    opcode: options.opcode,
    payload: options.payload,
    entryAddress: options.entryAddress,
    version: RcmVersion.V234,
    chip: Chip.T234
  })
}

export function t234SecureRange(message: Uint8Array): Uint8Array {
  return message.subarray(V2_EXTENDED_SECURE_OFFSET, V2_EXTENDED_OFF_PAYLOAD)
}

export function buildT234DownloadMessage(payload: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return buildT234RcmMessage({ opcode: T234RcmOpcode.DownloadExecute, payload })
}

export function t234WireOpcode(opcode: RcmOpcode): T234RcmOpcode {
  switch (opcode) {
    case RcmOpcode.DownloadExecute:
      return T234RcmOpcode.DownloadExecute
    case RcmOpcode.QueryBootRomVersion:
      return T234RcmOpcode.QueryBootRomVersion
    default:
      throw new RcmError(`T234 wire opcode for logical RCM opcode ${opcode} is unknown`)
  }
}

// T264 exports
export const T264_PAYLOAD_OFFSET = V2_EXTENDED_OFF_PAYLOAD

export function t264MessageSize(payloadLength: number): number {
  return V2_EXTENDED_OFF_PAYLOAD + payloadLength
}

export type T264RcmMessageOptions = {
  opcode: T264RcmOpcode
  payload: Uint8Array
  entryAddress?: number
}

export async function buildT264RcmMessage(
  options: T264RcmMessageOptions
): Promise<Uint8Array<ArrayBuffer>> {
  return buildV2ExtendedRcmMessage({
    opcode: options.opcode,
    payload: options.payload,
    entryAddress: options.entryAddress,
    version: RcmVersion.V264,
    chip: Chip.T264
  })
}

export function t264SecureRange(message: Uint8Array): Uint8Array {
  return message.subarray(V2_EXTENDED_SECURE_OFFSET, V2_EXTENDED_OFF_PAYLOAD)
}

export function buildT264DownloadMessage(payload: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return buildT264RcmMessage({ opcode: T264RcmOpcode.DownloadExecute, payload })
}

export function t264WireOpcode(opcode: RcmOpcode): T264RcmOpcode {
  switch (opcode) {
    case RcmOpcode.DownloadExecute:
      return T264RcmOpcode.DownloadExecute
    case RcmOpcode.QueryBootRomVersion:
      return T264RcmOpcode.QueryBootRomVersion
    default:
      throw new RcmError(`T264 wire opcode for logical RCM opcode ${opcode} is unknown`)
  }
}
