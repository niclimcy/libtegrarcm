import { BctError } from '../../errors'
import { byteSum } from '../../utils/bytes'
import { assertContiguous, NUM_RE } from './cfg'

/**
 * T186 MB1-BCT `pmic` (and `brcommand`) platform-config fragment assembly.
 *
 * Layout of the fragment body (after the `[version][count]` header, where here
 * `count` is the body's u32 word-count — see PROTOCOL.md), all little-endian:
 *
 *   topHeader  u32   retries | wait<<8 | railCount<<16
 *   directory  u32[] one per rail: railId<<16 | byteOffsetFromBodyStart
 *   per rail:  u32   railHeader = blockCount<<16 | 1, then its command blocks
 *
 * Each block starts with a packed header word and is checksummed so the block's
 * bytes sum to 0 mod 256 (the header's low byte is the check byte):
 *
 *   I2C  (type 1): (0xC0|count)<<24 | (ctrl<<4)<<16 | slave<<8 | cksum,
 *                  then blockDelay, a reserved 0, then count (reg,mask,value)
 *   MMIO (type 0): (0x80|count)<<24 | cksum, then blockDelay, reserved 0,
 *                  then count (addr,mask,value)
 *   PWM  (type 2): 0xC1<<24 | (ctrl<<4|0xD)<<16 | cksum, then 0, 0, then
 *                  sourceFrqHz, periodNs, and a computed dutyNs
 *
 * See PROTOCOL.md and tests/bct/v2/pmic.test.ts.
 */

export interface PmicCommand {
  /** 8-bit register (I2C) or 32-bit MMIO address. */
  reg: number
  mask: number
  value: number
}

export type PmicBlockType = 'mmio' | 'i2c' | 'pwm'

export interface PmicBlock {
  type: PmicBlockType
  blockDelay: number
  /** i2c/mmio commands (empty for pwm). */
  commands: PmicCommand[]
  /** i2c/pwm controller id. */
  controllerId?: number | undefined
  /** i2c slave address. */
  slaveAdd?: number | undefined
  /** pwm fields; min/max/init are compiled into a duty value. */
  sourceFrqHz?: number | undefined
  periodNs?: number | undefined
  minMicrovolts?: number | undefined
  maxMicrovolts?: number | undefined
  initMicrovolts?: number | undefined
}

export interface PmicRail {
  railId: number
  blocks: PmicBlock[]
}

export interface PmicConfig {
  major: number
  minor: number
  commandRetriesCount: number
  waitBeforeStartBusClearUs: number
  /** Rails in the cfg's declaration order (that's the directory order too). */
  rails: PmicRail[]
}

const WIRE_TYPE: Record<PmicBlockType, number> = { mmio: 0, i2c: 1, pwm: 2 }

function req(value: number | undefined, what: string): number {
  if (value === undefined) throw new BctError(`pmic block missing ${what}`)
  return value
}

/** PWM duty in ns: linearly map init between [min,max] onto the period. */
function pwmDutyNs(block: PmicBlock): number {
  const min = req(block.minMicrovolts, 'min-microvolts')
  const max = req(block.maxMicrovolts, 'max-microvolts')
  const init = req(block.initMicrovolts, 'init-microvolts')
  const period = req(block.periodNs, 'period-ns')
  // Without these guards a fixed-voltage rail (max==min) divides by zero and a
  // mis-authored init silently packs a wrong duty word (NaN/negative -> 0 or a
  // huge u32 via >>> 0), driving the wrong voltage with no error.
  if (max <= min) {
    throw new BctError(`pmic pwm rail has max-microvolts (${max}) <= min-microvolts (${min})`)
  }
  if (init < min || init > max) {
    throw new BctError(`pmic pwm init-microvolts ${init} is outside [${min}, ${max}]`)
  }
  return Math.floor(((init - min) * period) / (max - min))
}

/** A controller id is packed into a 4-bit nibble; reject anything wider. */
function nibble(value: number, what: string): number {
  if (value < 0 || value > 0xf) throw new BctError(`pmic ${what} ${value} does not fit in 4 bits`)
  return value
}

/** Pack one command block to u32 words with its checksum byte applied. */
function packBlock(block: PmicBlock): number[] {
  const words: number[] = []
  if (block.type === 'pwm') {
    const ctrl = nibble(req(block.controllerId, 'controller-id'), 'controller-id')
    words.push((0xc1 << 24) | (((ctrl << 4) | 0xd) << 16), 0, 0)
    words.push(
      req(block.sourceFrqHz, 'source-frq-hz'),
      req(block.periodNs, 'period-ns'),
      pwmDutyNs(block)
    )
  } else {
    const count = block.commands.length
    const hdr =
      block.type === 'i2c'
        ? ((0xc0 | count) << 24) |
          ((nibble(req(block.controllerId, 'i2c-controller-id'), 'i2c-controller-id') << 4) << 16) |
          (req(block.slaveAdd, 'slave-add') << 8)
        : (0x80 | count) << 24
    words.push(hdr >>> 0, block.blockDelay, 0)
    for (const c of block.commands) words.push(c.reg >>> 0, c.mask >>> 0, c.value >>> 0)
  }
  // Checksum: header low byte set so the block's bytes sum to 0 mod 256.
  words[0] = ((words[0] ?? 0) | ((0x100 - byteSum(words)) & 0xff)) >>> 0
  return words
}

