// Explicit operator stand for the manual AI-mapping acceptance run (kuppersberg only).
// Creates ONE inactive copy of the cooktop category (237418) in a new ym-type channel.
// Clears only the agreed 20 target rows; keeps filled rows for comparison mode, expressions,
// service rows and visibility untouched. No LLM calls. Never touches the source channel.
require('dotenv').config()
const fs = require('node:fs')
const path = require('node:path')
const { Client } = require('pg')
const { prepareCategory } = require('./sandbox-data.cjs')

const CATEGORY_ID = '237418'
const SOURCE_IDENTIFIER = 'ym'
const COPY_IDENTIFIER = 'ym_ai_sandbox_20261009_cooktop'
const CLEAR_IDS = [
  'yandexattr_23679910', 'yandexattr_14805523', 'yandexattr_14805336', 'yandexattr_14805494',
  'yandexattr_23681910', 'yandexattr_38641390', 'yandexattr_38642810', 'yandexattr_38635950',
  'yandexattr_38635670', 'yandexattr_38635850', 'yandexattr_38485730', 'yandexattr_38486550',
  'yandexattr_22454033', 'yandexattr_13887626', 'yandexattr_44234790', 'yandexattr_38485570',
  'yandexattr_38304130', 'yandexattr_39375370', 'yandexattr_39596190', 'yandexattr_39565950'
]
const output = path.resolve(__dirname, '../../docs/ai-mapping/kuppersberg-acceptance-stand.json')

function databaseClient () {
  const database = process.env.OPENPIM_DATABASE_NAME || process.env.DATABASE_NAME
  if (database !== 'kuppersberg') throw new Error('This stand only supports the kuppersberg database')
  return new Client({ host: process.env.OPENPIM_DATABASE_ADDRESS || process.env.DATABASE_URL,
    port: Number(process.env.OPENPIM_DATABASE_PORT || process.env.DATABASE_PORT || 5432), database,
    user: process.env.OPENPIM_DATABASE_USER || process.env.DATABASE_USER,
    password: process.env.OPENPIM_DATABASE_PASSWORD || process.env.DATABASE_PASSWORD,
    connectionTimeoutMillis: 10000 })
}

function rowName (row) {
  if (!row || row.name == null) return null
  if (typeof row.name === 'string') return row.name
  return row.name.ru || Object.values(row.name).find(value => typeof value === 'string') || null
}

