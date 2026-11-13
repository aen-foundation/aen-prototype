// The Gemini UI, against a scripted fake of the Gemini API (no key, no network): the model's tool use, and above all
// that the model cannot confirm anything itself.
import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startCafe } from '../src/business/cafe.ts'
import { startDirectory } from '../src/directory/server.ts'
import { startUi } from '../src/ui/server.ts'

const KEY = 'test-key-not-real-123'
type Req = { headers: Record<string, unknown>; body: { contents: { role: string; parts: Record<string, any>[] }[] } }

describe('Gemini UI', () => {
	const queue: object[] = []
	const seen: Req[] = []
	let fake: ReturnType<typeof createServer>
	let dir: Awaited<ReturnType<typeof startDirectory>>
	let cafe: Awaited<ReturnType<typeof startCafe>>
	let ui: Awaited<ReturnType<typeof startUi>>

	const call = (name: string, args: object, extra: object = {}) => ({ role: 'model', parts: [{ functionCall: { name, args }, ...extra }] })
	const say = (t: string) => ({ role: 'model', parts: [{ text: t }] })
	const post = async (path: string, body: object, headers: Record<string, string> = { 'x-aen-ui': '1' }) => {
		const r = await fetch(`${ui.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ sessionId: 'session-test-1', ...body }) })
		return { status: r.status, data: (await r.json()) as any }
	}
	const lastResult = () => seen.at(-1)!.body.contents.at(-1)!.parts[0].functionResponse.response.result
	const order = { items: [{ serviceId: 'espresso', quantity: 2 }] }
	const ID = '127.0.0.1:4152'

	beforeAll(async () => {
		fake = createServer((req, res) => {
			let b = ''
			req.on('data', (c) => (b += c))
			req.on('end', () => {
				seen.push({ headers: req.headers, body: JSON.parse(b) })
				const next = queue.shift()
				res.setHeader('content-type', 'application/json')
				if (!next) return (res.statusCode = 500), res.end(JSON.stringify({ error: { message: 'script ran out' } }))
				if ('error' in next) return (res.statusCode = 400), res.end(JSON.stringify(next))
				res.end(JSON.stringify({ candidates: [{ content: next }] }))
			})
		})
		await new Promise<void>((r) => fake.listen(4150, '127.0.0.1', r))
		dir = await startDirectory({ port: 4151, allowPrivate: true })
		cafe = await startCafe({ port: 4152, stepMs: 50 })
		await fetch(`${dir.url}/register`, { method: 'POST', body: JSON.stringify({ url: cafe.url }) })
		ui = await startUi({ port: 4153, directoryUrl: dir.url, gemini: { apiKey: KEY, model: 'fake-model', baseUrl: 'http://127.0.0.1:4150' } })
	})
	afterAll(async () => {
		await ui.close()
		await cafe.close()
		await dir.close()
		fake.closeAllConnections()
		fake.close()
	})

	it('runs the whole shopping flow, and only the user can confirm the order', async () => {
		queue.push(
			call('aen_search', { capability: 'order.create', category: 'coffee' }, { thoughtSignature: 'sig-abc' }),
			call('aen_get_business', { id: ID }),
			// the model tries to confirm by itself:
			call('aen_call_action', { businessId: ID, action: 'order.create', inputJson: JSON.stringify(order), userConfirmed: true }),
			say('I will order 2 espressos ($7.00). Please confirm.')
		)
		const t1 = await post('/api/chat', { text: 'Order two espressos' })
		expect(t1.status).toBe(200)
		expect(t1.data.reply).toContain('confirm')
		expect(t1.data.events.map((e: any) => e.type)).toEqual(['tool', 'tool', 'confirm', 'tool'])
		expect(t1.data.events.some((e: any) => e.type === 'payment')).toBe(false) // nothing was ordered
		expect(lastResult()).toMatchObject({ error: 'confirmation_required' })

		const confirmId = t1.data.events.find((e: any) => e.type === 'confirm').id
		queue.push(call('aen_call_action', { businessId: ID, action: 'order.create', inputJson: JSON.stringify(order) }), say('Please approve access at the link.'))
		const t2 = await post('/api/confirm', { id: confirmId, decision: 'approve' })
		const auth = t2.data.events.find((e: any) => e.type === 'authorization')
		expect(auth.uri.startsWith(cafe.url)).toBe(true)

		await fetch(`${cafe.url}/device/decision`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `user_code=${auth.userCode}&decision=approve` })
		queue.push(call('aen_call_action', { businessId: ID, action: 'order.create', inputJson: JSON.stringify(order) }), say('Pay on the page.'))
		const t3 = await post('/api/chat', { text: 'I approved access. Please continue.' })
		const pay = t3.data.events.find((e: any) => e.type === 'payment')
		expect(pay).toMatchObject({ amount: 700, currency: 'USD' })
		expect(pay.url.startsWith(cafe.url)).toBe(true)
	})

	it('shows the user which personal data a message shares before they confirm', async () => {
		queue.push(call('aen_call_action', { businessId: ID, action: 'contact.request', inputJson: JSON.stringify({ message: 'Do you have oat milk?', email: 'sam@example.org' }) }), say('I will send that. Please confirm.'))
		const t = await post('/api/chat', { text: 'ask the cafe about oat milk' })
		const c = t.data.events.find((e: any) => e.type === 'confirm')
		expect(c.shares).toEqual([{ field: 'email', kind: 'email', purpose: expect.stringContaining('reply') }])
		expect(c.input).toMatchObject({ email: 'sam@example.org' })
	})

	it('sends the key only to Gemini, in a header, and never to the browser', async () => {
		expect(seen.length).toBeGreaterThan(0)
		for (const r of seen) expect(r.headers['x-goog-api-key']).toBe(KEY)
		const page = await (await fetch(ui.url)).text()
		const state = JSON.stringify(await (await fetch(`${ui.url}/api/state`, { headers: { 'x-aen-ui': '1' } })).json())
		expect(page + state).not.toContain(KEY)
	})

	it('hands Gemini its own turn back untouched (thought signatures survive)', async () => {
		const withSig = seen.find((r) => r.body.contents.some((c) => c.parts.some((p) => p.thoughtSignature === 'sig-abc')))
		expect(withSig).toBeTruthy()
	})

	it('a cancelled request cannot be confirmed afterwards', async () => {
		queue.push(call('aen_call_action', { businessId: ID, action: 'order.create', inputJson: JSON.stringify({ items: [{ serviceId: 'croissant', quantity: 1 }] }) }), say('Waiting for your confirmation.'))
		const t = await post('/api/chat', { text: 'Order a croissant' })
		const id = t.data.events.find((e: any) => e.type === 'confirm').id
		queue.push(say('Cancelled.'))
		expect((await post('/api/confirm', { id, decision: 'deny' })).status).toBe(200)
		expect((await post('/api/confirm', { id, decision: 'approve' })).status).toBe(404)
	})

	it('treats unparsable tool input as an error instead of acting', async () => {
		queue.push(call('aen_call_action', { businessId: ID, action: 'order.create', inputJson: '{not json' }), say('Sorry, that failed.'))
		const t = await post('/api/chat', { text: 'order' })
		expect(t.data.events.find((e: any) => e.type === 'tool').ok).toBe(false)
		expect(t.data.events.some((e: any) => e.type === 'confirm')).toBe(false)
	})

	it('reports a Gemini error without crashing, and keeps a long message that names the replacement model', async () => {
		queue.push({ error: { message: 'This model models/old-model is no longer available to new users. ' + 'x'.repeat(250) + ' Please update your code to use models/new-model.' } })
		const t = await post('/api/chat', { text: 'hello' })
		expect(t.status).toBe(502)
		expect(t.data.message).toContain('no longer available')
		expect(t.data.message).toContain('models/new-model') // past the old 200-character cut-off
		expect(JSON.stringify(t.data)).not.toContain(KEY)
	})

	it('only answers the page itself: no header or a foreign origin is refused', async () => {
		expect((await post('/api/chat', { text: 'hi' }, {})).status).toBe(403)
		expect((await post('/api/chat', { text: 'hi' }, { 'x-aen-ui': '1', origin: 'https://evil.example' })).status).toBe(403)
	})

	it('says clearly when no API key is set', async () => {
		const bare = await startUi({ port: 4154, directoryUrl: dir.url, gemini: { apiKey: '' } })
		try {
			const r = await fetch(`${bare.url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aen-ui': '1' }, body: JSON.stringify({ text: 'hi' }) })
			expect(r.status).toBe(503)
			expect(((await r.json()) as { error: string }).error).toBe('no_api_key')
		} finally {
			await bare.close()
		}
	})

	// Runs only when a real key is in the environment: checks the real Gemini API accepts our tool format.
	it.skipIf(!process.env.GEMINI_API_KEY)('works against the real Gemini API', async () => {
		const live = await startUi({ port: 4155, directoryUrl: dir.url })
		try {
			const r = await fetch(`${live.url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aen-ui': '1' }, body: JSON.stringify({ sessionId: 'live-session-1', text: 'Find a coffee shop that takes orders.' }) })
			const d = (await r.json()) as { events: { type: string; name?: string }[]; reply: string }
			expect(r.status).toBe(200)
			expect(d.events.some((e) => e.type === 'tool' && e.name === 'aen_search')).toBe(true)
		} finally {
			await live.close()
		}
	}, 60_000)
})