/** A field packed into a single byte of the top header; reject silent truncation. */
function byte(value: number, what: string): number {
  if (value < 0 || value > 0xff) throw new BctError(`pmic ${what} ${value} does not fit in a byte`)
  return value
}

/** Serialize a parsed pmic/brcommand config to its MB1-BCT fragment block. */
export function packPmicFragment(cfg: PmicConfig): Uint8Array<ArrayBuffer> {
  const railBodies = cfg.rails.map((rail) => {
    const words: number[] = [((rail.blocks.length << 16) | 1) >>> 0]
    for (const block of rail.blocks) words.push(...packBlock(block))
    return words
  })

  const topHeader =
    (byte(cfg.commandRetriesCount, 'command-retries-count') |
      (byte(cfg.waitBeforeStartBusClearUs, 'wait-before-start-bus-clear-us') << 8) |
      (byte(cfg.rails.length, 'rail count') << 16)) >>>
    0

  let offset = (1 + cfg.rails.length) * 4
  const directory = cfg.rails.map((rail, i) => {
    const entry = ((rail.railId << 16) | offset) >>> 0
    offset += (railBodies[i]?.length ?? 0) * 4
    return entry
  })

  const body = [topHeader, ...directory, ...railBodies.flat()]
  const out = new Uint8Array(8 + body.length * 4)
  const view = new DataView(out.buffer)
  view.setUint32(0, ((cfg.major << 16) | cfg.minor) >>> 0, true)
  view.setUint32(4, body.length, true)
  body.forEach((word, i) => view.setUint32(8 + i * 4, word >>> 0, true))
  return out
}

/** Parse a `pmic.*` (or `brcommand.*`) cfg into structured rails/blocks. */
export function parsePmicCfg(cfg: string, ns = 'pmic'): PmicConfig {
  const scalar = (key: string): number => {
    const m = new RegExp(`${ns}\\.${key}\\s*=\\s*${NUM_RE}`).exec(cfg)
    return m?.[1] ? Number(m[1]) : 0
  }

  const rails: PmicRail[] = []
  const railRe = new RegExp(`${ns}\\.(\\w+)\\.(\\d+)\\.block-count\\s*=\\s*(\\d+)`, 'g')
  for (let rm = railRe.exec(cfg); rm; rm = railRe.exec(cfg)) {
    const [, name, idStr, countStr] = rm
    const railId = Number(idStr)
    const blockCount = Number(countStr)
    const blocks: PmicBlock[] = []
    for (let bi = 0; bi < blockCount; bi++) {
      const prefix = `${ns}\\.${name}\\.${railId}\\.block\\[${bi}\\]`
      const field = (name: string): number | undefined => {
        const m = new RegExp(`${prefix}\\.${name}\\s*=\\s*${NUM_RE}`).exec(cfg)
        return m?.[1] === undefined ? undefined : Number(m[1])
      }
      const commands: PmicCommand[] = []
      // reg/mask are always 0x-prefixed; the value may be bare (`= 0`).
      const cmdRe = new RegExp(
        `${prefix}\\.commands\\[(\\d+)\\]\\.(0x[0-9a-fA-F]+)\\.(0x[0-9a-fA-F]+)\\s*=\\s*${NUM_RE}`,
        'g'
      )
      for (let cm = cmdRe.exec(cfg); cm; cm = cmdRe.exec(cfg)) {
        commands[Number(cm[1])] = {
          reg: parseInt(cm[2]!, 16),
          mask: parseInt(cm[3]!, 16),
          value: Number(cm[4])
        }
      }
      assertContiguous(commands, `${ns}.${name}.${railId}.block[${bi}].commands`)
      const type = field('type')
      const blockDelay = field('block-delay') ?? 0
      if (type === WIRE_TYPE.pwm) {
        blocks.push({
          type: 'pwm',
          blockDelay,
          commands: [],
          controllerId: field('controller-id'),
          sourceFrqHz: field('source-frq-hz'),
          periodNs: field('period-ns'),
          minMicrovolts: field('min-microvolts'),
          maxMicrovolts: field('max-microvolts'),
          initMicrovolts: field('init-microvolts')
        })
      } else if (type === WIRE_TYPE.i2c) {
        blocks.push({
          type: 'i2c',
          blockDelay,
          commands,
          controllerId: field('i2c-controller-id'),
          slaveAdd: field('slave-add')
        })
      } else {
        blocks.push({ type: 'mmio', blockDelay, commands })
      }
    }
    rails.push({ railId, blocks })
  }

  return {
    major: scalar('major'),
    minor: scalar('minor'),
    commandRetriesCount: scalar('command-retries-count'),
    waitBeforeStartBusClearUs: scalar('wait-before-start-bus-clear-us'),
    rails
  }
}
