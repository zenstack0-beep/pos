'use strict';

const readline = require('node:readline');
const readlinePromises = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { MongoClient } = require('mongodb');
const { hash } = require('../api/_password');
const auth = require('../api/_sa_auth');

function readSecret(prompt) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return Promise.reject(new Error('Run this command in an interactive terminal so the password can be entered without echo.'));
  }

  return new Promise((resolve, reject) => {
    readline.emitKeypressEvents(stdin);
    const wasRaw = !!stdin.isRaw;
    const chars = [];
    let finished = false;

    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      stdin.removeListener('keypress', onKeypress);
      stdin.setRawMode(wasRaw);
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };

    const onKeypress = (char, key = {}) => {
      if (key.ctrl && key.name === 'c') return finish(new Error('Cancelled.'));
      if (key.name === 'return' || key.name === 'enter') return finish(null, chars.join(''));
      if (key.name === 'backspace') {
        chars.pop();
        return;
      }
      if (char && !key.ctrl && !key.meta) chars.push(char);
    };

    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.on('keypress', onKeypress);
    stdin.resume();
  });
}

async function confirmReset(email, role) {
  const rl = readlinePromises.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(`Reset password and MFA for active ${role} account ${email}? Type RESET-SUPERADMIN: `);
    if (answer !== 'RESET-SUPERADMIN') throw new Error('Confirmation did not match.');
  } finally {
    rl.close();
  }
}

async function main() {
  const uri = String(process.env.MONGODB_URI || '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  const databaseName = String(process.env.MONGODB_DB || 'the_smart_pos').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  const email = String(process.env.SA_EMAIL || process.env.SUPERADMIN_EMAIL || '').trim().toLowerCase();
  const sessionSecret = String(process.env.SUPERADMIN_SESSION_SECRET || '');

  if (!/^mongodb(?:\+srv)?:\/\//i.test(uri) || /\[SENSITIVE\]/i.test(uri)) {
    throw new Error('MONGODB_URI is missing or redacted. Use vercel env run for Production secrets; env pull may write [SENSITIVE] placeholders.');
  }
  if (!databaseName || /\[SENSITIVE\]/i.test(databaseName)) {
    throw new Error('MONGODB_DB is missing or redacted. Use the real Production database name.');
  }
  if (!email.includes('@') || email.length > 254 || email === '[sensitive]') {
    throw new Error('Set a valid SA_EMAIL (or SUPERADMIN_EMAIL) for the account to recover.');
  }
  if (Buffer.byteLength(sessionSecret) < 48 || /\[SENSITIVE\]/i.test(sessionSecret)) {
    throw new Error('SUPERADMIN_SESSION_SECRET is missing or invalid. Set a Production value of at least 48 characters before recovery.');
  }

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
    const database = client.db(databaseName);
    const admins = database.collection('superadmins');
    const admin = await admins.findOne({ email, active: true }, { projection: { id: 1, email: 1, role: 1 } });
    if (!admin) throw new Error('Active super admin was not found in this database. Check the email and Production database.');

    await confirmReset(admin.email, admin.role);
    const password = await readSecret('New password (at least 14 characters): ');
    const confirmation = await readSecret('Confirm new password: ');
    if (password.length < 14) throw new Error('Password must be at least 14 characters.');
    if (password !== confirmation) throw new Error('Passwords did not match. No changes were made.');

    const updated = await admins.updateOne({ id: admin.id, active: true }, {
      $set: {
        passwordHash: await hash(password),
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
    stdout.write('Password and MFA were reset. Sign in with the new password and enroll an authenticator.\n');
  } finally {
    await client.close();
  }
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
