'use strict';

// Attaches every existing shop hostname (<slug>.<POS_ROOT_DOMAIN>) to the NEW Vercel project.
// Use it once to repair shops that were created after the move and never got a domain.
//
//   Preview : node scripts/sync-tenant-domains.js
//   Apply   : node scripts/sync-tenant-domains.js --apply
//   One shop: node scripts/sync-tenant-domains.js --apply --slug myshop
//
// Needs these in your shell: MONGODB_URI, MONGODB_DB (if not the default), POS_ROOT_DOMAIN,
// VERCEL_API_TOKEN, VERCEL_PROJECT_ID and VERCEL_TEAM_ID (team accounts only) of the NEW Vercel account.
const { MongoClient } = require('mongodb');
const { registerTenantDomain } = require('../api/_vercel-domain');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const only = args.includes('--slug') ? String(args[args.indexOf('--slug') + 1] || '').toLowerCase() : '';

(async () => {
  const uri = String(process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGODB_URL || '').trim();
  if (!uri) throw new Error('Set MONGODB_URI in your environment.');
  if (!process.env.POS_ROOT_DOMAIN) throw new Error('Set POS_ROOT_DOMAIN (for example pos.zenstack360.com).');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  try {
    const database = client.db(process.env.MONGODB_DB || 'the_smart_pos');
    const filter = { slug: { $nin: ['main', null] }, status: { $nin: ['deleted'] } };
    if (only) filter.slug = only;
    const tenants = await database.collection('tenants').find(filter, { projection: { slug: 1, name: 1, status: 1 } }).toArray();
    console.log(`${tenants.length} shop(s) found. ${apply ? 'APPLYING' : 'Preview only (add --apply to register)'}\n`);
    let ok = 0, bad = 0;
    for (const tenant of tenants) {
      const host = `${tenant.slug}.${String(process.env.POS_ROOT_DOMAIN).trim().toLowerCase()}`;
      if (!apply) { console.log(`- would register ${host}  (${tenant.name})`); continue; }
      try {
        const r = await registerTenantDomain(tenant.slug, { strict: true });
        await database.collection('tenants').updateOne({ _id: tenant._id }, { $set: { domainStatus: { domain: r.domain, verified: r.verified !== false, checkedAt: new Date() } } });
        if (r.verified === false) { bad++; console.log(`! ${host} added but NOT verified yet:`, JSON.stringify(r.verification)); }
        else { ok++; console.log(`✓ ${host}`); }
      } catch (error) { bad++; console.log(`✗ ${host}: ${error.message}`); }
    }
    if (apply) console.log(`\nDone. ${ok} ok, ${bad} need attention.`);
  } finally { await client.close(); }
})().catch((error) => { console.error(error.message); process.exit(1); });