// scenarios/state-race-test.js
// Goal: Mixed concurrent state-transition operations on the same rule.
// Sends PATCH + DEACTIVATE + RETIRE + DELETE in parallel to see how the API handles it.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Counter } from 'k6/metrics';
import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';
import { logUnexpected } from '../libs/helpers.js';

const baseConfig = JSON.parse(open('../config/base.json'));
const rulePayload = JSON.parse(open('../payloads/rule-payload.json'));

const serverErrorCounter = new Counter('server_errors_500');
const successCounter = new Counter('operation_success');
const notFoundCounter = new Counter('not_found_404');
const conflictCounter = new Counter('conflict_409');
const stateErrorCounter = new Counter('state_error_422');
const rateLimitCounter = new Counter('rate_limited_429');
const customErrorRate = new Rate('custom_error_rate');

export const options = {
  vus: 1,
  iterations: 3,  // 3 bursts × fresh rule each × 8 parallel mixed ops
  thresholds: {
    http_req_duration: ['p(95)<5000'],
  },
};

function createFreshActiveRule(headers) {
  // Step 1: Create a fresh Draft rule
  const ts = Date.now();
  const ruleCode = `STATE_RACE_TEST_${ts}`;
  const createBody = JSON.parse(JSON.stringify(rulePayload));
  createBody.data.attributes.rule_code = ruleCode;
  createBody.data.attributes.name = `StateRaceRule_${ts}`;

  const createRes = http.post(
    `${baseConfig.baseUrlRules}/api/v1/rules`,
    JSON.stringify(createBody),
    { headers }
  );

  if (createRes.status !== 201) {
    console.log(`❌ Create failed: ${createRes.status}`);
    return null;
  }

  const ruleId = createRes.json()?.data?.id;
  console.log(`   Created rule: ${ruleId}`);

  // Step 2: Activate it (so DEACTIVATE/RETIRE will be valid ops)
  // Note: if your API requires a separate activate step, adjust here.
  // Skipping activation for now — we'll test on Draft rule and see what happens.

  return ruleId;
}

export function setup() {
  const token = __ENV.BEARER_TOKEN;
  if (!token) throw new Error('BEARER_TOKEN not set!');
  console.log(`🎯 STATE TRANSITION RACE TEST`);
  console.log(`   Strategy: 8 parallel mixed operations (PATCH + DEACTIVATE + RETIRE + DELETE) per burst`);
  console.log(`   3 bursts, fresh rule each burst`);
  return { token };
}

