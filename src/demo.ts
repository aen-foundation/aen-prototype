// End-to-end demo with a scripted "agent" (no LLM): search, order, hand-off, user pays, poll until ready.
import { pathToFileURL } from 'node:url'

import { createClient } from './adapter/client.ts'
import { startCafe } from './business/cafe.ts'
import { startDirectory } from './directory/server.ts'

export async function runDemo(log: (s: string) => void = console.log) {
	const dir = await startDirectory({ port: 4100, allowPrivate: true })
	const cafe = await startCafe({ port: 4101, stepMs: 100 })
	const agent = createClient(dir.url, { allowPrivate: true })
	try {
		const reg = await fetch(`${dir.url}/register`, { method: 'POST', body: JSON.stringify({ url: cafe.url }) })
		log(`1. cafe registers with the directory -> ${reg.status}`)

		const found = (await agent.search(undefined, 'coffee', 'order.create')) as { results: { id: string; name: string; verification: string }[] }
		const id = found.results[0]!.id
		log(`2. agent searches (category coffee, capability order.create) -> ${found.results.map((r) => `${r.name} [${r.verification}]`).join(', ')}`)

		const biz = await agent.getBusiness(id)
		log(`3. agent reads the compact business -> actions: ${biz!.actions.map((a) => a.capability).join(', ')}`)
		const schema = await agent.describeAction(id, 'order.create')
		log(`   ...and fetches the input schema of just order.create -> ${Object.keys((schema!.input as { properties: object }).properties).join(', ')}`)

		const order = { items: [{ serviceId: 'espresso', quantity: 2 }] }
		const refused = await agent.callAction(id, 'order.create', order)
		log(`4. order without user confirmation -> ${refused.ok ? 'ALLOWED (bug)' : `refused: ${refused.error}`}`)

		const needAuth = await agent.callAction(id, 'order.create', order, true)
		if (needAuth.ok || needAuth.error !== 'authorization_required') throw new Error('expected authorization_required')
		log(`5. the business needs the USER's approval -> ${needAuth.verificationUri} (code ${needAuth.userCode})`)
		const ok = await fetch(`${cafe.url}/device/decision`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `user_code=${needAuth.userCode}&decision=approve` })
		log(`   user opens the page and approves -> ${ok.status}`)

		const placed = await agent.callAction(id, 'order.create', order, true)
		if (!placed.ok) throw new Error(placed.message)
		const h = placed.body as { orderId: string; amount: { amount: number }; handoffUrl: string }
		log(`6. confirmed order -> hand-off: $${(h.amount.amount / 100).toFixed(2)} at ${h.handoffUrl}`)

		const approve = await fetch(`${h.handoffUrl}/approve`, { method: 'POST' })
		log(`7. the USER pays on the provider page (test mode) -> ${approve.status}`)

		let status = ''
		for (let i = 0; i < 50 && status !== 'ready'; i++) {
			const sRes = await agent.callAction(id, 'order.status', { orderId: h.orderId })
			if (!sRes.ok && sRes.error === 'authorization_required') {
				await fetch(`${cafe.url}/device/decision`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `user_code=${sRes.userCode}&decision=approve` })
				continue
			}
			status = sRes.ok ? (sRes.body as { status: string }).status : `error (${sRes.message})`
			await new Promise((r) => setTimeout(r, 50))
		}
		log(`8. agent polls order.status -> ${status}`)
		return status === 'ready'
	} finally {
		await agent.close()
		await cafe.close()
		await dir.close()
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit((await runDemo()) ? 0 : 1)
