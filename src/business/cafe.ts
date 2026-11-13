// Sample business: a cafe that takes orders and hands the user off to a (test-mode) payment page.
// It is a stand-in for a real business and shows what an AEN-compatible one has to do: publish a (signed) descriptor,
// let the user approve access on its own page, accept only requests proven by the key a token was issued to,
// never trust a retry, and push a hint when its descriptor changes.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { pathToFileURL } from 'node:url'

import { jcs, makeReplayGuard, signDescriptor, verifyDpop, type SigningKey } from '../crypto.ts'
import type { Psp } from '../payments/test-wallet.ts'
import { close, html, json, listen, makeLimiter, readForm, readJson } from '../http.ts'
import { makeSigner } from '../token.ts'

const SCOPE_TEXT: Record<string, string> = {
	'order.create': 'place orders (you still pay yourself, on the payment page)',
	'order.status': 'check the status of orders it placed',
	'contact.request': 'send the cafe a message, including the email address you give'
}
const money = (c: number) => `$${(c / 100).toFixed(2)}`
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

type Item = { id: string; name: string; price: { amount: number; currency: string } }
type Order = { id: string; owner: string; total: number; status: 'pending_payment' | 'paid' | 'preparing' | 'ready' | 'expired'; updatedAt: string; expiresAt: number }
type Device = { userCode: string; jkt: string; scopes: string[]; state: 'pending' | 'approved' | 'denied'; expiresAt: number }

export function descriptor(base: string, menu: Item[], key?: SigningKey, name = 'Corner Cafe', tokenPayments = false) {
	const host = new URL(base).host
	const oauth = (scope: string) => ({ type: 'oauth2-device', scopes: [scope], deviceEndpoint: '/device/authorize', tokenEndpoint: '/token' })
	const doc = {
		aen: '0.1',
		id: host,
		kind: 'business',
		name,
		url: base,
		categories: ['food', 'coffee'],
		keywords: menu.map((m) => m.name.toLowerCase()),
		countries: ['US'],
		actions: [
			{ id: 'menu', capability: 'catalog.search', method: 'GET', path: '/menu', description: 'List the menu with current prices.', input: { type: 'object', properties: { q: { type: 'string' } } }, auth: { type: 'none' }, sideEffects: false },
			{ id: 'order', capability: 'order.create', method: 'POST', path: '/orders', input: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { type: 'object', required: ['serviceId', 'quantity'], properties: { serviceId: { type: 'string' }, quantity: { type: 'integer', minimum: 1, maximum: 20 } } } } } }, auth: oauth('order.create'), sideEffects: true, requiresUserConfirmation: true, payment: true },
			{ id: 'contact', capability: 'contact.request', method: 'POST', path: '/enquiries', description: 'Send the cafe a question.', input: { type: 'object', required: ['message', 'email'], additionalProperties: false, properties: { message: { type: 'string', maxLength: 1000 }, email: { type: 'string', format: 'email' } } }, auth: oauth('contact.request'), sideEffects: true, requiresUserConfirmation: true, sharesPersonalData: [{ field: 'email', kind: 'email', purpose: 'so the cafe can reply to your question' }] },
			...(tokenPayments ? [{ id: 'pay', capability: 'order.pay', method: 'POST', path: '/orders/{orderId}/pay', description: 'Pay an order with a one-time wallet token for exactly the confirmed amount.', input: { type: 'object', required: ['payment'], properties: { payment: { type: 'object', required: ['type', 'token'], properties: { type: { enum: ['test.token'] }, token: { type: 'string' } } } } }, auth: oauth('order.create'), sideEffects: true, requiresUserConfirmation: true, payment: true }] : []),
			{ id: 'order-status', capability: 'order.status', method: 'GET', path: '/orders/{orderId}', auth: oauth('order.status'), sideEffects: false }
		],
		events: { path: '/events' },
		payment: tokenPayments ? { modes: ['handoff', 'token'], provider: 'test-pay', tokenTypes: ['test.token'] } : { modes: ['handoff'], provider: 'test-pay' }
	}
	return key ? signDescriptor(doc, key) : doc
}

