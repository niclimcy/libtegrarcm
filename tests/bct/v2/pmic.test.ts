import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { packPmicFragment, parsePmicCfg, PmicConfig } from '../../../src/bct/v2/pmic'
import { BctError } from '../../../src/errors'

function golden(name: string): Uint8Array<ArrayBuffer> {
  const src = readFileSync(fileURLToPath(new URL(`../../golden/${name}`, import.meta.url)))
  const out = new Uint8Array(src.length)
  out.set(src)
  return out
}
function mb1cfg(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../golden/mb1cfg/${name}`, import.meta.url)),
    'utf8'
  )
}

describe('T186 MB1-BCT pmic fragment (cfg -> block, vs P2771 golden)', () => {
  const cfg = parsePmicCfg(mb1cfg('pmic.cfg'))

  test('parses the rails in declaration order with their block counts', () => {
    expect(cfg.rails.map((r) => r.railId)).toEqual([1, 3, 2, 4, 5, 6])
    expect(cfg.rails.map((r) => r.blocks.length)).toEqual([4, 3, 3, 4, 1, 1])
    expect(cfg.commandRetriesCount).toBe(1)
  })

  test('packs byte-exact to the pmic block [0xb8d8, 0xbb84)', () => {
    const block = packPmicFragment(cfg)
    expect(block).toEqual(golden('t186_p2771_mb1.bct').subarray(0xb8d8, 0xbb84))
  })
})

describe('pwm duty validation', () => {
  const pwmCfg = (min: number, max: number, init: number): PmicConfig => ({
    major: 1,
    minor: 0,
    commandRetriesCount: 1,
    waitBeforeStartBusClearUs: 0,
    rails: [
      {
        railId: 1,
        blocks: [
          {
            type: 'pwm',
            blockDelay: 0,
            commands: [],
            controllerId: 0,
            sourceFrqHz: 1000,
            periodNs: 1000,
            minMicrovolts: min,
            maxMicrovolts: max,
            initMicrovolts: init
          }
        ]
      }
    ]
  })

  test('rejects a pwm rail whose min equals max (divide-by-zero)', () => {
    expect(() => packPmicFragment(pwmCfg(500000, 500000, 500000))).toThrow(BctError)
  })

  test('rejects a pwm rail whose init is below min (negative duty)', () => {
    expect(() => packPmicFragment(pwmCfg(600000, 1200000, 500000))).toThrow(BctError)
  })

  test('accepts a well-formed pwm rail (init within [min, max])', () => {
    expect(() => packPmicFragment(pwmCfg(600000, 1200000, 900000))).not.toThrow()
  })
})

describe('pmic cfg field-range validation', () => {
  test('parsePmicCfg rejects a block with a gap in its command indices', () => {
    const cfg = [
      'pmic.major = 1;',
      'pmic.minor = 0;',
      'pmic.command-retries-count = 1;',
      'pmic.sd0.1.block-count = 1;',
      'pmic.sd0.1.block[0].type = 0;', // mmio
      'pmic.sd0.1.block[0].commands[0].0x00.0xff = 0x1;',
      'pmic.sd0.1.block[0].commands[2].0x04.0xff = 0x2;' // index 1 missing
    ].join('\n')
    expect(() => parsePmicCfg(cfg)).toThrow(BctError)
  })

  test('packPmicFragment rejects a wait value that would truncate into a byte', () => {
    const cfg: PmicConfig = {
      major: 1,
      minor: 0,
      commandRetriesCount: 1,
      waitBeforeStartBusClearUs: 500, // > 255
      rails: []
    }
    expect(() => packPmicFragment(cfg)).toThrow(BctError)
  })

  test('packPmicFragment rejects an i2c controller-id above 15', () => {
    const cfg: PmicConfig = {
      major: 1,
      minor: 0,
      commandRetriesCount: 1,
      waitBeforeStartBusClearUs: 0,
      rails: [
        {
          railId: 1,
          blocks: [
            {
              type: 'i2c',
              blockDelay: 0,
              commands: [{ reg: 0, mask: 0xff, value: 1 }],
              controllerId: 16, // only 4 bits available
              slaveAdd: 0x20
            }
          ]
        }
      ]
    }
    expect(() => packPmicFragment(cfg)).toThrow(BctError)
  })
})
