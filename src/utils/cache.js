const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'cache.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`
    CREATE TABLE IF NOT EXISTS cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER NOT NULL
    )
`);

const getStmt = db.prepare('SELECT value, expires_at FROM cache WHERE key = ?');
const setStmt = db.prepare('INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)');
const deleteStmt = db.prepare('DELETE FROM cache WHERE key = ?');
const sweepStmt = db.prepare('DELETE FROM cache WHERE expires_at < ?');

class SqliteCache {
    constructor(sweepIntervalMs = 30 * 60 * 1000) {
        setInterval(() => sweepStmt.run(Date.now()), sweepIntervalMs).unref();
    }

    get(key) {
        const row = getStmt.get(key);
        if (!row) return undefined;
        if (Date.now() > row.expires_at) {
            deleteStmt.run(key);
            return undefined;
        }
        return JSON.parse(row.value);
    }

    set(key, value, ttlMs) {
        setStmt.run(key, JSON.stringify(value), Date.now() + ttlMs);
    }

    delete(key) {
        deleteStmt.run(key);
    }

    // Retorna { value, hit } — hit indica se veio do cache ou foi recém-calculado.
    async getOrSet(key, ttlMs, fn) {
        const cached = this.get(key);
        if (cached !== undefined) {
            return { value: cached, hit: true };
        }
        const value = await fn();
        this.set(key, value, ttlMs);
        return { value, hit: false };
    }
}

module.exports = new SqliteCache();
