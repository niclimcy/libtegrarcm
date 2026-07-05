import {
  T124_SDRAM_CFG_LAYOUT,
  T186_SDRAM_CFG_LAYOUT,
  T210_SDRAM_CFG_LAYOUT,
  T234_SDRAM_CFG_LAYOUT,
  T264_SDRAM_CFG_LAYOUT,
  type SdramCfgLayout
} from './bct/sdramCfg'
import { T124_BCT_LAYOUT, T132_BCT_LAYOUT, T210_BCT_LAYOUT, type BctLayout } from './bct/v1'
import { T186_BR_BCT_LAYOUT, type BrBctLayout } from './bct/v2/brBct'
import { T186_MB1_BCT_LAYOUT, type Mb1BctLayout } from './bct/v2/mb1Bct'
import { T234_MB1_NV_HEADER_LAYOUT, type Mb1NvHeaderLayout } from './bct/v2/mb1NvHeader'
import { appletLoadAddress, Chip } from './constants'
import { RcmError } from './errors'
import {
  buildT124RcmMessage,
  buildT132RcmMessage,
  buildT186RcmMessage,
  buildT194RcmMessage,
  buildT210RcmMessage,
  buildT234RcmMessage,
  buildT264RcmMessage,
  T186_PAYLOAD_OFFSET,
  t186SecureRange,
  T194_PAYLOAD_OFFSET,
  t194SecureRange,
  t194WireOpcode,
  T210_PAYLOAD_OFFSET,
  t210SecureRange,
  T234_PAYLOAD_OFFSET,
  t234SecureRange,
  t234WireOpcode,
  T264_PAYLOAD_OFFSET,
  t264SecureRange,
  t264WireOpcode,
  type RcmMessageOptions
} from './rcm'

/**
 * Per-chip capability registry. Everything chip-specific the library knows —
 * RCM framing, BCT layouts, SDRAM cfg layout, applet load address — hangs off
 * one {@link ChipProfile}, so supporting a new chip is one registry entry plus
 * whatever family-specific packers it needs, not edits to scattered switch
 * statements. Layout data for a new chip comes out of its flash package's own
 * binaries (tools/extract-chip-tables.ts + `sdramCfgLayoutFromTable`).
 */

/** RCM message framing for one chip family. `build` takes logical
 * {@link RcmOpcode}s and writes the chip's wire encoding; it may be async
 * (T194's layout embeds SHA-256 digests computed via WebCrypto). */
export interface RcmCodec {
  build: (options: RcmMessageOptions) => Uint8Array<ArrayBuffer> | Promise<Uint8Array<ArrayBuffer>>
  secureRange: (message: Uint8Array) => Uint8Array
  /** Header size = byte offset of the payload within a built frame. */
  payloadOffset: number
}

export interface ChipProfile {
  chip: Chip
  name: string
  /** BCT/tool generation: v1 = tegrabct (flat BCT), v2 = tegrabct_v2 (BR+MB1). */
  family: 'v1' | 'v2'
  /** Bootrom applet load address substituted for a zero entry point. */
  appletLoadAddress: number
  /** RCM message framing; absent = not implemented for this chip yet. */
  rcm?: RcmCodec
  /** SDRAM `.cfg` packing layout (`parseSdramCfg`). */
  sdramCfg?: SdramCfgLayout
  /** v1 flat BCT layout (`serializeBct`). */
  bct?: BctLayout
  /** v2 BR-BCT layout (`patchBrBctOdmData`). */
  brBct?: BrBctLayout
  /** v2 MB1-BCT layout (`patchMb1BctSdram`, fragment packers). */
  mb1Bct?: Mb1BctLayout
  /** T234/T264 MB1 NV header wrapper (`parseMb1NvHeader`) — a different,
   * smaller structure than `mb1Bct`: just the fixed-size prefix
   * `tegrahost_v2 --addmb1nvheader` puts around an image, not a
   * self-contained SDRAM-bearing BCT. */
  mb1NvHeader?: Mb1NvHeaderLayout
}

const T124_RCM_CODEC: RcmCodec = {
  build: buildT124RcmMessage,
  secureRange: t210SecureRange,
  payloadOffset: T210_PAYLOAD_OFFSET
}

const T132_RCM_CODEC: RcmCodec = {
  build: buildT132RcmMessage,
  secureRange: t210SecureRange,
  payloadOffset: T210_PAYLOAD_OFFSET
}

const T210_RCM_CODEC: RcmCodec = {
  build: buildT210RcmMessage,
  secureRange: t210SecureRange,
  payloadOffset: T210_PAYLOAD_OFFSET
}

/** T186 v2 RCM framing (0x520 secure base). */
const T186_RCM_CODEC: RcmCodec = {
  build: buildT186RcmMessage,
  secureRange: t186SecureRange,
  payloadOffset: T186_PAYLOAD_OFFSET
}

