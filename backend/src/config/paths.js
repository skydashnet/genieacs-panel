import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
export const DB_CONFIG_PATH = path.join(DATA_DIR, 'db-config.json');
export const SQLITE_PATH = path.join(DATA_DIR, 'panel.sqlite');

export function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}
