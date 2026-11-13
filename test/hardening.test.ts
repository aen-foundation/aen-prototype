// HTTPS only, input checks against the action's own schema, personal-data disclosure, and re-reading a changed schema.
import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createClient } from '../src/adapter/client.ts'
import { startCafe } from '../src/business/cafe.ts'
import { startDirectory } from '../src/directory/server.ts'

const form = { 'content-type': 'application/x-www-form-urlencoded' }
const listen = (handler: Parameters<typeof createServer>[1], port: number) => {
	const s = createServer(handler)
	return new Promise<{ close(): void }>((resolve) => s.listen(port, '127.0.0.1', () => resolve({ close: () => (s.closeAllConnections(), s.close()) })))
}

describe('HTTPS', () => {
	it('the directory refuses plain http for anything but loopback, before fetching', async () => {
		const d = await startDirectory({ port: 4700, allowPrivate: true })
		try {
			const r = await fetch(`${d.url}/register`, { method: 'POST', body: JSON.stringify({ url: 'http://shop.example.org' }) })
			expect(r.status).toBe(422)
			expect(((await r.json()) as { error: string }).error).toContain('https is required')
		} finally {
			await d.close()
		}
	})
})

describe('requests are checked against the action schema, and personal data is disclosed', () => {
	let dir: Awaited<ReturnType<typeof startDirectory>>
	let cafe: Awaited<ReturnType<typeof startCafe>>
	const ID = '127.0.0.1:4711'
	const agent = () => createClient(dir.url, { allowPrivate: true, cacheMs: 0 })
	const good = { message: 'Do you have oat milk?', email: 'sam@example.org' }
	async function approved(a: ReturnType<typeof agent>, action: string, input: Record<string, unknown>) {
		const r = await a.callAction(ID, action, input, true)
		if (r.ok || r.error !== 'authorization_required') return r
		await fetch(`${cafe.url}/device/decision`, { method: 'POST', headers: form, body: `user_code=${r.userCode}&decision=approve` })
		return a.callAction(ID, action, input, true)
	}

	beforeAll(async () => {
		dir = await startDirectory({ port: 4710, allowPrivate: true })
		cafe = await startCafe({ port: 4711 })
		await fetch(`${dir.url}/register`, { method: 'POST', body: JSON.stringify({ url: cafe.url }) })
	})
	afterAll(async () => {
		await cafe.close()
		await dir.close()
	})

	it('refuses a request with a missing or mistyped field, before any confirmation or access request', async () => {
		const a = agent()
		for (const bad of [{ email: 'sam@example.org' }, { message: 42, email: 'sam@example.org' }, { message: 'hi', email: 'not-an-email' }]) {
			const r = await a.callAction(ID, 'contact.request', bad)
			expect(r).toMatchObject({ ok: false, error: 'invalid_input' }) // not confirmation_required, not authorization_required
		}
		expect(cafe.enquiries).toHaveLength(0)
	})

	it('sends only the fields the action declares', async () => {
		const a = agent()
		expect(await a.callAction(ID, 'contact.request', { ...good, phone: '+94 77 123 4567' })).toMatchObject({ ok: false, error: 'invalid_input', message: expect.stringContaining('"phone" is not declared') })
		// also when the schema does not say additionalProperties: false
		expect(await a.callAction(ID, 'order.create', { items: [{ serviceId: 'espresso', quantity: 1 }], coupon: 'FREE' })).toMatchObject({ ok: false, error: 'invalid_input' })
	})

	it('tells the user which personal data a call shares, before they confirm', async () => {
		const r = await agent().callAction(ID, 'contact.request', good)
		expect(r).toMatchObject({ ok: false, error: 'confirmation_required', shares: [{ field: 'email', kind: 'email', purpose: expect.stringContaining('reply') }] })
		expect((r as { message: string }).message).toContain('personal data')
		expect(await agent().describeAction(ID, 'contact.request')).toMatchObject({ sharesPersonalData: [{ field: 'email' }] })
	})

	it('delivers a confirmed message', async () => {
		const r = await approved(agent(), 'contact.request', good)
		expect(r).toMatchObject({ ok: true, status: 201 })
		expect(cafe.enquiries).toEqual([expect.objectContaining(good)])
	})
})

