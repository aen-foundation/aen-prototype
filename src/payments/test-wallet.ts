// TEST-MODE stand-ins for the two real parties in a token payment. No card data and no money exist here.
//   wallet: the USER's side. Mints a one-time token only for exactly what the user just confirmed.
//   psp:    the BUSINESS's payment processor. Redeems a token for one charge.
// The allowance mirrors the fields of ACP's delegated payment spec: reason one_time, max_amount (minor units), currency,
// checkout_session_id, merchant_id, expires_at. AEN itself never sees inside a token: its format is the provider's.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

export type Allowance = { reason: 'one_time'; max_amount: number; currency: string; checkout_session_id: string; merchant_id: string; expires_at: string }
export type Charge = { merchant: string; amount: number; currency: string; orderId: string }
export type Redeem = { ok: true } | { ok: false; reason: 'invalid_token' | 'already_used' | 'wrong_merchant' | 'wrong_order' | 'amount_exceeds_allowance' | 'wrong_currency' | 'expired' }
export type Wallet = { mint(a: { merchant: string; orderId: string; maxAmount: number; currency: string; ttlMs?: number }): string }
export type Psp = { redeem(token: string, charge: Charge): Redeem }

export function createTestPayments() {
	const secret = randomBytes(32)
	const used = new Set<string>()
	const sign = (p: string) => createHmac('sha256', secret).update(p).digest('base64url')

	const wallet: Wallet = {
		mint({ merchant, orderId, maxAmount, currency, ttlMs = 5 * 60_000 }) {
			const claims = { jti: randomUUID(), allowance: { reason: 'one_time', max_amount: maxAmount, currency, checkout_session_id: orderId, merchant_id: merchant, expires_at: new Date(Date.now() + ttlMs).toISOString() } satisfies Allowance }
			const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
			return `tpt_${payload}.${sign(payload)}`
		}
	}

	const psp: Psp = {
		redeem(token, charge) {
			const [payload, sig] = token.replace(/^tpt_/, '').split('.')
			if (!payload || !sig) return { ok: false, reason: 'invalid_token' }
			const expected = Buffer.from(sign(payload))
			const given = Buffer.from(sig)
			if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'invalid_token' }
			const { jti, allowance: a } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { jti: string; allowance: Allowance }
			// One time: a validly signed token is consumed the first time anyone presents it, even if the charge is then refused.
			if (used.has(jti)) return { ok: false, reason: 'already_used' }
			used.add(jti)
			if (Date.parse(a.expires_at) < Date.now()) return { ok: false, reason: 'expired' }
			if (a.merchant_id !== charge.merchant) return { ok: false, reason: 'wrong_merchant' }
			if (a.checkout_session_id !== charge.orderId) return { ok: false, reason: 'wrong_order' }
			if (a.currency !== charge.currency) return { ok: false, reason: 'wrong_currency' }
			if (charge.amount > a.max_amount) return { ok: false, reason: 'amount_exceeds_allowance' }
			return { ok: true }
		}
	}
	return { wallet, psp }
}
