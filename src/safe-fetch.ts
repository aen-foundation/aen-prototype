// fetch that refuses private, loopback and link-local addresses, checked at connect time on the address actually used
// (so a hostname that resolves to an internal address is refused too: DNS rebinding). Redirects are never followed.
import { lookup } from 'node:dns'
import { isIP } from 'node:net'

import { Agent, fetch as ufetch, type RequestInit, type Response } from 'undici'

export function isPrivateAddress(ip: string): boolean {
	const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip
	if (isIP(v4) === 4) {
		const [a, b] = v4.split('.').map(Number) as [number, number]
		return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
	}
	const x = ip.toLowerCase()
	return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb')
}

export type SafeFetch = ((url: string | URL, init?: RequestInit) => Promise<Response>) & { close(): Promise<void> }

export function safeFetch(allowPrivate = false): SafeFetch {
	const agent = new Agent({
		connect: {
			lookup: (hostname, options, cb) =>
				lookup(hostname, options, (err, address, family) => {
					if (err) return (cb as (e: Error) => void)(err)
					const list = Array.isArray(address) ? address.map((a) => a.address) : [address as string]
					if (!allowPrivate && list.some(isPrivateAddress)) return (cb as (e: Error) => void)(new Error(`refusing to connect to a private address (${hostname})`))
					;(cb as (e: null, a: unknown, f: unknown) => void)(null, address, family)
				})
		}
	})
	const f = ((url: string | URL, init: RequestInit = {}) => {
		// Node does not call the DNS lookup for a literal IP, so a literal private address has to be refused here.
		const host = new URL(url).hostname.replace(/^\[|\]$/g, '')
		if (!allowPrivate && isIP(host) && isPrivateAddress(host)) return Promise.reject(new Error(`refusing to connect to a private address (${host})`))
		return ufetch(url, { redirect: 'error', ...init, dispatcher: agent })
	}) as SafeFetch
	f.close = () => agent.close()
	return f
}
