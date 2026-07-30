// =============================================================================
// POD 4 (AUTH & AUTHORIZATION) — RATE LIMIT CHECK
// =============================================================================
// Purpose: Verify if 100 req/min gateway rate limit is still enforced.
// Method : Ramp 60 rpm → 100 rpm → 150 rpm over 3 min. Watch for HTTP 429s.
// Result : 429s around 100 rpm mark = limit STILL THERE
//          Clean run to 150 rpm     = limit RESOLVED
//
// Run    : .\k6.exe run pod4-ratelimit-check.js
// =============================================================================

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate } from 'k6/metrics';

// ---------- CONFIG ----------
const BASE_URL = 'https://<PASTE-POD4-AUTH-BASE-URL>.azurewebsites.net';
// Auth endpoints need a token — paste a valid bearer here.
const AUTH_TOKEN = '';
// IDs for the tenant-scoped endpoints. Leave blank and those endpoints
// are simply skipped (the token-only GETs still run).
const TENANT_ID = '';
const USER_ID   = '';
const ROLE_ID   = '';
// ----------------------------

const rateLimit429 = new Counter('rate_limit_429_count');
const rateLimitRate = new Rate('rate_limit_429_ratio');

export const options = {
  scenarios: {
    ramp_rpm: {
      executor: 'ramping-arrival-rate',
      startRate: 60,             // start below limit
      timeUnit: '1m',            // per MINUTE
      preAllocatedVUs: 20,
      maxVUs: 50,
      stages: [
        { duration: '1m', target: 60 },   // hold 60 rpm — should be clean
        { duration: '1m', target: 100 },  // ramp to 100 rpm — the limit boundary
        { duration: '1m', target: 150 },  // ramp to 150 rpm — should trigger 429 if limit exists
      ],
    },
  },
  thresholds: {
    'rate_limit_429_ratio': ['rate<1.0'],
  },
};

const headers = {
  headers: {
    ...(AUTH_TOKEN ? { 'Authorization': `Bearer ${AUTH_TOKEN}` } : {}),
    'Accept': 'application/vnd.api+json',
    'Content-Type': 'application/vnd.api+json',
  },
};

// READ-ONLY endpoints only — no user creation, no role assignment, no membership changes.
// (Excluded on purpose: POST /auth0/users/bulkimport, POST .../members/me, POST .../roles)
const endpoints = [
  { name: 'GET /auth/me',                    url: `${BASE_URL}/auth/me` },
  { name: 'GET /auth0/organizations/mine',   url: `${BASE_URL}/auth0/organizations/mine` },
  { name: 'GET /auth0/permissions',          url: `${BASE_URL}/auth0/permissions` },
  { name: 'GET /linesofbusiness',            url: `${BASE_URL}/linesofbusiness?page=1&pageSize=10` },
  { name: 'GET /products',                   url: `${BASE_URL}/products?page=1&pageSize=10` },
  { name: 'GET /writingcompanies',           url: `${BASE_URL}/writingcompanies?page=1&pageSize=10` },
  { name: 'GET /loblevelversions',           url: `${BASE_URL}/loblevelversions?page=1&pageSize=10` },
];

// Tenant-scoped endpoints — only added if the IDs above are filled in
if (TENANT_ID && USER_ID) {
  endpoints.push({ name: 'GET /tenants/{id}/members/{userId}/roles', url: `${BASE_URL}/tenants/${TENANT_ID}/members/${USER_ID}/roles` });
}
if (TENANT_ID && ROLE_ID) {
  endpoints.push({ name: 'GET /tenants/{id}/roles/{roleId}/permissions', url: `${BASE_URL}/tenants/${TENANT_ID}/roles/${ROLE_ID}/permissions` });
}
if (TENANT_ID) {
  endpoints.push({ name: 'GET /tenants/{id}/logs', url: `${BASE_URL}/tenants/${TENANT_ID}/logs?page=1&pageSize=10` });
}

export default function () {
  const idx = (__VU + __ITER) % endpoints.length;
  const ep = endpoints[idx];

  const res = http.get(ep.url, headers);

  const is429 = res.status === 429;
  const is503 = res.status === 503;

  rateLimit429.add(is429 ? 1 : 0);
  rateLimitRate.add(is429);

  check(res, {
    'not rate-limited (429)': (r) => r.status !== 429,
    'not throttled (503)':    (r) => r.status !== 503,
    'no server error (5xx)':  (r) => r.status < 500,
  });

  if (is429 || is503) {
    console.warn(`[${ep.name}] Status: ${res.status} | Body: ${res.body ? res.body.substring(0, 200) : 'empty'}`);
  }
}

export function handleSummary(data) {
  const total429 = data.metrics.rate_limit_429_count
    ? data.metrics.rate_limit_429_count.values.count
    : 0;
  const totalReqs = data.metrics.http_reqs
    ? data.metrics.http_reqs.values.count
    : 0;
  const pct = totalReqs > 0 ? ((total429 / totalReqs) * 100).toFixed(2) : '0.00';

  const verdict = total429 > 0
    ? '\n\n🚨 RATE LIMIT STILL ENFORCED — escalate to senior\n'
    : '\n\n✅ NO 429 responses — rate limit appears RESOLVED\n';

  const summary = `
================================================================
  POD 4 (AUTH & AUTHORIZATION) — RATE LIMIT CHECK RESULT
================================================================
  Base URL                : ${BASE_URL}
  Endpoints probed        : ${endpoints.length}
  Total requests fired    : ${totalReqs}
  HTTP 429 responses      : ${total429}
  429 rate                : ${pct}%
${verdict}================================================================
`;
  console.log(summary);
  return {
    'stdout': summary,
    'pod4-ratelimit-result.json': JSON.stringify(data, null, 2),
  };
}