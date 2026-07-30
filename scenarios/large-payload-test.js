// scenarios/large-payload-test.js
// Goal: Send oversized payloads and see how API responds.
// Looking for: 500s, timeouts, OOM, silent garbage acceptance, missing 413.

import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';
import { logUnexpected } from '../libs/helpers.js';

const baseConfig = JSON.parse(open('../config/base.json'));
const rulePayload = JSON.parse(open('../payloads/rule-payload.json'));

const serverError = new Counter('server_errors_500');
const payloadTooLarge = new Counter('payload_too_large_413');
const badRequest = new Counter('bad_request_400');
const validationError = new Counter('validation_422');
const silentSuccess = new Counter('silent_success_201');
const timeoutCount = new Counter('timeouts');

export const options = {
  vus: 1,
  iterations: 1,  // Just 1 iteration — we'll send all test cases sequentially
  thresholds: {
    http_req_duration: ['p(95)<30000'], // allow up to 30s for large payloads
  },
  // Critical: allow LONG requests since we expect potential slowness
  setupTimeout: '60s',
};

// helper: generate a string of given length
function bigString(n) {
  return 'A'.repeat(n);
}

// helper: generate deeply nested AST (for rule body)
function deepNestedAst(depth) {
  // builds: { node_type: "sequence", body: [ { node_type: "sequence", body: [ ... ] } ] }
  let node = { node_type: "literal", value: "leaf" };
  for (let i = 0; i < depth; i++) {
    node = { node_type: "sequence", body: [node] };
  }
  return node;
}

// helper: generate wide AST (one node with many children)
function wideAst(width) {
  const children = [];
  for (let i = 0; i < width; i++) {
    children.push({ node_type: "literal", value: `child_${i}` });
  }
  return { node_type: "sequence", body: children };
}

function classifyAndCount(label, res, payloadSizeKb) {
  console.log(`\n📦 ${label} | size: ${payloadSizeKb} KB | status: ${res.status} | duration: ${res.timings.duration.toFixed(0)}ms`);

  if (res.status === 0) {
    timeoutCount.add(1);
    console.log(`   ⏱️ TIMEOUT / connection failure`);
  } else if (res.status === 201) {
    silentSuccess.add(1);
    console.log(`   ⚠️ API ACCEPTED — silently stored oversized data?`);
  } else if (res.status === 400) {
    badRequest.add(1);
    console.log(`   ✅ Clean 400 Bad Request`);
  } else if (res.status === 413) {
    payloadTooLarge.add(1);
    console.log(`   ✅ Clean 413 Payload Too Large (textbook correct!)`);
  } else if (res.status === 422) {
    validationError.add(1);
    console.log(`   ✅ Clean 422 Validation`);
  } else if (res.status >= 500) {
    serverError.add(1);
    console.log(`   🚨 SERVER ERROR 500+ — POTENTIAL BUG`);
    console.log(`   Body (first 300 chars): ${res.body?.substring(0, 300)}`);
  } else {
    console.log(`   ❓ Unexpected status: ${res.status}`);
    console.log(`   Body (first 300 chars): ${res.body?.substring(0, 300)}`);
  }

  // checks for the report — we want 400/413/422 for oversized inputs
  const cleanReject = [400, 413, 422].includes(res.status);
  const checkObj = {};
  checkObj[`${label} - clean rejection (400/413/422)`] = () => cleanReject;
  check(res, checkObj);
}

