// Validates AEN documents against the JSON Schemas in spec/schemas. The schemas are the standard; this is only a
// convenience wrapper (library + CLI: `pnpm validate <file.json> [descriptor|payment-handoff|payment-result|order-status]`).
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import type { ErrorObject } from 'ajv/dist/2020.js'

// Ajv and ajv-formats are CommonJS: load them with require so the constructors have the right types under ESM.
const require = createRequire(import.meta.url)
const Ajv2020: typeof import('ajv/dist/2020.js').default = require('ajv/dist/2020').default
const addFormats: typeof import('ajv-formats').default = require('ajv-formats').default

export type Kind = 'descriptor' | 'payment-handoff' | 'payment-result' | 'order-status'
export type Result = { ok: true } | { ok: false; errors: string[] }

const dir = new URL('../spec/schemas/', import.meta.url)
const ajv = new Ajv2020({ allErrors: true, strict: true })
addFormats(ajv)
const compiled = Object.fromEntries(
	(['descriptor', 'payment-handoff', 'payment-result', 'order-status'] as const).map((k) => [
		k,
		ajv.compile(JSON.parse(readFileSync(new URL(`${k}.schema.json`, dir), 'utf8')))
	])
)

export function validate(kind: Kind, doc: unknown): Result {
	const check = compiled[kind]
	if (check(doc)) return { ok: true }
	return {
		ok: false,
		errors: (check.errors ?? []).map((e: ErrorObject) => `${e.instancePath || '/'} ${e.message}`)
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [file, kind = 'descriptor'] = process.argv.slice(2)
	if (!file) {
		console.error('usage: pnpm validate <file.json> [descriptor|payment-handoff|payment-result|order-status]')
		process.exit(2)
	}
	const r = validate(kind as Kind, JSON.parse(readFileSync(file, 'utf8')))
	console.log(r.ok ? `ok: ${file} is a valid ${kind}` : `invalid ${kind}:\n  ${r.errors.join('\n  ')}`)
	process.exit(r.ok ? 0 : 1)
}
