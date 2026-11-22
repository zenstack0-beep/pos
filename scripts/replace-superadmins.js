'use strict';

const crypto = require('node:crypto');
const readline = require('node:readline');
const readlinePromises = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { MongoClient } = require('mongodb');
const { hash } = require('../api/_password');
const auth = require('../api/_sa_auth');
const { audit } = require('../api/_sa_audit');

const TARGET_EMAIL = 'admin@gmail.com';

function safeError(message) {
  const error = new Error(message);
  error.safeMessage = message;
  return error;
}

function readSecret(prompt) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return Promise.reject(safeError('Run this command in an interactive terminal so the password can be entered without echo.'));
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
      if (key.ctrl && key.name === 'c') return finish(safeError('Cancelled.'));
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

async function confirm(target) {
  const rl = readlinePromises.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(`Replace every superadmin in ${target} with ${TARGET_EMAIL}? Type REPLACE-ALL-SUPERADMINS: `);
    if (answer !== 'REPLACE-ALL-SUPERADMINS') throw safeError('Confirmation did not match. No database changes were made.');
  } finally {
    rl.close();
  }
}

async function readDatabaseName() {
  const rl = readlinePromises.createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question('Production MongoDB database name: ')).trim();
  } finally {
    rl.close();
  }
}

async function main() {
  if (process.env.VERCEL_ENV) {
    throw safeError('Run this script directly with node, not through vercel env run. Vercel Secrets cannot be pulled into a local recovery process.');
  }
  const configuredUri = String(process.env.MONGODB_URI || '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  const uri = configuredUri || await readSecret('Production MongoDB URI (input is hidden): ');
  const configuredDatabase = String(process.env.MONGODB_DB || '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  const databaseName = configuredDatabase || await readDatabaseName();

  if (!/^mongodb(?:\+srv)?:\/\//i.test(uri) || /\[SENSITIVE\]/i.test(uri)) {
    throw safeError('Enter the actual Production Atlas connection string. Do not use a redacted placeholder or a local .env value.');
  }
  if (!databaseName || /\[SENSITIVE\]/i.test(databaseName) || /_local$/i.test(databaseName)) {
    throw safeError('Provide the exact Production database name. Local database names ending in _local are rejected.');
  }
  let host;
  try {
    host = new URL(uri).hostname;
  } catch {
    throw safeError('MONGODB_URI is not a valid MongoDB connection string.');
  }
  if (!host || /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/i.test(host)) {
    throw safeError('A local MongoDB host is not allowed for this Production recovery.');
  }

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
    const database = client.db(databaseName);
    const names = new Set((await database.listCollections({}, { nameOnly: true }).toArray()).map(item => item.name));
    if (!names.has('tenants') && !names.has('superadmins')) {
      throw safeError('This database has neither a tenants nor a superadmins collection. It does not look like the live POS database; no changes were made.');
    }

    const admins = database.collection('superadmins');
    await admins.createIndex({ email: 1 }, { unique: true });
    const existingCount = await admins.countDocuments({});
    stdout.write(`Connected to ${host}/${databaseName}. Existing superadmin records: ${existingCount}.\n`);

    const password = await readSecret('New password (at least 14 characters): ');
    const confirmation = await readSecret('Confirm new password: ');
    if (password.length < 14) throw safeError('Password must be at least 14 characters. No database changes were made.');
    if (password !== confirmation) throw safeError('Passwords did not match. No database changes were made.');
    await confirm(`${host}/${databaseName}`);

    const now = new Date();
    const admin = {
      id: crypto.randomUUID(),
      email: TARGET_EMAIL,
      role: 'root',
      active: true,
      passwordHash: await hash(password),
      totp: null,
      pendingTotp: null,
      mfaEnabled: false,
      recoveryHashes: [],
      failedLogins: 0,
      lockedUntil: null,
      createdAt: now,
      updatedAt: now
    };
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        if (names.has('superadmin_sessions')) {
          await database.collection('superadmin_sessions').deleteMany({}, { session });
        }
        await admins.deleteMany({}, { session });
        await admins.insertOne(admin, { session });
        if (names.has('audit_logs')) {
          await audit(database, admin, { headers: {} }, 'admin.replace_all', 'superadmin', admin.id, null,
            'All superadmin accounts replaced during owner-requested recovery', { session });
        }
      }, { writeConcern: { w: 'majority' } });
    } finally {
      await session.endSession();
    }

    await auth.rateClear(database, `account:${TARGET_EMAIL}`);
    const finalCount = await admins.countDocuments({});
    const saved = await admins.findOne({ email: TARGET_EMAIL, active: true }, { projection: { _id: 0, email: 1, role: 1, mfaEnabled: 1 } });
    if (finalCount !== 1 || !saved || saved.role !== 'root' || saved.mfaEnabled !== false) {
      throw safeError('The database update completed but the final account check did not match. Verify the superadmins collection before retrying.');
    }

    stdout.write(`Replaced all superadmin accounts. ${TARGET_EMAIL} is now the sole active root account.\n`);
    stdout.write('Sign in with the new password and complete authenticator enrollment.\n');
  } finally {
    await client.close();
  }
}

main().catch(error => {
  const message = error.safeMessage || `Database operation failed (${error.name || 'Error'}${error.code ? `, code ${error.code}` : ''}). Verify the database state before retrying.`;
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
