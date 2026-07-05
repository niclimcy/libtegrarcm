import { BctError } from '../../errors'
import { packSdramScratch, type SdramScratchLayout } from './sdramScratch'

/**
 * T186 MB1-BCT — the larger of the two v2 boot-config structures (see
 * `brBct.ts` for the BR-BCT). Assembled from six board `.cfg` fragments
 * (pinmux/scr/pad/pmic/brcommand/prod) by `tegrabct_v2 --mb1bct`. This module
 * covers the scalar header fields, the per-instance SDRAM section, and — via
 * the `parse*`/`packMb1Fragment` helpers below — assembly of the register-list
 * platform-config fragments (pinmux/pad/prod/scr); the command-block fragments
 * (pmic, brcommand) live in `pmic.ts`/`brCommand.ts`. See PROTOCOL.md.
 */

export interface Mb1BctLayout {
  sizeOffset: number
  versionOffset: number
  sdramSetsOffset: number
  sdramSetStride: number
  maxSdramSets: number
}

/**
 * T186 MB1-BCT layout (chip 0x18, `tegrabct_v2 --mb1bct`). The trailing
 * platform-config region (pinmux/scr/pad/pmic/brcommand/prod) that follows
 * the SDRAM section is a run of back-to-back `{version, count, entries}`
 * blocks; `misc` maps to the board-invariant header, not a fragment — see
 * PROTOCOL.md.
 */
export const T186_MB1_BCT_LAYOUT: Mb1BctLayout = {
  sizeOffset: 0x0,
  versionOffset: 0x4,
  sdramSetsOffset: 0xbb0,
  sdramSetStride: 0x12b0,
  maxSdramSets: 4
} as const

/** One pre-packed SDRAM parameter instance, board-specific — compiled from
 * the board `.cfg` by `parseSdramCfg` (or lifted from native `tegrabct_v2
 * --sdram` output). */
export interface Mb1SdramSet {
  raw: Uint8Array
}

/** Total BCT size the MB1-BCT header reports for itself. */
export function mb1BctSize(
  mb1Bct: Uint8Array<ArrayBuffer>,
  layout: Mb1BctLayout = T186_MB1_BCT_LAYOUT
): number {
  return new DataView(mb1Bct.buffer, mb1Bct.byteOffset, mb1Bct.byteLength).getUint32(
    layout.sizeOffset,
    true
  )
}

/** MB1-BCT format version (`0xf` for known tegrabct_v2 builds). */
export function mb1BctVersion(
  mb1Bct: Uint8Array<ArrayBuffer>,
  layout: Mb1BctLayout = T186_MB1_BCT_LAYOUT
): number {
  return new DataView(mb1Bct.buffer, mb1Bct.byteOffset, mb1Bct.byteLength).getUint32(
    layout.versionOffset,
    true
  )
}

/**
 * Patch pre-packed SDRAM instances into an existing MB1-BCT (produced by the
 * native `tegrabct_v2` tool) in place. Each instance occupies
 * `sdramSetStride` bytes; bytes beyond the trailing platform-config region
 * start are left untouched.
 */
export function patchMb1BctSdram(
  mb1Bct: Uint8Array<ArrayBuffer>,
  sets: Mb1SdramSet[],
  layout: Mb1BctLayout = T186_MB1_BCT_LAYOUT
): void {
  if (sets.length > layout.maxSdramSets) {
    throw new BctError(`too many SDRAM sets: ${sets.length} > ${layout.maxSdramSets}`)
  }
  sets.forEach((set, i) => {
    if (set.raw.length > layout.sdramSetStride) {
      throw new BctError(`SDRAM set ${i} exceeds stride 0x${layout.sdramSetStride.toString(16)}`)
    }
    const offset = layout.sdramSetsOffset + i * layout.sdramSetStride
    if (offset + set.raw.length > mb1Bct.length) {
      throw new BctError(`SDRAM set ${i} at 0x${offset.toString(16)} overflows the MB1-BCT`)
    }
    mb1Bct.set(set.raw, offset)
  })
}

