import { BctError } from '../errors'
import { sbkHash } from '../sign'

/**
 * Boot Configuration Table (BCT) serialization for T210.
 *
 * A BCT is a fixed-size, little-endian struct the bootrom reads to bring up
 * SDRAM and locate the bootloader. The offsets in {@link T210_BCT_LAYOUT} were
 * extracted from tegrabct's own field table (s_BctFields / NvBctT21xGetFieldTable)
 * and its signing manifest — see PROTOCOL.md.
 *
 * SDRAM and device-parameter register blocks are chip-board specific; this
 * module takes them pre-packed (compile a board `.cfg` with `parseSdramCfg`
 * from `../sdramCfg`) and positions them at the correct offset/stride. The
 * common real operation — patching bootloader-table entries into a board
 * template — is also supported directly.
 */

/**
 * Boot medium the BCT's device-parameter block is configured for
 * (NvBootDevType): SPI flash = 3, sdmmc/eMMC = 4, written at devTypeOffset
 * (per tegrabct `--updatedevparam`).
 */
export const BootMedium = {
  SpiFlash: 3,
  Sdmmc: 4
} as const
export type BootMedium = (typeof BootMedium)[keyof typeof BootMedium]

const BOOTLOADER_HASH_SIZE = 16

/**
 * One entry of the BCT bootloader table (NvBootLoaderInfo, 0x12c bytes on T210):
 * where a bootloader image lives on the boot medium and how to load it. The
 * seven u32 fields are followed by a 16-byte AES-CMAC and a 256-byte RSA-PSS
 * signature (the latter filled by the signing tool for PKC-fused devices).
 */
export interface BootLoaderInfo {
  version: number
  startBlock: number
  startPage: number
  length: number
  loadAddress: number
  entryPoint: number
  attribute: number
  /** 16-byte AES-CMAC over the bootloader image; zero-filled when omitted. */
  cryptoHash?: Uint8Array
}

/** One SDRAM controller parameter set (NvBootSdramParams), pre-packed from a
 * board `.cfg` (see `parseSdramCfg`). On T210 each set is up to
 * `sdramSetStride` bytes. */
export interface SdramParamSet {
  raw: Uint8Array
}

/** Boot-medium parameter block (NvBootDevParams), likewise pre-packed. */
export interface BootDeviceParamSet {
  medium: BootMedium
  raw: Uint8Array
}

export interface BctInput {
  bootDataVersion: number
  /** log2 of the boot-medium block size. */
  blockSizeLog2: number
  /** log2 of the boot-medium page size. */
  pageSizeLog2: number
  partitionSize: number
  odmData?: number
  secureDebugControl?: number
  /** 16-byte chip UID (ECID) read from the bootrom. */
  uniqueChipId?: Uint8Array
  bootDevice?: BootDeviceParamSet
  sdram?: SdramParamSet[]
  bootLoaders?: BootLoaderInfo[]
}

/** Field offsets and total size of a V1 BCT (T210 / T124). */
export interface BctLayout {
  size: number
  /** Signed/hashed region: [signedFrom, signedTo). */
  signedFrom: number
  signedTo: number
  cryptoHashOffset: number
  uniqueChipIdOffset: number
  bootDataVersionOffset: number
  blockSizeLog2Offset: number
  pageSizeLog2Offset: number
  partitionSizeOffset: number
  odmDataOffset: number
  secureDebugControlOffset: number
  devTypeOffset: number
  deviceParamsOffset: number
  numSdramSetsOffset: number
  sdramSetsOffset: number
  sdramSetStride: number
  maxSdramSets: number
  bootLoadersUsedOffset: number
  bootLoaderTableOffset: number
  bootLoaderInfoStride: number
  maxBootLoaders: number
  /**
   * Offset of the NumParamSets word in the BCT (written as 1 after SDRAM is
   * populated). Chip-specific: T210=0x540, T124=0x420.
   */
  numParamSetsOffset: number
  /**
   * Offset of the reserved pad byte written as 0x80 at the end of the BCT
   * signed region. T210 = size − 20, T124 = size − 2.
   */
  reservedPadOffset: number
  /**
   * Value written to the partitionSize field. T210 = 0x1000000 (16 MB),
   * T124 = 0x08000000 (128 MB).
   */
  partitionSize: number
}

