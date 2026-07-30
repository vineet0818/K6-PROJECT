// scenarios/load-test.js (Business Critical APIs - Rules, LOB Versions, Accounts)
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Counter } from 'k6/metrics';
import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';

import {
  extractRules,
  extractAccounts,
  filterRulesByStatus,
  uniqueName,
  classify,
  logUnexpected
} from '../libs/helpers.js';

const baseConfig = JSON.parse(open('../config/base.json'));
const testConfig = JSON.parse(open('../config/load.json'));
const rulePayload = JSON.parse(open('../payloads/rule-payload.json'));

const customErrorRate = new Rate('custom_error_rate');
const throttledCounter = new Counter('throttled_responses');

export const options = {
  stages: testConfig.loadProfile.stages,
  thresholds: testConfig.thresholds,
};

// helper: run a check, track error rate, log unexpected, count 429s
function track(label, res, okCodes) {
  const verdict = classify(res, okCodes);
  const passed = verdict === 'ok' || verdict === 'throttled';

  const checkObj = {};
  checkObj[`${label} - ok/throttled`] = () => passed;
  check(res, checkObj);

  if (verdict === 'throttled') throttledCounter.add(1);
  if (verdict === 'bad') logUnexpected(label, res);

  // error rate only counts genuine failures, not 429s
  customErrorRate.add(verdict === 'bad');
}

// ------------------------------------------------
// SETUP
// ------------------------------------------------
export function setup() {
  const token = __ENV.BEARER_TOKEN;
  if (!token) {
    throw new Error('BEARER_TOKEN environment variable is not set!');
  }

  const headers = {
    ...baseConfig.headers,
    'Authorization': `Bearer ${token}`,
  };

  // 1. Rules
  let rulesRes = http.get(
    `${baseConfig.baseUrlRules}/api/v1/rules`,
    { headers }
  );
  if (rulesRes.status !== 200) {
    throw new Error(`Setup failed to fetch rules: ${rulesRes.status}`);
  }
  const allRules = extractRules(rulesRes);
  if (allRules.length === 0) throw new Error('No rules found!');

  // 2. Accounts
  let accountsRes = http.get(
    `${baseConfig.baseUrlAccounts}/api/v1/accounts`,
    { headers }
  );
  if (accountsRes.status !== 200) {
    throw new Error(`Setup failed to fetch accounts: ${accountsRes.status}`);
  }
  const accounts = extractAccounts(accountsRes);
  if (accounts.length === 0) throw new Error('No accounts found!');

  const draftRules = filterRulesByStatus(allRules, 'Draft');
  const activeRules = filterRulesByStatus(allRules, 'Active');

  console.log(`✅ Fetched ${allRules.length} rules, ${accounts.length} accounts.`);
  console.log(`   → ${draftRules.length} Draft, ${activeRules.length} Active.`);

  return { token, draftRules, activeRules, accounts };
}

