import bcrypt from 'bcryptjs';
import { getDb, closePool } from '../src/config/database.js';

async function main() {
  const username = process.argv[2];
  const password = process.argv[3];

  if (!username || !password) {
    console.error('Usage: npm run reset-password -- <username> <newPassword>');
    process.exitCode = 1;
    return;
  }

  if (password.length < 8) {
    console.error('Password must be at least 8 characters');
    process.exitCode = 1;
    return;
  }

  try {
    const db = getDb();
    const user = await db('users').where({ username }).first('id');
    if (!user) {
      console.error(`User "${username}" not found`);
      process.exitCode = 1;
      return;
    }

    const hashed = await bcrypt.hash(password, 12);
    await db('users').where({ username }).update({
      password: hashed,
      updated_at: new Date()
    });
    console.log(`Password updated for "${username}"`);
  } catch (error) {
    console.error('Password reset failed:', error);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

main();