/** T210 (chip 0x21) BCT layout — see PROTOCOL.md and tests/bct/v1.test.ts. */
export const T210_BCT_LAYOUT: BctLayout = {
  size: 0x2800,
  signedFrom: 0x510,
  signedTo: 0x2800,
  cryptoHashOffset: 0x00,
  uniqueChipIdOffset: 0x520,
  bootDataVersionOffset: 0x530,
  blockSizeLog2Offset: 0x534,
  pageSizeLog2Offset: 0x538,
  partitionSizeOffset: 0x53c,
  odmDataOffset: 0x508,
  secureDebugControlOffset: 0x27e4,
  devTypeOffset: 0x544,
  deviceParamsOffset: 0x548,
  numSdramSetsOffset: 0x588,
  sdramSetsOffset: 0x58c,
  sdramSetStride: 0x768,
  maxSdramSets: 4,
  bootLoadersUsedOffset: 0x232c,
  bootLoaderTableOffset: 0x2330,
  bootLoaderInfoStride: 0x12c,
  maxBootLoaders: 4,
  numParamSetsOffset: 0x540,
  reservedPadOffset: 0x2800 - 20, // 0x27ec
  partitionSize: 0x1000000
} as const

/**
 * T124 (chip 0x40, Tegra K1) BCT layout.
 *
 * Field offsets confirmed from bct_dump on an nvflash-generated golden BCT:
 *   Crypto offset  = 1712 = 0x6B0  (signed/hashed region starts here)
 *   Crypto length  = 6480 = 0x1950 (signed region ends at 0x2000 = BCT size)
 *   BootDataVersion (0x00400001) verified at 0x6D0
 *   BlockSizeLog2=14 at 0x6D4, PageSizeLog2=9 at 0x6D8, confirmed by bct_dump
 *   PartitionSize = 0x08000000 (128 MB), confirmed by bct_dump
 *   SDRAM set stride = 0x4D4 bytes (4 sets × 0x4D4 = 0x1350 from 0x7F8 to 0x1B48)
 *   bootLoadersUsed at 0x1B48 (4 sets × 0x4D4 past sdramSetsOffset)
 *   Pad marker (0x80) at offset 0x1FFE = size − 2
 *
 * All header fields are shifted by 0x1A0 relative to T210 (signedFrom delta).
 */
export const T124_BCT_LAYOUT: BctLayout = {
  size: 0x2000,
  signedFrom: 0x6b0,
  signedTo: 0x2000,
  cryptoHashOffset: 0x6b0,
  uniqueChipIdOffset: 0x6c0,
  bootDataVersionOffset: 0x6d0,
  blockSizeLog2Offset: 0x6d4,
  pageSizeLog2Offset: 0x6d8,
  partitionSizeOffset: 0x6dc,
  odmDataOffset: 0x6a8,
  secureDebugControlOffset: 0x1fe4,
  devTypeOffset: 0x6e4,
  deviceParamsOffset: 0x6f4,
  numSdramSetsOffset: 0x7f4,
  sdramSetsOffset: 0x7f8,
  sdramSetStride: 0x4d4,
  maxSdramSets: 4,
  bootLoadersUsedOffset: 0x1b48,
  bootLoaderTableOffset: 0x1b4c,
  bootLoaderInfoStride: 0x12c,
  maxBootLoaders: 4,
  numParamSetsOffset: 0x6e0,
  reservedPadOffset: 0x2000 - 2, // 0x1ffe — confirmed from golden BCT (bct_dump)
  partitionSize: 0x08000000 // 128 MB — confirmed by bct_dump PartitionSize
} as const

/**
 * T132 (Tegra K1 Denver) BCT layout.
 *
 * Inherits T124 fields, but introduces MTS structures and expands the BCT size
 * to 8704 bytes (0x2200).
 */
