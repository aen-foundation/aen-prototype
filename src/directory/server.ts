// Reference directory: holds each business's DESCRIPTOR (its identity, search keys and the schema of its actions) and
// never its data. The descriptor format cannot carry business data (no prices, menus, availability, descriptions,
// addresses or policies: the schema rejects them), so a directory that stores descriptors stores no data; agents get
// data by calling the business. A signed descriptor can be served from here and checked by the agent without asking the
// business; an unsigned one is read from the business itself.
// Descriptors are FETCHED from the business's own host (never accepted in a request), refreshed with conditional
// requests, and the index follows the business through its optional event stream.
// PROTOTYPE: in-memory, and the register endpoint is open (rate-limited).
import { resolveTxt as dnsResolveTxt } from 'node:dns/promises'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

import { keyFingerprint, verifySignature } from '../crypto.ts'
import { close, json, listen, makeLimiter, readJson } from '../http.ts'
import { safeFetch } from '../safe-fetch.ts'
import { validate } from '../validate.ts'

type Fetched = {
	id: string; kind: string; name: string; categories?: string[]; keywords?: string[]
	countries?: string[]; actions?: { capability: string }[]; events?: { path: string }
	signing?: { alg: string; publicKey: string; signature: string }
}
/** host: the descriptor is served by the host it names. dns: and it is signed with a key pinned in that domain's DNS. */
export type Verification = 'host' | 'dns'
/** What the directory keeps: the descriptor (schema + search keys) and the facts it derived. No business data exists in a descriptor. */
type Entry = {
	doc: Fetched
	id: string; descriptorUrl: string; target: URL; etag: string | null; level: Verification; keyFingerprint?: string
	kind: string; name: string; categories: string[]; keywords: string[]; capabilities: string[]; countries: string[]; eventsPath?: string
}
type Ingest = { ok: true; entry: Entry } | { ok: false; status: number; error: string; details?: string[] }

