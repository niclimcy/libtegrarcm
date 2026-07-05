#!/usr/bin/env node
/**
 * Extract SDRAM/BCT field-layout tables from NVIDIA tegrabct binaries.
 *
 * The tegraflash tools ship as unstripped static i386 ELFs whose cfg parsers
 * are table-driven: arrays of `{name*, offset, type, enumTable*}` rows (one
 * per `SDRAM[n].<Field>` the cfg dialect accepts) plus `{name*, value}` enum
 * tables. This walks the symtab for those arrays, decodes them, and emits
 * JSON layout descriptors per chip — the authoritative name->offset map the
 * library's `SdramCfgLayout`s are verified against, with no disassembly or
 * goldens needed.
 *
 * The tables are compilation-unit statics (no global references to scan
 * for), so each is attributed to its chip via the symtab's STT_FILE
 * grouping: local symbols follow their source-file marker, and the sibling
 * symbol names in the same unit carry the chip tag (NvTegraT18x...,
 * nvtegra_buildbct_t21x.c, ...).
 *
 * Usage:
 *   node tools/extract-chip-tables.ts [--fields-only] <tegrabct|tegrabct_v2>...
 *
 * --fields-only emits compact `SdramFieldTable` records ({chip, structSize,
 * fields: {name: offset}}) — the fixture format tests/golden/chiptables/*.json
 * is staged in and `sdramCfgLayoutFromTable` consumes.
 */
import { readFileSync } from 'node:fs'
import type { SdramFieldTable } from '../src/bct/sdramCfg.ts'

const SYM_SDRAM = 's_SdramTable'
// {const char *name; u32 offset; u32 type; const void *enumTable}
const ROW_SIZE = 16
// {const char *name; u32 value}
const ENUM_ROW_SIZE = 8

interface Section {
  type: number
  addr: number
  offset: number
  size: number
  link: number
}

interface Sym {
  name: string
  value: number
  size: number
}

interface CompileUnit {
  file: string
  syms: Sym[]
}

interface Field {
  name: string
  offset: number
  type: number
  enum?: boolean
}

interface Hole {
  beforeField: string
  padBytes: number
}

interface TableRecord {
  binary: string
  table: string
  chip: string
  sourceFile: string
  structSize: number
  fieldCount: number
  holes: Hole[]
  enums: Record<string, Record<string, number>>
  fields: Field[]
}

/** Minimal ELF32 reader: sections, symtab compile units, vaddr->file mapping. */
class Elf32 {
  readonly data: Buffer
  readonly view: DataView
  readonly sections: Section[] = []

  constructor(path: string) {
    this.data = readFileSync(path)
    this.view = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength)
    if (this.data.readUInt32BE(0) !== 0x7f454c46 || this.data[4] !== 1) {
      throw new Error(`${path}: not an ELF32 binary`)
    }
    const shoff = this.view.getUint32(0x20, true)
    const shentsize = this.view.getUint16(0x2e, true)
    const shnum = this.view.getUint16(0x30, true)
    for (let i = 0; i < shnum; i++) {
      const at = shoff + i * shentsize
      this.sections.push({
        type: this.view.getUint32(at + 4, true),
        addr: this.view.getUint32(at + 12, true),
        offset: this.view.getUint32(at + 16, true),
        size: this.view.getUint32(at + 20, true),
        link: this.view.getUint32(at + 24, true)
      })
    }
  }

  v2o(vaddr: number): number {
    for (const s of this.sections) {
      if (s.addr && s.addr <= vaddr && vaddr < s.addr + s.size) {
        return s.offset + (vaddr - s.addr)
      }
    }
    throw new Error(`vaddr 0x${vaddr.toString(16)} not mapped`)
  }

  cstrAt(fileOffset: number): string {
    const end = this.data.indexOf(0, fileOffset)
    return this.data.toString('latin1', fileOffset, end)
  }

  cstr(vaddr: number): string {
    return this.cstrAt(this.v2o(vaddr))
  }

  /** (sourceFile, locals) per STT_FILE group; local statics follow their
   * source-file marker in the symtab. */
  compileUnits(): CompileUnit[] {
    const units: CompileUnit[] = []
    for (const sec of this.sections) {
      if (sec.type !== 2) continue // SHT_SYMTAB
      const strtab = this.sections[sec.link]
      if (!strtab) continue
      let unit: CompileUnit | undefined
      for (let at = sec.offset; at < sec.offset + sec.size; at += 16) {
        const name = this.cstrAt(strtab.offset + this.view.getUint32(at, true))
        const value = this.view.getUint32(at + 4, true)
        const size = this.view.getUint32(at + 8, true)
        const info = this.view.getUint8(at + 12)
        if ((info & 0xf) === 4) {
          // STT_FILE
          unit = { file: name, syms: [] }
          units.push(unit)
        } else if (name && unit) {
          unit.syms.push({ name, value, size })
        }
      }
    }
    return units.filter((u) => u.syms.length > 0)
  }
}

