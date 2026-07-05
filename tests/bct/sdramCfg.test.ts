import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
  parseSdramCfg,
  sdramCfgLayoutFromTable,
  T186_SDRAM_CFG_LAYOUT,
  T210_SDRAM_CFG_LAYOUT,
  T234_SDRAM_CFG_LAYOUT,
  T264_SDRAM_CFG_LAYOUT,
  type SdramFieldTable
} from '../../src/bct/sdramCfg'
import { T210_BCT_LAYOUT } from '../../src/bct/v1'
import { T186_MB1_BCT_LAYOUT } from '../../src/bct/v2/mb1Bct'
import { BctError } from '../../src/errors'

function golden(name: string): Uint8Array {
  const src = readFileSync(fileURLToPath(new URL(`../golden/${name}`, import.meta.url)))
  const out = new Uint8Array(src.length)
  out.set(src)
  return out
}

function goldenText(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../golden/${name}`, import.meta.url)), 'utf8')
}

describe('T210 SDRAM cfg (P3448, vs tegrabct golden)', () => {
  const sets = parseSdramCfg(goldenText('sdramcfg/t210_p3448.cfg'), T210_SDRAM_CFG_LAYOUT)

  test('packs 4 sets of exactly the BCT stride', () => {
    expect(sets).toHaveLength(4)
    for (const set of sets) expect(set.length).toBe(T210_BCT_LAYOUT.sdramSetStride)
  })

  test('each set is byte-identical to the golden BCT', () => {
    const bct = golden('t210_p3448.bct')
    const { sdramSetsOffset, sdramSetStride } = T210_BCT_LAYOUT
    sets.forEach((set, i) => {
      const offset = sdramSetsOffset + i * sdramSetStride
      expect(
        Buffer.from(set).equals(Buffer.from(bct.subarray(offset, offset + sdramSetStride)))
      ).toBe(true)
    })
  })
})

describe('T186 SDRAM cfg (P3310/P2771, vs tegrabct_v2 golden)', () => {
  const sets = parseSdramCfg(goldenText('sdramcfg/t186_p2771.cfg'), T186_SDRAM_CFG_LAYOUT)

  test('packs 4 sets of exactly the MB1-BCT stride', () => {
    expect(sets).toHaveLength(4)
    for (const set of sets) expect(set.length).toBe(T186_MB1_BCT_LAYOUT.sdramSetStride)
  })

  test('each set is byte-identical to the golden MB1-BCT', () => {
    const mb1 = golden('t186_p2771_mb1.bct')
    const { sdramSetsOffset, sdramSetStride } = T186_MB1_BCT_LAYOUT
    sets.forEach((set, i) => {
      const offset = sdramSetsOffset + i * sdramSetStride
      expect(
        Buffer.from(set).equals(Buffer.from(mb1.subarray(offset, offset + sdramSetStride)))
      ).toBe(true)
    })
  })

  test('the reserved BCT_NA word at 0x106c is zero-filled', () => {
    // the one u32 the cfg never lists (named BCT_NA in tegrabct_v2's own
    // field table) — its slot must stay 0 in every set
    const view = new DataView(sets[0]!.buffer)
    expect(view.getUint32(0x106c, true)).toBe(0)
  })
})

describe('extracted-table layouts (tools/extract-chip-tables.py fixtures)', () => {
  function table(file: string, chip: string): SdramFieldTable {
    const tables = JSON.parse(goldenText(`chiptables/${file}`)) as SdramFieldTable[]
    const found = tables.find((t) => t.chip === chip)
    if (!found) throw new Error(`${chip} missing from ${file}`)
    return found
  }

  test('T21X table layout packs the golden cfg byte-identically to the curated layout', () => {
    const layout = sdramCfgLayoutFromTable(table('t210_sdram.json', 'T21X'))
    expect(layout.setSize).toBe(T210_SDRAM_CFG_LAYOUT.setSize)
    const cfg = goldenText('sdramcfg/t210_p3448.cfg')
    const actual = parseSdramCfg(cfg, layout)
    const expected = parseSdramCfg(cfg, T210_SDRAM_CFG_LAYOUT)
    expect(actual.length).toBe(expected.length)
    actual.forEach((act, idx) => {
      expect(Buffer.from(act).equals(Buffer.from(expected[idx]!))).toBe(true)
    })
  })

  test('T18x table layout packs the golden cfg byte-identically to the curated layout', () => {
    const layout = sdramCfgLayoutFromTable(table('t186_sdram.json', 'T18x'))
    expect(layout.setSize).toBe(T186_SDRAM_CFG_LAYOUT.setSize)
    const cfg = goldenText('sdramcfg/t186_p2771.cfg')
    const actual = parseSdramCfg(cfg, layout)
    const expected = parseSdramCfg(cfg, T186_SDRAM_CFG_LAYOUT)
    expect(actual.length).toBe(expected.length)
    actual.forEach((act, idx) => {
      expect(Buffer.from(act).equals(Buffer.from(expected[idx]!))).toBe(true)
    })
  })

  test('R39 (Thor BSP) fixture carries every v2 chip; T18x/T19x match the R32-era tables', () => {
    const r39 = JSON.parse(goldenText('chiptables/t264_sdram.json')) as SdramFieldTable[]
    expect(r39.map((t) => t.chip).sort()).toEqual(['T18x', 'T19x', 'T23x', 'T264'])
    for (const chip of ['T18x', 'T19x']) {
      expect(table('t264_sdram.json', chip)).toEqual(table('t186_sdram.json', chip))
    }
    // T23x grew between BSP generations (0x21f8 in the R32-era binary) — the
    // T234 table must match the BSP line being flashed
    expect(table('t264_sdram.json', 'T23x').structSize).toBe(0x24d4)
    expect(table('t264_sdram.json', 'T264').structSize).toBe(0x3228)
    for (const t of r39) expect(t.fields['MemoryType']).toBe(0)
  })

  test('T234 and T264 layouts match their extracted table sizes', () => {
    const t23xTable = table('t264_sdram.json', 'T23x')
    const t264Table = table('t264_sdram.json', 'T264')
    expect(t23xTable.structSize).toBe(T234_SDRAM_CFG_LAYOUT.setSize)
    expect(t264Table.structSize).toBe(T264_SDRAM_CFG_LAYOUT.setSize)
  })

  test('T23x and T264 name-addressed packing matches sequential packing for contiguous fields', () => {
    const t23xLayout = sdramCfgLayoutFromTable(table('t264_sdram.json', 'T23x'))
    const t264Layout = sdramCfgLayoutFromTable(table('t264_sdram.json', 'T264'))

    const buildCfg = (tableObj: SdramFieldTable): string => {
      return Object.keys(tableObj.fields)
        .map((name) => `SDRAM[0].${name} = 0x12345678;`)
        .join('\n')
    }

    const t234Cfg = buildCfg(table('t264_sdram.json', 'T23x'))
    const t264Cfg = buildCfg(table('t264_sdram.json', 'T264'))

    const t234PackedName = parseSdramCfg(t234Cfg, t23xLayout)[0]!
    const t234PackedSeq = parseSdramCfg(t234Cfg, T234_SDRAM_CFG_LAYOUT)[0]!
    expect(Buffer.from(t234PackedName).equals(Buffer.from(t234PackedSeq))).toBe(true)

    const t264PackedName = parseSdramCfg(t264Cfg, t264Layout)[0]!
    const t264PackedSeq = parseSdramCfg(t264Cfg, T264_SDRAM_CFG_LAYOUT)[0]!
    expect(Buffer.from(t264PackedName).equals(Buffer.from(t264PackedSeq))).toBe(true)
  })

  test('name-addressed packing is cfg-order independent', () => {
    const layout = sdramCfgLayoutFromTable({
      chip: 'test',
      structSize: 12,
      fields: { A: 0, B: 4, C: 8 }
    })
    const forward = 'SDRAM[0].A = 0x1;\nSDRAM[0].B = 0x2;\nSDRAM[0].C = 0x3;\n'
    const reversed = 'SDRAM[0].C = 0x3;\nSDRAM[0].B = 0x2;\nSDRAM[0].A = 0x1;\n'
    const actual = parseSdramCfg(reversed, layout)
    const expected = parseSdramCfg(forward, layout)
    expect(actual.length).toBe(expected.length)
    actual.forEach((act, idx) => {
      expect(Buffer.from(act).equals(Buffer.from(expected[idx]!))).toBe(true)
    })
  })

  test('rejects a field the table does not know', () => {
    const layout = sdramCfgLayoutFromTable({ chip: 'test', structSize: 4, fields: { A: 0 } })
    expect(() => parseSdramCfg('SDRAM[0].Bogus = 0x1;\n', layout)).toThrow(
      /not in this chip's layout/
    )
  })
})

describe('parseSdramCfg validation', () => {
  const line = (set: number, name: string, value: string) => `SDRAM[${set}].${name} = ${value};\n`
  const tinyLayout = { setSize: 8 }

  test('maps NvBootMemoryType tokens per the tegrabct enum table', () => {
    const cfg =
      line(0, 'MemoryType', 'NvBootMemoryType_LpDdr4') + line(0, 'PllMInputDivider', '0x2')
    const [set] = parseSdramCfg(cfg, tinyLayout)
    expect([...set!]).toEqual([3, 0, 0, 0, 2, 0, 0, 0])
  })

  test('accepts decimal values', () => {
    const cfg = line(0, 'MemIoVoltage', '1100') + line(0, 'B', '0')
    const view = new DataView(parseSdramCfg(cfg, tinyLayout)[0]!.buffer)
    expect(view.getUint32(0, true)).toBe(1100)
  })

  test('rejects unknown value tokens', () => {
    expect(() => parseSdramCfg(line(0, 'MemoryType', 'NvBootMemoryType_Hbm'), tinyLayout)).toThrow(
      BctError
    )
  })

  test('rejects a cfg with no SDRAM lines', () => {
    expect(() => parseSdramCfg('# just a comment\n', tinyLayout)).toThrow(BctError)
  })

  test('rejects a missing set index', () => {
    const cfg =
      line(0, 'A', '0x1') + line(0, 'B', '0x2') + line(2, 'A', '0x1') + line(2, 'B', '0x2')
    expect(() => parseSdramCfg(cfg, tinyLayout)).toThrow(/missing SDRAM set 1/)
  })

  test('rejects sets with mismatched field lists', () => {
    const cfg =
      line(0, 'A', '0x1') + line(0, 'B', '0x2') + line(1, 'A', '0x1') + line(1, 'C', '0x2')
    expect(() => parseSdramCfg(cfg, tinyLayout)).toThrow(/different fields/)
  })

  test('rejects a cfg that does not fill the layout stride', () => {
    expect(() => parseSdramCfg(line(0, 'A', '0x1'), tinyLayout)).toThrow(/packs to 0x4/)
  })

  test('rejects a cfg that overflows the layout stride', () => {
    const cfg = line(0, 'A', '0x1') + line(0, 'B', '0x2') + line(0, 'C', '0x3')
    expect(() => parseSdramCfg(cfg, tinyLayout)).toThrow(/overflows/)
  })
})
