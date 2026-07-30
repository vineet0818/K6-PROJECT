// scenarios/delete-race-test.js
// Goal: 10 parallel DELETEs on same rule_id — look for 500s, deadlocks, wrong response codes.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Counter } from 'k6/metrics';
import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';
import { logUnexpected } from '../libs/helpers.js';

const baseConfig = JSON.parse(open('../config/base.json'));
const rulePayload = JSON.parse(open('../payloads/rule-payload.json'));

const successCounter = new Counter('delete_success_204');
const notFoundCounter = new Counter('delete_404');
const conflictCounter = new Counter('delete_409');
const validationErrorCounter = new Counter('delete_422');
const serverErrorCounter = new Counter('server_errors_500');
const rateLimitCounter = new Counter('rate_limited_429');
const customErrorRate = new Rate('custom_error_rate');

export const options = {
  vus: 1,
  iterations: 3,  // 3 bursts = 3 fresh rules × 10 DELETEs each = 30 total DELETEs
  thresholds: {
    http_req_duration: ['p(95)<5000'],
  },
};

function createFreshRule(headers) {
  const ts = Date.now();
  const ruleCode = `DELETE_RACE_TEST_${ts}`;
  const createBody = JSON.parse(JSON.stringify(rulePayload));
  createBody.data.attributes.rule_code = ruleCode;
  createBody.data.attributes.name = `DeleteRaceRule_${ts}`;

  const createRes = http.post(
    `${baseConfig.baseUrlRules}/api/v1/rules`,
    JSON.stringify(createBody),
    { headers }
  );

  if (createRes.status !== 201) {
    console.log(`❌ Create failed: ${createRes.status}`);
    return null;
  }
  return createRes.json()?.data?.id;
}

export function setup() {
  const token = __ENV.BEARER_TOKEN;
  if (!token) throw new Error('BEARER_TOKEN not set!');
  console.log(`🎯 DELETE race test — 3 bursts × 10 parallel DELETEs per fresh rule`);
  return { token };
}

export default function (data) {
  const { token } = data;
  const headers = {
    ...baseConfig.headers,
    'Authorization': `Bearer ${token}`,
  };

  const burstId = __ITER + 1;

  // Create a fresh rule for this burst
  console.log(`\n🆕 BURST ${burstId}/3 — Creating fresh rule...`);
  const ruleId = createFreshRule(headers);
  if (!ruleId) {
    console.log(`❌ Skipping burst ${burstId} — rule creation failed`);
    sleep(60);
    return;
  }
  console.log(`   Rule created: ${ruleId}`);
  console.log(`🔥 BURST ${burstId} — firing 10 parallel DELETEs at rule ${ruleId}`);

  // Build 10 parallel DELETE requests
  const requests = [];
  for (let i = 1; i <= 10; i++) {
    requests.push({
      method: 'DELETE',
      url: `${baseConfig.baseUrlRules}/api/v1/rules/${ruleId}`,
      params: { headers, tags: { endpoint: 'DELETE_race' } }
    });
  }

  const responses = http.batch(requests);

  let burstStats = { '204': 0, '404': 0, '409': 0, '422': 0, '429': 0, '500+': 0, 'other': 0 };
  responses.forEach((res, idx) => {
    const reqNum = idx + 1;
    if (res.status === 204) {
      burstStats['204']++;
      successCounter.add(1);
    } else if (res.status === 404) {
      burstStats['404']++;
      notFoundCounter.add(1);
    } else if (res.status === 409) {
      burstStats['409']++;
      conflictCounter.add(1);
    } else if (res.status === 422) {
      burstStats['422']++;
      validationErrorCounter.add(1);
    } else if (res.status === 429) {
      burstStats['429']++;
      rateLimitCounter.add(1);
    } else if (res.status >= 500) {
      burstStats['500+']++;
      serverErrorCounter.add(1);
      logUnexpected(`BURST${burstId} REQ${reqNum} - SERVER ERROR`, res);
    } else {
      burstStats['other']++;
      logUnexpected(`BURST${burstId} REQ${reqNum} - UNEXPECTED`, res);
    }

    // Accept 204 (delete success) or 404 (already deleted by another parallel req) as clean
    const passed = [204, 404, 409, 422].includes(res.status);
    const checkObj = {};
    checkObj[`BURST${burstId} REQ${reqNum} - clean response`] = () => passed;
    check(res, checkObj);
    customErrorRate.add(!passed);
  });

  console.log(`   📊 Burst ${burstId} results: ${JSON.stringify(burstStats)}`);

  sleep(60);
}

export function teardown() {
  console.log('✅ DELETE race test complete.');
}

export function handleSummary(data) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return {
    [`reports/delete-race-test-${timestamp}.html`]: htmlReport(data),
    [`reports/delete-race-test-${timestamp}.json`]: JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}