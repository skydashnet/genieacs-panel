import { executeQuery } from '../config/database.js';

class User {
  static async findByUsername(username) {
    const query = 'SELECT * FROM users WHERE username = ?';
    const rows = await executeQuery(query, [username]);
    return rows.length > 0 ? rows[0] : null;
  }

  static async findById(id) {
    const query = 'SELECT id, username, role, password, created_at, updated_at FROM users WHERE id = ?';
    const rows = await executeQuery(query, [id]);
    return rows.length > 0 ? rows[0] : null;
  }

  static async create(userData) {
    const { username, password, role = 'user' } = userData;
    const query = 'INSERT INTO users (username, password, role) VALUES (?, ?, ?)';
    const result = await executeQuery(query, [username, password, role]);
    return result.insertId;
  }

  static async updatePassword(id, hashedPassword) {
    const query = 'UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?';
    await executeQuery(query, [hashedPassword, id]);
  }

  static async updateUsername(id, newUsername) {
    const query = 'UPDATE users SET username = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?';
    await executeQuery(query, [newUsername, id]);
  }
}

export default User;