// scenarios/race-test.js v3 - Creates fresh rule, then races PATCHes on it
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Counter } from 'k6/metrics';
import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';
import { logUnexpected } from '../libs/helpers.js';

const baseConfig = JSON.parse(open('../config/base.json'));
const rulePayload = JSON.parse(open('../payloads/rule-payload.json'));

const successCounter = new Counter('patch_success_200');
const conflictCounter = new Counter('conflict_409');
const validationErrorCounter = new Counter('validation_422');
const serverErrorCounter = new Counter('server_errors_500');
const rateLimitCounter = new Counter('rate_limited_429');
const customErrorRate = new Rate('custom_error_rate');

export const options = {
  vus: 1,
  iterations: 5,
  thresholds: {
    http_req_duration: ['p(95)<5000'],
  },
};

export function setup() {
  const token = __ENV.BEARER_TOKEN;
  if (!token) throw new Error('BEARER_TOKEN not set!');

  const headers = {
    ...baseConfig.headers,
    'Authorization': `Bearer ${token}`,
  };

  // 🆕 Create a fresh Draft rule for this test
  const ts = Date.now();
  const ruleCode = `RACE_TEST_RULE_${ts}`;
  const createBody = JSON.parse(JSON.stringify(rulePayload));
  createBody.data.attributes.rule_code = ruleCode;
  createBody.data.attributes.name = `RaceTestRule_${ts}`;

  console.log(`🆕 Creating fresh test rule: ${ruleCode}`);
  const createRes = http.post(
    `${baseConfig.baseUrlRules}/api/v1/rules`,
    JSON.stringify(createBody),
    { headers }
  );

  if (createRes.status !== 201) {
    console.log(`❌ Create failed: ${createRes.status} :: ${createRes.body?.substring(0, 300)}`);
    throw new Error(`Failed to create test rule: ${createRes.status}`);
  }

  const newRule = createRes.json()?.data;
  const targetRuleId = newRule?.id;
  console.log(`🎯 RACE TARGET (fresh): rule_id = ${targetRuleId}`);
  console.log(`   Strategy: 10 parallel PATCHes per burst, 5 bursts, 60s between.`);

  return { token, targetRuleId, createdRuleCode: ruleCode };
}

export default function (data) {
  const { token, targetRuleId } = data;
  const headers = {
    ...baseConfig.headers,
    'Authorization': `Bearer ${token}`,
  };

  const ts = Date.now();
  const burstId = __ITER + 1;
  console.log(`\n🔥 BURST ${burstId}/5 — firing 10 parallel PATCHes at fresh rule ${targetRuleId}`);

  const requests = [];
  for (let i = 1; i <= 10; i++) {
    requests.push({
      method: 'PATCH',
      url: `${baseConfig.baseUrlRules}/api/v1/rules/${targetRuleId}`,
      body: JSON.stringify({
        data: {
          type: "UpdateRule",
          attributes: {
            description: `RACE_BURST${burstId}_REQ${i}_TS${ts}`
          }
        }
      }),
      params: { headers, tags: { endpoint: 'PATCH_race_parallel' } }
    });
  }

  const responses = http.batch(requests);

  let burstStats = { '200': 0, '409': 0, '422': 0, '429': 0, '500+': 0, 'other': 0 };
  let first422Body = null;

  responses.forEach((res, idx) => {
    const reqNum = idx + 1;
    if (res.status === 200) {
      burstStats['200']++;
      successCounter.add(1);
    } else if (res.status === 409) {
      burstStats['409']++;
      conflictCounter.add(1);
    } else if (res.status === 422) {
      burstStats['422']++;
      validationErrorCounter.add(1);
      if (!first422Body) first422Body = res.body?.substring(0, 300);
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

    const passed = [200, 409, 422].includes(res.status);
    const checkObj = {};
    checkObj[`BURST${burstId} REQ${reqNum} - clean response`] = () => passed;
    check(res, checkObj);
    customErrorRate.add(!passed);
  });

  console.log(`   📊 Burst ${burstId} results: ${JSON.stringify(burstStats)}`);
  if (first422Body) console.log(`   📋 Sample 422 body: ${first422Body}`);

  // Verify final state
  const verify = http.get(
    `${baseConfig.baseUrlRules}/api/v1/rules/${targetRuleId}`,
    { headers }
  );
  if (verify.status === 200) {
    const winningDesc = verify.json()?.data?.attributes?.description || 'N/A';
    console.log(`   🏁 Final description: "${winningDesc}"`);
  }

  sleep(60);
}

export function teardown(data) {
  const { token, targetRuleId } = data;
  const headers = {
    ...baseConfig.headers,
    'Authorization': `Bearer ${token}`,
  };

  // 🧹 Cleanup: delete the test rule
  if (targetRuleId) {
    console.log(`\n🧹 Cleaning up test rule ${targetRuleId}`);
    const delRes = http.del(
      `${baseConfig.baseUrlRules}/api/v1/rules/${targetRuleId}`,
      null,
      { headers }
    );
    console.log(`   Delete status: ${delRes.status}`);
  }
  console.log('✅ Race test v3 complete.');
}

export function handleSummary(data) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return {
    [`reports/race-test-${timestamp}.html`]: htmlReport(data),
    [`reports/race-test-${timestamp}.json`]: JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}