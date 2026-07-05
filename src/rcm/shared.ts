import { appletLoadAddress, Chip, RcmOpcode } from '../constants'
import { RcmError } from '../errors'

export type RcmMessageOptions = {
  opcode: RcmOpcode
  payload: Uint8Array
  /** Execution/entry address; defaults to the chip's applet load address. */
  entryAddress?: number
}

/**
 * A chip family's RCM message framing: the secure-header field offsets, the
 * protocol version, and how a payload length maps to a total message size. T210
 * and T186 differ only in these values, so one builder serves both.
 */
export interface RcmLayout {
  /** Start of the signed region (the RandomAesBlock). */
  secureOffset: number
  offLengthInsecure: number
  offOpcode: number
  offLengthSecure: number
  offPayloadLength: number
  offRcmVersion: number
  offEntryAddress: number
  offFixed80: number
  /** Byte offset of the payload within a built frame (i.e. the header size). */
  offPayload: number
  version: number
  /** Chip whose applet load address is the default entry point. */
  chip: Chip
  messageSize: (payloadLength: number) => number
  /** Logical→wire opcode remap (`NvTegraT<xx>xRcmMapOpCode`); identity when absent. */
  wireOpcode?: (opcode: RcmOpcode) => number
}

/**
 * Build an (unsigned) RCM message for `layout`. The signature region
 * (0x004..secureOffset) is left zero; run it through the signing step to
 * populate the hash/signature. All multi-byte fields are little-endian.
 */
export function buildRcmMessage(
  layout: RcmLayout,
  options: RcmMessageOptions
): Uint8Array<ArrayBuffer> {
  const { opcode, payload } = options
  const size = layout.messageSize(payload.length)
  if (layout.offPayload + payload.length > size) {
    throw new RcmError(`payload of ${payload.length} bytes overflows message of ${size}`)
  }

  const entryAddress = options.entryAddress ?? appletLoadAddress(layout.chip)
  const msg = new Uint8Array(size)
  const view = new DataView(msg.buffer)
  view.setUint32(layout.offLengthInsecure, size, true)
  view.setUint32(layout.offOpcode, layout.wireOpcode ? layout.wireOpcode(opcode) : opcode, true)
  view.setUint32(layout.offLengthSecure, size, true)
  view.setUint32(layout.offPayloadLength, payload.length, true)
  view.setUint32(layout.offRcmVersion, layout.version, true)
  view.setUint32(layout.offEntryAddress, entryAddress, true)
  view.setUint32(layout.offFixed80, 0x80, true)
  msg.set(payload, layout.offPayload)
  // ISO 7816-4 payload padding: a 0x80 marker after the data, then zero-fill.
  msg[layout.offPayload + payload.length] = 0x80
  return msg
}

/** The byte range covered by an RCM signature/hash: [secureOffset, end). */
export function secureRange(layout: RcmLayout, message: Uint8Array): Uint8Array {
  return message.subarray(layout.secureOffset)
}