export async function startDirectory(opts: { port: number; allowPrivate?: boolean; resolveTxt?: (name: string) => Promise<string[][]>; registerLimit?: number }) {
	const base = `http://127.0.0.1:${opts.port}`
	const entries = new Map<string, Entry>()
	const watching = new Map<string, AbortController>()
	const f = safeFetch(opts.allowPrivate)
	const resolveTxt = opts.resolveTxt ?? dnsResolveTxt
	const allowRegister = makeLimiter(opts.registerLimit ?? 20)

	/** Fetch, validate and verify a descriptor, keep only the index, and drop the rest. A 304 keeps what we have. */
	async function ingest(target: URL, prior?: Entry): Promise<Ingest> {
		let r
		try {
			r = await f(new URL('/.well-known/aen.json', target), { signal: AbortSignal.timeout(3000), headers: prior?.etag ? { 'if-none-match': prior.etag } : {} })
		} catch {
			return { ok: false, status: 422, error: 'could not fetch the descriptor from that host' }
		}
		if (r.status === 304 && prior) return { ok: true, entry: prior }
		if (r.status !== 200) return { ok: false, status: 422, error: `descriptor request answered ${r.status}` }
		if (!(r.headers.get('content-type') ?? '').startsWith('application/json')) return { ok: false, status: 422, error: 'descriptor must be served as application/json' }
		const text = await r.text()
		if (text.length > 64_000) return { ok: false, status: 422, error: 'descriptor too large (a descriptor is a schema, not data)' }
		let doc: Fetched
		try {
			doc = JSON.parse(text)
		} catch {
			return { ok: false, status: 422, error: 'descriptor is not JSON' }
		}
		const v = validate('descriptor', doc)
		if (!v.ok) return { ok: false, status: 422, error: 'invalid descriptor', details: v.errors }
		if (doc.id !== target.host) return { ok: false, status: 422, error: `descriptor id "${doc.id}" must equal the host "${target.host}"` }

		let level: Verification = 'host'
		let fp: string | undefined
		if (doc.signing) {
			if (!verifySignature(doc)) return { ok: false, status: 422, error: 'descriptor signature does not verify' }
			try {
				const txt = (await resolveTxt(`_aen.${target.hostname}`)).map((p) => p.join('')).join(' ')
				if (txt.includes('v=aen1') && txt.includes(`key=${keyFingerprint(doc.signing.publicKey)}`)) {
					level = 'dns'
					fp = keyFingerprint(doc.signing.publicKey)
				}
			} catch {
				// no DNS record: the signature is valid but not pinned, so it stays at host level
			}
		}
		const entry: Entry = {
			doc, id: doc.id, descriptorUrl: new URL('/.well-known/aen.json', target).href, target, etag: r.headers.get('etag'), level, keyFingerprint: fp,
			kind: doc.kind, name: doc.name, categories: doc.categories ?? [], keywords: doc.keywords ?? [],
			capabilities: [...new Set((doc.actions ?? []).map((a) => a.capability))], countries: doc.countries ?? [],
			eventsPath: doc.events?.path
		}
		return { ok: true, entry }
	}

	/** Live channel: the business tells us when something changed; we re-fetch from the host (the event carries nothing to trust). */
	function watch(id: string) {
		const e = entries.get(id)
		if (!e?.eventsPath || watching.has(id)) return
		const ac = new AbortController()
		watching.set(id, ac)
		void (async () => {
			while (!ac.signal.aborted) {
				try {
					const r = await f(new URL(e.eventsPath!, e.target), { signal: ac.signal, headers: { accept: 'text/event-stream' } })
					let buf = ''
					for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
						buf += Buffer.from(chunk).toString()
						let i
						while ((i = buf.indexOf('\n\n')) >= 0) {
							const block = buf.slice(0, i)
							buf = buf.slice(i + 2)
							if (block.includes('event: descriptor-changed')) {
								const cur = entries.get(id)
								const got = cur && (await ingest(cur.target, cur))
								if (got?.ok) entries.set(id, got.entry)
							}
						}
					}
				} catch {
					if (ac.signal.aborted) return
				}
				await new Promise((r) => setTimeout(r, 1000)) // reconnect
			}
		})()
	}

	/** What a search returns: a card of search keys and a pointer, nothing that belongs to the business's content. */
	const card = (e: Entry) => ({ id: e.id, kind: e.kind, name: e.name, categories: e.categories, capabilities: e.capabilities, verification: e.level })

	const server = createServer(async (req, res) => {
		try {
			const url = new URL(req.url ?? '/', base)

			if (req.method === 'GET' && url.pathname === '/.well-known/aen.json')
				return json(res, 200, {
					aen: '0.1', id: new URL(base).host, kind: 'directory', name: 'AEN reference directory (prototype)', url: base,
					actions: [{ id: 'search', capability: 'directory.search', method: 'GET', path: '/search', input: { type: 'object', properties: { q: { type: 'string' }, category: { type: 'string' }, capability: { type: 'string' }, country: { type: 'string' } } }, auth: { type: 'none' }, sideEffects: false }]
				})

			if (req.method === 'POST' && url.pathname === '/register') {
				if (!allowRegister(req.socket.remoteAddress ?? '?')) return json(res, 429, { error: 'rate_limited' })
				const b = (await readJson(req)) as { url?: string }
				const target = new URL(String(b.url))
				const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
				if (target.protocol !== 'https:' && !(target.protocol === 'http:' && loopback)) return json(res, 422, { error: 'https is required (plain http only for loopback, in development)' })
				const got = await ingest(target, entries.get(target.host))
				if (!got.ok) return json(res, got.status, { error: got.error, details: got.details })
				entries.set(got.entry.id, got.entry)
				watch(got.entry.id)
				return json(res, 201, { id: got.entry.id, verification: got.entry.level })
			}

			// Cards of search keys and a pointer only: an agent narrows down here, then reads one business from the business itself.
			if (req.method === 'GET' && url.pathname === '/search') {
				const q = (url.searchParams.get('q') ?? '').toLowerCase()
				const category = url.searchParams.get('category')
				const capability = url.searchParams.get('capability')
				const country = url.searchParams.get('country')
				const results = [...entries.values()]
					.filter((e) => !category || e.categories.includes(category))
					.filter((e) => !capability || e.capabilities.includes(capability))
					.filter((e) => !country || e.countries.includes(country))
					.filter((e) => !q || [e.name, ...e.categories, ...e.keywords, ...e.capabilities].some((t) => t.toLowerCase().includes(q)))
					.slice(0, 20)
					.map(card)
				return json(res, 200, { results })
			}

			const one = url.pathname.match(/^\/businesses\/([\w.%-]+)$/)
			if (req.method === 'GET' && one) {
				// The schema (descriptor) and where it lives. Signed copies can be checked by the agent without the business.
				const e = entries.get(decodeURIComponent(one[1]!))
				return e ? json(res, 200, { id: e.id, descriptorUrl: e.descriptorUrl, verification: e.level, keyFingerprint: e.keyFingerprint, descriptor: e.doc }) : json(res, 404, { error: 'not_found' })
			}
			json(res, 404, { error: 'not_found' })
		} catch {
			json(res, 400, { error: 'bad_request' })
		}
	})
	await listen(server, opts.port)
	return {
		url: base,
		close: async () => {
			for (const ac of watching.values()) ac.abort()
			await close(server)
			await f.close()
		}
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const port = Number(process.env.PORT ?? 4100)
	await startDirectory({ port, allowPrivate: process.env.ALLOW_PRIVATE === '1' })
	console.log(`directory on http://127.0.0.1:${port}`)
}