export default function (data) {
  const { token } = data;
  const headers = {
    ...baseConfig.headers,
    'Authorization': `Bearer ${token}`,
  };

  const burstId = __ITER + 1;

  // Create fresh rule for this burst
  console.log(`\n🆕 BURST ${burstId}/3 — Creating fresh rule...`);
  const ruleId = createFreshActiveRule(headers);
  if (!ruleId) {
    console.log(`❌ Skipping burst ${burstId} — rule creation failed`);
    sleep(60);
    return;
  }

  console.log(`🔥 BURST ${burstId} — firing 8 parallel MIXED operations on rule ${ruleId}`);

  const ts = Date.now();

  // Build 8 parallel requests — 2 of each operation type
  const requests = [
    // 2 PATCHes
    {
      method: 'PATCH',
      url: `${baseConfig.baseUrlRules}/api/v1/rules/${ruleId}`,
      body: JSON.stringify({
        data: {
          type: "UpdateRule",
          attributes: { description: `STATE_RACE_PATCH1_B${burstId}_TS${ts}` }
        }
      }),
      params: { headers, tags: { op: 'PATCH', slot: 1 } }
    },
    {
      method: 'PATCH',
      url: `${baseConfig.baseUrlRules}/api/v1/rules/${ruleId}`,
      body: JSON.stringify({
        data: {
          type: "UpdateRule",
          attributes: { description: `STATE_RACE_PATCH2_B${burstId}_TS${ts}` }
        }
      }),
      params: { headers, tags: { op: 'PATCH', slot: 2 } }
    },
    // 2 DEACTIVATEs
    {
      method: 'POST',
      url: `${baseConfig.baseUrlRules}/api/v1/rules/${ruleId}/deactivate`,
      body: null,
      params: { headers, tags: { op: 'DEACTIVATE', slot: 1 } }
    },
    {
      method: 'POST',
      url: `${baseConfig.baseUrlRules}/api/v1/rules/${ruleId}/deactivate`,
      body: null,
      params: { headers, tags: { op: 'DEACTIVATE', slot: 2 } }
    },
    // 2 RETIREs
    {
      method: 'POST',
      url: `${baseConfig.baseUrlRules}/api/v1/rules/${ruleId}/retire`,
      body: null,
      params: { headers, tags: { op: 'RETIRE', slot: 1 } }
    },
    {
      method: 'POST',
      url: `${baseConfig.baseUrlRules}/api/v1/rules/${ruleId}/retire`,
      body: null,
      params: { headers, tags: { op: 'RETIRE', slot: 2 } }
    },
    // 2 DELETEs
    {
      method: 'DELETE',
      url: `${baseConfig.baseUrlRules}/api/v1/rules/${ruleId}`,
      params: { headers, tags: { op: 'DELETE', slot: 1 } }
    },
    {
      method: 'DELETE',
      url: `${baseConfig.baseUrlRules}/api/v1/rules/${ruleId}`,
      params: { headers, tags: { op: 'DELETE', slot: 2 } }
    },
  ];

  const opNames = ['PATCH-1', 'PATCH-2', 'DEACTIVATE-1', 'DEACTIVATE-2', 'RETIRE-1', 'RETIRE-2', 'DELETE-1', 'DELETE-2'];

  // 🔥 Fire ALL 8 simultaneously
  const responses = http.batch(requests);

  let burstStats = { '200': 0, '204': 0, '404': 0, '409': 0, '422': 0, '429': 0, '500+': 0, 'other': 0 };
  let opResults = [];

  responses.forEach((res, idx) => {
    const opName = opNames[idx];
    opResults.push(`${opName}=${res.status}`);

    if (res.status === 200 || res.status === 204) {
      burstStats[res.status.toString()]++;
      successCounter.add(1);
    } else if (res.status === 404) {
      burstStats['404']++;
      notFoundCounter.add(1);
    } else if (res.status === 409) {
      burstStats['409']++;
      conflictCounter.add(1);
    } else if (res.status === 422) {
      burstStats['422']++;
      stateErrorCounter.add(1);
    } else if (res.status === 429) {
      burstStats['429']++;
      rateLimitCounter.add(1);
    } else if (res.status >= 500) {
      burstStats['500+']++;
      serverErrorCounter.add(1);
      logUnexpected(`BURST${burstId} ${opName} - SERVER ERROR`, res);
    } else {
      burstStats['other']++;
      logUnexpected(`BURST${burstId} ${opName} - UNEXPECTED`, res);
    }

    // Any 5xx is a fail. 4xx is acceptable (expected state conflicts).
    const passed = res.status < 500;
    const checkObj = {};
    checkObj[`BURST${burstId} ${opName} - no server error`] = () => passed;
    check(res, checkObj);
    customErrorRate.add(!passed);
  });

  console.log(`   📊 Burst ${burstId} status counts: ${JSON.stringify(burstStats)}`);
  console.log(`   📋 Per-op: ${opResults.join(', ')}`);

  // Check final state of the rule (or confirm it's deleted)
  const verify = http.get(
    `${baseConfig.baseUrlRules}/api/v1/rules/${ruleId}`,
    { headers }
  );
  if (verify.status === 200) {
    const rule = verify.json()?.data?.attributes;
    console.log(`   🏁 Final state: status=${rule?.status || 'N/A'}, description="${rule?.description || 'N/A'}"`);
  } else if (verify.status === 404) {
    console.log(`   🏁 Rule was DELETED (final state: gone)`);
  } else {
    console.log(`   ⚠️ Could not verify final state (status ${verify.status})`);
  }

  sleep(60);
}

export function teardown() {
  console.log('\n✅ State transition race test complete.');
}

export function handleSummary(data) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return {
    [`reports/state-race-test-${timestamp}.html`]: htmlReport(data),
    [`reports/state-race-test-${timestamp}.json`]: JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}