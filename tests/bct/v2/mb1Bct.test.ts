import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { packBrCommandFragment, parseBrCommandCfg } from '../../../src/bct/v2/brCommand'
import { T186_MB1_HEADER } from '../../../src/bct/v2/data/t186Mb1Header'
import { T186_SDRAM_SCRATCH } from '../../../src/bct/v2/data/t186SdramScratch'
import {
  assembleMb1Bct,
  mb1BctSize,
  mb1BctVersion,
  packMb1Fragment,
  packScrFragment,
  parseRegisterPairs,
  parseRegisterTriples,
  parseScrCfg,
  parseScrFragment,
  patchMb1BctSdram,
  T186_MB1_BCT_ASSEMBLY,
  T186_MB1_BCT_LAYOUT
} from '../../../src/bct/v2/mb1Bct'
import { packPmicFragment, parsePmicCfg } from '../../../src/bct/v2/pmic'
import { readUint32LE } from '../../../src/utils/bytes'

function mb1cfg(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../golden/mb1cfg/${name}`, import.meta.url)),
    'utf8'
  )
}

function golden(name: string): Uint8Array<ArrayBuffer> {
  const src = readFileSync(fileURLToPath(new URL(`../../golden/${name}`, import.meta.url)))
  const out = new Uint8Array(src.length)
  out.set(src)
  return out
}

describe('T186 MB1-BCT (tegrabct_v2 --mb1bct, P2771/quill cold-boot)', () => {
  const mb1Bct = golden('t186_p2771_mb1.bct')

  test('header scalars: size @0x0 and version @0x4', () => {
    expect(mb1Bct.length).toBe(49696)
    expect(mb1BctSize(mb1Bct)).toBe(mb1Bct.length)
    expect(mb1BctVersion(mb1Bct)).toBe(0xf)
  })

  test('4 SDRAM instances at sdramSetsOffset on the verified stride', () => {
    const L = T186_MB1_BCT_LAYOUT
    // EmcClockSource (0x40008002) sits 0xc0 into each packed SDRAM instance;
    // its 4 occurrences on a fixed stride independently confirm the offsets.
    const marker = 0x40008002
    for (let i = 0; i < L.maxSdramSets; i++) {
      const at = L.sdramSetsOffset + i * L.sdramSetStride + 0xc0
      expect(readUint32LE(mb1Bct, at)).toBe(marker)
    }
  })

  test('patchMb1BctSdram places pre-packed instances at sdramSetsOffset + i*stride', () => {
    const L = T186_MB1_BCT_LAYOUT
    const buf = new Uint8Array(L.sdramSetsOffset + L.maxSdramSets * L.sdramSetStride)
    patchMb1BctSdram(buf, [
      { raw: new Uint8Array([0xaa, 0xbb]) },
      { raw: new Uint8Array([0xcc, 0xdd]) }
    ])
    expect(buf[L.sdramSetsOffset]).toBe(0xaa)
    expect(buf[L.sdramSetsOffset + L.sdramSetStride]).toBe(0xcc)
  })

  test('patchMb1BctSdram rejects a set that overflows the stride', () => {
    const L = T186_MB1_BCT_LAYOUT
    const buf = new Uint8Array(L.sdramSetsOffset + L.sdramSetStride)
    expect(() => patchMb1BctSdram(buf, [{ raw: new Uint8Array(L.sdramSetStride + 1) }])).toThrow(
      /exceeds stride/
    )
  })

  test('patchMb1BctSdram rejects more sets than the layout holds', () => {
    const sets = Array.from({ length: 5 }, () => ({ raw: new Uint8Array(1) }))
    expect(() => patchMb1BctSdram(new Uint8Array(0), sets)).toThrow(/too many SDRAM sets: 5 > 4/)
  })

  test('patchMb1BctSdram rejects a set that overflows the buffer', () => {
    const L = T186_MB1_BCT_LAYOUT
    // buffer ends exactly where the SDRAM section would begin
    const buf = new Uint8Array(L.sdramSetsOffset)
    expect(() => patchMb1BctSdram(buf, [{ raw: new Uint8Array(1) }])).toThrow(
      /overflows the MB1-BCT/
    )
  })
})

// Cross-board check: P3636-P3509 (a different carrier board) produces a
// different-size MB1-BCT (its pinmux/pmic fragments pack smaller) with
// different SDRAM register values (different DRAM part), but the header and
// the SDRAM section's offset/stride are identical to P2771 - this is what
// justifies treating T186_MB1_BCT_LAYOUT as board-invariant rather than
// re-deriving it per board. See PROTOCOL.md.
describe('T186 MB1-BCT cross-board offset stability (P3636-P3509 vs P2771)', () => {
  const mb1Bct = golden('t186_p3636-p3509_mb1.bct')

  test('header (past the size field) is byte-identical to the P2771 golden, despite a different total size', () => {
    const p2771 = golden('t186_p2771_mb1.bct')
    expect(mb1Bct.length).not.toBe(p2771.length)
    expect(mb1BctSize(mb1Bct)).toBe(mb1Bct.length)

    // The header up to sdramSetsOffset is fixed/format-level (size and SDRAM
    // register *values* differ per board - see the marker check below for
    // why the SDRAM section's *offsets* are still trustworthy cross-board).
    const L = T186_MB1_BCT_LAYOUT
    expect(
      Buffer.from(mb1Bct.subarray(L.versionOffset, L.sdramSetsOffset)).equals(
        Buffer.from(p2771.subarray(L.versionOffset, L.sdramSetsOffset))
      )
    ).toBe(true)
  })

  test('version still reads 0xf and the SDRAM marker still lands on the same stride', () => {
    const L = T186_MB1_BCT_LAYOUT
    expect(mb1BctVersion(mb1Bct)).toBe(0xf)
    const marker = 0x40008002
    for (let i = 0; i < L.maxSdramSets; i++) {
      expect(readUint32LE(mb1Bct, L.sdramSetsOffset + i * L.sdramSetStride + 0xc0)).toBe(marker)
    }
  })
})

// The MB1-BCT's trailing platform-config region is a run of back-to-back
// `[version u32][count u32][rows…]` blocks compiled from the board `.cfg`
// fragments. These reproduce three register-list fragments byte-for-byte from
// their real cfgs (staged in tests/golden/mb1cfg/) against the P2771 golden,
// pinning the block format, the (major<<16)|minor version and the row widths.
describe('T186 MB1-BCT fragment assembly (cfg -> block, vs P2771 golden)', () => {
  const mb1Bct = golden('t186_p2771_mb1.bct')

  test('pinmux: 378 addr/value pairs pack byte-exact to [0x7d18, 0x88f0)', () => {
    const frag = parseRegisterPairs(mb1cfg('pinmux.cfg'), 'pinmux')
    expect(frag.rows.length).toBe(378)
    expect(
      Buffer.from(packMb1Fragment(frag)).equals(Buffer.from(mb1Bct.subarray(0x7d18, 0x88f0)))
    ).toBe(true)
  })

  test('pad: 2 pmc addr/value pairs pack byte-exact to [0xb8c0, 0xb8d8)', () => {
    const frag = parseRegisterPairs(mb1cfg('pad.cfg'), 'pmc')
    expect(frag.rows.length).toBe(2)
    expect(
      Buffer.from(packMb1Fragment(frag)).equals(Buffer.from(mb1Bct.subarray(0xb8c0, 0xb8d8)))
    ).toBe(true)
  })

  test('prod: 135 addr/mask/value triples pack byte-exact to [0xbbc4, EOF)', () => {
    const frag = parseRegisterTriples(mb1cfg('prod.cfg'))
    expect(frag.rows.length).toBe(135)
    expect(frag.rows[0]?.length).toBe(3)
    expect(
      Buffer.from(packMb1Fragment(frag)).equals(Buffer.from(mb1Bct.subarray(0xbbc4, mb1Bct.length)))
    ).toBe(true)
  })

  test('scr: 2878 value entries (indexed by N) pack byte-exact to [0x88f0, 0xb5f0)', () => {
    const frag = parseScrCfg(mb1cfg('scr.cfg'))
    expect(frag.rows.length).toBe(2878)
    expect(frag.major).toBe(4)
    expect(frag.minor).toBe(3)
    expect(
      Buffer.from(packMb1Fragment(frag)).equals(Buffer.from(mb1Bct.subarray(0x88f0, 0xb5f0)))
    ).toBe(true)
  })

  test('scr fragment incl. 2-bit <m> code tail packs byte-exact to [0x88f0, 0xb8c0)', () => {
    const frag = parseScrFragment(mb1cfg('scr.cfg'))
    expect(frag.values.length).toBe(2878)
    expect(frag.codes.length).toBe(2878)
    expect(
      Buffer.from(packScrFragment(frag)).equals(Buffer.from(mb1Bct.subarray(0x88f0, 0xb8c0)))
    ).toBe(true)
  })

  test('parseScrFragment throws when no scr rows match (wrong file / namespace)', () => {
    expect(() => parseScrFragment('scr.major = 4;\nscr.minor = 3;\n')).toThrow(/no register rows/)
  })

  test('packScrFragment rejects an out-of-range 2-bit code', () => {
    expect(() => packScrFragment({ major: 4, minor: 3, values: [0], codes: [4] })).toThrow(
      /exceeds 2 bits/
    )
  })

  test('version encodes (major<<16)|minor', () => {
    const frag = parseRegisterPairs(mb1cfg('pinmux.cfg'), 'pinmux')
    const block = packMb1Fragment(frag)
    expect(readUint32LE(block, 0)).toBe((frag.major << 16) | frag.minor)
    expect(readUint32LE(block, 0)).toBe(0x00010000)
  })

  // A namespace/format mismatch matches the version lines but zero register
  // rows; without a guard this silently emits an empty (count 0) fragment and
  // the board ships with no config applied. See the review finding.
  test('parseRegisterPairs throws when no register rows match', () => {
    expect(() => parseRegisterPairs('pinmux.major = 1;\npinmux.minor = 0;\n', 'pinmux')).toThrow(
      /no register rows/
    )
  })

  test('parseRegisterTriples throws when no register rows match', () => {
    expect(() => parseRegisterTriples('prod.major = 1;\nprod.minor = 0;\n')).toThrow(
      /no register rows/
    )
  })
})

// End-to-end: compile the six board cfgs + the golden's own SDRAM sets/header
// into a complete MB1-BCT and assert it is byte-identical to the tegrabct_v2
// output. This exercises the packed boot-scratch, the fragment directory, the
// scr 2-bit tail, and the physical fragment order all at once.
describe('assembleMb1Bct (cfg set -> full MB1-BCT, vs P2771 golden)', () => {
  const mb1Bct = golden('t186_p2771_mb1.bct')
  const scratchLayout = T186_SDRAM_SCRATCH

  test('the shipped src header template matches the golden [0, 0xbb0)', () => {
    expect(
      Buffer.from(T186_MB1_HEADER).equals(
        Buffer.from(mb1Bct.subarray(0, T186_MB1_BCT_ASSEMBLY.headerSize))
      )
    ).toBe(true)
  })

  test('reproduces t186_p2771_mb1.bct byte-for-byte', () => {
    const L = T186_MB1_BCT_ASSEMBLY
    // SDRAM param sets come straight from the golden (parseSdramCfg is tested
    // separately); the header template is the board-invariant src constant.
    const sdramSets = Array.from(
      { length: L.sdramSets },
      (_, i) =>
        new Uint8Array(
          mb1Bct.subarray(
            L.sdramSetsOffset + i * L.sdramSetStride,
            L.sdramSetsOffset + (i + 1) * L.sdramSetStride
          )
        )
    )

    const out = assembleMb1Bct({
      header: T186_MB1_HEADER,
      sdramSets,
      scratchLayout,
      fragments: {
        pinmux: packMb1Fragment(parseRegisterPairs(mb1cfg('pinmux.cfg'), 'pinmux')),
        scr: packScrFragment(parseScrFragment(mb1cfg('scr.cfg'))),
        pad: packMb1Fragment(parseRegisterPairs(mb1cfg('pad.cfg'), 'pmc')),
        pmic: packPmicFragment(parsePmicCfg(mb1cfg('pmic.cfg'))),
        brcommand: packBrCommandFragment(parseBrCommandCfg(mb1cfg('bootrom.cfg'))),
        prod: packMb1Fragment(parseRegisterTriples(mb1cfg('prod.cfg')))
      }
    })

    expect(out.length).toBe(mb1Bct.length)
    expect(Buffer.from(out).equals(Buffer.from(mb1Bct))).toBe(true)
  })

  test('rejects a too-short header template', () => {
    expect(() =>
      assembleMb1Bct({
        header: new Uint8Array(0x100),
        sdramSets: [new Uint8Array(T186_MB1_BCT_ASSEMBLY.sdramSetStride)],
        scratchLayout,
        fragments: {
          pinmux: new Uint8Array(8),
          scr: new Uint8Array(8),
          pad: new Uint8Array(8),
          pmic: new Uint8Array(8),
          brcommand: new Uint8Array(8),
          prod: new Uint8Array(8)
        }
      })
    ).toThrow(/header template/)
  })
})
