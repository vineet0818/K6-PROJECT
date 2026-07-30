// libs/helpers.js

export function extractCountries(res) {
  try {
    const json = res.json();
    if (json.data && Array.isArray(json.data)) {
      return json.data.map(item => ({
        id: item.id,
        code: item.attributes?.code || 'N/A',
        name: item.attributes?.name || 'N/A'
      }));
    }
    return [];
  } catch (e) {
    console.error('Failed to parse countries: ' + e.message);
    return [];
  }
}

export function uniqueName(prefix = 'PerfTest') {
  const ts = Date.now();
  const vu = __VU || 0;
  return `${prefix}_VU${vu}_${ts}`;
}

export function extractRules(res) {
  try {
    const json = res.json();
    if (json.data && Array.isArray(json.data)) {
      return json.data.map(item => ({
        id: item.id,
        status: item.attributes?.status || 'Unknown',
        rule_code: item.attributes?.rule_code || 'N/A'
      }));
    }
    return [];
  } catch (e) {
    console.error('Failed to parse rules: ' + e.message);
    return [];
  }
}

export function extractAccounts(res) {
  try {
    const json = res.json();
    if (json.data && Array.isArray(json.data)) {
      return json.data.map(item => ({
        id: item.id,
        legalName: item.attributes?.legalName || 'N/A'
      }));
    }
    return [];
  } catch (e) {
    console.error('Failed to parse accounts: ' + e.message);
    return [];
  }
}

export function filterRulesByStatus(rules, status) {
  return rules.filter(r => r.status === status);
}

// NEW: classify response as ok / throttled / bad
export function classify(res, expectedOkCodes) {
  if (expectedOkCodes.includes(res.status)) return 'ok';
  if (res.status === 429) return 'throttled';
  return 'bad';
}

// NEW: log first 200 chars of an unexpected response body
export function logUnexpected(label, res) {
  const snippet = (res.body || '').toString().substring(0, 200);
  console.warn(`${label} unexpected ${res.status} :: ${snippet}`);
}