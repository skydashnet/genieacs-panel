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
