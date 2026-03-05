// ============================================================
// session_store.js — SQLite-backed session persistence
// ============================================================

import Database from 'better-sqlite3';
import config from './config.js';
import crypto from 'crypto';

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
                owner_id TEXT,
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
                user_id TEXT,
                added_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT UNIQUE,
                phone TEXT UNIQUE,
                display_name TEXT,
                is_admin INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS auth_otps (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL,
                otp TEXT NOT NULL,
                expires_at DATETIME NOT NULL,
                used INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS session_collaborators (
                session_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (session_id, user_id)
            );
            CREATE TABLE IF NOT EXISTS access_requests (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                requester_phone TEXT,
                requester_email TEXT,
                otp TEXT,
                status TEXT DEFAULT 'pending',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                expires_at DATETIME NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_phone);
            CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
            CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
            CREATE INDEX IF NOT EXISTS idx_auth_otps_email ON auth_otps(email);
            CREATE INDEX IF NOT EXISTS idx_collaborators_session ON session_collaborators(session_id);
            CREATE INDEX IF NOT EXISTS idx_collaborators_user ON session_collaborators(user_id);
        `);

        // Safe migrations for existing databases
        const safeMigrations = [
            "ALTER TABLE sessions ADD COLUMN thread_open INTEGER DEFAULT 1",
            "ALTER TABLE sessions ADD COLUMN subscribers TEXT DEFAULT '[]'",
            "ALTER TABLE sessions ADD COLUMN owner_id TEXT",
            "ALTER TABLE allowed_phones ADD COLUMN user_id TEXT",
        ];
        for (const sql of safeMigrations) {
            try { this.db.exec(sql); } catch (_) { /* column already exists */ }
        }
        // Add owner_id index AFTER the column migration above
        try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_id)'); } catch (_) { }
    }

    // ── Sessions ───────────────────────────────────────────────

    createSession(id, userPhone, task, claudeSessionId, workingDir, ownerId = null) {
        const initialSubscribers = JSON.stringify([String(userPhone)]);
        this.db.prepare(
            'INSERT INTO sessions (id, user_phone, owner_id, task, claude_session_id, working_dir, subscribers) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(id, String(userPhone), ownerId, task, claudeSessionId, workingDir || config.DEFAULT_WORKING_DIR, initialSubscribers);
        return this.getSession(id);
    }

    _hydrateSession(session) {
        if (!session) return session;
        if (session.subscribers) {
            try { session.subscribers_arr = JSON.parse(session.subscribers); }
            catch (e) { session.subscribers_arr = [session.user_phone]; }
        } else {
            session.subscribers_arr = [session.user_phone];
        }
        return session;
    }

    getSession(id) {
        return this._hydrateSession(this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id));
    }

    getActiveSessions(userPhone) {
        return this.db.prepare(
            `SELECT * FROM sessions
             WHERE user_phone = ?
             AND (status = 'running' OR (status = 'stopped' AND updated_at >= datetime('now', '-1 day')))
             ORDER BY updated_at DESC`
        ).all(userPhone).map(s => this._hydrateSession(s));
    }

    getAllActiveSessions() {
        return this.db.prepare(
            `SELECT * FROM sessions
             WHERE (status = 'running' OR (status = 'stopped' AND updated_at >= datetime('now', '-1 day')))
             ORDER BY updated_at DESC LIMIT 20`
        ).all().map(s => this._hydrateSession(s));
    }

    /** Get all sessions visible to a user (owner + collaborator) */
    getSessionsForUser(userId, limit = 50, offset = 0) {
        return this.db.prepare(
            `SELECT DISTINCT s.*, u.display_name as owner_name, u.email as owner_email
             FROM sessions s
             LEFT JOIN users u ON s.owner_id = u.id
             WHERE s.owner_id = ?
                OR s.id IN (SELECT session_id FROM session_collaborators WHERE user_id = ?)
             ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`
        ).all(userId, userId, limit, offset).map(s => this._hydrateSession(s));
    }

    /** Get sessions for a phone (existing WhatsApp flow) */
    getRecentSessions(userPhone, limit = 5) {
        return this.db.prepare(
            'SELECT * FROM sessions WHERE user_phone = ? ORDER BY updated_at DESC LIMIT ?'
        ).all(userPhone, limit).map(s => this._hydrateSession(s));
    }

    getGlobalRecentSessions(limit = 10) {
        return this.db.prepare(
            `SELECT s.*, u.display_name as owner_name, u.email as owner_email
             FROM sessions s LEFT JOIN users u ON s.owner_id = u.id
             ORDER BY s.updated_at DESC LIMIT ?`
        ).all(limit).map(s => this._hydrateSession(s));
    }

    updateSession(id, updates) {
        const fields = [];
        const values = [];
        for (const [key, val] of Object.entries(updates)) {
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

    getCurrentThread(userPhone) {
        const phoneParam = String(userPhone);
        const likeParam = `%"${phoneParam}"%`;
        return this._hydrateSession(this.db.prepare(
            `SELECT * FROM sessions
             WHERE (user_phone = ? OR subscribers LIKE ?) AND thread_open = 1 AND claude_session_id IS NOT NULL
             ORDER BY updated_at DESC LIMIT 1`
        ).get(phoneParam, likeParam));
    }

    getTotalCost() {
        const result = this.db.prepare('SELECT SUM(cost_usd) as total FROM sessions').get();
        return result.total || 0;
    }

    closeThread(userPhone) {
        const phoneParam = String(userPhone);
        const likeParam = `%"${phoneParam}"%`;
        this.db.prepare(
            `UPDATE sessions SET thread_open = 0, updated_at = CURRENT_TIMESTAMP
             WHERE (user_phone = ? OR subscribers LIKE ?) AND thread_open = 1`
        ).run(phoneParam, likeParam);
    }

    cleanOrphanedSessions() {
        return this.db.prepare(
            `UPDATE sessions SET status = 'stopped' WHERE status = 'running'`
        ).run().changes;
    }

    incrementCost(id, delta) {
        this.db.prepare(
            'UPDATE sessions SET cost_usd = cost_usd + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
        ).run(delta, id);
    }

    // ── Messages ───────────────────────────────────────────────

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

    // ── Allowed Phones ────────────────────────────────────────

    getAllowedPhones() {
        return this.db.prepare(
            `SELECT ap.*, u.email as user_email, u.display_name as user_name
             FROM allowed_phones ap LEFT JOIN users u ON ap.user_id = u.id
             ORDER BY ap.added_at DESC`
        ).all();
    }

    isPhoneAllowed(phone) {
        return !!this.db.prepare('SELECT phone FROM allowed_phones WHERE phone = ?').get(String(phone));
    }

    addAllowedPhone(phone, label = '', userId = null) {
        this.db.prepare(
            'INSERT OR REPLACE INTO allowed_phones (phone, label, user_id) VALUES (?, ?, ?)'
        ).run(String(phone), label, userId);
    }

    removeAllowedPhone(phone) {
        this.db.prepare('DELETE FROM allowed_phones WHERE phone = ?').run(String(phone));
    }

    seedAllowedPhones(phones) {
        const insert = this.db.prepare('INSERT OR IGNORE INTO allowed_phones (phone, label) VALUES (?, ?)');
        for (const phone of phones) insert.run(String(phone).trim(), 'seed');
    }

    // ── Users ─────────────────────────────────────────────────

    createUser({ email, phone, displayName, isAdmin = 0 }) {
        const id = crypto.randomUUID();
        this.db.prepare(
            'INSERT INTO users (id, email, phone, display_name, is_admin) VALUES (?, ?, ?, ?, ?)'
        ).run(id, email || null, phone || null, displayName || email || phone || 'User', isAdmin ? 1 : 0);
        return this.getUserById(id);
    }

    getUserById(id) {
        return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    }

    getUserByEmail(email) {
        return this.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    }

    getUserByPhone(phone) {
        return this.db.prepare('SELECT * FROM users WHERE phone = ?').get(String(phone));
    }

    upsertUserByEmail(email, displayName = null) {
        let user = this.getUserByEmail(email);
        if (!user) user = this.createUser({ email, displayName: displayName || email.split('@')[0] });
        return user;
    }

    linkPhoneToUser(userId, phone) {
        this.db.prepare('UPDATE users SET phone = NULL WHERE phone = ? AND id != ?').run(String(phone), userId);
        this.db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(String(phone), userId);
        this.db.prepare('UPDATE allowed_phones SET user_id = ? WHERE phone = ?').run(userId, String(phone));
    }

    getAllUsers() {
        return this.db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
    }

    // ── Email OTP Auth ────────────────────────────────────────

    createOtp(email) {
        const otp = String(Math.floor(100000 + Math.random() * 900000));
        const id = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        this.db.prepare('UPDATE auth_otps SET used = 1 WHERE email = ? AND used = 0').run(email);
        this.db.prepare(
            'INSERT INTO auth_otps (id, email, otp, expires_at) VALUES (?, ?, ?, ?)'
        ).run(id, email, otp, expiresAt);
        return otp;
    }

    verifyOtp(email, otp) {
        const record = this.db.prepare(
            `SELECT * FROM auth_otps
             WHERE email = ? AND otp = ? AND used = 0 AND expires_at > datetime('now')
             ORDER BY created_at DESC LIMIT 1`
        ).get(email, otp);
        if (!record) return false;
        this.db.prepare('UPDATE auth_otps SET used = 1 WHERE id = ?').run(record.id);
        return true;
    }

    // ── Session Collaborators ─────────────────────────────────

    addCollaborator(sessionId, userId) {
        this.db.prepare(
            'INSERT OR IGNORE INTO session_collaborators (session_id, user_id) VALUES (?, ?)'
        ).run(sessionId, userId);
    }

    removeCollaborator(sessionId, userId) {
        this.db.prepare(
            'DELETE FROM session_collaborators WHERE session_id = ? AND user_id = ?'
        ).run(sessionId, userId);
    }

    isCollaborator(sessionId, userId) {
        return !!this.db.prepare(
            'SELECT 1 FROM session_collaborators WHERE session_id = ? AND user_id = ?'
        ).get(sessionId, userId);
    }

    getCollaborators(sessionId) {
        return this.db.prepare(
            `SELECT u.id, u.email, u.phone, u.display_name, sc.granted_at
             FROM session_collaborators sc JOIN users u ON sc.user_id = u.id
             WHERE sc.session_id = ?`
        ).all(sessionId);
    }

    // ── Access Requests (WhatsApp OTP) ────────────────────────

    createAccessRequest(sessionId, requesterPhone) {
        const id = crypto.randomUUID();
        const otp = String(Math.floor(100000 + Math.random() * 900000));
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
        this.db.prepare(
            `INSERT INTO access_requests (id, session_id, requester_phone, otp, expires_at) VALUES (?, ?, ?, ?, ?)`
        ).run(id, sessionId, requesterPhone, otp, expiresAt);
        return { id, otp };
    }

    claimAccessWithOtp(sessionId, phone, otp) {
        const req = this.db.prepare(
            `SELECT * FROM access_requests
             WHERE session_id = ? AND requester_phone = ? AND otp = ? AND status = 'pending' AND expires_at > datetime('now')`
        ).get(sessionId, phone, otp);
        if (!req) return false;
        this.db.prepare(`UPDATE access_requests SET status = 'claimed' WHERE id = ?`).run(req.id);
        return true;
    }

    getPendingAccessRequests(sessionId) {
        return this.db.prepare(
            `SELECT * FROM access_requests WHERE session_id = ? AND status = 'pending' AND expires_at > datetime('now')`
        ).all(sessionId);
    }
}

export default SessionStore;
