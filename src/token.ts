// Access tokens: short-lived, scoped, for one audience, bound to the key of the client they were issued to (`jkt`), and
// signed (HMAC) so nothing about them is stored server-side.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export type Claims = { aud: string; scopes: string[]; exp: number; jkt: string }

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url')

export function makeSigner(secret: Buffer = randomBytes(32)) {
	const sign = (payload: string) => createHmac('sha256', secret).update(payload).digest()
	return {
		issue(aud: string, scopes: string[], jkt: string, ttlSeconds = 600): { token: string; claims: Claims } {
			const claims: Claims = { aud, scopes, exp: Date.now() + ttlSeconds * 1000, jkt }
			const payload = b64(JSON.stringify(claims))
			return { token: `${payload}.${b64(sign(payload))}`, claims }
		},
		/** Returns the claims only if the signature, audience, expiry and scope all check out. */
		verify(token: string | undefined, aud: string, scope: string): Claims | null {
			const [payload, sig] = (token ?? '').split('.')
			if (!payload || !sig) return null
			const expected = sign(payload)
			const given = Buffer.from(sig, 'base64url')
			if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
			try {
				const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Claims
				return claims.aud === aud && claims.exp > Date.now() && claims.scopes.includes(scope) ? claims : null
			} catch {
				return null
			}
		}
	}
}
