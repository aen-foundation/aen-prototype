import { describe, expect, it } from 'vitest'

import { jcs, keyFingerprint, makeDpopKey, makeReplayGuard, makeSigningKey, signDescriptor, verifyDpop, verifySignature } from '../src/crypto.ts'
import { isPrivateAddress } from '../src/safe-fetch.ts'
import { validate } from '../src/validate.ts'

describe('canonical JSON', () => {
	it('does not depend on key order or whitespace', () => expect(jcs({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}'))
})

describe('signed descriptors', () => {
	const key = makeSigningKey()
	const doc = signDescriptor({ aen: '0.1', id: 'x.example.org', kind: 'business', name: 'X' }, key)
	it('verifies, and the signed document still matches the schema', () => {
		expect(verifySignature(doc)).toBe(true)
		expect(validate('descriptor', doc).ok).toBe(true)
	})
	it('fails if anything is changed after signing', () => expect(verifySignature({ ...doc, name: 'Y' } as typeof doc)).toBe(false))
	it('fails under another key', () => expect(verifySignature({ ...doc, signing: { ...doc.signing, publicKey: makeSigningKey().publicKey } })).toBe(false))
	it('has a stable fingerprint to pin in DNS', () => expect(keyFingerprint(key.publicKey)).toMatch(/^sha256:[0-9a-f]{64}$/))
})

describe('DPoP-style proofs', () => {
	const k = makeDpopKey()
	const ok = (proof: string | undefined, o: Partial<Parameters<typeof verifyDpop>[1]> = {}) => verifyDpop(proof, { method: 'GET', url: 'https://b.example/orders/1?x=1', fresh: makeReplayGuard(), ...o })
	it('accepts a proof for exactly this request', () => expect(ok(k.proof('GET', 'https://b.example/orders/1'))).toBe(k.jkt))
	it('rejects another method, another path, a missing proof and garbage', () => {
		expect(ok(k.proof('POST', 'https://b.example/orders/1'))).toBeNull()
		expect(ok(k.proof('GET', 'https://b.example/orders/2'))).toBeNull()
		expect(ok(undefined)).toBeNull()
		expect(ok('a.b.c')).toBeNull()
	})
	it('rejects a replayed proof', () => {
		const fresh = makeReplayGuard()
		const p = k.proof('GET', 'https://b.example/orders/1')
		expect(ok(p, { fresh })).toBe(k.jkt)
		expect(ok(p, { fresh })).toBeNull()
	})
	it('binds to the access token', () => {
		expect(ok(k.proof('GET', 'https://b.example/orders/1', 'tok'), { accessToken: 'tok' })).toBe(k.jkt)
		expect(ok(k.proof('GET', 'https://b.example/orders/1', 'tok'), { accessToken: 'other' })).toBeNull()
	})
})

describe('private addresses', () => {
	it.each(['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1'])('treats %s as private', (ip) => expect(isPrivateAddress(ip)).toBe(true))
	it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('treats %s as public', (ip) => expect(isPrivateAddress(ip)).toBe(false))
})
