// Checks the agent's request against the action's own `input` schema before anything is sent or shown for confirmation.
// The schema comes from the business, so it is untrusted: it is size-capped, stripped of keywords that can hang or
// reach out (regular expressions, references), and anything unusable is skipped, because the business enforces its own
// input anyway. This check is there to catch the model's mistakes early, and to send only fields the action declares.
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

import type { ValidateFunction } from 'ajv/dist/2020.js'

import { jcs } from '../crypto.ts'

const require = createRequire(import.meta.url)
const Ajv2020: typeof import('ajv/dist/2020.js').default = require('ajv/dist/2020').default
const addFormats: typeof import('ajv-formats').default = require('ajv-formats').default
const ajv = new Ajv2020({ allErrors: true, strict: false, validateSchema: true })
addFormats(ajv)

const MAX_BYTES = 8_000
const MAX_DEPTH = 8
// Keywords that can run regular expressions or reference other documents.
const DROP = new Set(['pattern', 'patternProperties', '$ref', '$dynamicRef', '$anchor', '$dynamicAnchor', '$id', '$schema', '$defs', 'definitions'])
const SUBSCHEMA = new Set(['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems'])
const LISTS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])

function clean(s: unknown, depth: number): unknown {
	if (depth > MAX_DEPTH) throw new Error('schema too deep')
	if (!s || typeof s !== 'object' || Array.isArray(s)) return s
	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
		if (DROP.has(k) || (k === 'format' && v === 'regex')) continue
		if (k === 'properties' && v && typeof v === 'object') out[k] = Object.fromEntries(Object.entries(v).map(([n, sub]) => [n, clean(sub, depth + 1)]))
		else if (SUBSCHEMA.has(k)) out[k] = clean(v, depth + 1)
		else if (LISTS.has(k) && Array.isArray(v)) out[k] = v.map((x) => clean(x, depth + 1))
		else out[k] = v
	}
	return out
}

const compiled = new Map<string, ValidateFunction | null>()
function compile(schema: unknown): ValidateFunction | null {
	if (JSON.stringify(schema).length > MAX_BYTES) return null
	const key = createHash('sha256').update(jcs(schema)).digest('hex')
	if (!compiled.has(key)) {
		try {
			compiled.set(key, ajv.compile(clean(schema, 0) as object))
		} catch {
			compiled.set(key, null)
		}
	}
	return compiled.get(key)!
}

export type InputCheck = { ok: true; checked: boolean } | { ok: false; errors: string[] }

/** `pathParams`: input names the action's path fills in; they are not body fields. */
export function checkInput(schema: unknown, input: Record<string, unknown>, pathParams: string[] = []): InputCheck {
	if (!schema || typeof schema !== 'object') return { ok: true, checked: false }
	const props = (schema as { properties?: Record<string, unknown> }).properties
	// Only declared fields are sent: if the action lists its fields, an extra one is refused, whatever the schema's additionalProperties says.
	if (props && typeof props === 'object') {
		const extra = Object.keys(input).filter((k) => !(k in props) && !pathParams.includes(k))
		if (extra.length) return { ok: false, errors: extra.map((k) => `field "${k}" is not declared by this action`) }
	}
	const validate = compile(schema)
	if (!validate) return { ok: true, checked: false }
	if (validate(input)) return { ok: true, checked: true }
	return { ok: false, errors: (validate.errors ?? []).slice(0, 5).map((e) => `${e.instancePath || '/'} ${e.message}`) }
}
