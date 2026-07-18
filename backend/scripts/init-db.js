import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { getDb, closePool } from '../src/config/database.js';
import { ensureSchema } from '../src/config/schema.js';
import { seedDefaults } from '../src/config/seed.js';

dotenv.config();

async function seedAdmin(db) {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !password) {
    return;
  }

  const existing = await db('users').where({ username }).first();
  if (existing) {
    console.log(`Admin user "${username}" already exists, skipping`);
    return;
  }

  const hashed = await bcrypt.hash(password, 12);
  await db('users').insert({ username, password: hashed, role: 'admin' });
  console.log(`Created admin user "${username}"`);
}

async function main() {
  const db = getDb();
  try {
    await ensureSchema(db);
    await seedDefaults(db);
    await seedAdmin(db);
    console.log('Database initialization complete');
  } catch (error) {
    console.error('Database initialization failed:', error);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

main();
