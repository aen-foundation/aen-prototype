// Small web UI: a chat page where Gemini acts as the agent. Binds to 127.0.0.1 only. The API key stays on the server.
// Run: pnpm ui  (starts the sample directory + cafe too, so it works on its own).
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

import { createClient } from '../adapter/client.ts'
import { startCafe } from '../business/cafe.ts'
import { startDirectory } from '../directory/server.ts'
import { close, html, json, listen, makeLimiter, readJson } from '../http.ts'
import { createTestPayments, type Wallet } from '../payments/test-wallet.ts'
import { payWithWallet, runAgent, type GeminiConfig, type Session, type UiEvent } from './agent.ts'

const PAGE = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const MAX_SESSIONS = 50

export async function startUi(opts: { port: number; directoryUrl: string; gemini?: Partial<GeminiConfig>; wallet?: Wallet }) {
	const base = `http://127.0.0.1:${opts.port}`
	const cfg = {
		apiKey: opts.gemini?.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '',
		model: opts.gemini?.model ?? process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
		baseUrl: opts.gemini?.baseUrl ?? 'https://generativelanguage.googleapis.com'
	}
	const sessions = new Map<string, Session>()
	const allow = makeLimiter(40)

	const session = (id: string): Session => {
		let s = sessions.get(id)
		if (!s) {
			if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!)
			s = { client: createClient(opts.directoryUrl, { allowPrivate: true, cacheMs: 0 }), contents: [], approvals: new Set(), pending: new Map(), wallet: opts.wallet, payments: new Map() }
			sessions.set(id, s)
		}
		return s
	}

	const server = createServer(async (req, res) => {
		try {
			const url = new URL(req.url ?? '/', base)
			if (req.method === 'GET' && url.pathname === '/') return html(res, 200, PAGE.replace('{{MODEL}}', cfg.model))
			if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not_found' })
			// Only this page may call the API (a website you visit must not be able to drive your agent).
			const origin = req.headers.origin
			if (req.headers['x-aen-ui'] !== '1' || (origin && origin !== base)) return json(res, 403, { error: 'forbidden' })

			if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, { hasKey: !!cfg.apiKey, model: cfg.model })
			if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' })
			if (!cfg.apiKey) return json(res, 503, { error: 'no_api_key', message: 'Set GEMINI_API_KEY (see .env.example) and restart.' })
			if (!allow(req.socket.remoteAddress ?? '?')) return json(res, 429, { error: 'rate_limited' })

			const body = (await readJson(req, 4000)) as { sessionId?: string; text?: string; id?: string; decision?: string }
			const sid = typeof body.sessionId === 'string' && /^[\w-]{8,64}$/.test(body.sessionId) ? body.sessionId : randomUUID()
			const events: UiEvent[] = []

			if (url.pathname === '/api/reset') return (sessions.delete(sid), json(res, 200, { ok: true }))

			let text = ''
			if (url.pathname === '/api/chat') text = String(body.text ?? '').slice(0, 1000)
			else if (url.pathname === '/api/confirm') {
				const s = session(sid)
				const p = s.pending.get(String(body.id))
				if (!p) return json(res, 404, { error: 'nothing_to_confirm' })
				s.pending.delete(String(body.id))
				if (body.decision === 'approve') {
					s.approvals.add(p.hash)
					text = 'I confirm. Please go ahead with exactly that.'
				} else text = 'I cancelled that request. Do not do it.'
			} else if (url.pathname === '/api/pay') {
				// Only for an order the business stated and the page showed: the amount is never taken from the request.
				if (!session(sid).payments.has(String(body.id))) return json(res, 404, { error: 'nothing_to_pay' })
				try {
					const reply = await payWithWallet(cfg, session(sid), String(body.id), events)
					return json(res, 200, { sessionId: sid, reply, events })
				} catch (e) {
					return json(res, 502, { sessionId: sid, error: 'model_error', message: e instanceof Error ? e.message : 'failed', events })
				}
			} else return json(res, 404, { error: 'not_found' })
			if (!text.trim()) return json(res, 400, { error: 'empty' })

			try {
				const reply = await runAgent(cfg, session(sid), text, events)
				return json(res, 200, { sessionId: sid, reply, events })
			} catch (e) {
				return json(res, 502, { sessionId: sid, error: 'model_error', message: e instanceof Error ? e.message : 'failed', events })
			}
		} catch {
			json(res, 400, { error: 'bad_request' })
		}
	})
	await listen(server, opts.port)
	return { url: base, close: () => close(server) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const dir = await startDirectory({ port: 4100, allowPrivate: true })
	const { wallet, psp } = createTestPayments()
	const cafe = await startCafe({ port: 4101, psp })
	await fetch(`${dir.url}/register`, { method: 'POST', body: JSON.stringify({ url: cafe.url }) })
	const ui = await startUi({ port: Number(process.env.PORT ?? 4200), directoryUrl: dir.url, wallet })
	console.log(`AEN agent UI:  ${ui.url}\nsample cafe:   ${cafe.url} (registered in the sample directory ${dir.url})`)
	if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) console.log('No Gemini key found: copy .env.example to .env, add GEMINI_API_KEY, then restart.')
}
