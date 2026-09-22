/**
 * Stand-in for `@deepseek-ai/dsh-tools` used by the test suites.
 *
 * `defineTool` keeps only what this plugin relies on, but it rejects the same
 * malformed definitions the framework would: unknown spec keys, missing
 * sections, a non-function render.
 */

const ALLOWED_SPEC_KEYS = new Set([
  'type', 'required', 'description', 'enum', 'const', 'items', 'properties', 'additionalProperties', 'oneOf', 'default',
])

const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'])

/** Validate one property spec the way the framework's converter expects it. */
function assertSpec(spec, path) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error(`${path}: expected a property spec object`)
  }
  for (const key of Object.keys(spec)) {
    if (!ALLOWED_SPEC_KEYS.has(key)) throw new Error(`${path}: unsupported spec key "${key}"`)
  }
  if (!TYPES.has(spec.type)) throw new Error(`${path}: missing or invalid type ${JSON.stringify(spec.type)}`)
  if (spec.required !== undefined && typeof spec.required !== 'boolean') throw new Error(`${path}: required must be a boolean`)
  if (spec.enum !== undefined) {
    if (!Array.isArray(spec.enum) || spec.enum.length === 0) throw new Error(`${path}: enum must be a non-empty array`)
    for (const entry of spec.enum) {
      if (typeof entry !== 'string' && typeof entry !== 'number' && typeof entry !== 'boolean') {
        throw new Error(`${path}: enum entries must be primitives`)
      }
    }
  }
  if (spec.type === 'array') {
    if (spec.items === undefined) throw new Error(`${path}: array needs items`)
    assertSpec(spec.items, `${path}.items`)
  }
  if (spec.type === 'object') {
    // The harness schema compiler requires this to be explicit on every object.
    if (typeof spec.additionalProperties !== 'boolean') {
      throw new Error(`${path}: schema.additionalProperties must be explicitly true or false`)
    }
    for (const [key, value] of Object.entries(spec.properties ?? {})) assertSpec(value, `${path}.properties.${key}`)
  }
}

/**
 * Identity registration with the framework's guard rails.
 * @param definition - the tool definition written by the plugin.
 */
export function defineTool(definition) {
  for (const key of ['name', 'description', 'parameters', 'output', 'execute']) {
    if (definition[key] === undefined) throw new Error(`defineTool: missing ${key}`)
  }
  if (typeof definition.name !== 'string' || !/^[a-z][a-z0-9_]*$/u.test(definition.name)) {
    throw new Error(`defineTool: tool name "${String(definition.name)}" is not a lowercase snake_case identifier`)
  }
  if (typeof definition.output.render !== 'function') throw new Error(`defineTool(${definition.name}): output.render must be a function`)
  if (definition.output.schema === undefined) throw new Error(`defineTool(${definition.name}): output.schema is required`)
  assertSpec(definition.output.schema, `${definition.name}.output.schema`)
  for (const [key, value] of Object.entries(definition.parameters)) {
    assertSpec(value, `${definition.name}.parameters.${key}`)
  }
  return definition
}

export const TOOL_ABORTED = 'tool_aborted'
