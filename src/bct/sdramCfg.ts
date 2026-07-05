import { BctError } from '../errors'

/**
 * SDRAM parameter `.cfg` parsing — the board memory config `tegrabct --bct`
 * (T210) / `tegrabct_v2 --sdram` (T186) compiles into the BCT's packed
 * NvBootSdramParams sets.
 *
 * The cfg is machine-generated (`t210_emc_reg_tool` / `t186_emc_reg_tool`) as
 * `SDRAM[<set>].<Field> = <value>;` lines listing every struct field in
 * declaration order, each a little-endian u32 — so a set packs as consecutive
 * u32s in file order. Verified byte-for-byte against the golden BCTs the real
 * tools produced from these same cfgs, and field-by-field against the tools'
 * own `s_SdramTable` name->offset parse tables (see PROTOCOL.md and
 * tools/extract-chip-tables.ts): 474 fields * 4 = 0x768 fills the T210 stride
 * exactly; T186 needs one reserved word (see {@link T186_SDRAM_CFG_LAYOUT}).
 */

/**
 * `NvBootMemoryType_*` token values, lifted from `s_NvBootMemoryTypeTable` in
 * the `tegrabct`/`tegrabct_v2` binaries (identical in both): the bootrom enum
 * is None=0, LpDdr2=1, Ddr3=2, LpDdr4=3, and the unsupported DDR-type tokens
 * collapse to 0. The table also accepts the unprefixed names.
 */
const MEMORY_TYPES: Record<string, number> = {
  None: 0,
  Ddr: 0,
  LpDdr: 0,
  Ddr2: 0,
  LpDdr2: 1,
  Ddr3: 2,
  LpDdr4: 3
}
const CFG_TOKENS = new Map<string, number>(
  Object.entries(MEMORY_TYPES).flatMap(([name, value]) => [
    [name, value],
    [`NvBootMemoryType_${name}`, value]
  ])
)

/** How a chip's packed NvBootSdramParams relates to its cfg field list. */
export interface SdramCfgLayout {
  /** Exact packed size of one set — the BCT's SDRAM set stride. */
  setSize: number
  /** Struct holes the cfg doesn't list: pad u32s inserted before the named field. */
  padWordsBefore?: Readonly<Record<string, number>>
  /**
   * Authoritative field-name -> byte-offset map, as extracted from the native
   * tool's own `s_SdramTable` (tools/extract-chip-tables.ts --fields-only).
   * When present, fields place by name — cfg order and `padWordsBefore` are
   * irrelevant, and unlisted reserved words simply stay zero.
   */
  offsets?: Readonly<Record<string, number>>
}

/** One chip record of `tools/extract-chip-tables.ts --fields-only` output
 * (staged in tests/golden/chiptables/*.json). */
export interface SdramFieldTable {
  chip: string
  structSize: number
  fields: Readonly<Record<string, number>>
}

/** Turn an extracted field table into a name-addressed {@link SdramCfgLayout} */
export function sdramCfgLayoutFromTable(table: SdramFieldTable): SdramCfgLayout {
  return { setSize: table.structSize, offsets: table.fields }
}

/** T124 (chip 0x40): the cfg's fields fill the 0x4d4 stride sequentially. */
export const T124_SDRAM_CFG_LAYOUT: SdramCfgLayout = { setSize: 0x4d4 } as const

/** T210 (chip 0x21): the cfg's 474 fields fill the 0x768 stride exactly. */
export const T210_SDRAM_CFG_LAYOUT: SdramCfgLayout = { setSize: 0x768 } as const

/**
 * T186 (chip 0x18): 1195 cfg fields plus one reserved u32 the cfg generator
 * never emits — a field tegrabct_v2's own `s_SdramTable` names `BCT_NA`, at
 * 0x106c between `McBypassSidInit` and `McSidStreamidOverrideConfigPtcr` —
 * fill the 0x12b0 stride. Every cfg field's packed offset matches that table
 * (extracted with tools/extract-chip-tables.ts) with this single pad.
 */