export const T132_BCT_LAYOUT: BctLayout = {
  size: 0x2200,
  signedFrom: 0x6b0,
  signedTo: 0x2200,
  cryptoHashOffset: 0x6b0,
  uniqueChipIdOffset: 0x6c0,
  bootDataVersionOffset: 0x6d0,
  blockSizeLog2Offset: 0x6d4,
  pageSizeLog2Offset: 0x6d8,
  partitionSizeOffset: 0x6dc,
  odmDataOffset: 0x6a8,
  secureDebugControlOffset: 0x21e4,
  devTypeOffset: 0x6e4,
  deviceParamsOffset: 0x6f4,
  numSdramSetsOffset: 0x7f4,
  sdramSetsOffset: 0x7f8,
  sdramSetStride: 0x4d4,
  maxSdramSets: 4,
  bootLoadersUsedOffset: 0x1b48,
  bootLoaderTableOffset: 0x1b4c,
  bootLoaderInfoStride: 0x12c,
  maxBootLoaders: 4,
  numParamSetsOffset: 0x6e0,
  reservedPadOffset: 0x2200 - 2, // 0x21fe
  partitionSize: 0x08000000
} as const

function setBlock(bct: Uint8Array, offset: number, block: Uint8Array, what: string): void {
  if (offset + block.length > bct.length) {
    throw new BctError(
      `${what} of ${block.length} bytes at 0x${offset.toString(16)} overflows the BCT`
    )
  }
  bct.set(block, offset)
}

function writeBootLoaderInfo(
  view: DataView,
  bct: Uint8Array,
  offset: number,
  info: BootLoaderInfo
): void {
  const words = [
    info.version,
    info.startBlock,
    info.startPage,
    info.length,
    info.loadAddress,
    info.entryPoint,
    info.attribute
  ]
  if (offset + words.length * 4 + BOOTLOADER_HASH_SIZE > bct.length) {
    throw new BctError(`bootloader info at 0x${offset.toString(16)} overflows the BCT`)
  }
  words.forEach((word, i) => view.setUint32(offset + i * 4, word >>> 0, true))

  if (info.cryptoHash) {
    if (info.cryptoHash.length !== BOOTLOADER_HASH_SIZE) {
      throw new BctError(`bootloader cryptoHash must be ${BOOTLOADER_HASH_SIZE} bytes`)
    }
    bct.set(info.cryptoHash, offset + words.length * 4)
  }
}

/**
 * Serialize structured configuration into a little-endian T210 BCT byte array.
 * When `template` is supplied it is copied in first (and sizes the buffer), then
 * the structured fields are patched over it; otherwise a zero buffer of
 * `layout.size` is used. Leaves the crypto hash zero — run {@link signBct}.
 */
