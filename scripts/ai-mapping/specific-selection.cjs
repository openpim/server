const themes = {
  '237418': [/тип.*панел|панел.*тип/i, /конфор/i, /материал.*панел|поверхност/i, /мощност/i, /управлен/i, /установк|независим/i, /нагрев|индукц|электрич|газов/i, /защит|блокиров|таймер/i],
  '70103401': [/производительност/i, /мощност/i, /скорост/i, /режим.*работ|отвод|циркуляц/i, /шум/i, /управлен/i, /двигател/i, /фильтр/i, /освещен|ламп/i, /установк|встраив|воздуховод/i],
  '90580': [/тип.*шкаф|газов|электрич/i, /объем|объём/i, /мощност/i, /энергопотребл/i, /режим|программ/i, /грил|конвекц/i, /очистк/i, /управлен/i, /температур/i, /телескоп|направляющ|дверц|стекл/i, /защит|блокиров|таймер/i]
}
function selectSpecificAttributes (categoryId, live, stored, previousIds, limit = 15) {
  const patterns = themes[categoryId]
  if (!patterns) throw Error('Unsupported category')
  if (!Number.isInteger(limit) || limit < 1 || limit > 30) throw Error('Invalid limit')
  const excluded = new Set(previousIds)
  const counts = new Map()
  for (const row of stored) counts.set(row.id, (counts.get(row.id) || 0) + 1)
  const liveCounts = new Map()
  for (const row of live) liveCounts.set(row.id, (liveCounts.get(row.id) || 0) + 1)
  const ranked = live.map(attribute => ({ attribute, theme: patterns.findIndex(pattern => pattern.test(attribute.name || '')) }))
    .filter(({ attribute, theme }) => {
      const row = stored.find(row => row.id === attribute.id)
      return !excluded.has(attribute.id) && !String(attribute.id).startsWith('#') && liveCounts.get(attribute.id) === 1 && counts.get(attribute.id) === 1 &&
        !row.deleted && !row.expr && (attribute.required || theme >= 0)
    })
    .sort((a, b) => Number(!!b.attribute.required) - Number(!!a.attribute.required) ||
      (a.theme < 0 ? patterns.length : a.theme) - (b.theme < 0 ? patterns.length : b.theme) || a.attribute.id.localeCompare(b.attribute.id))
  const selected = ranked.filter(row => row.attribute.required).slice(0, limit).map(row => row.attribute)
  const buckets = patterns.map((_, theme) => ranked.filter(row => !row.attribute.required && row.theme === theme).map(row => row.attribute))
  for (let index = 0; selected.length < limit; index++) {
    let added = false
    for (const bucket of buckets) {
      if (bucket[index] && selected.length < limit) { selected.push(bucket[index]); added = true }
    }
    if (!added) break
  }
  return selected
}
module.exports = { selectSpecificAttributes }
