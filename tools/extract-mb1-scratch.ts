#!/usr/bin/env node
/**
 * Extract the T186 packed-SDRAM-scratch layout from `tegrabct_v2` and emit the
 * `src/bct/v2/data/t186SdramScratch.ts` data module (and, with `--json`, the
 * raw fixture). The scratch region `[0x5670, 0x7cc0)` of the MB1-BCT is four
 * `0x994`-byte blocks bit-packed from each SDRAM param set by
 * `NvTegraT18xPackSdramParams`: a memory-type-specific hand-unrolled prefix
 * plus four generic controller-map tables. See PROTOCOL.md and
 * `src/bct/v2/sdramScratch.ts`.
 *
 * The controller-map tables are `{u16 dest, u16 pad, u32 srcMask, i16 shift,
 * u16 srcOff}` rows at fixed `.text` displacements from the function's PIC
 * base; the prefix is parsed from the disassembly of the LpDdr4/LpDdr2 branch
 * into normalized read-modify-write ops. Both are validated by the byte-exact
 * `tests/bct/v2/sdramScratch.test.ts`.
 *
 * Usage:
 *   node tools/extract-mb1-scratch.ts <tegrabct_v2> > src/bct/v2/data/t186SdramScratch.ts
 *   node tools/extract-mb1-scratch.ts --json <tegrabct_v2>   # raw fixture JSON
 *
 * The parse constants below (PIC base, group displacements/counts, the prefix
 * instruction window) are specific to the R32-era `tegrabct_v2` this project
 * targets; a different build needs them re-derived (symbol
 * `NvTegraT18xPackSdramParams`).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// PIC base = call-site + add-immediate at the function prologue; group tables
// live at these signed displacements with these row counts. Windows map a
// scratch register offset to a block byte offset (see sdramScratch.ts).
const PIC_BASE = 0x81452d4
const GROUPS: [number, number][] = [
  [-0x60e38, 1665],
  [-0x5c02c, 654],
  [-0x5a184, 1],
  [-0x5a178, 27]
]
const PREFIX_START = 0x8057da2
const PREFIX_END = 0x805818a
const BLOCK_SIZE = 0x994
const SDRAM_SET_SIZE = 0x12b0

interface Section {
  addr: number
  offset: number
  size: number
}

class Elf32 {
  readonly data: Buffer
  readonly view: DataView
  readonly sections: Section[] = []
  constructor(path: string) {
    this.data = readFileSync(path)
    this.view = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength)
    const shoff = this.view.getUint32(0x20, true)
    const shentsize = this.view.getUint16(0x2e, true)
    const shnum = this.view.getUint16(0x30, true)
    for (let i = 0; i < shnum; i++) {
      const at = shoff + i * shentsize
      this.sections.push({
        addr: this.view.getUint32(at + 12, true),
        offset: this.view.getUint32(at + 16, true),
        size: this.view.getUint32(at + 20, true)
      })
    }
  }
  v2o(vaddr: number): number {
    for (const s of this.sections) {
      if (s.addr && s.addr <= vaddr && vaddr < s.addr + s.size) return s.offset + (vaddr - s.addr)
    }
    throw new Error(`vaddr 0x${vaddr.toString(16)} not mapped`)
  }
}

/** `[dest, srcMask, shift, srcOff]` rows for one controller-map group. */
function readGroup(elf: Elf32, vaddr: number, count: number): number[][] {
  const rows: number[][] = []
  for (let i = 0; i < count; i++) {
    const o = elf.v2o(vaddr + i * 12)
    rows.push([
      elf.view.getUint16(o, true),
      elf.view.getUint32(o + 4, true),
      elf.view.getUint16(o + 8, true),
      elf.view.getUint16(o + 10, true)
    ])
  }
  return rows
}

interface PrefixOp {
  dest: number
  keep: number
  src: number
  width: number
  tf: [string, number][]
}