/**
 * A parsed MB1-BCT platform-config fragment. In the MB1-BCT these are packed
 * back-to-back as `[version u32][count u32][rows…]` (little-endian), each row a
 * fixed number of u32 words. `version` = `(major << 16) | minor` from the cfg.
 */
export interface Mb1Fragment {
  major: number
  minor: number
  /** Register rows: [addr, value] for pinmux/pad, [addr, mask, value] for prod. */
  rows: number[][]
}

function parseFragmentVersion(cfg: string, ns: string): { major: number; minor: number } {
  const major = new RegExp(`${ns}\\.major\\s*=\\s*(\\d+)`).exec(cfg)
  const minor = new RegExp(`${ns}\\.minor\\s*=\\s*(\\d+)`).exec(cfg)
  if (!major?.[1] || !minor?.[1]) throw new BctError(`${ns} cfg missing major/minor`)
  return { major: Number(major[1]), minor: Number(minor[1]) }
}

/** Parse a required capture group as `radix`, or throw on a malformed line. */
function group(match: RegExpExecArray, index: number, radix: number): number {
  const value = match[index]
  if (value === undefined) throw new BctError('malformed cfg register line')
  return parseInt(value, radix)
}

/**
 * Parse a pinmux/pad-style register cfg — `<ns>.0xADDR = 0xVALUE;` lines plus
 * `<ns>.major`/`.minor`. `ns` is `pinmux` for a pinmux cfg, `pmc` for a pad cfg.
 * Rows are `[addr, value]`.
 */
export function parseRegisterPairs(cfg: string, ns: string): Mb1Fragment {
  const { major, minor } = parseFragmentVersion(cfg, ns)
  const rows: number[][] = []
  const re = new RegExp(`^\\s*${ns}\\.(0x[0-9a-fA-F]+)\\s*=\\s*(0x[0-9a-fA-F]+)`, 'gm')
  for (let m = re.exec(cfg); m; m = re.exec(cfg)) {
    rows.push([group(m, 1, 16), group(m, 2, 16)])
  }
  if (rows.length === 0) throw new BctError(`${ns} cfg has no register rows`)
  return { major, minor, rows }
}

/**
 * Parse a prod-style register cfg — `prod.0xADDR.0xMASK = 0xVALUE;` lines plus
 * `prod.major`/`.minor`. Rows are `[addr, mask, value]`.
 */
export function parseRegisterTriples(cfg: string, ns = 'prod'): Mb1Fragment {
  const { major, minor } = parseFragmentVersion(cfg, ns)
  const rows: number[][] = []
  const re = new RegExp(
    `^\\s*${ns}\\.(0x[0-9a-fA-F]+)\\.(0x[0-9a-fA-F]+)\\s*=\\s*(0x[0-9a-fA-F]+)`,
    'gm'
  )
  for (let m = re.exec(cfg); m; m = re.exec(cfg)) {
    rows.push([group(m, 1, 16), group(m, 2, 16), group(m, 3, 16)])
  }
  if (rows.length === 0) throw new BctError(`${ns} cfg has no register rows`)
  return { major, minor, rows }
}

/**
 * Parse an scr (security config register) cfg — `scr.<index>.<m> = 0xVALUE;`.
 * The values pack densely indexed by `<index>` (0..count-1); rows are `[value]`.
 *
 * NOTE: this returns only the value array (the `[0x88f0, 0xb5f0)` portion of the
 * scr fragment). The `<m>` suffix is *also* packed — as a 2-bit-per-entry code
 * array at the fragment's tail — so a byte-exact scr fragment needs
 * {@link parseScrFragment}/{@link packScrFragment}, not `packMb1Fragment`.
 */
export function parseScrCfg(cfg: string): Mb1Fragment {
  const { values, major, minor } = parseScrFragment(cfg)
  return { major, minor, rows: values.map((v) => [v]) }
}

/** An scr fragment: a dense value array plus the per-entry 2-bit `<m>` codes. */
export interface ScrFragment {
  major: number
  minor: number
  values: number[]
  /** One 2-bit code per value, in index order (the `<m>` suffix of each line). */
  codes: number[]
}

