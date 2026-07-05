import { describe, expect, test } from 'vitest'
import { T234_SDRAM_CFG_LAYOUT, T264_SDRAM_CFG_LAYOUT } from '../src/bct/sdramCfg'
import { T124_BCT_LAYOUT, T132_BCT_LAYOUT, T210_BCT_LAYOUT } from '../src/bct/v1'
import { T186_MB1_BCT_LAYOUT } from '../src/bct/v2/mb1Bct'
import { T234_MB1_NV_HEADER_LAYOUT } from '../src/bct/v2/mb1NvHeader'
import { CHIP_PROFILES, chipProfile } from '../src/chips'
import { appletLoadAddress, Chip } from '../src/constants'
import { RcmError } from '../src/errors'
import {
  T186_PAYLOAD_OFFSET,
  T194_PAYLOAD_OFFSET,
  T210_PAYLOAD_OFFSET,
  T234_PAYLOAD_OFFSET,
  T264_PAYLOAD_OFFSET
} from '../src/rcm'

describe('chip profile registry', () => {
  test('covers every known chip id', () => {
    for (const chip of Object.values(Chip)) {
      expect(chipProfile(chip).chip).toBe(chip)
    }
  })

  test('rejects an unknown chip id', () => {
    expect(() => chipProfile(0x99 as Chip)).toThrow(RcmError)
  })

  test('applet load addresses agree with the constants map', () => {
    for (const profile of Object.values(CHIP_PROFILES)) {
      expect(profile.appletLoadAddress).toBe(appletLoadAddress(profile.chip))
    }
  })

  test('v1 family shares the v1 RCM framing offsets', () => {
    expect(chipProfile(Chip.T210).rcm?.payloadOffset).toBe(T210_PAYLOAD_OFFSET)
    expect(chipProfile(Chip.T124).rcm?.payloadOffset).toBe(T210_PAYLOAD_OFFSET)
    expect(chipProfile(Chip.T132).rcm?.payloadOffset).toBe(T210_PAYLOAD_OFFSET)
  })

  test('T186/T194/T234/T264 use their v2/extended framings', () => {
    expect(chipProfile(Chip.T186).rcm?.payloadOffset).toBe(T186_PAYLOAD_OFFSET)
    expect(chipProfile(Chip.T194).rcm?.payloadOffset).toBe(T194_PAYLOAD_OFFSET)
    expect(chipProfile(Chip.T234).rcm?.payloadOffset).toBe(T234_PAYLOAD_OFFSET)
    expect(chipProfile(Chip.T264).rcm?.payloadOffset).toBe(T264_PAYLOAD_OFFSET)
  })

  test('sdram cfg layouts match their BCT strides', () => {
    expect(chipProfile(Chip.T210).sdramCfg?.setSize).toBe(T210_BCT_LAYOUT.sdramSetStride)
    for (const chip of [Chip.T124, Chip.T132]) {
      expect(chipProfile(chip).sdramCfg?.setSize).toBe(T124_BCT_LAYOUT.sdramSetStride)
    }
    expect(chipProfile(Chip.T186).sdramCfg?.setSize).toBe(T186_MB1_BCT_LAYOUT.sdramSetStride)
    expect(chipProfile(Chip.T234).sdramCfg).toBe(T234_SDRAM_CFG_LAYOUT)
    expect(chipProfile(Chip.T264).sdramCfg).toBe(T264_SDRAM_CFG_LAYOUT)
  })

  test('BCT layouts hang off the right family', () => {
    expect(chipProfile(Chip.T210).family).toBe('v1')
    expect(chipProfile(Chip.T210).bct).toBe(T210_BCT_LAYOUT)

    expect(chipProfile(Chip.T124).family).toBe('v1')
    expect(chipProfile(Chip.T124).bct).toBe(T124_BCT_LAYOUT)
    expect(chipProfile(Chip.T124).brBct).toBeUndefined()

    expect(chipProfile(Chip.T132).family).toBe('v1')
    expect(chipProfile(Chip.T132).bct).toBe(T132_BCT_LAYOUT)
    expect(chipProfile(Chip.T132).brBct).toBeUndefined()

    const t186 = chipProfile(Chip.T186)
    expect(t186.family).toBe('v2')
    expect(t186.bct).toBeUndefined()
    expect(t186.mb1Bct).toBe(T186_MB1_BCT_LAYOUT)
  })

  test('T234/T264 share the MB1 NV header wrapper layout, distinct from T186 mb1Bct', () => {
    expect(chipProfile(Chip.T234).mb1NvHeader).toBe(T234_MB1_NV_HEADER_LAYOUT)
    expect(chipProfile(Chip.T264).mb1NvHeader).toBe(T234_MB1_NV_HEADER_LAYOUT)
    expect(chipProfile(Chip.T234).mb1Bct).toBeUndefined()
    expect(chipProfile(Chip.T194).mb1NvHeader).toBeUndefined()
  })
})
