import { describe, expect, test } from 'vitest'
import { BctError, RcmError, ReacquireNeededError, SignError, TegraUsbError } from '../src/errors'

describe('error hierarchy', () => {
  test('subclasses carry their own name and extend TegraUsbError', () => {
    const rcm = new RcmError('bad frame')
    expect(rcm.name).toBe('RcmError')
    expect(rcm.message).toBe('bad frame')
    expect(rcm).toBeInstanceOf(TegraUsbError)
    expect(rcm).toBeInstanceOf(Error)
    expect(new BctError('x').name).toBe('BctError')
    expect(new SignError('x').name).toBe('SignError')
  })

  test('forwards the error cause', () => {
    const cause = new Error('root')
    expect(new TegraUsbError('wrapped', { cause }).cause).toBe(cause)
  })

  test('ReacquireNeededError explains the reacquire flow', () => {
    const error = new ReacquireNeededError()
    expect(error.name).toBe('ReacquireNeededError')
    expect(error).toBeInstanceOf(TegraUsbError)
    expect(error.message).toMatch(/requestDevice\(\)/)
  })
})
