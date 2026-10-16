import { parse } from 'acorn'

// This is an interpreter, not a JavaScript VM. No source is passed to eval,
// Function, node:vm or native callback APIs. Unsupported syntax fails closed.
const forbidden = new Set(['constructor', 'prototype', '__proto__', 'caller', 'callee', 'arguments'])
const shortCircuit = Symbol('optional-chain')
const globals = new Set(['process', 'global', 'globalThis', 'window', 'document', 'require', 'module', 'exports', 'eval', 'Function', 'fetch', 'WebAssembly'])
const supported = new Set(['Literal', 'Identifier', 'ArrayExpression', 'ObjectExpression', 'Property', 'UnaryExpression', 'BinaryExpression', 'LogicalExpression', 'ConditionalExpression', 'MemberExpression', 'ChainExpression', 'CallExpression', 'AwaitExpression', 'ArrowFunctionExpression', 'FunctionExpression', 'BlockStatement', 'ReturnStatement', 'VariableDeclaration', 'VariableDeclarator', 'IfStatement', 'ExpressionStatement', 'TemplateLiteral', 'TemplateElement', 'SpreadElement', 'EmptyStatement'])
export interface ExpressionDiagnostic { valid: boolean; message?: string; line?: number; column?: number }
export interface ExpressionLimits { maxSteps?: number; timeoutMs?: number }
type Scope = Map<string, any>
type Capability = (...args: any[]) => any

function key(value: any): string | symbol {
    if (typeof value === 'symbol') return value
    if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Unsupported property key.')
    const result = String(value)
    if (forbidden.has(result)) throw new Error('Property is forbidden: ' + result)
    return result
}

function syntax(source: string): any {
    if (typeof source !== 'string' || source.length > 16000) throw new Error('Expression size limit exceeded (16000 characters).')
    const program: any = parse('async () => (\n' + source + '\n)', { ecmaVersion: 2022, locations: true })
    const node = program.body[0]?.expression?.body
    if (program.body.length !== 1 || !node) throw new Error('A single expression is required.')
    let count = 0
    function visit(value: any, depth: number): void {
        if (!value || typeof value !== 'object') return
        if (++count > 4000 || depth > 64) throw new Error('Expression complexity limit exceeded.')
        if (Array.isArray(value)) { value.forEach(child => visit(child, depth)); return }
        if (typeof value.type === 'string') {
          try {
            if (!supported.has(value.type)) throw Object.assign(new Error('Unsupported expression syntax: ' + value.type), { loc: value.loc?.start })
            if (value.type === 'BinaryExpression' && !['+','-','*','/','%','**','==','!=','===','!==','<','<=','>','>='].includes(value.operator)) throw new Error('Binary operator is not allowed.')
            if (value.type === 'UnaryExpression' && !['!','+','-','typeof','void'].includes(value.operator)) throw new Error('Unary operator is not allowed.')
            if (value.type === 'VariableDeclaration' && value.kind === 'var') throw new Error('Use const or let for local bindings.')
            if (value.regex || value.bigint) throw new Error('Regular expressions and BigInt are not allowed.')
            if (value.type === 'Identifier' && globals.has(value.name)) throw new Error('Identifier is not allowed: ' + value.name)
            if (value.type === 'MemberExpression' && !value.computed) key(value.property.name)
            if (value.type === 'MemberExpression' && value.object.type === 'Identifier' && value.object.name === 'channel' && (!value.computed && value.property.name === 'config' || value.computed && value.property.value === 'config')) throw new Error('Channel configuration is not allowed in expressions.')
            if (value.type === 'Property' && !value.computed) key(value.key.name ?? value.key.value)
            if (value.type === 'Property' && (value.kind !== 'init' || value.method)) throw new Error('Object accessors and methods are not allowed.')
            if (['ArrowFunctionExpression', 'FunctionExpression'].includes(value.type) && (value.generator || value.params.some((param: any) => param.type !== 'Identifier'))) throw new Error('Only simple function parameters are supported.')
          } catch (error: any) {
            if (!error.loc) error.loc = value.loc?.start
            throw error
          }
        }
        for (const name of Object.keys(value)) if (!['loc', 'start', 'end'].includes(name)) visit(value[name], depth + 1)
    }
    visit(node, 0)
    return node
}

