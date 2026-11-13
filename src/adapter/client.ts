// The agent side. Everything an agent (or the MCP adapter) does goes through here, and it enforces the rules of
// docs/spec-outline.md: descriptors are validated and treated as untrusted data, the user approves access on the
// business's own page, side effects need the user's confirmation, requests are proven by this client's key, URLs never
// leave the business's origin (or reach private networks), and responses are validated before the agent sees them.
// Keys and tokens live in this process's memory only (the user's device when run as a local MCP server).
//
// Low overhead for the model: it works by capability ("order.create"), never sees paths, gets compact cards first, one
// compact business next, and the input schema of a single action only when it asks for it.
import { randomUUID } from 'node:crypto'
import { resolveTxt as dnsResolveTxt } from 'node:dns/promises'

import { jcs, keyFingerprint, makeDpopKey, verifySignature } from '../crypto.ts'
import { checkInput } from './input-check.ts'
import { safeFetch } from '../safe-fetch.ts'
import { validate } from '../validate.ts'

type Auth = { type: 'none' | 'oauth2-device'; scopes?: string[]; deviceEndpoint?: string; tokenEndpoint?: string }
type Action = { id: string; capability: string; description?: string; output?: unknown; method: 'GET' | 'POST'; path: string; input?: unknown; auth: Auth; sideEffects: boolean; requiresUserConfirmation?: boolean; payment?: boolean; sharesPersonalData?: Shared[] }
export type Shared = { field: string; kind: string; purpose: string }
type Descriptor = {
	signing?: { alg: string; publicKey: string; signature: string }
	payment?: { modes: string[]; provider: string; tokenTypes?: string[] }
	id: string; name: string; url: string; categories?: string[]; keywords?: string[]; actions?: Action[]
}
export type CallResult =
	| { ok: true; status: number; body: unknown; instructions?: string; idempotencyKey?: string }
	| { ok: false; error: string; message: string; verificationUri?: string; userCode?: string; shares?: Shared[] }

const fail = (error: string, message: string, extra: object = {}): CallResult => ({ ok: false, error, message, ...extra })
const MAX_BYTES = 200_000
class AuthRequired extends Error {
	constructor(readonly uri: string, readonly userCode: string) {
		super('authorization_required')
	}
}

