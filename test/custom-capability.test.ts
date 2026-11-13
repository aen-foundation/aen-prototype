// AEN does not define every industry's payloads. A business can offer a capability AEN has never heard of, described
// by its own schema, and an agent can use it through the same client with the same safety rules.
import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createClient } from '../src/adapter/client.ts'
import { startDirectory } from '../src/directory/server.ts'

const ID = '127.0.0.1:4171'
const descriptor = {
	aen: '0.1', id: ID, kind: 'business', name: 'Harbour Spa', url: `http://${ID}`, categories: ['wellness'], keywords: ['massage'],
	actions: [
		{
			id: 'book-massage', capability: 'x.spa.book', method: 'POST', path: '/massages', description: 'Book a 60 minute massage.',
			input: { type: 'object', required: ['slot', 'therapist'], properties: { slot: { type: 'string' }, therapist: { enum: ['any', 'female', 'male'] } } },
			output: { type: 'object', properties: { bookingId: { type: 'string' } } }, auth: { type: 'none' }, sideEffects: true, requiresUserConfirmation: true
		}
	]
}

describe('a capability AEN has no schema for', () => {
	let dir: Awaited<ReturnType<typeof startDirectory>>
	let spa: ReturnType<typeof createServer>
	const bookings: unknown[] = []

	beforeAll(async () => {
		spa = createServer((req, res) => {
			res.setHeader('content-type', 'application/json')
			if (req.url === '/.well-known/aen.json') return res.end(JSON.stringify(descriptor))
			let b = ''
			req.on('data', (c) => (b += c))
			req.on('end', () => (bookings.push(JSON.parse(b)), res.statusCode = 201, res.end(JSON.stringify({ bookingId: 'b-1234567' }))))
		})
		await new Promise<void>((r) => spa.listen(4171, '127.0.0.1', r))
		dir = await startDirectory({ port: 4170, allowPrivate: true })
		await fetch(`${dir.url}/register`, { method: 'POST', body: JSON.stringify({ url: `http://${ID}` }) })
	})
	afterAll(async () => {
		await dir.close()
		spa.closeAllConnections()
		spa.close()
	})

	it('is found by its search keys and the unknown capability', async () => {
		const agent = createClient(dir.url, { allowPrivate: true, cacheMs: 0 })
		const hit = (await agent.search(undefined, undefined, 'x.spa.book')) as { results: { id: string; capabilities: string[] }[] }
		expect(hit.results[0]).toMatchObject({ id: ID, capabilities: ['x.spa.book'] })
	})

	it('describes itself: the agent gets the business-defined input, output and description on request', async () => {
		const agent = createClient(dir.url, { allowPrivate: true, cacheMs: 0 })
		expect(await agent.describeAction(ID, 'x.spa.book')).toMatchObject({
			input: { required: ['slot', 'therapist'] }, output: { properties: { bookingId: {} } }, untrusted_description: 'Book a 60 minute massage.', sideEffects: true
		})
	})

	it('is called by capability, with the same confirmation rule as every side effect', async () => {
		const agent = createClient(dir.url, { allowPrivate: true, cacheMs: 0 })
		const input = { slot: '2026-11-20T10:00:00Z', therapist: 'any' }
		expect(await agent.callAction(ID, 'x.spa.book', input)).toMatchObject({ ok: false, error: 'confirmation_required' })
		expect(bookings).toHaveLength(0)
		expect(await agent.callAction(ID, 'x.spa.book', input, true)).toMatchObject({ ok: true, status: 201, body: { bookingId: 'b-1234567' } })
		expect(bookings).toEqual([input])
	})
})