/**
 * Parse an scr cfg into its value array and the per-entry `<m>` codes. Unlike
 * the other fragments the scr block is `[version][count][values…][2-bit codes]`:
 * the `<m>` in `scr.<index>.<m>` is a 2-bit code packed little-endian at the
 * tail (`⌈count/4⌉` bytes), not unused metadata — see PROTOCOL.md.
 */
export function parseScrFragment(cfg: string): ScrFragment {
  const { major, minor } = parseFragmentVersion(cfg, 'scr')
  const byIndex = new Map<number, { value: number; code: number }>()
  const re = /^\s*scr\.(\d+)\.(\d+)\s*=\s*(0x[0-9a-fA-F]+)/gm
  for (let m = re.exec(cfg); m; m = re.exec(cfg)) {
    byIndex.set(group(m, 1, 10), { code: group(m, 2, 10), value: group(m, 3, 16) })
  }
  // a namespace/format mismatch matches major/minor but no scr.<n>.<m> lines;
  // guard so a wrong file never silently yields an empty (count 0) fragment
  if (byIndex.size === 0) throw new BctError('scr cfg has no register rows')
  const values: number[] = []
  const codes: number[] = []
  for (let i = 0; i < byIndex.size; i++) {
    const entry = byIndex.get(i)
    if (entry === undefined) throw new BctError(`scr cfg missing index ${i}`)
    if (entry.code > 3) throw new BctError(`scr index ${i} code ${entry.code} exceeds 2 bits`)
    values.push(entry.value)
    codes.push(entry.code)
  }
  return { major, minor, values, codes }
}

/**
 * Serialize an scr fragment: `[version u32][count u32][values u32…][2-bit codes]`,
 * the codes packed 4-per-byte little-endian, tail zero-padded to a byte.
 */
export function packScrFragment(fragment: ScrFragment): Uint8Array<ArrayBuffer> {
  const count = fragment.values.length
  const codeBytes = Math.ceil(count / 4)
  const bytes = new Uint8Array(8 + count * 4 + codeBytes)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, ((fragment.major << 16) | fragment.minor) >>> 0, true)
  view.setUint32(4, count, true)
  fragment.values.forEach((v, i) => view.setUint32(8 + i * 4, v >>> 0, true))
  const tail = 8 + count * 4
  fragment.codes.forEach((code, i) => {
    if (code < 0 || code > 3) throw new BctError(`scr code ${code} at index ${i} exceeds 2 bits`)
    const at = tail + (i >> 2)
    view.setUint8(at, view.getUint8(at) | (code << ((i & 3) * 2)))
  })
  return bytes
}

/**
 * Serialize a fragment to its MB1-BCT block: `[version u32][count u32][rows…]`,
 * little-endian, `version = (major << 16) | minor`.
 */
export function packMb1Fragment(fragment: Mb1Fragment): Uint8Array<ArrayBuffer> {
  const width = fragment.rows[0]?.length ?? 0
  const bytes = new Uint8Array(8 + fragment.rows.length * width * 4)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, ((fragment.major << 16) | fragment.minor) >>> 0, true)
  view.setUint32(4, fragment.rows.length, true)
  let offset = 8
  for (const row of fragment.rows) {
    if (row.length !== width) throw new BctError('fragment rows must be uniform width')
    for (const word of row) {
      view.setUint32(offset, word >>> 0, true)
      offset += 4
    }
  }
  return bytes
}

/**
 * Fixed region offsets used by {@link assembleMb1Bct}, from the T186 golden
 * map (see PROTOCOL.md "MB1-BCT"). All board-invariant — only the total size
 * and the per-set contents vary.
 */
export const T186_MB1_BCT_ASSEMBLY = {
  headerSize: 0xbb0,
  sdramSetsOffset: 0xbb0,
  sdramSetStride: 0x12b0,
  scratchOffset: 0x5670,
  scratchStride: 0x994,
  sdramSets: 4,
  directoryOffset: 0x7cc0,
  fragmentBase: 0x7d18
} as const

