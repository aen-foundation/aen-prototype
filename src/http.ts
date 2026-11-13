import type { IncomingMessage, ServerResponse } from 'node:http'

export const json = (res: ServerResponse, status: number, body: unknown) => {
	res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
	res.end(JSON.stringify(body))
}

export const html = (res: ServerResponse, status: number, body: string) => {
	res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
	res.end(body)
}

/** Reads a JSON body, refusing anything over `limit` bytes. */
export async function readJson(req: IncomingMessage, limit = 10_000): Promise<unknown> {
	let size = 0
	const chunks: Buffer[] = []
	for await (const c of req) {
		size += (c as Buffer).length
		if (size > limit) throw new Error('body too large')
		chunks.push(c as Buffer)
	}
	return size ? JSON.parse(Buffer.concat(chunks).toString()) : {}
}

export const listen = (server: import('node:http').Server, port: number) =>
	new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
export const close = (server: import('node:http').Server) =>
	new Promise<void>((resolve) => {
		server.closeAllConnections()
		server.close(() => resolve())
	})

/** Reads an application/x-www-form-urlencoded body. */
export async function readForm(req: IncomingMessage, limit = 2_000): Promise<URLSearchParams> {
	let size = 0
	const chunks: Buffer[] = []
	for await (const c of req) {
		size += (c as Buffer).length
		if (size > limit) throw new Error('body too large')
		chunks.push(c as Buffer)
	}
	return new URLSearchParams(Buffer.concat(chunks).toString())
}

/** Fixed-window rate limit: returns false once `key` has used `max` requests in the window. */
export function makeLimiter(max: number, windowMs = 60_000) {
	const hits = new Map<string, { n: number; reset: number }>()
	return (key: string): boolean => {
		const now = Date.now()
		const h = hits.get(key)
		if (!h || h.reset < now) return (hits.set(key, { n: 1, reset: now + windowMs }), true)
		return ++h.n <= max
	}
}
