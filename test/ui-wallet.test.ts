// UI wallet payment: one click pays, the model never sees the token, and nothing but the user's click can pay.
import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startCafe } from '../src/business/cafe.ts'
import { startDirectory } from '../src/directory/server.ts'
import { createTestPayments } from '../src/payments/test-wallet.ts'
import { startUi } from '../src/ui/server.ts'

const ID = '127.0.0.1:4621'
type Req = { body: unknown }

describe('UI wallet payment', () => {
	const queue: object[] = []
	const seen: Req[] = []
	const { wallet, psp } = createTestPayments()
	let fake: ReturnType<typeof createServer>
	let dir: Awaited<ReturnType<typeof startDirectory>>
	let cafe: Awaited<ReturnType<typeof startCafe>>
	let ui: Awaited<ReturnType<typeof startUi>>

	const call = (name: string, args: object) => ({ role: 'model', parts: [{ functionCall: { name, args } }] })
	const say = (t: string) => ({ role: 'model', parts: [{ text: t }] })
	const post = async (path: string, body: object, sessionId = 'wallet-session-1') => {
		const r = await fetch(`${ui.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-aen-ui': '1' }, body: JSON.stringify({ sessionId, ...body }) })
		return { status: r.status, data: (await r.json()) as any }
	}
	const decide = (userCode: string) => fetch(`${cafe.url}/device/decision`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `user_code=${userCode}&decision=approve` })

	/** Gets an order to the payment card, playing the user. */
	async function toPayment(sessionId: string, items: object[]) {
		const input = JSON.stringify({ items })
		queue.push(call('aen_call_action', { businessId: ID, action: 'order.create', inputJson: input }), say('Please confirm.'))
		const t1 = await post('/api/chat', { text: 'order' }, sessionId)
		if (!t1.data.events) throw new Error(JSON.stringify(t1))
		queue.push(call('aen_call_action', { businessId: ID, action: 'order.create', inputJson: input }), say('Approve access.'))
		const t2 = await post('/api/confirm', { id: t1.data.events.find((e: any) => e.type === 'confirm').id, decision: 'approve' }, sessionId)
		if (!t2.data.events) throw new Error('confirm: ' + JSON.stringify(t2))
		await decide(t2.data.events.find((e: any) => e.type === 'authorization').userCode)
		queue.push(call('aen_call_action', { businessId: ID, action: 'order.create', inputJson: input }), say('You can pay below.'))
		const t3 = await post('/api/chat', { text: 'approved' }, sessionId)
		return t3.data.events.find((e: any) => e.type === 'payment')
	}

	beforeAll(async () => {
		fake = createServer((req, res) => {
			let b = ''
			req.on('data', (c) => (b += c))
			req.on('end', () => {
				seen.push({ body: JSON.parse(b) })
				res.setHeader('content-type', 'application/json')
				res.end(JSON.stringify({ candidates: [{ content: queue.shift() ?? say('(script ran out)') }] }))
			})
		})
		await new Promise<void>((r) => fake.listen(4620, '127.0.0.1', r))
		dir = await startDirectory({ port: 4622, allowPrivate: true })
		cafe = await startCafe({ port: 4621, stepMs: 30, psp })
		await fetch(`${dir.url}/register`, { method: 'POST', body: JSON.stringify({ url: cafe.url }) })
		ui = await startUi({ port: 4623, directoryUrl: dir.url, wallet, gemini: { apiKey: 'k', model: 'fake', baseUrl: 'http://127.0.0.1:4620' } })
	})
	afterAll(async () => {
		await ui.close()
		await cafe.close()
		await dir.close()
		fake.closeAllConnections()
		fake.close()
	})

	it('pays with one click, and the model never sees the token', async () => {
		const pay = await toPayment('session-pay-1', [{ serviceId: 'espresso', quantity: 2 }])
		expect(pay).toMatchObject({ amount: 700, currency: 'USD', wallet: true })
		queue.push(say('Your 2 espressos are paid.'))
		const r = await post('/api/pay', { id: pay.orderId, amount: 1 /* ignored: the amount is what the business stated */ }, 'session-pay-1')
		expect(r.status).toBe(200)
		expect(r.data.events.find((e: any) => e.type === 'paid')).toMatchObject({ amount: 700 })
		expect(r.data.reply).toContain('paid')
		// nothing sent to the model, and nothing shown to the browser, contains a token
		expect(JSON.stringify(seen)).not.toContain('tpt_')
		expect(JSON.stringify(r.data)).not.toContain('tpt_')
		// and the last message the model got says what happened, in words
		const last = (seen.at(-1)!.body as any).contents.at(-1).parts[0].text as string
		expect(last).toContain('paid 7.00 USD')
	})

	it('cannot be triggered for an order the page never showed, or from another session', async () => {
		expect((await post('/api/pay', { id: 'order-never-shown' }, 'session-pay-1')).status).toBe(404)
		const pay = await toPayment('session-pay-2', [{ serviceId: 'croissant', quantity: 1 }])
		expect((await post('/api/pay', { id: pay.orderId }, 'session-other-9')).status).toBe(404)
	})

	it('only the user can pay: the model has no tool for it', async () => {
		const names = (seen.at(-1)!.body as any)
		void names
		const tools = JSON.stringify(((seen[0]!.body as any).tools[0].functionDeclarations as { name: string }[]).map((t) => t.name))
		expect(tools).not.toContain('pay')
		expect(tools).not.toContain('wallet')
	})

	it('falls back to the business payment page when the bank needs the user (large amounts)', async () => {
		const pay = await toPayment('session-pay-3', [{ serviceId: 'croissant', quantity: 13 }]) // $52.00
		queue.push(say('Your bank needs your approval: use the payment page.'))
		const r = await post('/api/pay', { id: pay.orderId }, 'session-pay-3')
		const fb = r.data.events.find((e: any) => e.type === 'payment')
		expect(fb).toMatchObject({ wallet: false })
		expect(fb.note).toContain('bank')
		expect(fb.url.startsWith(cafe.url)).toBe(true)
		expect(r.data.events.some((e: any) => e.type === 'paid')).toBe(false)
	})
})
