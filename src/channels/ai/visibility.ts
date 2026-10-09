// Bound parameters: tenant, selected catalog root IDs, visibility relation (or null).
// Besides selected subtrees, include other incoming sources of the same targets:
// one product may be visible through more than one source on a single relation.
// No product values or channel configuration are selected.
export const mappingVisibilityPathsSQL = `
WITH roots AS (
    SELECT path FROM items
    WHERE "tenantId"=$1 AND "deletedAt" IS NULL AND id=ANY($2::integer[])
), selected_sources AS (
    SELECT id, path FROM items
    WHERE "tenantId"=$1 AND "deletedAt" IS NULL
      AND path <@ ANY(ARRAY(SELECT path FROM roots))
), all_sources AS (
    SELECT id, path FROM selected_sources
    UNION
    SELECT source.id, source.path
    FROM "itemRelations" chosen
    JOIN "itemRelations" other ON other."targetId"=chosen."targetId"
      AND other."tenantId"=$1 AND other."relationId"=$3 AND other."deletedAt" IS NULL
    JOIN items source ON source.id=other."itemId"
      AND source."tenantId"=$1 AND source."deletedAt" IS NULL
    WHERE chosen."tenantId"=$1 AND chosen."relationId"=$3 AND chosen."deletedAt" IS NULL
      AND chosen."itemId" IN (SELECT id FROM selected_sources)
)
SELECT path::text FROM all_sources
`

// Ordinary/standard/relation-valued attributes use these product paths, not source paths.
// Derive targets only from selected roots, never from the widened alternative sources.
export const mappingVisibilityTargetsSQL = `
WITH roots AS (
    SELECT path FROM items
    WHERE "tenantId"=$1 AND "deletedAt" IS NULL AND id=ANY($2::integer[])
), selected_sources AS (
    SELECT id FROM items
    WHERE "tenantId"=$1 AND "deletedAt" IS NULL
      AND path <@ ANY(ARRAY(SELECT path FROM roots))
)
SELECT DISTINCT target.path::text AS path
FROM "itemRelations" relation
JOIN items target ON target.id=relation."targetId"
  AND target."tenantId"=$1 AND target."deletedAt" IS NULL
WHERE relation."tenantId"=$1 AND relation."deletedAt" IS NULL
  AND relation."relationId"=$3 AND relation."itemId" IN (SELECT id FROM selected_sources)
`