export function validateMappingExpression(source: string): ExpressionDiagnostic {
    if (!source?.trim()) return { valid: true }
    try { syntax(source); return { valid: true } } catch (error: any) {
        return { valid: false, message: error.message, line: Math.max(1, (error.loc?.line || 2) - 1), column: (error.loc?.column || 0) + 1 }
    }
}

export function expressionSnapshot(value: any): any {
    if (value === undefined) return undefined
    const serialized = JSON.stringify(value)
    if (serialized === undefined || serialized.length > 1000000) throw new Error('Expression JSON input limit exceeded.')
    return JSON.parse(serialized)
}

export async function evaluateMappingExpression(source: string, inputs: Record<string, any>, capabilities: Record<string, Capability> = {}, limits: ExpressionLimits = {}): Promise<any> {
    if (!source?.trim()) return null
    const root = syntax(source)
    const maxSteps = Math.min(limits.maxSteps || 10000, 10000)
    const timeoutMs = Math.min(limits.timeoutMs || 2000, 10000)
    const deadline = Date.now() + timeoutMs
    let steps = 0
    const closures = new WeakMap<object, { node: any; scope: Scope }>()
    const calls = new WeakMap<object, Capability>()
    const env: Scope = new Map()
    for (const name of Object.keys(inputs)) env.set(name, expressionSnapshot(inputs[name]))
    function primitive(value: any): any {
        if (value !== null && typeof value === 'object' || typeof value === 'function' || typeof value === 'symbol') throw new Error('Native coercion requires a primitive value.')
        return value
    }
    const token = (fn: Capability) => { const value = Object.freeze(Object.create(null)); calls.set(value, fn); return value }
    let capabilityCalls = 0
    const utils = Object.create(null)
    for (const name of Object.keys(capabilities)) utils[key(name)] = token(async (...args: any[]) => {
        tick()
        if (++capabilityCalls > 32) throw new Error('Expression capability call limit exceeded.')
        return expressionSnapshot(await capabilities[name](...output(args)))
    })
    env.set('utils', utils)
    env.set('undefined', undefined)
    for (const [name, fn] of Object.entries({ String: (v: any) => String(primitive(v)), Number: (v: any) => Number(primitive(v)), Boolean: (v: any) => Boolean(v), parseInt: (v: any, radix?: number) => parseInt(String(primitive(v)), primitive(radix)), parseFloat: (v: any) => parseFloat(String(primitive(v))), isNaN: (v: any) => Number.isNaN(Number(primitive(v))) })) env.set(name, token(fn))
    const math = Object.create(null)
    for (const name of ['abs', 'ceil', 'floor', 'round', 'min', 'max', 'sqrt', 'pow']) math[name] = token((...args: any[]) => (Math as any)[name](...args.map(primitive)))
    env.set('Math', math)
    env.set('JSON', { stringify: token((v: any) => JSON.stringify(output(v))), parse: token((v: any) => expressionSnapshot(JSON.parse(String(primitive(v))))) })

    function tick(): void {
        if (++steps > maxSteps) throw new Error('Expression computation limit exceeded.')
        if (Date.now() >= deadline) throw new Error('Expression timeout.')
    }
    function bounded(value: any): any {
        if (typeof value === 'string' && value.length > 100000 || Array.isArray(value) && value.length > 10000) throw new Error('Expression result size limit exceeded.')
        return value
    }
    function output(value: any, depth = 0, budget = { bytes: 0 }): any {
        tick()
        if (depth > 64) throw new Error('Expression result depth limit exceeded.')
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Expression result must be a finite number.')
        const add = (bytes: number) => { budget.bytes += bytes; if (budget.bytes > 1000000) throw new Error('Expression aggregate result size limit exceeded.') }
        if (value === null || value === undefined || ['string', 'number', 'boolean'].includes(typeof value)) {
            bounded(value)
            add(Buffer.byteLength(JSON.stringify(value) || 'null', 'utf8') + 1)
            return value
        }
        add(2)
        if (typeof value !== 'object' || calls.has(value) || closures.has(value)) throw new Error('Unsupported expression result; JSON value required.')
        if (Array.isArray(value)) return bounded(value.map(child => output(child, depth + 1, budget)))
        const result: Record<string, any> = {}
        for (const name of Object.keys(value)) { key(name); add(Buffer.byteLength(JSON.stringify(name), 'utf8') + 2); result[name] = output(value[name], depth + 1, budget) }
        return result
    }
    async function invoke(fn: any, args: any[]): Promise<any> {
        tick()
        if (!fn || typeof fn !== 'object') throw new Error('Function call is not allowed.')
        const capability = calls.get(fn)
        if (capability) return bounded(await capability(...args))
        const closure = closures.get(fn)
        if (!closure) throw new Error('Function call is not allowed.')
        const scope = new Map(closure.scope)
        closure.node.params.forEach((param: any, index: number) => scope.set(param.name, args[index]))
        const result = await run(closure.node.body, scope)
        return result instanceof ReturnValue ? result.value : result
    }
    async function member(node: any, scope: Scope): Promise<{ value: any; name: string | symbol }> {
        const value = await run(node.object, scope)
        if (value === shortCircuit || value == null && node.optional) return { value: shortCircuit, name: '' }
        return { value, name: key(node.computed ? await run(node.property, scope) : node.property.name) }
    }
    async function method(value: any, name: string | symbol, args: any[]): Promise<any> {
        if (Array.isArray(value)) {
            if (['map', 'filter', 'find', 'some', 'every', 'reduce'].includes(String(name))) {
                const result: any[] = []; let accumulator = args[1]; let start = 0
                if (name === 'reduce' && args.length < 2) { if (!value.length) throw new Error('Reduce requires a value.'); accumulator = value[0]; start = 1 }
                for (let index = start; index < value.length; index++) {
                    tick()
                    const row = await invoke(args[0], name === 'reduce' ? [accumulator, value[index], index] : [value[index], index])
                    if (name === 'map') result.push(row)
                    if (name === 'filter' && row) result.push(value[index])
                    if (name === 'find' && row) return value[index]
                    if (name === 'some' && row) return true
                    if (name === 'every' && !row) return false
                    if (name === 'reduce') accumulator = row
                }
                return name === 'reduce' ? accumulator : name === 'find' ? undefined : name === 'some' ? false : name === 'every' ? true : result
            }
            if (name === 'join') {
                const separator = args[0] === undefined ? ',' : String(primitive(args[0]))
                const pieces = value.map(row => row == null ? '' : String(primitive(row)))
                if (pieces.reduce((length, row) => length + row.length, 0) + separator.length * Math.max(0, pieces.length - 1) > 100000) throw new Error('Expression result size limit exceeded.')
                return pieces.join(separator)
            }
            if (name === 'concat') {
                if (value.length + args.reduce((length, row) => length + (Array.isArray(row) ? row.length : 1), 0) > 10000) throw new Error('Expression result size limit exceeded.')
                return value.concat(...args)
            }
            if (['includes', 'indexOf', 'slice'].includes(String(name))) return bounded((value as any)[name](...args.map(primitive)))
        }
        if (typeof value === 'string' && ['trim', 'toLowerCase', 'toUpperCase', 'includes', 'startsWith', 'endsWith', 'indexOf', 'slice', 'substring', 'split', 'replace'].includes(String(name))) {
            if (name === 'replace' && typeof args[0] !== 'string') throw new Error('Only string replacement is allowed.')
            return bounded((value as any)[name](...args.map(primitive)))
        }
        if (typeof value === 'number' && name === 'toFixed') return value.toFixed(Math.max(0, Math.min(20, Number(primitive(args[0])) || 0)))
        if (value && Object.prototype.hasOwnProperty.call(value, name)) return invoke(value[name], args)
        throw new Error('Method is not allowed: ' + String(name))
    }
    class ReturnValue { constructor(public value: any) {} }
    async function run(node: any, scope: Scope): Promise<any> {
        tick()
        if (!node) return undefined
        switch (node.type) {
            case 'Literal': return node.value
            case 'Identifier': if (!scope.has(node.name)) throw new Error('Unknown identifier: ' + node.name); return scope.get(node.name)
            case 'ChainExpression': { const value = await run(node.expression, scope); return value === shortCircuit ? undefined : value }
            case 'AwaitExpression': return run(node.argument, scope)
            case 'ArrayExpression': { const arr = []; for (const row of node.elements) { if (row?.type === 'SpreadElement') arr.push(...await run(row.argument, scope)); else arr.push(await run(row, scope)); bounded(arr) } return arr }
            case 'ObjectExpression': {
                const object = Object.create(null)
                for (const prop of node.properties) {
                    if (prop.type === 'SpreadElement') { const spread = await run(prop.argument, scope); for (const name of Object.keys(spread || {})) object[key(name)] = spread[name] }
                    else object[key(prop.computed ? await run(prop.key, scope) : prop.key.name ?? prop.key.value)] = await run(prop.value, scope)
                }
                return object
            }
            case 'MemberExpression': { const { value, name } = await member(node, scope); if (value === shortCircuit) return shortCircuit; if (value == null) { if (node.optional) return shortCircuit; throw new Error('Cannot access an empty value.') } return Object.prototype.hasOwnProperty.call(Object(value), name) ? value[name] : undefined }
            case 'CallExpression': {
                if (node.callee.type === 'MemberExpression') {
                    const { value, name } = await member(node.callee, scope)
                    if (value === shortCircuit || value == null && node.callee.optional) return shortCircuit
                    if (node.optional && (value == null || value[name] == null)) return shortCircuit
                    const args = []; for (const arg of node.arguments) { if (arg.type === 'SpreadElement') args.push(...await run(arg.argument, scope)); else args.push(await run(arg, scope)); bounded(args) }
                    return method(value, name, args)
                }
                const fn = await run(node.callee, scope); if (fn === shortCircuit || fn == null && node.optional) return shortCircuit
                const args = []; for (const arg of node.arguments) { if (arg.type === 'SpreadElement') args.push(...await run(arg.argument, scope)); else args.push(await run(arg, scope)); bounded(args) }
                return invoke(fn, args)
            }
            case 'ArrowFunctionExpression': case 'FunctionExpression': { const value = Object.freeze(Object.create(null)); closures.set(value, { node, scope: new Map(scope) }); return value }
            case 'ConditionalExpression': return run(await run(node.test, scope) ? node.consequent : node.alternate, scope)
            case 'LogicalExpression': { const left = await run(node.left, scope); return node.operator === '&&' ? left && await run(node.right, scope) : node.operator === '||' ? left || await run(node.right, scope) : left ?? await run(node.right, scope) }
            case 'UnaryExpression': { const value = await run(node.argument, scope); switch (node.operator) { case '!': return !value; case '+': return +primitive(value); case '-': return -primitive(value); case 'typeof': return typeof value; case 'void': return undefined; default: throw new Error('Unary operator is not allowed.') } }
            case 'BinaryExpression': {
                let a = await run(node.left, scope), b = await run(node.right, scope)
                if (node.operator === '===') return a === b
                if (node.operator === '!==') return a !== b
                if (['==', '!='].includes(node.operator) && (a == null || b == null || typeof a === 'object' && typeof b === 'object')) return node.operator === '==' ? a == b : a != b
                a = primitive(a); b = primitive(b)
                switch (node.operator) {
                    case '+': return bounded(a + b); case '-': return a - b; case '*': return a * b; case '/': return a / b; case '%': return a % b; case '**': return a ** b
                    case '==': return a == b; case '!=': return a != b; case '===': return a === b; case '!==': return a !== b; case '<': return a < b; case '<=': return a <= b; case '>': return a > b; case '>=': return a >= b
                    default: throw new Error('Binary operator is not allowed.')
                }
            }
            case 'TemplateLiteral': { let value = node.quasis[0].value.cooked; for (let i = 0; i < node.expressions.length; i++) value = bounded(value + String(primitive(await run(node.expressions[i], scope))) + node.quasis[i + 1].value.cooked); return value }
            case 'BlockStatement': { scope = new Map(scope); for (const statement of node.body) { const value = await run(statement, scope); if (value instanceof ReturnValue) return value } return undefined }
            case 'ReturnStatement': return new ReturnValue(await run(node.argument, scope))
            case 'VariableDeclaration': for (const declaration of node.declarations) { if (declaration.id.type !== 'Identifier') throw new Error('Unsupported variable binding.'); scope.set(declaration.id.name, await run(declaration.init, scope)) } return undefined
            case 'IfStatement': return run(await run(node.test, scope) ? node.consequent : node.alternate, scope)
            case 'ExpressionStatement': await run(node.expression, scope); return undefined
            case 'EmptyStatement': return undefined
            default: throw new Error('Unsupported expression syntax: ' + node.type)
        }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        const value = await Promise.race([run(root, env), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Expression timeout.')), timeoutMs) })])
        return output(value)
    } finally { if (timer) clearTimeout(timer) }
}
