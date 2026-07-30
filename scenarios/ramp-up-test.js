// scenarios/ramp-up-test.js
// Goal: Gradually increase VU count to find performance inflection points.
// Watches latency trends per stage to identify where API starts degrading.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Counter, Trend } from 'k6/metrics';
import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';
import { logUnexpected } from '../libs/helpers.js';

const baseConfig = JSON.parse(open('../config/base.json'));

const serverErrorCounter = new Counter('server_errors_500');
const rateLimitCounter = new Counter('rate_limited_429');
const customErrorRate = new Rate('custom_error_rate');
const latencyByStage = new Trend('latency_by_stage');

export const options = {
  stages: [
    // ramp-up profile: 1 → 2 → 5 → 10 → 15 → cool-down
    { duration: '30s', target: 1 },   // warm-up
    { duration: '1m',  target: 1 },   // hold at 1 VU (baseline)
    { duration: '30s', target: 2 },   // ramp to 2
    { duration: '1m',  target: 2 },   // hold at 2
    { duration: '30s', target: 5 },   // ramp to 5
    { duration: '1m',  target: 5 },   // hold at 5
    { duration: '30s', target: 10 },  // ramp to 10
    { duration: '1m',  target: 10 },  // hold at 10
    { duration: '30s', target: 15 },  // ramp to 15 (over the 100/min cap)
    { duration: '1m',  target: 15 },  // hold at 15
    { duration: '30s', target: 0 },   // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<3000'],
  },
};

export function setup() {
  const token = __ENV.BEARER_TOKEN;
  if (!token) throw new Error('BEARER_TOKEN not set!');
  console.log(`🎯 RAMP-UP / BREAKPOINT TEST`);
  console.log(`   Stages: 1 → 2 → 5 → 10 → 15 VUs (each held for 1 min)`);
  console.log(`   Total duration: ~8 minutes`);
  console.log(`   Watching for: latency degradation, 500 errors, breakpoint`);
  return { token };
}

export default function () {
  const token = __ENV.BEARER_TOKEN;
  const headers = {
    ...baseConfig.headers,
    'Authorization': `Bearer ${token}`,
  };

  // Simple GET — cheapest read to test raw API capacity
  const res = http.get(
    `${baseConfig.baseUrlRules}/api/v1/rules`,
    { headers, tags: { endpoint: 'GET_rules_rampup' } }
  );

  latencyByStage.add(res.timings.duration);

  if (res.status === 200) {
    // clean response — nothing to do
  } else if (res.status === 429) {
    rateLimitCounter.add(1);
  } else if (res.status >= 500) {
    serverErrorCounter.add(1);
    logUnexpected(`VU${__VU} - SERVER ERROR at load`, res);
  }

  // Accept 200 or 429 as OK (429 is expected once we hit the rate limit)
  const passed = res.status === 200 || res.status === 429;
  const checkObj = {};
  checkObj[`GET rules - clean response`] = () => passed;
  check(res, checkObj);
  customErrorRate.add(!passed);

  // Short think time — we want density to actually stress the API
  sleep(2);
}

export function teardown() {
  console.log('\n✅ Ramp-up test complete.');
}

export function handleSummary(data) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  console.log('\n============ RAMP-UP ANALYSIS ============');
  console.log(`Total requests: ${data.metrics.http_reqs?.values?.count || 0}`);
  console.log(`Rate limited (429): ${data.metrics.rate_limited_429?.values?.count || 0}`);
  console.log(`Server errors (500): ${data.metrics.server_errors_500?.values?.count || 0}`);
  console.log(`Overall p95 latency: ${data.metrics.http_req_duration?.values['p(95)']?.toFixed(0)}ms`);
  console.log(`Overall p99 latency: ${data.metrics.http_req_duration?.values['p(99)']?.toFixed(0)}ms`);
  console.log(`Max latency: ${data.metrics.http_req_duration?.values.max?.toFixed(0)}ms`);
  console.log(`\nInterpretation:`);
  console.log(`  → If p95 stays <500ms throughout: API handles ramp well ✅`);
  console.log(`  → If p95 spikes over stages: latency degrading under load ⚠️`);
  console.log(`  → If 500s appear at higher VU counts: potential breakpoint 🚨`);

  return {
    [`reports/ramp-up-test-${timestamp}.html`]: htmlReport(data),
    [`reports/ramp-up-test-${timestamp}.json`]: JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}