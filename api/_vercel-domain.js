'use strict';

// Attaches a shop hostname (<slug>.<POS_ROOT_DOMAIN>) to THIS Vercel project.
//
// Credentials are read from (first one found wins):
//   token     : POS_VERCEL_API_TOKEN    -> VERCEL_API_TOKEN
//   project   : POS_VERCEL_PROJECT_ID   -> VERCEL_PROJECT_ID   (Vercel also injects this one automatically
//               for the current project when "Automatically expose System Environment Variables" is on)
//   team      : POS_VERCEL_TEAM_ID      -> VERCEL_TEAM_ID      (leave empty for a personal/Hobby account)
//
// POS_WILDCARD_DOMAIN=true keeps its old meaning (no per-shop call is required), but when API credentials
// exist the hostname is now ALSO attached on a best-effort basis, so a missing "*.<root>" wildcard on a
// new Vercel account no longer leaves shops without a domain.

const API_TIMEOUT_MS = 7000;

function clean(value) { return String(value || '').trim(); }

function rootDomainFromEnv() {
  return clean(process.env.POS_ROOT_DOMAIN).toLowerCase()
    .replace(/^https?:\/\//, '').split('/')[0].replace(/:\d+$/, '');
}

function credentials() {
  return {
    token: clean(process.env.POS_VERCEL_API_TOKEN) || clean(process.env.VERCEL_API_TOKEN),
    projectId: clean(process.env.POS_VERCEL_PROJECT_ID) || clean(process.env.VERCEL_PROJECT_ID),
    teamId: clean(process.env.POS_VERCEL_TEAM_ID) || clean(process.env.VERCEL_TEAM_ID)
  };
}

async function vercelCall(method, path, creds, body) {
  const url = new URL(`https://api.vercel.com${path}`);
  if (creds.teamId) url.searchParams.set('teamId', creds.teamId);
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(API_TIMEOUT_MS)
  });
  const result = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, result };
}

function failure(message, code, status) {
  return Object.assign(new Error(message), { code, status });
}

function describeFailure(status, result) {
  const code = result?.error?.code || result?.code || '';
  const text = result?.error?.message || result?.message || `Vercel domain registration failed (HTTP ${status})`;
  if (status === 401 || code === 'forbidden' && /token/i.test(text)) {
    return `${text} - the Vercel API token is not valid for the account that owns this project. Create a new token in the NEW Vercel account and set VERCEL_API_TOKEN.`;
  }
  if (status === 404 && /project/i.test(text)) {
    return `${text} - VERCEL_PROJECT_ID (or VERCEL_TEAM_ID) still points to the OLD Vercel account. Use the project ID / team ID of the NEW project.`;
  }
  if (/another|other account|not_domain_owner|domain_already_in_use|verification/i.test(`${code} ${text}`)) {
    return `${text} - the root domain (or this hostname) is still attached to the OLD Vercel account. Add the TXT verification record Vercel shows for the root domain, or remove the hostname from the old project.`;
  }
  return text;
}

async function attachDomain(domain, creds) {
  const base = `/v9/projects/${encodeURIComponent(creds.projectId)}/domains`;
  const added = await vercelCall('POST', `/v10/projects/${encodeURIComponent(creds.projectId)}/domains`, creds, { name: domain });
  let record = added.ok ? added.result : null;

  if (!added.ok) {
    // Already attached to this project? That is a success. Attached somewhere else? That is a real failure.
    if (added.status === 409 || /already/i.test(JSON.stringify(added.result))) {
      const existing = await vercelCall('GET', `${base}/${encodeURIComponent(domain)}`, creds);
      if (existing.ok) record = existing.result;
    }
    if (!record) throw failure(describeFailure(added.status, added.result), 'VERCEL_DOMAIN_FAILED', added.status);
  }

  let verified = record.verified !== false;
  let verification = Array.isArray(record.verification) ? record.verification : [];
  if (!verified) {
    // Ask Vercel to re-check ownership (works as soon as the DNS / TXT record is in place).
    const check = await vercelCall('POST', `${base}/${encodeURIComponent(domain)}/verify`, creds).catch(() => null);
    if (check?.ok) {
      verified = check.result.verified !== false;
      if (!verified && Array.isArray(check.result.verification)) verification = check.result.verification;
    }
  }
  return { domain, verified, verification: verified ? [] : verification };
}

// options.strict = true -> always call the API and always throw on failure (used by the repair script).
async function registerTenantDomain(slug, options = {}) {
  const root = rootDomainFromEnv();
  if (!root || root.endsWith('.vercel.app')) return { skipped: true };

  const domain = `${slug}.${root}`;
  const wildcard = clean(process.env.POS_WILDCARD_DOMAIN).toLowerCase() === 'true';
  const creds = credentials();
  const hasCreds = !!(creds.token && creds.projectId);

  if (wildcard && !options.strict) {
    if (!hasCreds) return { domain, skipped: true, wildcard: true };
    // Wildcard is declared, but attach the hostname too in case "*.<root>" is not on this project yet.
    try {
      const attached = await attachDomain(domain, creds);
      return { ...attached, wildcard: true };
    } catch (error) {
      console.error(`Optional per-shop domain attach failed for ${domain}:`, error.message);
      return { domain, skipped: true, wildcard: true, warning: error.message };
    }
  }

  if (!hasCreds) {
    throw failure('Automatic domain setup is not configured. Add VERCEL_API_TOKEN (and VERCEL_PROJECT_ID / VERCEL_TEAM_ID if needed) to the Vercel project.', 'VERCEL_DOMAIN_CONFIG');
  }
  return attachDomain(domain, creds);
}

module.exports = { registerTenantDomain };