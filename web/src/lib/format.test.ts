import { describe, expect, it } from 'vitest'
import { ApiError } from './api-client'
import { errorText, formatInput, formatPrice, plainPrice } from './format'

describe('amounts the form fills in', () => {
  it('keeps six decimals, or six significant digits for small amounts, rounding down', () => {
    expect(formatInput(123_456_789_123_456_789_000n, 18)).toBe('123.456789')
    expect(formatInput(12_345_678n, 18)).toBe('0.0000000000123456')
    expect(formatInput(3_000_000n, 6)).toBe('3')
    expect(formatInput(0n, 18)).toBe('')
  })
})

describe('prices', () => {
  it('shows six significant digits', () => {
    expect(formatPrice(0.0297123456)).toBe('0.0297123')
    expect(formatPrice(33.65579)).toBe('33.6558')
    expect(formatPrice(Number.NaN)).toBe('unavailable')
  })

  it('never shows exponent notation', () => {
    expect(formatPrice(1.68468e-8)).toBe('0.0₇1685')
    expect(formatPrice(0.00001)).toBe('0.0₄1')
    expect(formatPrice(59_358_000)).toBe('59.36M')
    expect(formatPrice(2.5e9)).toBe('2.5B')
    expect(formatPrice(12_345.678)).toBe('12,345.68')
  })

  it('gives typeable prices for fields', () => {
    expect(plainPrice(1.68468e-8)).toBe('0.0000000168468')
    expect(plainPrice(33.65579)).toBe('33.6558')
    expect(plainPrice(0)).toBe('')
  })
})

describe('error messages', () => {
  it('explains known API codes and leaves others as they are', () => {
    expect(errorText(new ApiError('BOTH_TOKENS_REQUIRED', 422))).toMatch(/both tokens/)
    expect(errorText(new ApiError('INTERNAL_ERROR', 500))).toBe('The service could not complete this request. Try again in a moment.')
    expect(errorText(new ApiError('SOMETHING_NEW', 422))).toBe('SOMETHING_NEW')
  })
})
