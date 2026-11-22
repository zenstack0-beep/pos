'use strict';

const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { MongoClient } = require('mongodb');
const auth = require('../api/_sa_auth');

async function main() {
  const uri = String(process.env.MONGODB_URI || '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  const databaseName = String(process.env.MONGODB_DB || 'the_smart_pos').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  const email = String(process.env.SA_EMAIL || process.env.SUPERADMIN_EMAIL || '').trim().toLowerCase();
  if (!/^mongodb(?:\+srv)?:\/\//i.test(uri) || /\[SENSITIVE\]/i.test(uri)) {
    throw new Error('MONGODB_URI is missing or redacted. Use vercel env run for Production secrets; env pull may write [SENSITIVE] placeholders.');
  }
  if (!databaseName || /\[SENSITIVE\]/i.test(databaseName)) {
    throw new Error('MONGODB_DB is missing or redacted. Use the real Production database name.');
  }
  if (!email.includes('@') || email === '[sensitive]') {
    throw new Error('Set MONGODB_URI and SA_EMAIL (or SUPERADMIN_EMAIL) for the account to recover.');
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(`Disable MFA for ${email} so it can be enrolled again? Type RESET-MFA: `);
    if (answer !== 'RESET-MFA') throw new Error('Confirmation did not match.');
  } finally {
    rl.close();
  }

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
    const database = client.db(databaseName);
    const admins = database.collection('superadmins');
    const admin = await admins.findOne({ email, active: true }, { projection: { id: 1 } });
    if (!admin) throw new Error('Active super admin was not found.');

    const updated = await admins.updateOne({ id: admin.id, active: true }, {
      $set: {
        mfaEnabled: false,
        totp: null,
        pendingTotp: null,
        recoveryHashes: [],
        failedLogins: 0,
        lockedUntil: null,
        updatedAt: new Date()
      }
    });
    if (!updated.matchedCount) throw new Error('Active super admin was not found.');

    await database.collection('superadmin_sessions').deleteMany({ adminId: admin.id });
    await auth.rateClear(database, `account:${email}`);
    stdout.write('MFA was reset; sign in and enroll a new authenticator.\n');
  } finally {
    await client.close();
  }
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
