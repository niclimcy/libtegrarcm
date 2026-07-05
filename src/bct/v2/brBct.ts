import { BctError } from '../../errors'

/**
 * T186 (Jetson TX2) Bootrom BCT (BR-BCT). Unlike T210's single flat BCT, the
 * v2 tools split boot config into this small BR-BCT plus a much larger MB1-BCT
 * (see `mb1Bct.ts`), both assembled by the native `tegrabct_v2` — see
 * PROTOCOL.md.
 */

export interface BrBctLayout {
  size: number
  /** Signed/hashed region: [signedFrom, signedTo). Populated but, unlike
   * T210, not hashed by default flash.sh for zero-key devkits — see
   * PROTOCOL.md. */
  signedFrom: number
  signedTo: number
  odmDataOffset: number
}

/** T186 BR-BCT layout (chip 0x18, `tegrabct_v2 --brbct`). */
export const T186_BR_BCT_LAYOUT: BrBctLayout = {
  size: 0xe00,
  signedFrom: 0x680,
  signedTo: 0xe00,
  odmDataOffset: 0x678
} as const

/**
 * Patch the 32-bit ODM data field into an existing BR-BCT (produced by the
 * native `tegrabct_v2 --brbct`) in place.
 */
export function patchBrBctOdmData(
  brBct: Uint8Array<ArrayBuffer>,
  odmData: number,
  layout: BrBctLayout = T186_BR_BCT_LAYOUT
): void {
  if (brBct.length !== layout.size) {
    throw new BctError(`BR-BCT must be ${layout.size} bytes, got ${brBct.length}`)
  }
  const view = new DataView(brBct.buffer, brBct.byteOffset, brBct.byteLength)
  view.setUint32(layout.odmDataOffset, odmData >>> 0, true)
}

/**
 * Byte offsets within the BR-BCT that `tegrabct_v2 --brbct` populates from the
 * `--dev_param` (eMMC) cfg. The BR-BCT is otherwise all zeros for a zero-key
 * devkit (byte-identical P2771 vs P3636), so a complete BR-BCT is these
 * dev-param fields plus a handful of fixed init constants — see
 * {@link T186_BR_BCT_CONSTANTS} and PROTOCOL.md.
 */
const DEV_PARAM_OFFSETS = {
  blockSizeLog2: 0x6a4,
  pageSizeLog2: 0x6a8,
  partitionSize: 0x6ac,
  bootLoaderVersion: 0x6fc,
  bootLoaderEntryPoint: 0x70c,
  bootLoaderLoadAddress: 0x710
} as const

/**
 * Structural constants `tegrabct_v2` writes into a BR-BCT regardless of cfg
 * (empty `br_bct.cfg`): the total size, the eMMC dev-param header word, and two
 * fixed default blocks in the reserved region past the field table.
 */
const T186_BR_BCT_CONSTANTS: Readonly<Record<number, number[]>> = {
  0x6a0: [0x00180001], // eMMC NvBootDevParams header (chip 0x18, version 1)
  0xd44: [0x01010101, 0x01010100, 0x01010101, 0x00000101],
  0xd8c: [0x00000080]
} as const

/** T186 dev params compiled from the package's `emmc.cfg` (`--dev_param`). */
export interface T186DevParams {
  partitionSize: number
  blockSize: number
  pageSize: number
  bootLoader: { version: number; entryPoint: number; loadAddress: number }
}

function requireInt(cfg: string, key: string): number {
  const m = new RegExp(
    `^\\s*${key.replace(/[.[\]]/g, '\\$&')}\\s*=\\s*(0x[0-9a-fA-F]+|\\d+)`,
    'm'
  ).exec(cfg)
  if (!m?.[1]) throw new BctError(`emmc dev-param cfg missing ${key}`)
  return m[1].startsWith('0x') ? parseInt(m[1], 16) : parseInt(m[1], 10)
}

/** Parse the package's `emmc.cfg` (`tegrabct_v2 --dev_param`) into dev params. */
export function parseT186DevParams(cfg: string): T186DevParams {
  return {
    partitionSize: requireInt(cfg, 'PartitionSize'),
    blockSize: requireInt(cfg, 'BlockSize'),
    pageSize: requireInt(cfg, 'PageSize'),
    bootLoader: {
      version: requireInt(cfg, 'BootLoader[0].Version'),
      entryPoint: requireInt(cfg, 'BootLoader[0].EntryPoint'),
      loadAddress: requireInt(cfg, 'BootLoader[0].LoadAddress')
    }
  }
}

/** Exact power-of-two log2, or throw (block/page sizes must be powers of two). */
function log2Exact(value: number, what: string): number {
  if (value <= 0 || (value & (value - 1)) !== 0) {
    throw new BctError(`${what} must be a power of two, got ${value}`)
  }
  return Math.log2(value)
}

/**
 * Assemble a complete T186 BR-BCT (`tegrabct_v2 --brbct`), byte-exact to the
 * golden: dev params from `emmc.cfg`, the fixed init constants, and the ODM
 * data scalar. Everything else is zero for a zero-key devkit. See PROTOCOL.md.
 */
export function assembleBrBct(
  params: { devParams: T186DevParams; odmData?: number },
  layout: BrBctLayout = T186_BR_BCT_LAYOUT
): Uint8Array<ArrayBuffer> {
  const brBct = new Uint8Array(layout.size)
  const view = new DataView(brBct.buffer)
  view.setUint32(0, layout.size, true)

  for (const [offset, words] of Object.entries(T186_BR_BCT_CONSTANTS)) {
    words.forEach((word, i) => view.setUint32(Number(offset) + i * 4, word >>> 0, true))
  }

  const d = params.devParams
  view.setUint32(DEV_PARAM_OFFSETS.blockSizeLog2, log2Exact(d.blockSize, 'BlockSize'), true)
  view.setUint32(DEV_PARAM_OFFSETS.pageSizeLog2, log2Exact(d.pageSize, 'PageSize'), true)
  view.setUint32(DEV_PARAM_OFFSETS.partitionSize, d.partitionSize >>> 0, true)
  view.setUint32(DEV_PARAM_OFFSETS.bootLoaderVersion, d.bootLoader.version >>> 0, true)
  view.setUint32(DEV_PARAM_OFFSETS.bootLoaderEntryPoint, d.bootLoader.entryPoint >>> 0, true)
  view.setUint32(DEV_PARAM_OFFSETS.bootLoaderLoadAddress, d.bootLoader.loadAddress >>> 0, true)

  if (params.odmData) view.setUint32(layout.odmDataOffset, params.odmData >>> 0, true)
  return brBct
}