export default function () {
  const token = __ENV.BEARER_TOKEN;
  if (!token) throw new Error('BEARER_TOKEN not set!');

  const headers = {
    ...baseConfig.headers,
    'Authorization': `Bearer ${token}`,
  };

  // long timeout for huge payloads
  const params = { headers, timeout: '60s' };

  // ----------------------------------------------------------
  // TEST 1: 10 KB description (small, should succeed normally)
  // ----------------------------------------------------------
  {
    const payload = JSON.parse(JSON.stringify(rulePayload));
    payload.data.attributes.rule_code = `BIG_PAYLOAD_TEST_1_${Date.now()}`;
    payload.data.attributes.name = `BigPayloadTest1_${Date.now()}`;
    payload.data.attributes.description = bigString(10 * 1024); // 10 KB
    const body = JSON.stringify(payload);

    const res = http.post(`${baseConfig.baseUrlRules}/api/v1/rules`, body, params);
    classifyAndCount('TEST 1: 10 KB description (baseline)', res, (body.length / 1024).toFixed(1));
  }

  // ----------------------------------------------------------
  // TEST 2: 100 KB description
  // ----------------------------------------------------------
  {
    const payload = JSON.parse(JSON.stringify(rulePayload));
    payload.data.attributes.rule_code = `BIG_PAYLOAD_TEST_2_${Date.now()}`;
    payload.data.attributes.name = `BigPayloadTest2_${Date.now()}`;
    payload.data.attributes.description = bigString(100 * 1024); // 100 KB
    const body = JSON.stringify(payload);

    const res = http.post(`${baseConfig.baseUrlRules}/api/v1/rules`, body, params);
    classifyAndCount('TEST 2: 100 KB description', res, (body.length / 1024).toFixed(1));
  }

  // ----------------------------------------------------------
  // TEST 3: 1 MB description
  // ----------------------------------------------------------
  {
    const payload = JSON.parse(JSON.stringify(rulePayload));
    payload.data.attributes.rule_code = `BIG_PAYLOAD_TEST_3_${Date.now()}`;
    payload.data.attributes.name = `BigPayloadTest3_${Date.now()}`;
    payload.data.attributes.description = bigString(1 * 1024 * 1024); // 1 MB
    const body = JSON.stringify(payload);

    const res = http.post(`${baseConfig.baseUrlRules}/api/v1/rules`, body, params);
    classifyAndCount('TEST 3: 1 MB description', res, (body.length / 1024).toFixed(1));
  }

  // ----------------------------------------------------------
  // TEST 4: 10 MB description (very large)
  // ----------------------------------------------------------
  {
    const payload = JSON.parse(JSON.stringify(rulePayload));
    payload.data.attributes.rule_code = `BIG_PAYLOAD_TEST_4_${Date.now()}`;
    payload.data.attributes.name = `BigPayloadTest4_${Date.now()}`;
    payload.data.attributes.description = bigString(10 * 1024 * 1024); // 10 MB
    const body = JSON.stringify(payload);

    const res = http.post(`${baseConfig.baseUrlRules}/api/v1/rules`, body, params);
    classifyAndCount('TEST 4: 10 MB description', res, (body.length / 1024).toFixed(1));
  }

  // ----------------------------------------------------------
  // TEST 5: 5,000 character rule_code (way over the 64-char limit)
  // ----------------------------------------------------------
  {
    const payload = JSON.parse(JSON.stringify(rulePayload));
    payload.data.attributes.rule_code = bigString(5000); // 5000 chars, but the API limit is 64
    payload.data.attributes.name = `BigCodeTest_${Date.now()}`;
    const body = JSON.stringify(payload);

    const res = http.post(`${baseConfig.baseUrlRules}/api/v1/rules`, body, params);
    classifyAndCount('TEST 5: 5000-char rule_code (limit is 64)', res, (body.length / 1024).toFixed(1));
  }

  // ----------------------------------------------------------
  // TEST 6: Deeply nested AST in rule body (depth 1000)
  // ----------------------------------------------------------
  {
    const payload = JSON.parse(JSON.stringify(rulePayload));
    payload.data.attributes.rule_code = `DEEP_AST_TEST_${Date.now()}`;
    payload.data.attributes.name = `DeepAstTest_${Date.now()}`;
    payload.data.attributes.body = deepNestedAst(1000);
    const body = JSON.stringify(payload);

    const res = http.post(`${baseConfig.baseUrlRules}/api/v1/rules`, body, params);
    classifyAndCount('TEST 6: 1000-deep nested AST', res, (body.length / 1024).toFixed(1));
  }

  // ----------------------------------------------------------
  // TEST 7: Wide AST (10,000 sibling children)
  // ----------------------------------------------------------
  {
    const payload = JSON.parse(JSON.stringify(rulePayload));
    payload.data.attributes.rule_code = `WIDE_AST_TEST_${Date.now()}`;
    payload.data.attributes.name = `WideAstTest_${Date.now()}`;
    payload.data.attributes.body = wideAst(10000);
    const body = JSON.stringify(payload);

    const res = http.post(`${baseConfig.baseUrlRules}/api/v1/rules`, body, params);
    classifyAndCount('TEST 7: AST with 10,000 sibling children', res, (body.length / 1024).toFixed(1));
  }

  // ----------------------------------------------------------
  // TEST 8: 50 MB description (extreme)
  // ----------------------------------------------------------
  {
    const payload = JSON.parse(JSON.stringify(rulePayload));
    payload.data.attributes.rule_code = `EXTREME_TEST_${Date.now()}`;
    payload.data.attributes.name = `ExtremeTest_${Date.now()}`;
    payload.data.attributes.description = bigString(50 * 1024 * 1024); // 50 MB
    const body = JSON.stringify(payload);

    console.log(`\n🚨 TEST 8: Sending 50 MB payload — this may take a while or fail entirely...`);
    const res = http.post(`${baseConfig.baseUrlRules}/api/v1/rules`, body, params);
    classifyAndCount('TEST 8: 50 MB description (EXTREME)', res, (body.length / 1024).toFixed(1));
  }

  console.log(`\n\n========== TEST COMPLETE ==========`);
  console.log(`Review the counters above for findings.`);
}

export function handleSummary(data) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return {
    [`reports/large-payload-test-${timestamp}.html`]: htmlReport(data),
    [`reports/large-payload-test-${timestamp}.json`]: JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}