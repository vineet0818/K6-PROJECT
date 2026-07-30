// scenarios/state-op-race-test.js
// Goal: Parallel DEACTIVATE and parallel RETIRE on same rule to check for same
// DbUpdateConcurrencyException pattern seen in PATCH and DELETE races.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Counter } from 'k6/metrics';
import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';
import { logUnexpected } from '../libs/helpers.js';

const baseConfig = JSON.parse(open('../config/base.json'));
const rulePayload = JSON.parse(open('../payloads/rule-payload.json'));

const deactivateSuccess = new Counter('deactivate_success_200');
const deactivateStateErr = new Counter('deactivate_422');
const deactivate500 = new Counter('deactivate_500');
const retireSuccess = new Counter('retire_success_200');
const retireStateErr = new Counter('retire_422');
const retire500 = new Counter('retire_500');
const rateLimitCounter = new Counter('rate_limited_429');
const customErrorRate = new Rate('custom_error_rate');

export const options = {
  vus: 1,
  iterations: 6,  // 3 DEACTIVATE bursts + 3 RETIRE bursts (alternating)
  thresholds: {
    http_req_duration: ['p(95)<5000'],
  },
};

function createFreshRule(headers, prefix) {
  const ts = Date.now();
  const ruleCode = `${prefix}_RACE_TEST_${ts}`;
  const createBody = JSON.parse(JSON.stringify(rulePayload));
  createBody.data.attributes.rule_code = ruleCode;
  createBody.data.attributes.name = `${prefix}RaceRule_${ts}`;

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
  console.log(`🎯 DEACTIVATE + RETIRE race test`);
  console.log(`   3 bursts of 10 parallel DEACTIVATEs + 3 bursts of 10 parallel RETIREs`);
  console.log(`   Fresh rule per burst.`);
  return { token };
}

export default function (data) {
  const { token } = data;
  const headers = {
    ...baseConfig.headers,
    'Authorization': `Bearer ${token}`,
  };

  const iter = __ITER + 1;
  // Iterations 1-3: DEACTIVATE tests. Iterations 4-6: RETIRE tests.
  const isDeactivateBurst = iter <= 3;
  const opType = isDeactivateBurst ? 'DEACTIVATE' : 'RETIRE';
  const opPath = isDeactivateBurst ? 'deactivate' : 'retire';
  const burstNum = isDeactivateBurst ? iter : iter - 3;

  console.log(`\n🆕 BURST ${iter}/6 [${opType} #${burstNum}] — Creating fresh rule...`);
  const ruleId = createFreshRule(headers, opType);
  if (!ruleId) {
    console.log(`❌ Skipping — rule creation failed`);
    sleep(60);
    return;
  }
  console.log(`   Rule created: ${ruleId}`);
  console.log(`🔥 Firing 10 parallel ${opType}s at rule ${ruleId}`);

  // Build 10 parallel state-transition requests
  const requests = [];
  for (let i = 1; i <= 10; i++) {
    requests.push({
      method: 'POST',
      url: `${baseConfig.baseUrlRules}/api/v1/rules/${ruleId}/${opPath}`,
      body: null,
      params: { headers, tags: { endpoint: `${opType}_race` } }
    });
  }

  const responses = http.batch(requests);

  let burstStats = { '200': 0, '404': 0, '409': 0, '422': 0, '429': 0, '500+': 0, 'other': 0 };
  responses.forEach((res, idx) => {
    const reqNum = idx + 1;
    if (res.status === 200) {
      burstStats['200']++;
      if (isDeactivateBurst) deactivateSuccess.add(1); else retireSuccess.add(1);
    } else if (res.status === 404) {
      burstStats['404']++;
    } else if (res.status === 409) {
      burstStats['409']++;
    } else if (res.status === 422) {
      burstStats['422']++;
      if (isDeactivateBurst) deactivateStateErr.add(1); else retireStateErr.add(1);
    } else if (res.status === 429) {
      burstStats['429']++;
      rateLimitCounter.add(1);
    } else if (res.status >= 500) {
      burstStats['500+']++;
      if (isDeactivateBurst) deactivate500.add(1); else retire500.add(1);
      logUnexpected(`${opType} BURST${burstNum} REQ${reqNum} - SERVER ERROR`, res);
    } else {
      burstStats['other']++;
      logUnexpected(`${opType} BURST${burstNum} REQ${reqNum} - UNEXPECTED`, res);
    }

    const passed = res.status < 500;
    const checkObj = {};
    checkObj[`${opType} BURST${burstNum} REQ${reqNum} - no server error`] = () => passed;
    check(res, checkObj);
    customErrorRate.add(!passed);
  });

  console.log(`   📊 ${opType} Burst ${burstNum}: ${JSON.stringify(burstStats)}`);

  sleep(30);
}

export function teardown() {
  console.log('\n✅ DEACTIVATE + RETIRE race test complete.');
}

export function handleSummary(data) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return {
    [`reports/state-op-race-test-${timestamp}.html`]: htmlReport(data),
    [`reports/state-op-race-test-${timestamp}.json`]: JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}