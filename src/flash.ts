import { chipProfile, type RcmCodec } from './chips'
import { Chip, RcmOpcode } from './constants'
import { TegraDevice } from './device'
import { RcmError } from './errors'
import { sbkHash } from './sign'
import { readUint32LE } from './utils/bytes'

/**
 * High-level RCM flash orchestration.
 *
 * Sequences the recovery-mode transfer flow over a single bulk endpoint pair:
 * read the device context, stream the BCT, stream the boot images, then trigger
 * execution. Each step is one signed RCM message followed by a 4-byte status
 * read. Progress is reported with the same shape as libamlburn's burn flow
 * (`stage` / `bytesTransferred` / `totalBytes`).
 *
 * On T194 the bootrom-level flow is just the applet hand-off — read UID →
 * (query version) → download-and-execute the applet — matching what
 * `tegrarcm_v2 --chip 0x19` sends; the rest of flashing runs through the
 * downloaded applet, not RCM. Pass a package with only `executePayload`;
 * the program-BCT / boot-image stages throw (their T194 wire opcodes are
 * unknown — see PROTOCOL.md).
 */

export type FlashStage =
  'read-uid' | 'query-version' | 'program-bct' | 'stream-images' | 'execute' | 'finish'

export interface FlashProgress {
  stage: FlashStage
  bytesTransferred?: number
  totalBytes?: number
}

/** Offset of the object hash / signature within the RCM message header. */
const RCM_OBJECT_HASH_OFFSET = 0x004
const RCM_STATUS_LENGTH = 4
const DEFAULT_USB_CHUNK = 0x1000

/** Populates an RCM message's signature region in place before it is sent. */
export type MessageSigner = (message: Uint8Array<ArrayBuffer>) => Promise<void>

/** RCM message framing from the chip registry. Profiles without a codec
 * (T234/T264: no host-buildable RCM frame — see PROTOCOL.md) are rejected
 * rather than silently mis-framed as T210. */
function rcmCodecFor(chip: Chip): RcmCodec {
  const codec = chipProfile(chip).rcm
  if (!codec) {
    throw new RcmError(
      `RCM framing for chip 0x${chip.toString(16)} is not implemented (only T124/T132/T210, T186, and T194)`
    )
  }
  return codec
}

/** Zero-key (SBK) signer for a chip: AES-CMAC over that chip's secure range,
 * written to the object-hash offset (0x004, right after LengthInsecure). */
export function sbkSignerFor(chip: Chip): MessageSigner {
  const { secureRange } = rcmCodecFor(chip)
  return async (message) => {
    const hash = await sbkHash(secureRange(message))
    message.set(hash, RCM_OBJECT_HASH_OFFSET)
  }
}

/** Zero-key (SBK) signer bound to the T210 secure range. Name carries the chip
 * so it isn't mistakenly passed to a T186 flasher (whose range starts at 0x520);
 * for other chips use {@link sbkSignerFor}. */
export const t210SbkSigner: MessageSigner = sbkSignerFor(Chip.T210)

export interface TegraBootPackage {
  /** Signed Boot Configuration Table (see `bct/`). Omit on chips whose RCM
   * flow has no program-BCT stage (T194's applet hand-off). T186 splits boot
   * config into two BCTs — use {@link bcts} for that. */
  bct?: Uint8Array
  /**
   * Ordered BCTs streamed via the program-BCT stage, for chips (T186) whose
   * boot config is more than one BCT — the BR-BCT then the MB1-BCT. Takes
   * precedence over {@link bct}. Each is sent as its own ProgramBct message.
   */
  bcts?: Uint8Array[]
  /** Boot images / bootloader blocks, streamed in order after the BCT. */
  bootImages?: Uint8Array[]
  /**
   * Payload for the final download-and-execute hand-off (e.g. the miniloader or
   * bootloader entry stub). Sent last to start execution; omit to end after the
   * boot images.
   */
  executePayload?: Uint8Array
  executeEntryPoint?: number
}

export interface FlashOptions {
  chip?: Chip
  /** Fills the signature region of every message; defaults to {@link sbkSignerFor} for the chip. */
  signer?: MessageSigner
  /** Bulk-OUT chunk size for progress granularity. */
  usbChunkSize?: number
  /** Read the bootrom version during the context step. */
  queryVersion?: boolean
  onProgress?: (progress: FlashProgress) => void
}

export interface FlashResult {
  uid: Uint8Array<ArrayBuffer>
  bootRomVersion?: number
}

export class RcmFlasher {
  private readonly device: TegraDevice
  private readonly chip: Chip
  private readonly codec: RcmCodec
  private readonly signer: MessageSigner
  private readonly chunkSize: number
  private readonly queryVersionOnConnect: boolean
  private readonly onProgress?: (progress: FlashProgress) => void