async function main () {
  const client = databaseClient()
  await client.connect()
  let report = null
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL statement_timeout = '15s'")
    const sources = await client.query('SELECT id, identifier, type, "tenantId", mappings FROM channels WHERE identifier=$1 AND "deletedAt" IS NULL', [SOURCE_IDENTIFIER])
    if (sources.rowCount !== 1 || sources.rows[0].type !== 9) throw new Error('Expected exactly one Yandex channel named ym')
    const source = sources.rows[0]
    const category = source.mappings[CATEGORY_ID]
    if (!category || category.deleted || String(category.id) !== CATEGORY_ID) throw new Error('Source category unavailable')
    const collision = await client.query('SELECT id FROM channels WHERE identifier=$1 AND "deletedAt" IS NULL', [COPY_IDENTIFIER])
    if (collision.rowCount !== 0) throw new Error('Copy identifier already exists: ' + COPY_IDENTIFIER + ' (id ' + collision.rows[0].id + ')')
    for (const id of CLEAR_IDS) {
      const rows = category.attributes.filter(row => row.id === id)
      if (rows.length !== 1) throw new Error('Target row is missing or duplicated: ' + id)
      if (String(rows[0].expr || '').trim()) throw new Error('Target row has an expression: ' + id)
      if (!String(rows[0].attrIdent || '').trim()) throw new Error('Target row is already empty: ' + id)
    }
    const cleared = CLEAR_IDS.map(id => ({ id, name: rowName(category.attributes.find(row => row.id === id)), previousAttrIdent: category.attributes.find(row => row.id === id).attrIdent }))
    const copy = prepareCategory(category, CLEAR_IDS)
    const mappings = { [CATEGORY_ID]: copy }
    const name = { ru: 'AI тест — Варочные панели (09.10.2026)', en: 'AI acceptance test — cooktop (2026-10-09)' }
    const created = await client.query(`INSERT INTO channels
      (identifier, name, "order", "group", active, type, valid, visible, config, mappings, runtime,
       "parentId", "tenantId", "createdBy", "updatedBy", "createdAt", "updatedAt")
      SELECT $1, $2::jsonb, "order"+1, false, false, type, valid, visible, config, $3::jsonb, '{}'::jsonb,
       "parentId", "tenantId", 'codex-ai-experiment', 'codex-ai-experiment', NOW(), NOW()
      FROM channels WHERE id=$4 AND "tenantId"=$5 AND "deletedAt" IS NULL AND mappings=$6::jsonb
      RETURNING id, active`, [COPY_IDENTIFIER, JSON.stringify(name), JSON.stringify(mappings), source.id, source.tenantId, JSON.stringify(source.mappings)])
    if (created.rowCount !== 1) throw new Error('Source changed before copy')
    const copyId = created.rows[0].id

    // Read-back verification inside the same transaction; COMMIT only if everything passed.
    const readSource = await client.query('SELECT mappings FROM channels WHERE id=$1', [source.id])
    const readCopy = await client.query('SELECT identifier, active, type, mappings FROM channels WHERE id=$1', [copyId])
    const copyRow = readCopy.rows[0]
    const copyCategory = copyRow.mappings[CATEGORY_ID]
    const sourceUnchanged = JSON.stringify(readSource.rows[0].mappings) === JSON.stringify(source.mappings)
    const copyInactive = copyRow.active === false && copyRow.type === 9
    const clearedEmpty = CLEAR_IDS.every(id => {
      const row = copyCategory.attributes.find(entry => entry.id === id)
      return row && !String(row.attrIdent || '').trim() && !String(row.expr || '').trim()
    })
    const sameCount = copyCategory.attributes.length === category.attributes.length
    const preservedEqual = sameCount && category.attributes.every((sourceRow) => {
      const copyRow2 = copyCategory.attributes.find(entry => entry.id === sourceRow.id)
      if (!copyRow2) return false
      if (CLEAR_IDS.includes(sourceRow.id)) return true
      return String(copyRow2.attrIdent || '') === String(sourceRow.attrIdent || '') && String(copyRow2.expr || '') === String(sourceRow.expr || '')
    })
    if (!sourceUnchanged || !copyInactive || !clearedEmpty || !preservedEqual) {
      throw new Error('Verification failed: ' + JSON.stringify({ sourceUnchanged, copyInactive, clearedEmpty, preservedEqual }))
    }
    await client.query('COMMIT')

    const flags = row => String(row.id).startsWith('#') ? 'system' : String(row.expr || '').trim() ? 'expr' : String(row.attrIdent || '').trim() ? 'filled' : 'empty'
    const counts = copyCategory.attributes.reduce((acc, row) => { const key = flags(row); acc[key] = (acc[key] || 0) + 1; return acc }, {})
    report = { date: new Date().toISOString(), database: 'kuppersberg',
      sourceChannel: source.id, sourceIdentifier: SOURCE_IDENTIFIER,
      copyChannel: copyId, identifier: COPY_IDENTIFIER, copyActive: false,
      categoryId: CATEGORY_ID, categoryName: rowName(category),
      clearedCount: CLEAR_IDS.length, cleared,
      preservedCounts: counts,
      methodology: 'Inactive single-category copy for the manual UI acceptance run. Only the listed rows were cleared; all other rows, expressions, service rows and visibility are preserved. No LLM calls; the user runs the AI scenario in the UI. Source channel untouched.',
      verification: { sourceUnchanged, copyInactive, clearedRowsEmpty: clearedEmpty, preservedRowsEqual: preservedEqual } }
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({ copyChannel: copyId, identifier: COPY_IDENTIFIER, cleared: CLEAR_IDS.length, preservedCounts: counts, verified: true }))
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { await client.end() }
  if (report) console.log('Report: docs/ai-mapping/kuppersberg-acceptance-stand.json')
}

main().catch(error => { console.error('Stand failed: ' + (error.message || 'error') + '. Nothing was committed.'); process.exitCode = 1 })
