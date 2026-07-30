// scenarios/slow-client-test.js
// Goal: Open many slow / long-lived connections, see if API leaks resources or degrades.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Counter, Trend } from 'k6/metrics';
import { htmlReport } from 'https://raw.githubusercontent.com/benc-uk/k6-reporter/main/dist/bundle.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';
import { logUnexpected } from '../libs/helpers.js';

const baseConfig = JSON.parse(open('../config/base.json'));

const serverErrorCounter = new Counter('server_errors_500');
const timeoutCounter = new Counter('timeouts_or_disconnects');
const rateLimitCounter = new Counter('rate_limited_429');
const slowClientLatency = new Trend('slow_client_latency');
const healthyClientLatency = new Trend('healthy_client_latency');
const customErrorRate = new Rate('custom_error_rate');

export const options = {
  scenarios: {
    // Scenario 1: 5 "slow" VUs that hold connections open with long timeouts
    slow_clients: {
      executor: 'constant-vus',
      vus: 5,
      duration: '3m',
      exec: 'slowClient',
      startTime: '0s',
    },
    // Scenario 2: 1 "healthy" client that keeps making normal requests
    // to see if the API is still responsive while slow clients hold connections
    healthy_client: {
      executor: 'constant-vus',
      vus: 1,
      duration: '3m',
      exec: 'healthyClient',
      startTime: '10s', // start 10s after slow clients are established
    },
  },
  thresholds: {
    // healthy client should stay fast — if it slows down, API is starving
    'healthy_client_latency': ['p(95)<2000'],
  },
};

// ------------------------------------------------
// SLOW CLIENT — makes requests with very long timeouts
// simulates clients that hold connections open
// ------------------------------------------------
export function slowClient() {
  const token = __ENV.BEARER_TOKEN;
  const headers = {
    ...baseConfig.headers,
    'Authorization': `Bearer ${token}`,
  };

  // Very generous timeout — simulates a slow/idle client
  const params = {
    headers,
    timeout: '120s',
    tags: { client: 'slow' },
  };

  const res = http.get(
    `${baseConfig.baseUrlRules}/api/v1/rules`,
    params
  );

  if (res.status === 0) {
    timeoutCounter.add(1);
    console.log(`⏱️ SLOW-VU${__VU}: timeout / connection failure`);
  } else if (res.status >= 500) {
    serverErrorCounter.add(1);
    logUnexpected(`SLOW-VU${__VU} - SERVER ERROR`, res);
  } else if (res.status === 429) {
    rateLimitCounter.add(1);
  }

  slowClientLatency.add(res.timings.duration);

  // Hold "connection" idle before next request — mimics slow client behavior
  sleep(15);
}

// ------------------------------------------------
// HEALTHY CLIENT — normal requests, tests if API still responsive
// ------------------------------------------------
export function healthyClient() {
  const token = __ENV.BEARER_TOKEN;
  const headers = {
    ...baseConfig.headers,
    'Authorization': `Bearer ${token}`,
  };

  const params = {
    headers,
    timeout: '10s',
    tags: { client: 'healthy' },
  };

  const startTime = Date.now();
  const res = http.get(
    `${baseConfig.baseUrlRules}/api/v1/rules`,
    params
  );
  const elapsed = Date.now() - startTime;

  const passed = res.status === 200;
  const checkObj = {};
  checkObj[`HEALTHY-VU${__VU} - fast response`] = () => passed;
  check(res, checkObj);
  customErrorRate.add(!passed);

  if (res.status === 0) {
    timeoutCounter.add(1);
    console.log(`⏱️ HEALTHY: timeout (elapsed=${elapsed}ms)`);
  } else if (res.status >= 500) {
    serverErrorCounter.add(1);
    console.log(`🚨 HEALTHY: 500 error (elapsed=${elapsed}ms)`);
    logUnexpected(`HEALTHY - SERVER ERROR`, res);
  } else if (res.status === 429) {
    rateLimitCounter.add(1);
    console.log(`⚠️ HEALTHY: 429 rate-limited (elapsed=${elapsed}ms)`);
  } else if (res.status === 200) {
    // Log if healthy client is getting slower over time — that's the tell
    if (elapsed > 2000) {
      console.log(`⚠️ HEALTHY: slow response (${elapsed}ms) — possible resource starvation`);
    }
  }

  healthyClientLatency.add(res.timings.duration);

  sleep(10);
}

export function handleSummary(data) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  const slowLatencyMetric = data.metrics.slow_client_latency;
  const healthyLatencyMetric = data.metrics.healthy_client_latency;

  console.log('\n\n============ FINAL ANALYSIS ============');
  if (slowLatencyMetric) {
    console.log(`Slow client latency (p95): ${slowLatencyMetric.values['p(95)']?.toFixed(0)}ms`);
  }
  if (healthyLatencyMetric) {
    console.log(`Healthy client latency (p95): ${healthyLatencyMetric.values['p(95)']?.toFixed(0)}ms`);
    console.log(`  → If healthy client stayed under 2000ms, API is NOT resource-starved.`);
    console.log(`  → If healthy client crept up over time, potential resource leak / connection exhaustion.`);
  }

  return {
    [`reports/slow-client-test-${timestamp}.html`]: htmlReport(data),
    [`reports/slow-client-test-${timestamp}.json`]: JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}