// ------------------------------------------------
// MAIN
// ------------------------------------------------
export default function (data) {
  const { token, draftRules, activeRules, accounts } = data;

  const headers = {
    ...baseConfig.headers,
    'Authorization': `Bearer ${token}`,
  };

  const draftRule  = draftRules.length  > 0 ? draftRules[(__VU - 1)  % draftRules.length]  : null;
  const activeRule = activeRules.length > 0 ? activeRules[(__VU - 1) % activeRules.length] : null;
  const anyRule    = activeRule || draftRule;

  const account = accounts[(__VU - 1) % accounts.length];
  const accountId = account.id;

  // 1. GET Rules
  let res1 = http.get(
    `${baseConfig.baseUrlRules}/api/v1/rules`,
    { headers, tags: { endpoint: 'GET_rules_list' } }
  );
  track('01 GET Rules', res1, [200]);
  sleep(testConfig.thinkTime || 1);

  // 2. POST Rule (Create)
const ts = Date.now();
const uniqueRuleCode = `PERF_RULE_VU${__VU}_${ts}`;
const createPayload = JSON.parse(JSON.stringify(rulePayload));
createPayload.data.attributes.rule_code = uniqueRuleCode;
createPayload.data.attributes.name = `PerfTest Rule VU${__VU} ${ts}`;

let res2 = http.post(
  `${baseConfig.baseUrlRules}/api/v1/rules`,
  JSON.stringify(createPayload),
  { headers, tags: { endpoint: 'POST_rule' } }
);
track('02 POST Rule', res2, [201, 409]);
sleep(testConfig.thinkTime || 1);

  // 3. GET Rule by ID
  if (anyRule) {
    let res3 = http.get(
      `${baseConfig.baseUrlRules}/api/v1/rules/${anyRule.id}`,
      { headers, tags: { endpoint: 'GET_rule_by_id' } }
    );
    track('03 GET Rule by ID', res3, [200]);
  } else {
    console.warn('⚠️ No rules to fetch by ID.');
  }
  sleep(testConfig.thinkTime || 1);

  // 4. PATCH Update Rule
  if (anyRule) {
    let res4 = http.patch(
      `${baseConfig.baseUrlRules}/api/v1/rules/${anyRule.id}`,
      JSON.stringify({
        data: {
          type: "UpdateRule",
          attributes: {
            description: `Updated by PerfTest VU${__VU} at ${Date.now()}`
          }
        }
      }),
      { headers, tags: { endpoint: 'PATCH_rule' } }
    );
    track('04 PATCH Rule', res4, [200, 422]);
  } else {
    console.warn('⚠️ No rules to PATCH.');
  }
  sleep(testConfig.thinkTime || 1);

  // 5. POST Deactivate Rule
  if (activeRule) {
    let res5 = http.post(
      `${baseConfig.baseUrlRules}/api/v1/rules/${activeRule.id}/deactivate`,
      null,
      { headers, tags: { endpoint: 'POST_deactivate' } }
    );
    track('05 DEACTIVATE Rule', res5, [200, 422]);
  } else {
    console.warn('⚠️ No Active rule to DEACTIVATE.');
  }
  sleep(testConfig.thinkTime || 1);

  // 6. POST Retire Rule
  if (activeRule) {
    let res6 = http.post(
      `${baseConfig.baseUrlRules}/api/v1/rules/${activeRule.id}/retire`,
      null,
      { headers, tags: { endpoint: 'POST_retire' } }
    );
    track('06 RETIRE Rule', res6, [200, 422]);
  } else {
    console.warn('⚠️ No Active rule to RETIRE.');
  }
  sleep(testConfig.thinkTime || 1);

 // 7. DELETE Rule
if (draftRule) {
  let res7 = http.del(
    `${baseConfig.baseUrlRules}/api/v1/rules/${draftRule.id}`,
    null,
    { headers, tags: { endpoint: 'DELETE_rule' } }
  );
  // 404 is expected after first delete since same rule_id reused per VU
  track('07 DELETE Rule', res7, [204, 422, 404]);
} else {
  console.warn('⚠️ No Draft rule to DELETE.');
}
sleep(testConfig.thinkTime || 1);

  // 8. POST LOB Level Versions (Bulk)
  let res8 = http.post(
    `${baseConfig.baseUrl}/api/v1/loblevelversions/bulk`,
    JSON.stringify({
      lobId: baseConfig.lobId,
      configurationLevel: "Countrywide",
      countryId: baseConfig.countryId,
      versionName: `PerfTest_VU${__VU}_${Date.now()}`,
      scopes: [
        {
          jurisdictionId: null,
          writingCompanyId: null,
          newBusinessEffectiveDate: "2026-07-01",
          renewalBusinessEffectiveDate: "2026-07-01",
          expirationDate: null
        }
      ]
    }),
    { headers, tags: { endpoint: 'POST_lob_bulk' } }
  );
  track('08 POST LOB Version', res8, [201, 409]);
  sleep(testConfig.thinkTime || 1);

  // 9. GET Accounts (list)
  let res9 = http.get(
    `${baseConfig.baseUrlAccounts}/api/v1/accounts`,
    { headers, tags: { endpoint: 'GET_accounts_list' } }
  );
  track('09 GET Accounts', res9, [200]);
  sleep(testConfig.thinkTime || 1);

  // 10. GET Account by ID
  let res10 = http.get(
    `${baseConfig.baseUrlAccounts}/api/v1/accounts/${accountId}`,
    { headers, tags: { endpoint: 'GET_account_by_id' } }
  );
  track('10 GET Account by ID', res10, [200]);

  sleep(testConfig.thinkTime || 1);
}

// ------------------------------------------------
// TEARDOWN
// ------------------------------------------------
export function teardown(data) {
  console.log('✅ All Business Critical APIs executed.');
}

// ------------------------------------------------
// HANDLE SUMMARY
// ------------------------------------------------
export function handleSummary(data) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return {
    [`reports/business-critical-${timestamp}.html`]: htmlReport(data),
    [`reports/business-critical-${timestamp}.json`]: JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
} 