export const T186_SDRAM_CFG_LAYOUT: SdramCfgLayout = {
  setSize: 0x12b0,
  padWordsBefore: { McSidStreamidOverrideConfigPtcr: 1 }
} as const

/** T234 (chip 0x23): the cfg's 2357 fields fill the 0x24d4 stride exactly. */
export const T234_SDRAM_CFG_LAYOUT: SdramCfgLayout = { setSize: 0x24d4 } as const

/** T264 (chip 0x26): the cfg's 3210 fields fill the 0x3228 stride exactly. */
export const T264_SDRAM_CFG_LAYOUT: SdramCfgLayout = { setSize: 0x3228 } as const

function parseValue(token: string, line: string): number {
  if (/^0x[0-9a-fA-F]+$/.test(token)) return Number.parseInt(token, 16)
  if (/^\d+$/.test(token)) return Number.parseInt(token, 10)
  const value = CFG_TOKENS.get(token)
  if (value === undefined) throw new BctError(`unsupported SDRAM cfg value: ${line.trim()}`)
  return value
}

/**
 * Parse an SDRAM `.cfg` into one packed NvBootSdramParams blob per
 * `SDRAM[<set>]` (byte-identical to the native tools' BCT output), ready for
 * `serializeBct`'s `sdram` sets (T210) or `patchMb1BctSdram` (T186).
 */
export function parseSdramCfg(cfg: string, layout: SdramCfgLayout): Uint8Array<ArrayBuffer>[] {
  const sets: { name: string; value: number }[][] = []
  const re = /^\s*SDRAM\[(\d+)\]\.(\w+)\s*=\s*(\w+)\s*;/gm
  for (let m = re.exec(cfg); m; m = re.exec(cfg)) {
    ;(sets[Number(m[1])] ??= []).push({ name: m[2]!, value: parseValue(m[3]!, m[0]) })
  }
  if (sets.length === 0) throw new BctError('cfg has no SDRAM[<set>].<Field> lines')
  for (let i = 0; i < sets.length; i++) {
    if (sets[i] === undefined) throw new BctError(`cfg missing SDRAM set ${i}`)
  }

  // packing is order-based, so every set must list the same fields in the
  // same order (the generator always does)
  const fieldOrder = sets[0]?.map((f) => f.name).join('\n')
  sets.forEach((fields, i) => {
    if (fields.map((f) => f.name).join('\n') !== fieldOrder) {
      throw new BctError(`SDRAM set ${i} lists different fields than set 0`)
    }
  })

  return sets.map((fields, i) => {
    const raw = new Uint8Array(layout.setSize)
    const view = new DataView(raw.buffer)
    if (layout.offsets) {
      for (const { name, value } of fields) {
        const offset = layout.offsets[name]
        if (offset === undefined) {
          throw new BctError(`SDRAM set ${i}: field ${name} is not in this chip's layout`)
        }
        if (offset + 4 > layout.setSize) {
          throw new BctError(
            `SDRAM set ${i}: field ${name} at 0x${offset.toString(16)} overflows the ` +
              `0x${layout.setSize.toString(16)} stride`
          )
        }
        view.setUint32(offset, value >>> 0, true)
      }
      return raw
    }
    let offset = 0
    for (const { name, value } of fields) {
      offset += (layout.padWordsBefore?.[name] ?? 0) * 4
      if (offset + 4 > layout.setSize) {
        throw new BctError(`SDRAM set ${i} overflows the 0x${layout.setSize.toString(16)} stride`)
      }
      view.setUint32(offset, value >>> 0, true)
      offset += 4
    }
    if (offset !== layout.setSize) {
      throw new BctError(
        `SDRAM set ${i} packs to 0x${offset.toString(16)}, expected ` +
          `0x${layout.setSize.toString(16)} — cfg doesn't match this chip's layout`
      )
    }
    return raw
  })
}
