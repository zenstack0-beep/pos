'use strict';
/*
 * Finds out why a super admin cannot sign in after moving to a new MongoDB / Vercel account,
 * and (optionally) copies the super admin account(s) into the database the deployed app reads.
 *
 * The API reads database  MONGODB_DB  (default "the_smart_pos"). A super admin created while a
 * different MONGODB_DB was set (for example "the_smart_pos_local") is invisible to the deployed app.
 *
 * Usage (run on a trusted machine):
 *   Check only (changes nothing):
 *     MONGODB_URI='mongodb+srv://…' MONGODB_DB='<same value as Vercel, or leave unset>' node scripts/fix-superadmin-db.js
 *   Copy missing accounts from another database into the target database:
 *     MONGODB_URI='mongodb+srv://…' MONGODB_DB='<same as Vercel>' SOURCE_DB='the_smart_pos_local' CONFIRM=yes node scripts/fix-superadmin-db.js
 *
 * The copy is additive and idempotent: existing accounts (matched by email) are never overwritten, and
 * the source database is left untouched. Password hashes are copied as they are, so the same password works.
 * Nothing secret is printed.
 */
const { MongoClient } = require('mongodb');
const { resolveDbName } = require('../api/_db');

const clean = (v) => String(v || '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();

async function main() {
  const uri = clean(process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGODB_URL);
  if (!uri) throw new Error('Set MONGODB_URI.');
  const target = resolveDbName();
  const source = clean(process.env.SOURCE_DB);
  const confirm = process.env.CONFIRM === 'yes';

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
    console.log(`Target database (what the deployed app reads): "${target}"`);

    let names = [];
    try { names = (await client.db().admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name); }
    catch (_) { names = [...new Set([target, source].filter(Boolean))]; console.log('(Could not list all databases; checking only the ones named.)'); }

    const found = [];
    for (const name of names) {
      if (['admin', 'local', 'config'].includes(name)) continue;
      const rows = await client.db(name).collection('superadmins').find({}, { projection: { email: 1, role: 1, active: 1, mfaEnabled: 1 } }).toArray();
      if (rows.length) found.push({ name, rows });
    }
    if (!found.length) console.log('No "superadmins" collection with accounts was found in any database. Create one with scripts/create-superadmin.js.');
    for (const f of found) {
      console.log(`\nDatabase "${f.name}"${f.name === target ? '  <-- app reads this one' : ''}`);
      for (const r of f.rows) console.log(`  - ${r.email}  role=${r.role}  active=${r.active}  mfa=${!!r.mfaEnabled}`);
    }
    const inTarget = found.find((f) => f.name === target);
    if (!inTarget) console.log(`\nProblem: database "${target}" has no super admin, so sign-in always says "Invalid email or password".`);

    if (!source) {
      console.log('\nTo fix, either:\n  A) set MONGODB_DB in Vercel to the database that holds your super admin, then redeploy; or\n  B) re-run this script with SOURCE_DB=<that database> CONFIRM=yes to copy the account into "' + target + '".');
      return;
    }
    if (source === target) throw new Error('SOURCE_DB and the target database are the same. Nothing to copy.');
    const docs = await client.db(source).collection('superadmins').find({}).toArray();
    if (!docs.length) throw new Error(`No super admin accounts found in "${source}".`);
    const dest = client.db(target).collection('superadmins');
    await dest.createIndex({ email: 1 }, { unique: true });
    let copied = 0, skipped = 0;
    for (const doc of docs) {
      const email = String(doc.email || '').trim().toLowerCase();
      if (!email) continue;
      if (await dest.findOne({ email }, { projection: { _id: 1 } })) { skipped++; console.log(`  skip ${email} (already in "${target}")`); continue; }
      if (!confirm) { console.log(`  would copy ${email}`); continue; }
      await dest.insertOne({ ...doc, email, failedLogins: 0, lockedUntil: null });
      copied++; console.log(`  copied ${email}`);
    }
    console.log(confirm ? `\nDone. Copied ${copied}, skipped ${skipped}. Sign in at /superadmin/ (if you were rate limited, wait 10 minutes).`
      : '\nDry run only. Re-run with CONFIRM=yes to copy.');
    if (confirm && copied) console.log('Note: encrypted MFA secrets are only readable with the same SUPERADMIN_SESSION_SECRET. If MFA was enabled and that secret changed, run scripts/reset-superadmin-mfa.js.');
  } finally {
    await client.close();
  }
}

main().catch((error) => { console.error(`fix-superadmin-db failed: ${error.message}`); process.exitCode = 1; });