/** `psp`: pass the test payment processor to accept wallet tokens (order.pay) in addition to the hand-off page. */
export async function startCafe(opts: { port: number; stepMs?: number; signing?: SigningKey; limit?: number; psp?: Psp }) {
	const base = `http://127.0.0.1:${opts.port}`
	const host = new URL(base).host
	const step = opts.stepMs ?? 3000
	const menu: Item[] = [
		{ id: 'espresso', name: 'Espresso', price: { amount: 350, currency: 'USD' } },
		{ id: 'flat-white', name: 'Flat white', price: { amount: 450, currency: 'USD' } },
		{ id: 'croissant', name: 'Croissant', price: { amount: 400, currency: 'USD' } }
	]
	let name = 'Corner Cafe'
	const signer = makeSigner()
	const fresh = makeReplayGuard()
	const allow = makeLimiter(opts.limit ?? 60)
	const orders = new Map<string, Order>()
	const enquiries: { id: string; email: string; message: string }[] = []
	const idem = new Map<string, { hash: string; body: unknown }>()
	const devices = new Map<string, Device>() // by device_code
	const byUserCode = new Map<string, string>()
	const watchers = new Set<ServerResponse>()
	const touch = (o: Order, s: Order['status']) => ((o.status = s), (o.updatedAt = new Date().toISOString()))
	const body = () => JSON.stringify(descriptor(base, menu, opts.signing, name, !!opts.psp))
	const etag = () => `"${sha(body()).slice(0, 16)}"`

	const server = createServer(async (req, res) => {
		try {
			const url = new URL(req.url ?? '/', base)
			const ip = req.socket.remoteAddress ?? '?'
			const proof = () => req.headers.dpop as string | undefined
			// A request is authorised only if the token is valid AND this request is proven by the key it was issued to.
			const authed = (scope: string) => {
				const m = /^DPoP (.+)$/.exec(req.headers.authorization ?? '')
				const claims = m && signer.verify(m[1], host, scope)
				if (!m || !claims) return null
				const jkt = verifyDpop(proof(), { method: req.method!, url: url.href, accessToken: m[1], fresh })
				return jkt && jkt === claims.jkt ? claims : null
			}

			if (req.method === 'GET' && url.pathname === '/.well-known/aen.json') {
				if (req.headers['if-none-match'] === etag()) return (res.writeHead(304, { etag: etag() }), res.end())
				res.writeHead(200, { 'content-type': 'application/json', etag: etag(), 'cache-control': 'max-age=300' })
				return res.end(body())
			}

			if (req.method === 'GET' && url.pathname === '/events') {
				res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
				res.write(`event: hello\ndata: {}\n\n`)
				watchers.add(res)
				return void req.on('close', () => watchers.delete(res))
			}

			if (req.method === 'GET' && url.pathname === '/menu') {
				const q = (url.searchParams.get('q') ?? '').toLowerCase()
				return json(res, 200, { items: menu.filter((m) => m.name.toLowerCase().includes(q)) })
			}

			// ---- user consent: the agent asks, the USER approves on this page -------------------------------
			if (req.method === 'POST' && url.pathname === '/device/authorize') {
				if (!allow(`d:${ip}`)) return json(res, 429, { error: 'rate_limited' })
				const jkt = verifyDpop(proof(), { method: 'POST', url: url.href, fresh })
				if (!jkt) return json(res, 401, { error: 'invalid_dpop_proof' })
				const b = (await readJson(req)) as { scopes?: unknown }
				const scopes = Array.isArray(b.scopes) ? b.scopes.map(String) : []
				if (!scopes.length || scopes.some((s) => !(s in SCOPE_TEXT))) return json(res, 400, { error: 'invalid_scope' })
				const deviceCode = randomBytes(24).toString('base64url')
				const userCode = `${randomBytes(2).toString('hex')}-${randomBytes(2).toString('hex')}`.toUpperCase()
				devices.set(deviceCode, { userCode, jkt, scopes, state: 'pending', expiresAt: Date.now() + 10 * 60_000 })
				byUserCode.set(userCode, deviceCode)
				return json(res, 200, { device_code: deviceCode, user_code: userCode, verification_uri: `${base}/device?user_code=${userCode}`, expires_in: 600, interval: 1 })
			}

			if (req.method === 'GET' && url.pathname === '/device') {
				const d = devices.get(byUserCode.get(url.searchParams.get('user_code') ?? '') ?? '')
				if (!d || d.expiresAt < Date.now()) return html(res, 404, '<p>This code is not valid or has expired.</p>')
				return html(res, 200, `<h1>Corner Cafe</h1><p>An AI agent (key <code>${esc(d.jkt.slice(0, 12))}</code>) asks to:</p><ul>${d.scopes.map((s) => `<li>${esc(SCOPE_TEXT[s]!)}</li>`).join('')}</ul><p>Code: <b>${esc(d.userCode)}</b>. Only approve if you started this.</p><form method="post" action="/device/decision"><input type="hidden" name="user_code" value="${esc(d.userCode)}"><button name="decision" value="approve">Approve</button> <button name="decision" value="deny">Deny</button></form>`)
			}

			if (req.method === 'POST' && url.pathname === '/device/decision') {
				const f = await readForm(req)
				const d = devices.get(byUserCode.get(f.get('user_code') ?? '') ?? '')
				if (!d || d.expiresAt < Date.now() || d.state !== 'pending') return html(res, 409, '<p>This request can no longer be answered.</p>')
				d.state = f.get('decision') === 'approve' ? 'approved' : 'denied'
				return html(res, 200, `<p>${d.state === 'approved' ? 'Access approved. You can go back to your agent.' : 'Access denied.'}</p>`)
			}

			if (req.method === 'POST' && url.pathname === '/token') {
				if (!allow(`t:${ip}`)) return json(res, 429, { error: 'rate_limited' })
				const jkt = verifyDpop(proof(), { method: 'POST', url: url.href, fresh })
				if (!jkt) return json(res, 401, { error: 'invalid_dpop_proof' })
				const b = (await readJson(req)) as { grant_type?: string; device_code?: string }
				const d = b.grant_type === 'device_code' ? devices.get(b.device_code ?? '') : undefined
				if (!d || d.jkt !== jkt || d.expiresAt < Date.now()) return json(res, 400, { error: 'invalid_grant' })
				if (d.state === 'pending') return json(res, 400, { error: 'authorization_pending' })
				devices.delete(b.device_code!)
				if (d.state === 'denied') return json(res, 400, { error: 'access_denied' })
				const { token, claims } = signer.issue(host, d.scopes, jkt)
				return json(res, 200, { access_token: token, token_type: 'DPoP', expires_in: Math.round((claims.exp - Date.now()) / 1000), scope: d.scopes.join(' ') })
			}

			// ---- the business API --------------------------------------------------------------------------
			if (req.method === 'POST' && url.pathname === '/orders') {
				const claims = authed('order.create')
				if (!claims) return json(res, 401, { error: 'unauthorized' })
				if (!allow(`o:${claims.jkt}`)) return json(res, 429, { error: 'rate_limited' })
				const raw = (await readJson(req)) as { items?: { serviceId?: string; quantity?: number }[] }
				const items = Array.isArray(raw.items) ? raw.items : []
				let total = 0
				for (const it of items) {
					const m = menu.find((x) => x.id === it.serviceId)
					if (!m || !Number.isInteger(it.quantity) || it.quantity! < 1 || it.quantity! > 20) return json(res, 422, { error: 'invalid_item' })
					total += m.price.amount * it.quantity!
				}
				if (!items.length) return json(res, 422, { error: 'empty_order' })
				// A retry with the same Idempotency-Key gets the same order back, never a second one.
				const key = req.headers['idempotency-key'] ? `${claims.jkt}:${String(req.headers['idempotency-key'])}` : null
				const hash = sha(jcs(raw))
				if (key && idem.has(key)) {
					const prior = idem.get(key)!
					return prior.hash === hash ? json(res, 200, prior.body) : json(res, 422, { error: 'idempotency_key_reused' })
				}
				const order: Order = { id: randomUUID(), owner: claims.jkt, total, status: 'pending_payment', updatedAt: new Date().toISOString(), expiresAt: Date.now() + 15 * 60_000 }
				orders.set(order.id, order)
				const out = { status: 'requires_user_approval', orderId: order.id, amount: { amount: total, currency: 'USD' }, handoffUrl: `${base}/pay/${order.id}`, expiresAt: new Date(order.expiresAt).toISOString(), provider: 'test-pay' }
				if (key) idem.set(key, { hash, body: out })
				return json(res, 201, out)
			}

			if (req.method === 'POST' && url.pathname === '/enquiries') {
				const claims = authed('contact.request')
				if (!claims) return json(res, 401, { error: 'unauthorized' })
				if (!allow(`c:${claims.jkt}`)) return json(res, 429, { error: 'rate_limited' })
				const b = (await readJson(req)) as { message?: unknown; email?: unknown }
				if (typeof b.message !== 'string' || !b.message.trim() || b.message.length > 1000 || typeof b.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) return json(res, 422, { error: 'invalid_enquiry' })
				const e = { id: randomUUID(), email: b.email, message: b.message }
				enquiries.push(e)
				return json(res, 201, { enquiryId: e.id })
			}

			const tokenPay = url.pathname.match(/^\/orders\/([\w-]+)\/pay$/)
			if (req.method === 'POST' && tokenPay && opts.psp) {
				const claims = authed('order.create')
				if (!claims) return json(res, 401, { error: 'unauthorized' })
				if (!allow(`p:${claims.jkt}`)) return json(res, 429, { error: 'rate_limited' })
				const o = orders.get(tokenPay[1]!)
				if (!o || o.owner !== claims.jkt) return json(res, 404, { error: 'not_found' })
				const b = (await readJson(req)) as { payment?: { type?: string; token?: string } }
				if (b.payment?.type !== 'test.token' || typeof b.payment.token !== 'string') return json(res, 422, { error: 'unsupported_payment' })
				if (o.status !== 'pending_payment' || Date.now() > o.expiresAt) return json(res, 409, { error: 'order_not_payable' })
				// Amounts over $50 pretend to need the bank's own approval, as 3DS would: fall back to the hand-off page.
				if (o.total > 5000) return json(res, 202, { status: 'authentication_required', orderId: o.id, handoffUrl: `${base}/pay/${o.id}`, expiresAt: new Date(o.expiresAt).toISOString(), provider: 'test-pay' })
				const r = opts.psp.redeem(b.payment.token, { merchant: host, amount: o.total, currency: 'USD', orderId: o.id })
				if (!r.ok) return json(res, 402, { error: 'payment_declined', reason: r.reason })
				touch(o, 'paid')
				setTimeout(() => touch(o, 'preparing'), step)
				setTimeout(() => touch(o, 'ready'), step * 2)
				return json(res, 200, { status: 'completed', orderId: o.id, amount: { amount: o.total, currency: 'USD' }, paidAt: o.updatedAt })
			}

			const status = url.pathname.match(/^\/orders\/([\w-]+)$/)
			if (req.method === 'GET' && status) {
				const claims = authed('order.status')
				if (!claims) return json(res, 401, { error: 'unauthorized' })
				const o = orders.get(status[1]!)
				if (!o || o.owner !== claims.jkt) return json(res, 404, { error: 'not_found' })
				if (o.status === 'pending_payment' && Date.now() > o.expiresAt) touch(o, 'expired')
				return json(res, 200, { orderId: o.id, status: o.status, updatedAt: o.updatedAt })
			}

			// Stand-in for the payment provider's hosted page (test mode: no card data, no real money).
			const pay = url.pathname.match(/^\/pay\/([\w-]+)(\/approve)?$/)
			if (pay) {
				const o = orders.get(pay[1]!)
				if (!o) return html(res, 404, '<p>Unknown order.</p>')
				if (req.method === 'POST' && pay[2]) {
					if (o.status !== 'pending_payment' || Date.now() > o.expiresAt) return html(res, 409, '<p>This payment can no longer be approved.</p>')
					touch(o, 'paid')
					setTimeout(() => touch(o, 'preparing'), step)
					setTimeout(() => touch(o, 'ready'), step * 2)
					return html(res, 200, `<p>Test payment of ${money(o.total)} approved. No real money moved.</p>`)
				}
				return html(res, 200, `<h1>Test Pay</h1><p>Pay ${money(o.total)} to Corner Cafe (order ${esc(o.id)}).</p><p>Test mode: no card data, no real money.</p><form method="post" action="/pay/${esc(o.id)}/approve"><button>Approve payment</button></form>`)
			}

			json(res, 404, { error: 'not_found' })
		} catch {
			json(res, 400, { error: 'bad_request' })
		}
	})
	await listen(server, opts.port)
	return {
		url: base,
		enquiries,
		close: () => close(server),
		/** Changes a price. The directory never holds prices, so there is nothing to tell it: agents read them from here. */
		changePrice(id: string, amount: number) {
			menu.find((m) => m.id === id)!.price.amount = amount
		},
		/** Renames the business and tells watchers, as a business would when what a directory indexes changes. */
		rename(next: string) {
			name = next
			for (const w of watchers) w.write(`event: descriptor-changed\ndata: ${JSON.stringify({ etag: etag() })}\n\n`)
		}
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const port = Number(process.env.PORT ?? 4101)
	await startCafe({ port })
	console.log(`cafe on http://127.0.0.1:${port}  (descriptor: /.well-known/aen.json)`)
}