/** T194 v2 RCM framing — its own larger layout (payload @0x7b0, 256-byte
 * signed secure header, embedded SHA-256 digests). Only the two opcodes with
 * known wire values build (download-and-execute = 5, version query = 7); the
 * program-bct/bootloader stages have no known T194 wire opcodes and throw —
 * the real `tegrarcm_v2 --chip 0x19` flow only ever sends those two messages
 * and hands the rest of flashing to the downloaded applet. See PROTOCOL.md. */
const T194_RCM_CODEC: RcmCodec = {
  build: (options) =>
    buildT194RcmMessage({
      opcode: t194WireOpcode(options.opcode),
      payload: options.payload,
      ...(options.entryAddress !== undefined && { entryAddress: options.entryAddress })
    }),
  secureRange: t194SecureRange,
  payloadOffset: T194_PAYLOAD_OFFSET
}

const T234_RCM_CODEC: RcmCodec = {
  build: (options) =>
    buildT234RcmMessage({
      opcode: t234WireOpcode(options.opcode),
      payload: options.payload,
      ...(options.entryAddress !== undefined && { entryAddress: options.entryAddress })
    }),
  secureRange: t234SecureRange,
  payloadOffset: T234_PAYLOAD_OFFSET
}

const T264_RCM_CODEC: RcmCodec = {
  build: (options) =>
    buildT264RcmMessage({
      opcode: t264WireOpcode(options.opcode),
      payload: options.payload,
      ...(options.entryAddress !== undefined && { entryAddress: options.entryAddress })
    }),
  secureRange: t264SecureRange,
  payloadOffset: T264_PAYLOAD_OFFSET
}

const profile = (p: ChipProfile): ChipProfile => p

/**
 * Every chip the library knows about. Entries without an `rcm` codec
 * (T234/T264 have no host-buildable RCM frame — see PROTOCOL.md) are
 * recognized but rejected by {@link RcmFlasher} rather than silently
 * mis-framed.
 */
export const CHIP_PROFILES: Readonly<Record<Chip, ChipProfile>> = {
  [Chip.T124]: profile({
    chip: Chip.T124,
    name: 'T124',
    family: 'v1',
    appletLoadAddress: appletLoadAddress(Chip.T124),
    rcm: T124_RCM_CODEC,
    sdramCfg: T124_SDRAM_CFG_LAYOUT,
    bct: T124_BCT_LAYOUT
  }),
  [Chip.T132]: profile({
    chip: Chip.T132,
    name: 'T132',
    family: 'v1',
    appletLoadAddress: appletLoadAddress(Chip.T132),
    rcm: T132_RCM_CODEC,
    sdramCfg: T124_SDRAM_CFG_LAYOUT,
    bct: T132_BCT_LAYOUT
  }),
  [Chip.T210]: profile({
    chip: Chip.T210,
    name: 'T210',
    family: 'v1',
    appletLoadAddress: appletLoadAddress(Chip.T210),
    rcm: T210_RCM_CODEC,
    sdramCfg: T210_SDRAM_CFG_LAYOUT,
    bct: T210_BCT_LAYOUT
  }),
  [Chip.T186]: profile({
    chip: Chip.T186,
    name: 'T186',
    family: 'v2',
    appletLoadAddress: appletLoadAddress(Chip.T186),
    rcm: T186_RCM_CODEC,
    sdramCfg: T186_SDRAM_CFG_LAYOUT,
    brBct: T186_BR_BCT_LAYOUT,
    mb1Bct: T186_MB1_BCT_LAYOUT
  }),
  [Chip.T194]: profile({
    chip: Chip.T194,
    name: 'T194',
    family: 'v2',
    appletLoadAddress: appletLoadAddress(Chip.T194),
    rcm: T194_RCM_CODEC
  }),
  [Chip.T234]: profile({
    chip: Chip.T234,
    name: 'T234',
    family: 'v2',
    appletLoadAddress: appletLoadAddress(Chip.T234),
    rcm: T234_RCM_CODEC,
    sdramCfg: T234_SDRAM_CFG_LAYOUT,
    mb1NvHeader: T234_MB1_NV_HEADER_LAYOUT
  }),
  [Chip.T264]: profile({
    chip: Chip.T264,
    name: 'T264',
    family: 'v2',
    appletLoadAddress: appletLoadAddress(Chip.T264),
    rcm: T264_RCM_CODEC,
    sdramCfg: T264_SDRAM_CFG_LAYOUT,
    mb1NvHeader: T234_MB1_NV_HEADER_LAYOUT
  })
}

/** Look up a chip's profile; throws on an id the registry doesn't know. */
export function chipProfile(chip: Chip): ChipProfile {
  const found = CHIP_PROFILES[chip] as ChipProfile | undefined
  if (!found) throw new RcmError(`unknown chip 0x${chip.toString(16)}`)
  return found
}
