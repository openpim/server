function prepareCategory (source, ids) {
  const copy = JSON.parse(JSON.stringify(source))
  for (const id of ids) {
    const rows = copy.attributes.filter(row => row.id === id)
    if (id.startsWith('#') || rows.length !== 1 || rows[0].expr) throw new Error('Not eligible for sandbox evaluation: ' + id)
    rows[0].attrIdent = ''
    rows[0].expr = ''
  }
  delete copy.readingTime
  delete copy.changed
  return copy
}

function applySuggestions (category, requests, suggestions) {
  const seen = new Set()
  for (const suggestion of suggestions) {
    if (seen.has(suggestion.id)) throw new Error('duplicate suggestion')
    seen.add(suggestion.id)
    const request = requests.find(row => row.attribute.id === suggestion.id)
    const rows = category.attributes.filter(row => row.id === suggestion.id)
    if (!request || rows.length !== 1 || rows[0].attrIdent || rows[0].expr) throw new Error('Suggestion outside empty sandbox scope')
    if (suggestion.attrIdent && !request.candidates.some(row => row.attrIdent === suggestion.attrIdent)) throw new Error('Unknown candidate')
  }
  const copy = JSON.parse(JSON.stringify(category))
  for (const suggestion of suggestions) {
    if (suggestion.attrIdent) copy.attributes.find(row => row.id === suggestion.id).attrIdent = suggestion.attrIdent
  }
  return copy
}

function selectCandidateGroups (groups, identifier) {
  if (!identifier) return groups
  const selected = groups.filter(group => group.identifier === identifier)
  if (selected.length !== 1) throw new Error('Expected exactly one candidate group: ' + identifier)
  return selected
}

function experimentCategory (id = '61377314') {
  const categories = { '61377314': { id: '61377314', slug: 'grill', name: 'Сковороды-гриль' },
    '15450095': { id: '15450095', slug: 'wine', name: 'Винные шкафы' } }
  if (!Object.hasOwn(categories, id)) throw new Error('Unsupported experiment category')
  return categories[id]
}

module.exports = { prepareCategory, applySuggestions, selectCandidateGroups, experimentCategory }
