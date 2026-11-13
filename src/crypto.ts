// Small crypto helpers for the prototype: DPoP-style proofs (a token only works with the key it was issued to),
// Ed25519 signing of descriptors, canonical JSON. Node's built-in crypto only.
import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from 'node:crypto'

export const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url')
const sha256 = (s: Buffer | string) => createHash('sha256').update(s).digest()

/** Canonical JSON (sorted keys, no whitespace), so a signature does not depend on formatting. */
export function jcs(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`
	if (v && typeof v === 'object') {
		const o = v as Record<string, unknown>
		return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${jcs(o[k])}`).join(',')}}`
	}
	return JSON.stringify(v)
}

// ---- DPoP-style proof of possession --------------------------------------------------------------------------
export type Jwk = { kty: 'EC'; crv: 'P-256'; x: string; y: string }
const enc = (o: unknown) => b64u(JSON.stringify(o))
export const jwkThumbprint = (j: Jwk) => b64u(sha256(`{"crv":"${j.crv}","kty":"${j.kty}","x":"${j.x}","y":"${j.y}"}`))

export function makeDpopKey() {
	const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
	const raw = publicKey.export({ format: 'jwk' }) as Jwk
	const jwk: Jwk = { kty: raw.kty, crv: raw.crv, x: raw.x, y: raw.y }
	return {
		jkt: jwkThumbprint(jwk),
		/** A one-use proof that this request (method + URL) comes from the holder of the key. */
		proof(method: string, url: string, accessToken?: string): string {
			const u = new URL(url)
			const head = enc({ typ: 'dpop+jwt', alg: 'ES256', jwk })
			const body = enc({ htm: method, htu: u.origin + u.pathname, iat: Math.floor(Date.now() / 1000), jti: randomUUID(), ...(accessToken ? { ath: b64u(sha256(accessToken)) } : {}) })
			const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' })
			return `${head}.${body}.${b64u(sig)}`
		}
	}
}

/** Remembers proof ids for a while: a proof can be used once. */
export function makeReplayGuard(ttlMs = 120_000) {
	const seen = new Map<string, number>()
	return (jti: string): boolean => {
		const now = Date.now()
		for (const [k, t] of seen) if (t < now) seen.delete(k)
		if (seen.has(jti)) return false
		seen.set(jti, now + ttlMs)
		return true
	}
}

/** Returns the key thumbprint if the proof is genuine, fresh, unused and for exactly this request; otherwise null. */
export function verifyDpop(proof: string | undefined, o: { method: string; url: string; accessToken?: string; fresh: (jti: string) => boolean }): string | null {
	try {
		const [h, p, s] = (proof ?? '').split('.')
		if (!h || !p || !s) return null
		const head = JSON.parse(Buffer.from(h, 'base64url').toString()) as { typ?: string; alg?: string; jwk?: Jwk }
		const body = JSON.parse(Buffer.from(p, 'base64url').toString()) as { htm?: string; htu?: string; iat?: number; jti?: string; ath?: string }
		const jwk = head.jwk
		if (head.typ !== 'dpop+jwt' || head.alg !== 'ES256' || jwk?.kty !== 'EC' || jwk.crv !== 'P-256') return null
		const key = createPublicKey({ key: jwk as never, format: 'jwk' })
		if (!verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))) return null
		const u = new URL(o.url)
		if (body.htm !== o.method || body.htu !== u.origin + u.pathname) return null
		if (typeof body.iat !== 'number' || Math.abs(Date.now() / 1000 - body.iat) > 60) return null
		if (o.accessToken && body.ath !== b64u(sha256(o.accessToken))) return null
		if (typeof body.jti !== 'string' || !o.fresh(body.jti)) return null
		return jwkThumbprint(jwk)
	} catch {
		return null
	}
}

// ---- Signed descriptors -------------------------------------------------------------------------------------
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex')
export type SigningKey = { privateKey: KeyObject; publicKey: string }

export function makeSigningKey(): SigningKey {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519')
	return { privateKey, publicKey: b64u(publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI_ED25519.length)) }
}

/** What goes in a DNS TXT record to pin the key: `_aen.<host> TXT "v=aen1; key=<fingerprint>"`. */
export const keyFingerprint = (publicKey: string) => `sha256:${createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex')}`

export function signDescriptor<T extends object>(doc: T, key: SigningKey) {
	const signing = { alg: 'Ed25519' as const, publicKey: key.publicKey }
	const signature = b64u(sign(null, Buffer.from(jcs({ ...doc, signing })), key.privateKey))
	return { ...doc, signing: { ...signing, signature } }
}

export function verifySignature(doc: { signing?: { alg: string; publicKey: string; signature: string } }): boolean {
	try {
		const s = doc.signing
		if (!s || s.alg !== 'Ed25519') return false
		const { signature, ...rest } = s
		const pub = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(s.publicKey, 'base64url')]), format: 'der', type: 'spki' })
		return verify(null, Buffer.from(jcs({ ...doc, signing: rest })), pub, Buffer.from(signature, 'base64url'))
	} catch {
		return false
	}
}