/**
 * The six platform-config fragments, pre-packed to their MB1-BCT block bytes
 * (`packMb1Fragment` / {@link packScrFragment} / `packPmicFragment` /
 * `packBrCommandFragment`). Physical on-disk order is the field order here;
 * the fragment directory records them in a different (type) slot order.
 */
export interface Mb1Fragments {
  pinmux: Uint8Array
  scr: Uint8Array
  pad: Uint8Array
  pmic: Uint8Array
  brcommand: Uint8Array
  prod: Uint8Array
}

/** Inputs to {@link assembleMb1Bct}. */
export interface Mb1BctParts {
  /** The `[0, headerSize)` template; the total-size field @0 is overwritten. */
  header: Uint8Array
  /** Packed NvBootSdramParams sets (`sdramSetStride` bytes each), 1..4. */
  sdramSets: Uint8Array[]
  /** Layout for {@link packSdramScratch} (`data/t186SdramScratch.ts`). */
  scratchLayout: SdramScratchLayout
  fragments: Mb1Fragments
}

/**
 * Assemble a complete, byte-exact T186 MB1-BCT: header template, SDRAM param
 * sets, the per-set packed boot-scratch, the fragment directory, and the six
 * platform-config fragments concatenated in physical order. Reproduces
 * `tegrabct_v2 --mb1bct` output. See PROTOCOL.md for the region map.
 */
export function assembleMb1Bct(parts: Mb1BctParts): Uint8Array<ArrayBuffer> {
  const L = T186_MB1_BCT_ASSEMBLY
  const { header, sdramSets, scratchLayout, fragments } = parts
  if (header.length < L.headerSize) {
    throw new BctError(`MB1-BCT header template is ${header.length} bytes, need ${L.headerSize}`)
  }
  if (sdramSets.length === 0 || sdramSets.length > L.sdramSets) {
    throw new BctError(`MB1-BCT needs 1..${L.sdramSets} SDRAM sets, got ${sdramSets.length}`)
  }

  // physical order (matches the offset fields the directory records)
  const physical = [
    fragments.pinmux,
    fragments.scr,
    fragments.pad,
    fragments.pmic,
    fragments.brcommand,
    fragments.prod
  ]
  const fragmentsSize = physical.reduce((total, f) => total + f.length, 0)
  const total = L.fragmentBase + fragmentsSize

  const out = new Uint8Array(total)
  out.set(header.subarray(0, L.headerSize), 0)

  sdramSets.forEach((set, i) => {
    if (set.length !== L.sdramSetStride) {
      throw new BctError(`SDRAM set ${i} is ${set.length} bytes, need ${L.sdramSetStride}`)
    }
    out.set(set, L.sdramSetsOffset + i * L.sdramSetStride)
    out.set(packSdramScratch(set, scratchLayout), L.scratchOffset + i * L.scratchStride)
  })

  // place fragments and remember each one's offset (from fragmentBase) + size
  const placed = new Map<Uint8Array, { offset: number; size: number }>()
  let cursor = L.fragmentBase
  for (const frag of physical) {
    out.set(frag, cursor)
    placed.set(frag, { offset: cursor - L.fragmentBase, size: frag.length })
    cursor += frag.length
  }

  // fragment directory (field id 0x50): type=2, count=10, then 10 slots in
  // fixed *type* order — pinmux, scr, pad, brcommand, pmic, prod, then 4 empty
  const view = new DataView(out.buffer)
  view.setUint16(L.directoryOffset, 2, true)
  view.setUint32(L.directoryOffset + 4, 10, true)
  const slotOrder = [
    fragments.pinmux,
    fragments.scr,
    fragments.pad,
    fragments.brcommand,
    fragments.pmic,
    fragments.prod
  ]
  slotOrder.forEach((frag, i) => {
    const at = L.directoryOffset + 8 + i * 8
    const info = placed.get(frag)
    if (info === undefined) throw new BctError('fragment missing from placement map')
    view.setUint32(at, info.offset, true)
    view.setUint32(at + 4, info.size, true)
  })

  view.setUint32(0, total, true) // self-reported total size
  return out
}
