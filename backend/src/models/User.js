import { getDb } from '../config/database.js';

class User {
  static async findByUsername(username) {
    return (await getDb()('users').where({ username }).first()) || null;
  }

  static async findById(id) {
    return (
      (await getDb()('users')
        .select('id', 'username', 'role', 'password', 'created_at', 'updated_at')
        .where({ id })
        .first()) || null
    );
  }

  static async count() {
    const row = await getDb()('users').count({ n: '*' }).first();
    return Number(row?.n || 0);
  }

  static async create(userData) {
    const { username, password, role = 'user' } = userData;
    const [id] = await getDb()('users').insert({ username, password, role });
    return id;
  }

  static async createInitialAdmin(userData) {
    const { username, password } = userData;
    const db = getDb();

    return db.transaction(async (trx) => {
      const existing = await trx('users').count({ n: '*' }).first();
      if (Number(existing?.n || 0) > 0) {
        const error = new Error('Setup already completed');
        error.code = 'SETUP_COMPLETED';
        throw error;
      }

      try {
        await trx('app_state').insert({ key: 'setup_completed', value: '1' });
      } catch (error) {
        if (
          error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
          error.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
          error.code === 'ER_DUP_ENTRY'
        ) {
          const setupError = new Error('Setup already completed');
          setupError.code = 'SETUP_COMPLETED';
          throw setupError;
        }
        throw error;
      }

      const [id] = await trx('users').insert({
        username,
        password,
        role: 'admin'
      });
      return id;
    });
  }

  static async updatePassword(id, hashedPassword) {
    await getDb()('users')
      .where({ id })
      .update({ password: hashedPassword, updated_at: new Date() });
  }

  static async updateUsername(id, newUsername) {
    await getDb()('users')
      .where({ id })
      .update({ username: newUsername, updated_at: new Date() });
  }
}

export default User;