describe('a hostile or odd action schema', () => {
	const ID = '127.0.0.1:4721'
	const doc = (input: object) => ({ aen: '0.1', id: ID, kind: 'business', name: 'Odd', url: `http://${ID}`, actions: [{ id: 'find', capability: 'catalog.search', method: 'GET', path: '/find', input, auth: { type: 'none' }, sideEffects: false }] })
	let schema: object = {}
	let dir: Awaited<ReturnType<typeof startDirectory>>
	let biz: { close(): void }
	const hits: string[] = []

	beforeAll(async () => {
		biz = await listen((q, res) => {
			res.setHeader('content-type', 'application/json')
			if (q.url === '/.well-known/aen.json') return res.end(JSON.stringify(doc(schema)))
			hits.push(q.url!)
			res.end('{"ok":true}')
		}, 4721)
		dir = await startDirectory({ port: 4720, allowPrivate: true })
	})
	afterAll(async () => {
		biz.close()
		await dir.close()
	})
	const use = async (s: object, input: Record<string, unknown>) => {
		schema = s
		await fetch(`${dir.url}/register`, { method: 'POST', body: JSON.stringify({ url: `http://${ID}` }) })
		return createClient(dir.url, { allowPrivate: true, cacheMs: 0 }).callAction(ID, 'find', input)
	}

	it('does not hang on a regular expression designed to (the pattern keyword is not run)', async () => {
		const t = Date.now()
		const r = await use({ type: 'object', properties: { q: { type: 'string', pattern: '^(a+)+$' } } }, { q: 'a'.repeat(45) + '!' })
		expect(r).toMatchObject({ ok: true })
		expect(Date.now() - t).toBeLessThan(2000)
	})

	it('still refuses an unknown field and keeps a property that happens to be called "pattern"', async () => {
		const s = { type: 'object', required: ['pattern'], properties: { pattern: { type: 'string' } } }
		expect(await use(s, {})).toMatchObject({ ok: false, error: 'invalid_input' })
		expect(await use(s, { pattern: 'x' })).toMatchObject({ ok: true })
	})

	it('skips a schema that is too large instead of failing, and the business still decides', async () => {
		const big = { type: 'object', properties: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`field${i}`, { type: 'string', description: 'x'.repeat(20) }])) }
		expect(await use(big, { field1: 'a' })).toMatchObject({ ok: true })
	})
})

describe('a business that changes its schema while the agent has the old one', () => {
	const ID = '127.0.0.1:4731'
	let version = 1
	let alwaysMissing = false
	const hits: string[] = []
	let dir: Awaited<ReturnType<typeof startDirectory>>
	let biz: { close(): void }
	const doc = () => ({ aen: '0.1', id: ID, kind: 'business', name: 'Mover', url: `http://${ID}`, actions: [{ id: 'menu', capability: 'catalog.search', method: 'GET', path: `/v${version}/menu`, auth: { type: 'none' }, sideEffects: false }] })

	beforeAll(async () => {
		biz = await listen((q, res) => {
			res.setHeader('content-type', 'application/json')
			if (q.url === '/.well-known/aen.json') return res.end(JSON.stringify(doc()))
			hits.push(q.url!)
			if (alwaysMissing || q.url !== `/v${version}/menu`) return (res.statusCode = 404), res.end('{"error":"not_found"}')
			res.end('{"items":[]}')
		}, 4731)
		dir = await startDirectory({ port: 4730, allowPrivate: true })
		await fetch(`${dir.url}/register`, { method: 'POST', body: JSON.stringify({ url: `http://${ID}` }) })
	})
	afterAll(async () => {
		biz.close()
		await dir.close()
	})

	it('re-reads the schema when a call fails, and retries once if it changed', async () => {
		const a = createClient(dir.url, { allowPrivate: true, cacheMs: 60_000 })
		expect(await a.callAction(ID, 'catalog.search')).toMatchObject({ ok: true }) // caches v1
		version = 2 // the business moves its endpoint
		hits.length = 0
		expect(await a.callAction(ID, 'catalog.search')).toMatchObject({ ok: true })
		expect(hits).toEqual(['/v1/menu', '/v2/menu']) // stale path failed, then the new one worked
	})

	it('does not loop when the schema did not change and the business really says not found', async () => {
		alwaysMissing = true
		const a = createClient(dir.url, { allowPrivate: true, cacheMs: 60_000 })
		hits.length = 0
		expect(await a.callAction(ID, 'catalog.search')).toMatchObject({ ok: false, error: 'business_error' })
		expect(hits).toEqual(['/v2/menu']) // one request, no retry
		alwaysMissing = false
	})
})
