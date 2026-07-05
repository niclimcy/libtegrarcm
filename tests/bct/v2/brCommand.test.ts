import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { packBrCommandFragment, parseBrCommandCfg } from '../../../src/bct/v2/brCommand'
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

describe('T186 MB1-BCT brcommand fragment (cfg -> block, vs P2771 golden)', () => {
  const cfg = parseBrCommandCfg(mb1cfg('bootrom.cfg'))

  test('parses two aoblocks each with one 2-command I2C block', () => {
    expect(cfg.aoblocks.length).toBe(2)
    expect(cfg.aoblocks[0]?.[0]?.commands.length).toBe(2)
    expect(cfg.aoblocks[0]?.[0]?.slaveAdd).toBe(0x3c)
  })

  test('packs byte-exact to the brcommand block [0xbb84, 0xbbc4)', () => {
    const block = packBrCommandFragment(cfg)
    expect(block).toEqual(golden('t186_p2771_mb1.bct').subarray(0xbb84, 0xbbc4))
  })
})

describe('brcommand cfg command-index validation', () => {
  test('rejects a block with a gap in its command indices', () => {
    const cfg = [
      'bootrom.major = 1;',
      'bootrom.minor = 0;',
      'bootrom.aoblock-count = 1;',
      'bootrom.aoblock[0].block-count = 1;',
      'bootrom.aoblock[0].block[0].slave-add = 0x10;',
      'bootrom.aoblock[0].block[0].reg-data-size = 8;',
      'bootrom.aoblock[0].block[0].reg-add-size = 8;',
      'bootrom.aoblock[0].block[0].commands[0].0x00 = 0x1;',
      'bootrom.aoblock[0].block[0].commands[2].0x02 = 0x3;' // index 1 missing
    ].join('\n')
    expect(() => parseBrCommandCfg(cfg)).toThrow(BctError)
  })
})
