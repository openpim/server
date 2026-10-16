// Run explicitly against Kuppersberg. Uses only SELECT/VALUES inside READ ONLY;
// fixture CTEs shadow real tables, so no catalog rows or credentials enter assertions.
require('dotenv').config()
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Client } = require('pg')
const { mappingVisibilityPathsSQL, mappingVisibilityTargetsSQL } = require('../src/channels/ai/visibility.ts')
const { mappingLOVSamplesSQL } = require('../src/channels/ai/values.ts')

test('visibility SQL preserves descendants and multiple incoming sources, isolates tenants and ignores deleted links', {
  skip: (process.env.OPENPIM_DATABASE_NAME || process.env.DATABASE_NAME) !== 'kuppersberg'
}, async () => {
  const client = new Client({
    host: process.env.OPENPIM_DATABASE_ADDRESS || process.env.DATABASE_URL,
    port: Number(process.env.OPENPIM_DATABASE_PORT || process.env.DATABASE_PORT || 5432),
    database: process.env.OPENPIM_DATABASE_NAME || process.env.DATABASE_NAME,
    user: process.env.OPENPIM_DATABASE_USER || process.env.DATABASE_USER,
    password: process.env.OPENPIM_DATABASE_PASSWORD || process.env.DATABASE_PASSWORD,
    connectionTimeoutMillis: 10000
  })
  const sql = mappingVisibilityPathsSQL.replace('WITH roots AS (', `WITH
    items(id,path,"tenantId","deletedAt") AS (VALUES
      (20,'1.20'::ltree,'tenant',NULL::timestamptz),
      (25,'1.20.25'::ltree,'tenant',NULL::timestamptz),
      (30,'1.30'::ltree,'tenant',NULL::timestamptz),
      (40,'1.40'::ltree,'other',NULL::timestamptz),
      (50,'1.50'::ltree,'tenant',NULL::timestamptz),
      (60,'1.60'::ltree,'tenant',NULL::timestamptz)
    ), "itemRelations"("itemId","targetId","relationId","tenantId","deletedAt") AS (VALUES
      (20,100,38,'tenant',NULL::timestamptz),
      (30,100,38,'tenant',NULL::timestamptz),
      (40,100,38,'tenant',NULL::timestamptz),
      (50,100,38,'tenant','2020-01-01'::timestamptz),
      (60,100,4,'tenant',NULL::timestamptz)
    ), roots AS (`)
  try {
    await client.connect()
    await client.query('BEGIN READ ONLY')
    await client.query("SET LOCAL statement_timeout = '10s'")
    const query = async (tenant, relation) => (await client.query(sql, [tenant, [20], relation])).rows.map(row => row.path).sort()
    assert.deepEqual(await query('tenant', 38), ['1.20', '1.20.25', '1.30'])
    assert.deepEqual(await query('tenant', null), ['1.20', '1.20.25'])
    assert.deepEqual(await query('other', 38), [])
    const targetSQL = mappingVisibilityTargetsSQL.replace('WITH roots AS (', `WITH
      items(id,path,"tenantId","deletedAt") AS (VALUES
        (20,'1.20'::ltree,'tenant',NULL::timestamptz),
        (25,'1.20.25'::ltree,'tenant',NULL::timestamptz),
        (30,'1.30'::ltree,'tenant',NULL::timestamptz),
        (40,'1.20.40'::ltree,'other',NULL::timestamptz),
        (50,'1.20.50'::ltree,'tenant','2020-01-01'::timestamptz),
        (100,'2.200.100'::ltree,'tenant',NULL::timestamptz),
        (101,'2.300.101'::ltree,'tenant',NULL::timestamptz),
        (102,'2.400.102'::ltree,'other',NULL::timestamptz),
        (103,'2.500.103'::ltree,'tenant','2020-01-01'::timestamptz)
      ), "itemRelations"("itemId","targetId","relationId","tenantId","deletedAt") AS (VALUES
        (20,100,38,'tenant',NULL::timestamptz),
        (25,100,38,'tenant',NULL::timestamptz),
        (30,100,38,'tenant',NULL::timestamptz),
        (30,101,38,'tenant',NULL::timestamptz),
        (20,101,4,'tenant',NULL::timestamptz),
        (20,101,38,'tenant','2020-01-01'::timestamptz),
        (20,101,38,'other',NULL::timestamptz),
        (40,101,38,'tenant',NULL::timestamptz),
        (50,101,38,'tenant',NULL::timestamptz),
        (20,102,38,'tenant',NULL::timestamptz),
        (20,103,38,'tenant',NULL::timestamptz)
      ), roots AS (`)
    const targets = async (tenant, relation, roots = [20]) => (await client.query(targetSQL, [tenant, roots, relation])).rows.map(row => row.path).sort()
    assert.deepEqual(await targets('tenant', 38), ['2.200.100'])
    assert.deepEqual(await targets('tenant', 4), ['2.300.101'])
    assert.deepEqual(await targets('tenant', null), [])
    assert.deepEqual(await targets('other', 38), [])
    assert.deepEqual(await targets('tenant', 38, [50]), [])
    const lovSQL = `WITH lovs(id,"values","tenantId","deletedAt") AS (
      SELECT 1, jsonb_agg(jsonb_build_object('id',n,'value',jsonb_build_object('ru','value '||n)) ORDER BY n), 'tenant', NULL::timestamptz FROM generate_series(1,12) n
      UNION ALL SELECT 2, '[{"value":"foreign"}]'::jsonb, 'other', NULL::timestamptz
      UNION ALL SELECT 3, '[{"value":"deleted"}]'::jsonb, 'tenant', '2020-01-01'::timestamptz
      UNION ALL SELECT 4, '{}'::jsonb, 'tenant', NULL::timestamptz
    ), attributes(id,identifier,lov,"tenantId","deletedAt") AS (
      VALUES (11,'source',1,'tenant',NULL::timestamptz), (12,'foreign',2,'tenant',NULL::timestamptz)
    ) ` + mappingLOVSamplesSQL
    const samples = (await client.query(lovSQL, ['tenant', [1, 2, 3, 4], ['source','foreign']])).rows
    assert.equal(samples.length, 1)
    assert.equal(samples[0].id, 1)
    assert.equal(samples[0].total, 12)
    assert.equal(samples[0].values.length, 8)
    assert.equal(samples[0].values[0].value.ru, 'value 1')
    assert.equal(samples[0].values[7].value.ru, 'value 8')
    const scopedSQL = `WITH lovs(id,"values","tenantId","deletedAt") AS (
      SELECT 1, jsonb_agg(jsonb_build_object('value','foreign '||n,'attrs',jsonb_build_array(99)) ORDER BY n)
        || '[{"value":"global"},{"value":"slider","attrs":[11]},{"value":"steel","attrs":[12]}]'::jsonb,
        'tenant', NULL::timestamptz FROM generate_series(1,20) n
    ), attributes(id,identifier,lov,"tenantId","deletedAt") AS (
      VALUES (11,'control',1,'tenant',NULL::timestamptz), (12,'material',1,'tenant',NULL::timestamptz),
        (13,'foreign',1,'other',NULL::timestamptz), (14,'deleted',1,'tenant','2020-01-01'::timestamptz)
    ) ` + mappingLOVSamplesSQL
    const scoped = (await client.query(scopedSQL, ['tenant', [1], ['control','material','foreign','deleted']])).rows
    assert.equal(scoped.length, 2)
    assert.deepEqual(scoped.find(row => row.attributeIdent === 'control').values.map(row => row.value), ['global','slider'])
    assert.deepEqual(scoped.find(row => row.attributeIdent === 'material').values.map(row => row.value), ['global','steel'])
    assert.equal(scoped[0].total, 2)
    await client.query('ROLLBACK')
  } finally { await client.end() }
})
