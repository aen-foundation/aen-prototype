// The adapter over real MCP (stdio), as an agent such as Claude or ChatGPT would use it.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startCafe } from '../src/business/cafe.ts'
import { startDirectory } from '../src/directory/server.ts'

describe('MCP adapter', () => {
	let dir: Awaited<ReturnType<typeof startDirectory>>
	let cafe: Awaited<ReturnType<typeof startCafe>>
	let client: Client

	const call = async (name: string, args: Record<string, unknown>) => {
		const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] }
		return JSON.parse(r.content[0]!.text)
	}

	beforeAll(async () => {
		dir = await startDirectory({ port: 4140, allowPrivate: true })
		cafe = await startCafe({ port: 4141, stepMs: 50 })
		await fetch(`${dir.url}/register`, { method: 'POST', body: JSON.stringify({ url: cafe.url }) })
		client = new Client({ name: 'test-agent', version: '0' })
		await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/adapter/mcp.ts'], env: { ...process.env, AEN_DIRECTORY_URL: dir.url, AEN_ALLOW_PRIVATE: '1' } as Record<string, string> }))
	})
	afterAll(async () => {
		await client.close()
		await cafe.close()
		await dir.close()
	})

	it('exposes four small tools', async () => {
		const { tools } = await client.listTools()
		expect(tools.map((t) => t.name).sort()).toEqual(['aen_call_action', 'aen_describe_action', 'aen_get_business', 'aen_search'])
	})

	it('search, refusal, user approval, then a payment hand-off, by capability', async () => {
		const found = await call('aen_search', { category: 'coffee', capability: 'order.create' })
		const id = found.results[0].id
		const input = { items: [{ serviceId: 'espresso', quantity: 1 }] }
		expect(await call('aen_call_action', { businessId: id, action: 'order.create', input })).toMatchObject({ ok: false, error: 'confirmation_required' })
		const need = await call('aen_call_action', { businessId: id, action: 'order.create', input, userConfirmed: true })
		expect(need).toMatchObject({ ok: false, error: 'authorization_required' })
		await fetch(`${cafe.url}/device/decision`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `user_code=${need.userCode}&decision=approve` })
		const placed = await call('aen_call_action', { businessId: id, action: 'order.create', input, userConfirmed: true })
		expect(placed).toMatchObject({ ok: true, body: { status: 'requires_user_approval' } })
		expect(placed.instructions).toMatch(/user pays/i)
		expect(placed.idempotencyKey).toBeTruthy()
	})

	it('describes one action on request and wraps business text as untrusted', async () => {
		const b = await call('aen_get_business', { id: '127.0.0.1:4141' })
		expect(b.untrusted_content.name).toBe('Corner Cafe')
		expect(JSON.stringify(b)).not.toContain('"input"')
		expect((await call('aen_describe_action', { businessId: '127.0.0.1:4141', action: 'order.create' })).input.required).toEqual(['items'])
	})
})
