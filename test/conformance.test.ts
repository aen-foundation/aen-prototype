// Conformance: the spec's example documents. Any implementation, in any language, should agree with these.
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { descriptor } from '../src/business/cafe.ts'
import { validate } from '../src/validate.ts'

const load = (dir: string) =>
	readdirSync(new URL(`../spec/examples/${dir}/`, import.meta.url)).map((f) => [f, JSON.parse(readFileSync(new URL(`../spec/examples/${dir}/${f}`, import.meta.url), 'utf8'))] as const)

describe('descriptor examples', () => {
	for (const [name, doc] of load('valid')) it(`accepts valid/${name}`, () => expect(validate('descriptor', doc)).toEqual({ ok: true }))
	for (const [name, doc] of load('invalid')) it(`rejects invalid/${name}`, () => expect(validate('descriptor', doc).ok).toBe(false))
	it('accepts the descriptor the sample cafe really serves', () => expect(validate('descriptor', descriptor('http://127.0.0.1:4101', []))).toEqual({ ok: true }))
})

describe('response schemas', () => {
	const handoff = { status: 'requires_user_approval', orderId: 'abcdef12-0000', amount: { amount: 700, currency: 'USD' }, handoffUrl: 'https://pay.example/x', expiresAt: '2026-11-13T12:00:00Z', provider: 'test-pay' }
	it('accepts a payment hand-off', () => expect(validate('payment-handoff', handoff).ok).toBe(true))
	it('rejects a payment hand-off carrying card data', () => expect(validate('payment-handoff', { ...handoff, cardNumber: '4242424242424242' }).ok).toBe(false))
	it('rejects a hand-off that already claims to be paid', () => expect(validate('payment-handoff', { ...handoff, status: 'paid' }).ok).toBe(false))
	it('rejects an unknown order status', () => expect(validate('order-status', { orderId: 'abcdef12-0000', status: 'teleported', updatedAt: '2026-11-13T12:00:00Z' }).ok).toBe(false))
})