/** {name*, value} rows until a NULL name pointer. */
function readEnumTable(elf: Elf32, vaddr: number): Record<string, number> {
  const values: Record<string, number> = {}
  for (let at = vaddr; ; at += ENUM_ROW_SIZE) {
    const o = elf.v2o(at)
    const namePtr = elf.view.getUint32(o, true)
    if (namePtr === 0) return values
    values[elf.cstr(namePtr)] = elf.view.getUint32(o + 4, true)
  }
}

/** {name*, offset, type, enumTable*} rows; NULL-name row terminates. */
function readFieldTable(
  elf: Elf32,
  vaddr: number,
  size: number
): { fields: Field[]; enums: Record<string, Record<string, number>> } {
  const fields: Field[] = []
  const enums: Record<string, Record<string, number>> = {}
  for (let i = 0; i < Math.floor(size / ROW_SIZE); i++) {
    const o = elf.v2o(vaddr + i * ROW_SIZE)
    const namePtr = elf.view.getUint32(o, true)
    if (namePtr === 0) break
    const field: Field = {
      name: elf.cstr(namePtr),
      offset: elf.view.getUint32(o + 4, true),
      type: elf.view.getUint32(o + 8, true)
    }
    const enumPtr = elf.view.getUint32(o + 12, true)
    if (enumPtr) {
      field.enum = true
      enums[field.name] = readEnumTable(elf, enumPtr)
    }
    fields.push(field)
  }
  return { fields, enums }
}

/** Chip tags in a unit's symbol names: NvTegraT18x... / NvTegraT264... */
function unitTags(unit: CompileUnit): Set<string> {
  const tags = new Set<string>()
  for (const sym of unit.syms) {
    const m = /(T\d+x|T\d{3})/.exec(sym.name)
    if (m?.[1]) tags.add(m[1])
  }
  return tags
}

/** Chip tag for a compilation unit: from its sibling symbol names
 * (NvTegraT18x...), the source-file name (..._t21x.c), or — for the
 * T23x/T264 cfg-handler units whose own symbols carry no tag — the nearest
 * unit (by symtab distance) with an unambiguous tag; per-chip units are
 * contiguous in link order, so the closest tag is the owning chip's. */
function chipOf(units: CompileUnit[], index: number): string {
  const unit = units[index]!
  const own = unitTags(unit)
  if (own.size === 1) return [...own][0]!
  const m = /(t\d+x(?:_b\d+)?)/.exec(unit.file)
  if (m?.[1]) return m[1].toUpperCase()
  for (let d = 1; d < units.length; d++) {
    for (const neighbor of [units[index - d], units[index + d]]) {
      if (!neighbor) continue
      const tags = unitTags(neighbor)
      if (tags.size === 1) return [...tags][0]!
    }
  }
  return unit.file
}

function extract(path: string): TableRecord[] {
  const elf = new Elf32(path)
  const out: TableRecord[] = []
  const units = elf.compileUnits()
  for (const [index, unit] of units.entries()) {
    const table = unit.syms.find((s) => s.name === SYM_SDRAM)
    if (!table) continue
    const { fields, enums } = readFieldTable(elf, table.value, table.size)
    const holes: Hole[] = []
    let expected = 0
    for (const f of [...fields].sort((a, b) => a.offset - b.offset)) {
      if (f.offset > expected) {
        holes.push({ beforeField: f.name, padBytes: f.offset - expected })
      }
      expected = Math.max(expected, f.offset + 4)
    }
    out.push({
      binary: path,
      table: `${SYM_SDRAM}@0x${table.value.toString(16)}`,
      chip: chipOf(units, index),
      sourceFile: unit.file,
      structSize: expected,
      fieldCount: fields.length,
      holes,
      enums,
      fields
    })
  }
  return out
}

function main(): void {
  const args = process.argv.slice(2)
  const fieldsOnly = args.includes('--fields-only')
  const paths = args.filter((a) => a !== '--fields-only')
  if (paths.length === 0) {
    console.error('usage: extract-chip-tables.ts [--fields-only] <tegrabct binary>...')
    process.exit(1)
  }
  const records = paths.flatMap(extract)
  const output = fieldsOnly
    ? records.map((t): SdramFieldTable => ({
        chip: t.chip,
        structSize: t.structSize,
        fields: Object.fromEntries(t.fields.map((f) => [f.name, f.offset]))
      }))
    : records
  process.stdout.write(JSON.stringify(output, null, 2) + '\n')
}

main()