export function serializeBct(
  input: BctInput,
  options: { template?: Uint8Array; layout?: BctLayout } = {}
): Uint8Array<ArrayBuffer> {
  const layout = options.layout ?? T210_BCT_LAYOUT
  if (options.template && options.template.length < layout.size) {
    throw new BctError(
      `template of ${options.template.length} bytes is smaller than the ${layout.size}-byte BCT`
    )
  }
  const size = options.template?.length ?? layout.size
  const bct = new Uint8Array(size)
  if (options.template) bct.set(options.template)

  const view = new DataView(bct.buffer)
  const u32 = (offset: number, value: number) => view.setUint32(offset, value >>> 0, true)

  u32(layout.bootDataVersionOffset, input.bootDataVersion)
  u32(layout.blockSizeLog2Offset, input.blockSizeLog2)
  u32(layout.pageSizeLog2Offset, input.pageSizeLog2)
  u32(layout.partitionSizeOffset, input.partitionSize)
  if (input.odmData !== undefined) u32(layout.odmDataOffset, input.odmData)
  if (input.secureDebugControl !== undefined) {
    u32(layout.secureDebugControlOffset, input.secureDebugControl)
  }

  if (input.uniqueChipId) {
    if (input.uniqueChipId.length !== 16) {
      throw new BctError(`uniqueChipId must be 16 bytes, got ${input.uniqueChipId.length}`)
    }
    setBlock(bct, layout.uniqueChipIdOffset, input.uniqueChipId, 'unique chip id')
  }

  if (input.bootDevice) {
    u32(layout.devTypeOffset, input.bootDevice.medium)
    setBlock(bct, layout.deviceParamsOffset, input.bootDevice.raw, 'boot device params')
  }

  let sdram = input.sdram ?? []
  if (sdram.length === 1 && layout.maxSdramSets > 1) {
    const first = sdram[0]!
    sdram = Array.from({ length: layout.maxSdramSets }, () => first)
  }
  if (sdram.length > layout.maxSdramSets) {
    throw new BctError(`too many SDRAM sets: ${sdram.length} > ${layout.maxSdramSets}`)
  }
  // tegrabct leaves NumSdramSets at 0 even with sets present (the bootrom
  // selects by strap/odmdata) — match it: place the data, don't write the count.
  sdram.forEach((set, i) => {
    if (set.raw.length > layout.sdramSetStride) {
      throw new BctError(`SDRAM set ${i} exceeds stride 0x${layout.sdramSetStride.toString(16)}`)
    }
    setBlock(bct, layout.sdramSetsOffset + i * layout.sdramSetStride, set.raw, `sdram set ${i}`)
  })

  const bootLoaders = input.bootLoaders ?? []
  if (bootLoaders.length > layout.maxBootLoaders) {
    throw new BctError(`too many bootloaders: ${bootLoaders.length} > ${layout.maxBootLoaders}`)
  }
  u32(layout.bootLoadersUsedOffset, bootLoaders.length)
  bootLoaders.forEach((info, i) =>
    writeBootLoaderInfo(
      view,
      bct,
      layout.bootLoaderTableOffset + i * layout.bootLoaderInfoStride,
      info
    )
  )

  return bct
}

/** Patch a single bootloader-table entry into an existing BCT in place. */
export function patchBootLoaderInfo(
  bct: Uint8Array<ArrayBuffer>,
  index: number,
  info: BootLoaderInfo,
  layout: BctLayout = T210_BCT_LAYOUT
): void {
  if (index >= layout.maxBootLoaders) {
    throw new BctError(`bootloader index ${index} exceeds max ${layout.maxBootLoaders}`)
  }
  const view = new DataView(bct.buffer, bct.byteOffset, bct.byteLength)
  writeBootLoaderInfo(
    view,
    bct,
    layout.bootLoaderTableOffset + index * layout.bootLoaderInfoStride,
    info
  )
}

/** The byte range the BCT crypto hash / signature covers: [signedFrom, signedTo). */
export function bctSignedRange(
  bct: Uint8Array<ArrayBuffer>,
  layout: BctLayout = T210_BCT_LAYOUT
): Uint8Array<ArrayBuffer> {
  // subarray() silently clamps out-of-range bounds; guard so a truncated BCT
  // can't be signed over a short range instead of failing loudly.
  if (bct.length < layout.signedTo) {
    throw new BctError(
      `BCT of ${bct.length} bytes is too short for its signed range ` +
        `[0x${layout.signedFrom.toString(16)}, 0x${layout.signedTo.toString(16)})`
    )
  }
  return bct.subarray(layout.signedFrom, layout.signedTo)
}

/**
 * Zero-key (SBK) sign a BCT: AES-CMAC over the signed range, written to the
 * crypto-hash field in place. Returns the 16-byte hash. For PKC-fused devices
 * substitute the RSA-PSS path from `sign.ts`.
 */
export async function signBct(
  bct: Uint8Array<ArrayBuffer>,
  layout: BctLayout = T210_BCT_LAYOUT
): Promise<Uint8Array<ArrayBuffer>> {
  const hash = await sbkHash(bctSignedRange(bct, layout))
  bct.set(hash, layout.cryptoHashOffset)
  return hash
}