  constructor(device: TegraDevice, options: FlashOptions = {}) {
    this.device = device
    this.chip = options.chip ?? Chip.T210
    this.codec = rcmCodecFor(this.chip)
    this.signer = options.signer ?? sbkSignerFor(this.chip)
    this.chunkSize = options.usbChunkSize ?? DEFAULT_USB_CHUNK
    this.queryVersionOnConnect = options.queryVersion ?? false
    if (options.onProgress) this.onProgress = options.onProgress
  }

  /** Run the full ordered flash flow. */
  async flash(pkg: TegraBootPackage): Promise<FlashResult> {
    const uid = await this.readContext()
    const result: FlashResult = { uid }

    if (this.queryVersionOnConnect) {
      result.bootRomVersion = await this.queryBootRomVersion()
    }

    const bcts = pkg.bcts ?? (pkg.bct ? [pkg.bct] : [])
    for (const bct of bcts) await this.programBct(bct)
    if (pkg.bootImages?.length) await this.streamBootImages(pkg.bootImages)

    if (pkg.executePayload) {
      await this.execute(pkg.executePayload, pkg.executeEntryPoint)
    }

    this.emit({ stage: 'finish' })
    return result
  }

  /** Read the chip UID the bootrom emits on the first bulk-IN packet. */
  async readContext(): Promise<Uint8Array<ArrayBuffer>> {
    this.emit({ stage: 'read-uid' })
    return this.device.readUid()
  }

  async queryBootRomVersion(): Promise<number> {
    this.emit({ stage: 'query-version' })
    await this.sendMessage(RcmOpcode.QueryBootRomVersion, new Uint8Array(0), 'query-version')
    return this.readStatus()
  }

  async programBct(bct: Uint8Array): Promise<void> {
    await this.sendMessage(RcmOpcode.ProgramBct, bct, 'program-bct')
    this.checkStatus(await this.readStatus(), 'program-bct')
  }

  /** Stream boot images / bootloader blocks in order, one RCM message each,
   * reporting cumulative progress across the whole set. */
  async streamBootImages(images: Uint8Array[]): Promise<void> {
    const totalBytes = images.reduce((sum, image) => sum + image.length, 0)
    let transferred = 0
    this.emit({ stage: 'stream-images', bytesTransferred: 0, totalBytes })

    const header = this.codec.payloadOffset
    for (const image of images) {
      const message = await this.signMessage(RcmOpcode.ProgramBootloader, image)
      // `sent` counts framed bytes (header + image + padding); subtract the
      // header so progress tracks image-payload bytes actually on the wire.
      await this.streamBulk(message, (sent) =>
        this.emit({
          stage: 'stream-images',
          bytesTransferred: transferred + Math.max(0, Math.min(sent - header, image.length)),
          totalBytes
        })
      )
      transferred += image.length
      this.checkStatus(await this.readStatus(), 'stream-images')
      this.emit({ stage: 'stream-images', bytesTransferred: transferred, totalBytes })
    }
  }

  /** Download-and-execute hand-off that starts the streamed bootloader. */
  async execute(payload: Uint8Array, entryPoint?: number): Promise<void> {
    const entry = entryPoint ?? chipProfile(this.chip).appletLoadAddress
    const message = await this.codec.build({
      opcode: RcmOpcode.DownloadExecute,
      payload,
      entryAddress: entry
    })
    await this.signer(message)
    await this.streamBulk(message, (sent) =>
      this.emit({ stage: 'execute', bytesTransferred: sent, totalBytes: message.length })
    )
    this.checkStatus(await this.readStatus(), 'execute')
  }

  private async signMessage(
    opcode: RcmOpcode,
    payload: Uint8Array
  ): Promise<Uint8Array<ArrayBuffer>> {
    const message = await this.codec.build({ opcode, payload })
    await this.signer(message)
    return message
  }

  private async sendMessage(
    opcode: RcmOpcode,
    payload: Uint8Array,
    stage: FlashStage
  ): Promise<void> {
    const message = await this.signMessage(opcode, payload)
    await this.streamBulk(message, (sent) =>
      this.emit({ stage, bytesTransferred: sent, totalBytes: message.length })
    )
  }

  private async streamBulk(
    data: Uint8Array<ArrayBuffer>,
    onChunk: (bytesSent: number) => void
  ): Promise<void> {
    let sent = 0
    while (sent < data.length) {
      const end = Math.min(sent + this.chunkSize, data.length)
      // `data` is a fresh, standalone framed message; a subarray view over it is
      // a valid BufferSource for transferOut — no per-chunk copy needed.
      await this.device.send(data.subarray(sent, end))
      sent = end
      onChunk(sent)
    }
  }

  private async readStatus(): Promise<number> {
    const reply = await this.device.receive(RCM_STATUS_LENGTH)
    if (reply.length < RCM_STATUS_LENGTH) {
      throw new RcmError(`short RCM status: ${reply.length} bytes`)
    }
    return readUint32LE(reply)
  }

  private checkStatus(status: number, stage: FlashStage): void {
    if (status !== 0) {
      throw new RcmError(`${stage} failed with RCM status 0x${status.toString(16)}`)
    }
  }

  private emit(progress: FlashProgress): void {
    this.onProgress?.(progress)
  }
}