export function createClient(directoryUrl: string, opts: { allowPrivate?: boolean; cacheMs?: number; resolveTxt?: (name: string) => Promise<string[][]> } = {}) {
	const f = safeFetch(opts.allowPrivate)
	const key = makeDpopKey()
	const tokens = new Map<string, { token: string; exp: number }>()
	const pending = new Map<string, { deviceCode: string; userCode: string; uri: string }>()
	const resolveTxt = opts.resolveTxt ?? dnsResolveTxt
	const cache = new Map<string, { at: number; value: { verification: string; descriptor: Descriptor } }>()

	async function http(url: URL, init: { method?: string; body?: unknown; token?: string; proof?: boolean; headers?: Record<string, string> } = {}) {
		const method = init.method ?? 'GET'
		const headers: Record<string, string> = { 'content-type': 'application/json', ...init.headers }
		if (init.proof) headers.dpop = key.proof(method, url.href, init.token)
		if (init.token) headers.authorization = `DPoP ${init.token}`
		const r = await f(url, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: AbortSignal.timeout(5000) })
		// The machine API is JSON only. HTML belongs to the pages a human opens (approval, payment), never to a response an agent reads.
		if (!(r.headers.get('content-type') ?? '').startsWith('application/json')) throw new Error('the business answered with something other than JSON: refused')
		const text = await r.text()
		if (text.length > MAX_BYTES) throw new Error('response too large')
		return { status: r.status, body: text ? JSON.parse(text) : null }
	}

	/** Signed by the business and the signing key is pinned in the business's own DNS: the copy cannot have been altered. */
	async function provenByDns(d: Descriptor): Promise<boolean> {
		if (!d.signing || !verifySignature(d)) return false
		try {
			const txt = (await resolveTxt(`_aen.${new URL(`http://${d.id}`).hostname}`)).map((p) => p.join('')).join(' ')
			return txt.includes('v=aen1') && txt.includes(`key=${keyFingerprint(d.signing.publicKey)}`)
		} catch {
			return false
		}
	}
	const wellFormed = (d: unknown, businessId: string): d is Descriptor => validate('descriptor', d).ok && (d as Descriptor).id === businessId && new URL((d as Descriptor).url).host === businessId

	/**
	 * The directory holds the schema (the descriptor), not the data. A copy it serves is accepted only if the business
	 * signed it and its key is pinned in the business's DNS, which this client checks itself, so the directory cannot alter
	 * it. Anything else is read from the business's own host instead. The descriptor must name the host it is served
	 * from, so a directory can hide or misdirect but cannot make one host pass as another.
	 */
	async function load(businessId: string, fresh = false) {
		const hit = cache.get(businessId)
		if (!fresh && hit && Date.now() - hit.at < (opts.cacheMs ?? 30_000)) return hit.value
		try {
			const p = await http(new URL(`/businesses/${encodeURIComponent(businessId)}`, directoryUrl))
			const ptr = p.body as { id?: string; descriptorUrl?: string; descriptor?: unknown }
			if (p.status !== 200 || ptr.id !== businessId || !ptr.descriptorUrl) return null
			let d: Descriptor | null = null
			let verification: 'host' | 'dns' = 'host'
			// `fresh` (re-reading after a failure) never trusts the directory's copy: it goes to the business.
			if (!fresh && wellFormed(ptr.descriptor, businessId) && (await provenByDns(ptr.descriptor))) {
				d = ptr.descriptor
				verification = 'dns'
			} else {
				const at = new URL(ptr.descriptorUrl)
				if (at.host !== businessId || at.pathname !== '/.well-known/aen.json') return null
				const r = await http(at)
				if (r.status !== 200 || !wellFormed(r.body, businessId)) return null
				d = r.body
				if (await provenByDns(d)) verification = 'dns'
			}
			const value = { verification, descriptor: d }
			cache.set(businessId, { at: Date.now(), value })
			return value
		} catch {
			return null
		}
	}

	async function token(d: Descriptor, a: Action): Promise<string> {
		const scopes = [...a.auth.scopes!].sort()
		const k = `${d.id}|${scopes.join(',')}`
		const have = tokens.get(k)
		if (have && have.exp > Date.now() + 5000) return have.token
		const origin = new URL(d.url).origin
		const p = pending.get(k)
		if (!p) {
			const r = await http(new URL(a.auth.deviceEndpoint!, d.url), { method: 'POST', body: { scopes }, proof: true })
			const b = r.body as { device_code?: string; user_code?: string; verification_uri?: string }
			if (r.status !== 200 || !b.device_code || !b.user_code || !b.verification_uri) throw new Error('the business refused the access request')
			if (new URL(b.verification_uri).origin !== origin) throw new Error('approval page is not on the business origin')
			pending.set(k, { deviceCode: b.device_code, userCode: b.user_code, uri: b.verification_uri })
			throw new AuthRequired(b.verification_uri, b.user_code)
		}
		const r = await http(new URL(a.auth.tokenEndpoint!, d.url), { method: 'POST', body: { grant_type: 'device_code', device_code: p.deviceCode }, proof: true })
		const b = r.body as { access_token?: string; expires_in?: number; error?: string }
		if (r.status === 200 && b.access_token) {
			tokens.set(k, { token: b.access_token, exp: Date.now() + (b.expires_in ?? 60) * 1000 })
			pending.delete(k)
			return b.access_token
		}
		if (b.error === 'authorization_pending') throw new AuthRequired(p.uri, p.userCode)
		pending.delete(k)
		throw new Error(`access ${b.error === 'access_denied' ? 'was denied by the user' : 'failed'}`)
	}

	/** Resolves an action by id, or by capability when exactly one action offers it. */
	const pick = (d: Descriptor, idOrCapability: string) => {
		const byId = d.actions?.find((x) => x.id === idOrCapability)
		if (byId) return byId
		const byCap = d.actions?.filter((x) => x.capability === idOrCapability) ?? []
		return byCap.length === 1 ? byCap[0] : undefined
	}

	/** One attempt against one descriptor. `stale`: the failure could be caused by a schema that has since changed. */
	async function run(d: Descriptor, idOrCapability: string, input: Record<string, unknown>, userConfirmed: boolean, idem: string): Promise<{ result: CallResult; stale: boolean }> {
		const done = (result: CallResult, stale = false) => ({ result, stale })
		const a = pick(d, idOrCapability)
		if (!a) return done(fail('unknown_action', 'The business has no such action (or the capability is offered more than once: use the action id).'), true)

		// Check the request against the action's own schema first, so a mistake never reaches the user's confirmation card.
		const pathParams = [...a.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!)
		const checked = checkInput(a.input, input, pathParams)
		if (!checked.ok) return done(fail('invalid_input', `The request does not match what "${a.id}" accepts: ${checked.errors.join('; ')}. Read its input with describeAction and try again.`))

		if (a.sideEffects && !userConfirmed) {
			const shares = (a.sharesPersonalData ?? []).filter((x) => x.field in input)
			return done(fail('confirmation_required', `"${a.id}" at ${d.name} changes something${a.payment ? ' and leads to a payment' : ''}${shares.length ? ' and shares personal data' : ''}. Ask the user to confirm the exact request, then call again with userConfirmed=true.`, shares.length ? { shares } : {}))
		}

		const origin = new URL(d.url).origin
		const rest = { ...input }
		const path = a.path.replace(/\{(\w+)\}/g, (_, k: string) => {
			const v = rest[k]
			delete rest[k]
			return encodeURIComponent(String(v ?? ''))
		})
		const target = new URL(path, d.url)
		if (target.origin !== origin) return done(fail('origin_mismatch', 'Action path leaves the business origin: refused.'))
		if (a.method === 'GET') for (const [k, v] of Object.entries(rest)) target.searchParams.set(k, String(v))

		try {
			const tok = a.auth.type === 'oauth2-device' ? await token(d, a) : undefined
			const key = a.sideEffects ? idem : undefined
			const { status, body } = await http(target, { method: a.method, body: a.method === 'POST' ? rest : undefined, token: tok, proof: a.auth.type !== 'none', headers: key ? { 'idempotency-key': key } : {} })
			if (status >= 400) return done(fail('business_error', `The business answered ${status}: ${JSON.stringify(body).slice(0, 200)}`), [400, 404, 405, 410, 422].includes(status))

			if (a.capability === 'order.pay') {
				const v = validate('payment-result', body)
				if (!v.ok) return done(fail('invalid_response', `Payment result breaks the spec: ${v.errors.join('; ')}`))
				const r = body as { status: string; handoffUrl?: string }
				if (r.handoffUrl && new URL(r.handoffUrl).origin !== origin) return done(fail('origin_mismatch', 'Payment page is not on the business origin: refused.'))
				return done({ ok: true, status, body, idempotencyKey: key })
			}
			if (a.payment) {
				const v = validate('payment-handoff', body)
				if (!v.ok) return done(fail('invalid_response', `Payment response breaks the spec: ${v.errors.join('; ')}`))
				if (new URL((body as { handoffUrl: string }).handoffUrl).origin !== origin) return done(fail('origin_mismatch', 'Payment page is not on the business origin: refused.'))
				return done({ ok: true, status, body, idempotencyKey: key, instructions: 'Show the user the amount and handoffUrl. The user pays there, themselves. Never try to pay on their behalf. Then poll order.status. If the call must be retried, reuse the same idempotencyKey.' })
			}
			if (a.capability === 'order.status' && !validate('order-status', body).ok) return done(fail('invalid_response', 'Status response breaks the spec.'))
			return done({ ok: true, status, body, idempotencyKey: key })
		} catch (e) {
			if (e instanceof AuthRequired) return done(fail('authorization_required', `Ask the user to open ${e.uri} and approve access (code ${e.userCode}). Then call again.`, { verificationUri: e.uri, userCode: e.userCode }))
			return done(fail('request_failed', e instanceof Error ? e.message : 'request failed'))
		}
	}

	return {
		/** Compact cards: id, name, capabilities, verification. Narrow with `capability`, `category` and `country`. */
		async search(q?: string, category?: string, capability?: string, country?: string) {
			const u = new URL('/search', directoryUrl)
			for (const [k, v] of Object.entries({ q, category, capability, country })) if (v) u.searchParams.set(k, v)
			return (await http(u)).body
		},

		/** One compact business: its actions by capability. No schemas, no paths, no data (call `catalog.search` for what it sells). Text from the business is under `untrusted_content`. */
		async getBusiness(businessId: string) {
			const v = await load(businessId)
			if (!v) return null
			const d = v.descriptor
			return {
				id: d.id,
				verification: v.verification,
				payment: d.payment,
				actions: (d.actions ?? []).map((a) => ({ id: a.id, capability: a.capability, sideEffects: a.sideEffects, requiresUserConfirmation: !!a.requiresUserConfirmation, payment: !!a.payment, needsApproval: a.auth.type !== 'none' })),
				untrusted_content: { name: d.name, categories: d.categories, keywords: d.keywords }
			}
		},

		/** The input schema (and output, and the business's own description) of ONE action, only when the agent needs to build a request. */
		async describeAction(businessId: string, idOrCapability: string) {
			const d = (await load(businessId))?.descriptor
			const a = d && pick(d, idOrCapability)
			return a ? { id: a.id, capability: a.capability, sideEffects: a.sideEffects, payment: !!a.payment, input: a.input ?? { type: 'object' }, output: a.output, sharesPersonalData: a.sharesPersonalData, untrusted_description: a.description } : null
		},

		async callAction(businessId: string, idOrCapability: string, input: Record<string, unknown> = {}, userConfirmed = false, idempotencyKey?: string): Promise<CallResult> {
			const d = (await load(businessId))?.descriptor
			if (!d) return fail('unknown_business', 'No valid descriptor for that business.')
			const idem = idempotencyKey ?? randomUUID()
			const first = await run(d, idOrCapability, input, userConfirmed, idem)
			if (first.stale) {
				// The call failed in a way a changed schema would cause (not found, not allowed, bad input). If the business's
				// own descriptor now differs from the one used, try once more with it (same idempotency key).
				const again = (await load(businessId, true))?.descriptor
				if (again && jcs(again) !== jcs(d)) return (await run(again, idOrCapability, input, userConfirmed, idem)).result
			}
			return first.result
		},
		close: () => f.close()
	}
}