/** Parse the hand-unrolled prefix from objdump into normalized RMW ops. */
function readPrefix(path: string): PrefixOp[] {
  const asm = execFileSync('objdump', [
    '-d',
    `--start-address=0x${PREFIX_START.toString(16)}`,
    `--stop-address=0x${PREFIX_END.toString(16)}`,
    path
  ]).toString()
  const insns: [string, string][] = []
  for (const line of asm.split('\n')) {
    const m = /^\s*[0-9a-f]+:\s+(?:[0-9a-f]{2} )+\s*\t(\w+)\s*(.*)/.exec(line)
    if (m) insns.push([m[1]!, (m[2] ?? '').split('#')[0]!.trim()])
  }
  // split into groups terminated by the write helper call
  const groups: [string, string][][] = []
  let cur: [string, string][] = []
  for (const [mn, op] of insns) {
    cur.push([mn, op])
    if (mn === 'calll' && op.includes('8057832')) {
      groups.push(cur)
      cur = []
    }
  }
  const imm = (s: string): number => parseInt(s.split(',')[0]!.trim().replace(/^\$/, ''), 16) >>> 0
  const ops: PrefixOp[] = []
  for (const g of groups) {
    let dest = 0
    for (const [mn, op] of g) {
      if (mn === 'movl' && op.startsWith('$0x') && op.endsWith('%edx')) {
        dest = imm(op)
        break
      }
    }
    let keep = 0xffffffff
    let src: number | undefined
    let width = 4
    const tf: [string, number][] = []
    let seenSrc = false
    for (const [mn, op] of g) {
      if (mn === 'calll') continue
      const parts = op.split(',').map((p) => p.trim())
      const srcMem = /^(0x[0-9a-f]+)\(%esi\)$/.exec(parts[0] ?? '')
      if ((mn === 'movl' || mn === 'movzwl' || mn === 'movzbl') && srcMem) {
        src = parseInt(srcMem[1]!, 16)
        width = mn === 'movl' ? 4 : mn === 'movzwl' ? 2 : 1
        seenSrc = true
      } else if (!seenSrc && mn === 'andl' && parts[0]!.startsWith('$') && /%e(ax|bp)$/.test(op)) {
        keep &= imm(op)
      } else if (!seenSrc && mn === 'andb' && parts.at(-1) === '%al') {
        keep &= 0xffffff00 | imm(op)
      } else if (!seenSrc && mn === 'andb' && parts.at(-1) === '%ah') {
        keep &= 0xffff00ff | (imm(op) << 8)
      } else if (!seenSrc && mn === 'xorb' && op === '%al, %al') {
        keep &= 0xffffff00
      } else if (!seenSrc && mn === 'xorb' && op === '%ah, %ah') {
        keep &= 0xffff00ff
      } else if (seenSrc && (mn === 'shll' || mn === 'shrl')) {
        tf.push([mn, imm(op) & 0x1f])
      } else if (seenSrc && mn === 'andl' && parts[0]!.startsWith('$')) {
        tf.push(['and', imm(op)])
      }
    }
    // direct-copy group: source loaded whole, no mask ops → full overwrite
    if (tf.length === 0 && keep === 0xffffffff && src !== undefined) keep = 0
    ops.push({ dest, keep: keep >>> 0, src: src ?? 0, width, tf })
  }
  return ops
}

function main(): void {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const path = args.find((a) => a !== '--json')
  if (!path) {
    console.error('usage: extract-mb1-scratch.ts [--json] <tegrabct_v2>')
    process.exit(1)
  }
  const elf = new Elf32(path)
  const controllerMaps = GROUPS.map(([disp, count]) => readGroup(elf, PIC_BASE + disp, count))
  const prefix = readPrefix(path)
  const layout = {
    blockSize: BLOCK_SIZE,
    sdramSetSize: SDRAM_SET_SIZE,
    window1: { lo: 0x64, hi: 0x570, base: 0x420 },
    window2: { lo: 0xae4, hi: 0xf64, base: 0x0 },
    prefix,
    controllerMaps
  }
  if (json) {
    process.stdout.write(JSON.stringify(layout) + '\n')
    return
  }
  const rows = (r: number[]): string => `[${r.join(',')}]`
  const prefixTs = prefix
    .map(
      (o) =>
        `  { dest: ${o.dest}, keep: ${o.keep}, src: ${o.src}, width: ${o.width}, tf: ${JSON.stringify(o.tf)} }`
    )
    .join(',\n')
  const mapsTs = controllerMaps.map((grp) => `  [${grp.map(rows).join(',')}]`).join(',\n')
  process.stdout.write(
    `import type { SdramScratchLayout } from '../sdramScratch'\n\n` +
      `/**\n * T186 packed SDRAM boot-scratch layout, extracted from tegrabct_v2's\n` +
      ` * NvTegraT18xPackSdramParams. Regenerate with tools/extract-mb1-scratch.ts.\n` +
      ` * Consumed by packSdramScratch. See PROTOCOL.md.\n */\n` +
      `export const T186_SDRAM_SCRATCH: SdramScratchLayout = {\n` +
      `  blockSize: ${BLOCK_SIZE},\n  sdramSetSize: ${SDRAM_SET_SIZE},\n` +
      `  window1: { lo: 0x64, hi: 0x570, base: 0x420 },\n` +
      `  window2: { lo: 0xae4, hi: 0xf64, base: 0x0 },\n` +
      `  prefix: [\n${prefixTs}\n  ],\n  controllerMaps: [\n${mapsTs}\n  ]\n}\n`
  )
}

main()
