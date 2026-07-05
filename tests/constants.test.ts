import { describe, expect, test } from 'vitest'
import {
  APPLET_LOAD_ADDR_DEFAULT,
  APPLET_LOAD_ADDR_T132,
  APPLET_LOAD_ADDR_T186,
  appletLoadAddress,
  APX_PID_MASK,
  ApxProductId,
  Chip,
  DeviceFilters,
  VENDOR_NVIDIA
} from '../src/constants'

describe('DeviceFilters', () => {
  test('matches the NVIDIA vendor id with no product id', () => {
    expect(VENDOR_NVIDIA).toBe(0x0955)
    expect(DeviceFilters).toEqual([{ vendorId: 0x0955 }])
  })
})

describe('ApxProductId (cross-checked vs L4T flash.sh / board targets)', () => {
  test('Orin (T234) and Thor (T264) recovery PIDs', () => {
    // R39.2.0 (Thor BSP): _nv_base_orin_target uses pid 0x7023, _nv_base_thor
    // pid 0x7026; flash.sh drives chip 0x23 and 0x26 respectively.
    expect(Chip.T234).toBe(0x23)
    expect(Chip.T264).toBe(0x26)
    expect(ApxProductId.t234).toContain(0x7023)
    expect(ApxProductId.thor).toEqual([0x7026])
  })

  test('all T234 board-variant PIDs collapse to 0x7023 under the APX pidmask', () => {
    // recovery_status() matches vid=0x0955, pid & 0xF0FF — so every t234
    // variant (0x7023/0x7223/…/0x7623) is the same recovery device.
    expect(APX_PID_MASK).toBe(0xf0ff)
    for (const pid of ApxProductId.t234) expect(pid & APX_PID_MASK).toBe(0x7023)
    expect(0x7026 & APX_PID_MASK).toBe(0x7026)
  })
})

describe('appletLoadAddress', () => {
  test('T132 loads its preboot lower at 0x4000f000', () => {
    expect(appletLoadAddress(Chip.T132)).toBe(APPLET_LOAD_ADDR_T132)
  })

  test('the v2 family (T186/T194/T234) downloads to 0x40020000', () => {
    // NvTegraRcmGetAppletAddress maps 0x18/0x19/0x23 -> 0x40020000; T194's is
    // also confirmed by tests/golden/t194_rcm_1.rcm (EntryAddress @0x700).
    expect(APPLET_LOAD_ADDR_T186).toBe(0x40020000)
    expect(appletLoadAddress(Chip.T186)).toBe(0x40020000)
    expect(appletLoadAddress(Chip.T194)).toBe(0x40020000)
    expect(appletLoadAddress(Chip.T234)).toBe(0x40020000)
  })

  test('other chips use the default 0x40010000', () => {
    expect(appletLoadAddress(Chip.T210)).toBe(APPLET_LOAD_ADDR_DEFAULT)
    expect(appletLoadAddress(Chip.T124)).toBe(APPLET_LOAD_ADDR_DEFAULT)
  })
})
