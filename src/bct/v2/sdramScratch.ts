import { BctError } from '../../errors'

/**
 * T186 packed SDRAM boot-scratch — the `[0x5670, 0x7cc0)` region of the
 * MB1-BCT, four `0x994`-byte blocks (one per SDRAM param set). Each block is
 * the BR/SC7 warmboot scratch-register image `NvTegraT18xPackSdramParams`
 * bit-packs from one packed NvBootSdramParams set: the bootrom restores MC/EMC
 * from it on resume without re-reading the BCT. See PROTOCOL.md.
 *
 * The packer is data-driven from the tool's own logic (extracted by
 * `tools/extract-mb1-scratch.ts` into `data/t186SdramScratch.ts`): a
 * memory-type-specific hand-unrolled `prefix` followed by four generic
 * `controllerMaps`, applied in order. Both read a field from the SDRAM set and
 * merge it into a scratch register via a masked read-modify-write. Scratch
 * registers address a block through two windows; a dest outside both is
 * silently dropped (as in the tool).
 */

/** One source→scratch transform op, replayed in `tf` order after the read. */
export interface ScratchPrefixOp {
  /** Scratch register offset to update. */
  dest: number
  /** AND-mask applied to the current scratch word before the source is OR'd in. */
  keep: number
  /** Byte offset of the source field in the SDRAM set. */
  src: number
  /** Source read width in bytes (1, 2 or 4). */
  width: number
  /** Ordered source transforms: `['shll'|'shrl', bits]` or `['and', mask]`. */
  tf: [string, number][]
}

/** `[dest, srcMask, shift, srcOffset]` controller-map row (see {@link packSdramScratch}). */
export type ScratchMapRow = [number, number, number, number]

/** Windowed scratch-register ↔ block-offset mapping. */
export interface ScratchWindow {
  lo: number
  hi: number
  base: number
}

/** Everything needed to pack a scratch block (see `data/t186SdramScratch.ts`). */
export interface SdramScratchLayout {
  blockSize: number
  sdramSetSize: number
  window1: ScratchWindow
  window2: ScratchWindow
  prefix: ScratchPrefixOp[]
  controllerMaps: ScratchMapRow[][]
}

/** Map a scratch register offset to its block byte offset, or -1 if unstored. */
function blockOffset(reg: number, w1: ScratchWindow, w2: ScratchWindow): number {
  // unsigned 32-bit compares, exactly as the native helper's windowing
  const a = (reg - w1.lo) >>> 0
  if (a <= w1.hi - w1.lo) return w1.base + reg
  const d = (reg - w2.lo) >>> 0
  if (d <= w2.hi - w2.lo) return w2.base + d
  return -1
}

function readField(view: DataView, off: number, width: number): number {
  // DataView getters throw RangeError out-of-bounds — a bad extraction should
  // surface, not silently read 0
  if (width === 4) return view.getUint32(off, true)
  if (width === 2) return view.getUint16(off, true)
  if (width === 1) return view.getUint8(off)
  throw new BctError(`bad scratch source width ${width}`)
}

/**
 * A signed 16-bit shift, matching the controller-map encoding: a negative value
 * shifts right by its magnitude, a non-negative value shifts left. x86 masks the
 * shift count to 5 bits.
 */
function applyShift(value: number, shift16: number): number {
  if (shift16 & 0x8000) return value >>> (-shift16 & 0x1f)
  return (value << (shift16 & 0x1f)) >>> 0
}

/**
 * Pack one SDRAM param set into its `0x994`-byte boot-scratch block, byte-exact
 * to `tegrabct_v2`. `set` is one packed NvBootSdramParams instance
 * (`layout.sdramSetSize` bytes, from `parseSdramCfg`).
 */
export function packSdramScratch(
  set: Uint8Array,
  layout: SdramScratchLayout
): Uint8Array<ArrayBuffer> {
  if (set.length < layout.sdramSetSize) {
    throw new BctError(
      `SDRAM set is ${set.length} bytes, need ${layout.sdramSetSize} to pack scratch`
    )
  }
  const block = new Uint8Array(layout.blockSize)
  const blockView = new DataView(block.buffer)
  const setView = new DataView(set.buffer, set.byteOffset, set.byteLength)
  const { window1: w1, window2: w2 } = layout

  const readScratch = (reg: number): number | undefined => {
    const off = blockOffset(reg, w1, w2)
    return off < 0 ? undefined : blockView.getUint32(off, true)
  }
  const writeScratch = (reg: number, value: number): void => {
    const off = blockOffset(reg, w1, w2)
    if (off >= 0) blockView.setUint32(off, value >>> 0, true)
  }

  for (const op of layout.prefix) {
    const cur = readScratch(op.dest)
    if (cur === undefined) continue
    let v = readField(setView, op.src, op.width)
    for (const [kind, arg] of op.tf) {
      if (kind === 'shll') v = (v << arg) >>> 0
      else if (kind === 'shrl') v = v >>> arg
      else v &= arg // 'and'
    }
    writeScratch(op.dest, ((cur & op.keep) | v) >>> 0)
  }

  for (const rows of layout.controllerMaps) {
    for (const [dest, srcMask, shift, srcOff] of rows) {
      const cur = readScratch(dest)
      if (cur === undefined) continue
      const clearMask = applyShift(srcMask, shift)
      const orValue = applyShift(setView.getUint32(srcOff, true) & srcMask, shift)
      writeScratch(dest, ((cur & ~clearMask) | orValue) >>> 0)
    }
  }
  return block
}
