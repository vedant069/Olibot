// ============================================================
// session_store.js — SQLite-backed session persistence
// ============================================================

import Database from 'better-sqlite3';
import config from './config.js';

class SessionStore {
    constructor() {
        this.db = new Database(config.DB_PATH);
        this.db.pragma('journal_mode = WAL');
        this._init();
    }

    _init() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                user_phone TEXT NOT NULL,
                claude_session_id TEXT,
                task TEXT,
                status TEXT DEFAULT 'running',
                thread_open INTEGER DEFAULT 1,
                working_dir TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                cost_usd REAL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT REFERENCES sessions(id),
                role TEXT NOT NULL,
                content TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS allowed_phones (
                phone TEXT PRIMARY KEY,
                label TEXT,
                added_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_phone);
            CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
            CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
        `);
        // Safely add thread_open column to existing databases
        try {
            this.db.exec('ALTER TABLE sessions ADD COLUMN thread_open INTEGER DEFAULT 1');
        } catch (_) { /* column already exists */ }
        // Safely add subscribers column to existing databases
        try {
            this.db.exec("ALTER TABLE sessions ADD COLUMN subscribers TEXT DEFAULT '[]'");
        } catch (_) { /* column already exists */ }
    }

    createSession(id, userPhone, task, claudeSessionId, workingDir) {
        const initialSubscribers = JSON.stringify([String(userPhone)]);
        this.db.prepare(
            'INSERT INTO sessions (id, user_phone, task, claude_session_id, working_dir, subscribers) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(id, String(userPhone), task, claudeSessionId, workingDir || config.DEFAULT_WORKING_DIR, initialSubscribers);
        return this.getSession(id);
    }

    getSession(id) {
        const session = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
        if (session && session.subscribers) {
            try { session.subscribers_arr = JSON.parse(session.subscribers); }
            catch (e) { session.subscribers_arr = [session.user_phone]; }
        } else if (session) {
            session.subscribers_arr = [session.user_phone];
        }
        return session;
    }

    getActiveSessions(userPhone) {
        return this.db.prepare(
            `SELECT * FROM sessions 
             WHERE user_phone = ? 
             AND (status = 'running' OR (status = 'stopped' AND updated_at >= datetime('now', '-1 day')))
             ORDER BY updated_at DESC`
        ).all(userPhone);
    }

    getAllActiveSessions() {
        return this.db.prepare(
            `SELECT * FROM sessions 
             WHERE (status = 'running' OR (status = 'stopped' AND updated_at >= datetime('now', '-1 day')))
             ORDER BY updated_at DESC LIMIT 20`
        ).all();
    }

    getRecentSessions(userPhone, limit = 5) {
        return this.db.prepare(
            'SELECT * FROM sessions WHERE user_phone = ? ORDER BY updated_at DESC LIMIT ?'
        ).all(userPhone, limit);
    }

    getGlobalRecentSessions(limit = 10) {
        return this.db.prepare(
            'SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?'
        ).all(limit);
    }

    updateSession(id, updates) {
        const fields = [];
        const values = [];
        for (const [key, val] of Object.entries(updates)) {
            // handle arrays (like subscribers)
            if (key === 'subscribers_arr') {
                fields.push(`subscribers = ?`);
                values.push(JSON.stringify(val));
            } else {
                fields.push(`${key} = ?`);
                values.push(val);
            }
        }
        fields.push('updated_at = CURRENT_TIMESTAMP');
        values.push(id);
        this.db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    }

    addMessage(sessionId, role, content) {
        this.db.prepare(
            'INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)'
        ).run(sessionId, role, content);
    }

    upsertLastAssistantMessage(sessionId, content) {
        const lastMsg = this.db.prepare(
            'SELECT id, role FROM messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1'
        ).get(sessionId);

        if (lastMsg && lastMsg.role === 'assistant') {
            this.db.prepare(
                'UPDATE messages SET content = ?, timestamp = CURRENT_TIMESTAMP WHERE id = ?'
            ).run(content, lastMsg.id);
        } else {
            this.addMessage(sessionId, 'assistant', content);
        }
    }

    getMessages(sessionId, limit = 20) {
        return this.db.prepare(
            'SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?'
        ).all(sessionId, limit).reverse();
    }

    /**
     * Get the current "thread" session for a user — most recent open session
     * with a valid claude_session_id, regardless of running/completed status.
     * Returns null if no open thread exists (user closed it or never started).
     */
    getCurrentThread(userPhone) {
        // Find session where user_phone is the primary OR user is in the JSON array of subscribers
        const phoneParam = String(userPhone);
        const likeParam = `%"${phoneParam}"%`;
        const session = this.db.prepare(
            `SELECT * FROM sessions
             WHERE (user_phone = ? OR subscribers LIKE ?) AND thread_open = 1 AND claude_session_id IS NOT NULL
             ORDER BY updated_at DESC LIMIT 1`
        ).get(phoneParam, likeParam);
        if (session && session.subscribers) {
            try { session.subscribers_arr = JSON.parse(session.subscribers); }
            catch (e) { session.subscribers_arr = [session.user_phone]; }
        } else if (session) {
            session.subscribers_arr = [session.user_phone];
        }
        return session;
    }

    /**
     * Get the total cost aggregated across all sessions
     */
    getTotalCost() {
        const result = this.db.prepare('SELECT SUM(cost_usd) as total FROM sessions').get();
        return result.total || 0;
    }

    /**
     * Close the current thread for a user so their next message starts fresh.
     * Called when user says "done", "close", "new task", etc.
     */
    closeThread(userPhone) {
        const phoneParam = String(userPhone);
        const likeParam = `%"${phoneParam}"%`;
        this.db.prepare(
            `UPDATE sessions SET thread_open = 0, updated_at = CURRENT_TIMESTAMP
             WHERE (user_phone = ? OR subscribers LIKE ?) AND thread_open = 1`
        ).run(phoneParam, likeParam);
    }

    /**
     * Mark all currently running sessions as stopped (useful on server restart)
     */
    /**
     * Mark all currently running sessions as stopped (useful on server restart)
     */
    cleanOrphanedSessions() {
        const result = this.db.prepare(
            `UPDATE sessions SET status = 'stopped' WHERE status = 'running'`
        ).run();
        return result.changes;
    }

    /**
     * Increment the cost for a session by a specific amount.
     */
    incrementCost(id, delta) {
        this.db.prepare(
            'UPDATE sessions SET cost_usd = cost_usd + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).run(delta, id);
    }

    // ── Allowed Phones ────────────────────────────────────────

    getAllowedPhones() {
        return this.db.prepare('SELECT * FROM allowed_phones ORDER BY added_at DESC').all();
    }

    isPhoneAllowed(phone) {
        const row = this.db.prepare('SELECT phone FROM allowed_phones WHERE phone = ?').get(String(phone));
        return !!row;
    }

    addAllowedPhone(phone, label = '') {
        this.db.prepare(
            'INSERT OR REPLACE INTO allowed_phones (phone, label) VALUES (?, ?)'
        ).run(String(phone), label);
    }

    removeAllowedPhone(phone) {
        this.db.prepare('DELETE FROM allowed_phones WHERE phone = ?').run(String(phone));
    }

    /**
     * Seed from config.ALLOWED_PHONES so env-var numbers work on first boot.
     * Does NOT delete existing entries or previous sessions.
     */
    seedAllowedPhones(phones) {
        const insert = this.db.prepare('INSERT OR IGNORE INTO allowed_phones (phone, label) VALUES (?, ?)');
        for (const phone of phones) {
            insert.run(String(phone).trim(), 'seed');
        }
    }
}

export default SessionStore;
