import { BctError } from '../../errors'
import { byteSum } from '../../utils/bytes'
import { assertContiguous, NUM_RE } from './cfg'

/**
 * T186 MB1-BCT `brcommand` (bootrom command) platform-config fragment assembly.
 *
 * Like `pmic` this is a command-block fragment, but with a distinct `aoblock`
 * structure and a more compact command encoding. Fragment body (after the
 * `[version][count-in-words]` header), all little-endian:
 *
 *   prefix   u32[8]  a fixed header region (mostly zero; see PREFIX below)
 *   per block: regSizeWord, then a checksummed I2C block header, then commands
 *
 *   regSizeWord u32  encodes reg-data-size / reg-add-size (see regSizeWord())
 *   blockHeader u32  slave | count<<8 | cksum<<16 | 0x80<<24, where cksum (byte 2)
 *                    is set so the header + command words sum to 0 mod 256
 *   commands    u32  byte-packed (reg, value) pairs, two commands per word
 *
 * Two constants are only observed on the single available board (the `0x0b` in
 * the prefix and the `regSizeWord` encoding for 8/8-bit registers) — see
 * PROTOCOL.md.
 */

export interface BrCommand {
  reg: number
  value: number
}

export interface BrBlock {
  slaveAdd: number
  regDataSize: number
  regAddSize: number
  commands: BrCommand[]
}

export interface BrConfig {
  major: number
  minor: number
  /** One entry per aoblock, each holding its command blocks. */
  aoblocks: BrBlock[][]
}

// 8-word fixed prefix. The 0x0b at word 5 is an unidentified constant observed
// on P2771 (likely the sensor-aotag/header region) — reproduced, not derived.
const PREFIX = [0, 0, 0, 0, 0, 0x0b, 0, 0]

/** reg-data-size / reg-add-size word. Inferred from the single board's 8/8-bit
 * registers (→ 0x0909); the exact bit meaning isn't pinned. */
function regSizeWord(block: BrBlock): number {
  return ((((block.regAddSize >> 3) + 8) & 0xff) << 8) | (((block.regDataSize >> 3) + 8) & 0xff)
}

function packBrBlock(block: BrBlock): number[] {
  const count = block.commands.length
  const cmdWords: number[] = []
  for (let i = 0; i < count; i += 2) {
    const a = block.commands[i]!
    const b = block.commands[i + 1]
    let word = (a.reg & 0xff) | ((a.value & 0xff) << 8)
    if (b) word |= ((b.reg & 0xff) << 16) | ((b.value & 0xff) << 24)
    cmdWords.push(word >>> 0)
  }
  const header0 = ((block.slaveAdd & 0xff) | ((count & 0xff) << 8) | (0x80 << 24)) >>> 0
  const cksum = (0x100 - byteSum([header0, ...cmdWords])) & 0xff
  const header = (header0 | (cksum << 16)) >>> 0
  return [regSizeWord(block), header, ...cmdWords]
}

/** Serialize a parsed brcommand config to its MB1-BCT fragment block. */
export function packBrCommandFragment(cfg: BrConfig): Uint8Array<ArrayBuffer> {
  const body = [...PREFIX]
  for (const aoblock of cfg.aoblocks) {
    for (const block of aoblock) body.push(...packBrBlock(block))
  }
  const out = new Uint8Array(8 + body.length * 4)
  const view = new DataView(out.buffer)
  view.setUint32(0, ((cfg.major << 16) | cfg.minor) >>> 0, true)
  view.setUint32(4, body.length, true)
  body.forEach((word, i) => view.setUint32(8 + i * 4, word >>> 0, true))
  return out
}

/** Parse a `bootrom.*` (brcommand) cfg into structured aoblocks/blocks. */
export function parseBrCommandCfg(cfg: string): BrConfig {
  const scalar = (key: string): number => {
    const m = new RegExp(`bootrom\\.${key}\\s*=\\s*${NUM_RE}`).exec(cfg)
    return m?.[1] ? Number(m[1]) : 0
  }
  const aoblockCount = scalar('aoblock-count')
  const aoblocks: BrBlock[][] = []
  for (let ai = 0; ai < aoblockCount; ai++) {
    const aoField = (key: string): number => {
      const m = new RegExp(`bootrom\\.aoblock\\[${ai}\\]\\.${key}\\s*=\\s*${NUM_RE}`).exec(cfg)
      return m?.[1] ? Number(m[1]) : 0
    }
    const blockCount = aoField('block-count')
    const blocks: BrBlock[] = []
    for (let bi = 0; bi < blockCount; bi++) {
      const prefix = `bootrom\\.aoblock\\[${ai}\\]\\.block\\[${bi}\\]`
      const field = (key: string): number => {
        const m = new RegExp(`${prefix}\\.${key}\\s*=\\s*${NUM_RE}`).exec(cfg)
        return m?.[1] ? Number(m[1]) : 0
      }
      const commands: BrCommand[] = []
      const cmdRe = new RegExp(
        `${prefix}\\.commands\\[(\\d+)\\]\\.(0x[0-9a-fA-F]+)\\s*=\\s*${NUM_RE}`,
        'g'
      )
      for (let cm = cmdRe.exec(cfg); cm; cm = cmdRe.exec(cfg)) {
        commands[Number(cm[1])] = { reg: parseInt(cm[2]!, 16), value: Number(cm[3]) }
      }
      assertContiguous(commands, `bootrom.aoblock[${ai}].block[${bi}].commands`)
      blocks.push({
        slaveAdd: field('slave-add'),
        regDataSize: field('reg-data-size'),
        regAddSize: field('reg-add-size'),
        commands
      })
    }
    aoblocks.push(blocks)
  }
  if (aoblocks.length === 0) throw new BctError('brcommand cfg has no aoblocks')
  return { major: scalar('major'), minor: scalar('minor'), aoblocks }
}
