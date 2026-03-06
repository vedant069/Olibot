import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import config from './config.js';
import SessionStore from './session_store.js';
import {
    signJwt, requireAuth, optionalAuth, requireAdmin,
    sendWelcomeEmail, sendAccessRequestEmail, generatePassword
} from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Temp store for uploaded files
const pendingImages = new Map();
function storePendingImage(filePath) {
    const token = `img-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingImages.set(token, filePath);
    setTimeout(() => { try { fs.unlinkSync(pendingImages.get(token)); } catch (_) { } pendingImages.delete(token); }, 5 * 60 * 1000);
    return token;
}
export { pendingImages };

export function startDashboard(store, messageHandler, port = 18790, wa = null) {
    const app = express();
    app.use(cors({ origin: true, credentials: true }));
    app.use(express.json({ strict: false }));
    app.use(cookieParser());
    app.use(express.static(path.join(__dirname, 'public')));

    // ── Auth ──────────────────────────────────────────────────

    app.post('/api/auth/login', (req, res) => {
        try {
            const { email, password } = req.body;
            if (!email || !password) return res.status(400).json({ error: 'email and password required' });
            const user = store.verifyPassword(email, password);
            if (!user) return res.status(401).json({ error: 'Invalid email or password' });
            const token = signJwt({ id: user.id, email: user.email, displayName: user.display_name, isAdmin: !!user.is_admin, role: user.role });
            res.cookie('wa_token', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000, secure: process.env.NODE_ENV === 'production' });
            res.json({ success: true, user: { id: user.id, email: user.email, displayName: user.display_name, isAdmin: !!user.is_admin, role: user.role } });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/auth/logout', (req, res) => {
        res.clearCookie('wa_token');
        res.json({ success: true });
    });

    app.get('/api/me', requireAuth, (req, res) => {
        const user = store.getUserById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ id: user.id, email: user.email, phone: user.phone, displayName: user.display_name, isAdmin: !!user.is_admin, role: user.role });
    });

    // ── Stats ─────────────────────────────────────────────────

    app.get('/api/stats', optionalAuth, (req, res) => {
        try {
            const totalCost = store.getTotalCost();
            const activeSessions = store.getAllActiveSessions();
            const allSessions = store.countAllSessions();
            const allMessages = store.db.prepare('SELECT COUNT(*) as count FROM messages').get().count;
            const pendingRequests = req.user?.isAdmin ? store.countPendingRequests() : 0;
            res.json({ totalCost, activeCount: activeSessions.length, totalSessions: allSessions, totalMessages: allMessages, pendingRequests });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Sessions ──────────────────────────────────────────────

    app.get('/api/sessions', requireAuth, (req, res) => {
        try {
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 20;
            const offset = (page - 1) * limit;
            const sessions = store.getSessionsForUser(req.user.id, limit, offset);
            const total = store.countAllSessions();
            res.json({ sessions, total, page, totalPages: Math.ceil(total / limit) });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/sessions/active', optionalAuth, (req, res) => {
        try { res.json(store.getAllActiveSessions()); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/sessions/:id/messages', requireAuth, (req, res) => {
        try { res.json(store.getMessages(req.params.id, 100)); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Request / Grant Access ────────────────────────────────

    /** Any logged-in user can request access to a session */
    app.post('/api/sessions/:id/request-access', requireAuth, async (req, res) => {
        try {
            const session = store.getSession(req.params.id);
            if (!session) return res.status(404).json({ error: 'Session not found' });
            const requester = store.getUserById(req.user.id);
            const { note } = req.body;

            const requestId = store.createAccessRequest(
                req.params.id, requester.id,
                requester.display_name, requester.email, note || ''
            );

            // Email all admins
            const admins = store.getAdmins();
            for (const admin of admins) {
                if (admin.email) {
                    await sendAccessRequestEmail(
                        admin.email, requester.display_name, requester.email,
                        req.params.id, session.task
                    ).catch(e => console.warn('[Auth] Email send failed:', e.message));
                }
            }
            res.json({ success: true, requestId });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    /** Admin approves or rejects a request */
    app.post('/api/admin/access-requests/:id/resolve', requireAuth, requireAdmin, (req, res) => {
        try {
            const { approve } = req.body;
            store.resolveAccessRequest(req.params.id, req.user.id, !!approve);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    /** Get all pending requests (admin notification feed) */
    app.get('/api/admin/access-requests', requireAuth, requireAdmin, (req, res) => {
        try { res.json(store.getPendingAccessRequests()); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    /** Grant access directly */
    app.post('/api/sessions/:id/grant-access', requireAuth, requireAdmin, (req, res) => {
        try {
            const { userId } = req.body;
            if (!userId) return res.status(400).json({ error: 'userId required' });
            store.addCollaborator(req.params.id, userId);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/sessions/:id/collaborators', requireAuth, (req, res) => {
        try { res.json(store.getCollaborators(req.params.id)); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Admin: User Management ────────────────────────────────

    app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
        try { res.json(store.getAllUsers()); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
        try {
            const { email, displayName, role, isAdmin } = req.body;
            if (!email) return res.status(400).json({ error: 'email is required' });

            // Check if user already exists
            const existing = store.getUserByEmail(email);
            if (existing) return res.status(409).json({ error: 'A user with this email already exists' });

            const password = generatePassword();
            const passwordHash = SessionStore.hashPassword(password);
            const user = store.createUser({
                email: email.toLowerCase().trim(),
                displayName: displayName || email.split('@')[0],
                role: role || 'developer',
                isAdmin: isAdmin ? 1 : 0,
                passwordHash,
                createdBy: req.user.id,
            });

            // Send welcome email with password
            if (config.SMTP_USER) {
                await sendWelcomeEmail(user.email, user.display_name, password)
                    .catch(e => console.warn('[Auth] Welcome email failed:', e.message));
            }

            res.json({ success: true, user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role } });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.delete('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
        try {
            if (req.params.id === req.user.id) return res.status(400).json({ error: "Can't delete yourself" });
            store.deleteUser(req.params.id);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/admin/users/:id/reset-password', requireAuth, requireAdmin, async (req, res) => {
        try {
            const user = store.getUserById(req.params.id);
            if (!user) return res.status(404).json({ error: 'User not found' });
            const password = generatePassword();
            store.updateUserPassword(user.id, SessionStore.hashPassword(password));
            if (config.SMTP_USER && user.email) {
                await sendWelcomeEmail(user.email, user.display_name, password)
                    .catch(e => console.warn('[Auth] Reset email failed:', e.message));
            }
            res.json({ success: true, message: 'Password reset and emailed to user' });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Users (self) ──────────────────────────────────────────

    app.get('/api/users', requireAuth, (req, res) => {
        // Non-admins get a minimal list for sharing purposes
        try {
            const users = store.getAllUsers().map(u => ({ id: u.id, displayName: u.display_name, email: u.email, role: u.role }));
            res.json(users);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/users/link-phone', requireAuth, (req, res) => {
        try {
            const { phone } = req.body;
            if (!phone) return res.status(400).json({ error: 'phone required' });
            store.linkPhoneToUser(req.user.id, phone);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Web Chat ──────────────────────────────────────────────

    app.post('/api/sessions/start', requireAuth, async (req, res) => {
        try {
            const { phone, text } = req.body;
            if (!phone || !text) return res.status(400).json({ error: 'phone and text are required' });
            const startInstruction = /^(start fresh|new task|ignore previous)/i.test(text) ? text : `[start fresh] ${text}`;
            const tokens = Array.isArray(req.body.imageTokens) ? req.body.imageTokens : (req.body.imageToken ? [req.body.imageToken] : []);
            const imagePath = tokens.map(t => { const p = pendingImages.get(t); pendingImages.delete(t); return p; }).filter(Boolean)[0] || null;
            const result = await messageHandler({ phone: String(phone), text: startInstruction, pushName: req.user.displayName || 'Dashboard', imagePath, ownerId: req.user.id });
            res.json({ success: true, sessionId: result?.sessionId });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/sessions/:id/message', requireAuth, async (req, res) => {
        try {
            const { phone, text } = req.body;
            const sessionId = req.params.id;
            if (!phone || !text) return res.status(400).json({ error: 'phone and text are required' });
            const session = store.getSession(sessionId);
            if (!session) return res.status(404).json({ error: 'Session not found' });
            // Check access: owner or collaborator
            const isOwner = session.owner_id === req.user.id;
            const isCollab = store.isCollaborator(sessionId, req.user.id);
            if (!isOwner && !isCollab && !req.user.isAdmin) return res.status(403).json({ error: 'You do not have access to this session. Request access first.' });
            const tokens = Array.isArray(req.body.imageTokens) ? req.body.imageTokens : (req.body.imageToken ? [req.body.imageToken] : []);
            const imagePath = tokens.map(t => { const p = pendingImages.get(t); pendingImages.delete(t); return p; }).filter(Boolean)[0] || null;
            await messageHandler({ phone: String(phone), text: `[resume ${sessionId}] ${text}`, pushName: req.user.displayName || 'Dashboard', imagePath });
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── File Upload ───────────────────────────────────────────

    const uploadHandler = express.raw({ type: '*/*', limit: '50mb' });
    app.post('/api/upload-file', uploadHandler, (req, res) => {
        try {
            const mimeType = req.headers['x-mime-type'] || 'application/octet-stream';
            let origName = 'file';
            try { if (req.headers['x-file-name']) origName = decodeURIComponent(req.headers['x-file-name']); } catch (_) { }
            const safeName = origName.replace(/[^a-zA-Z0-9.\u0080-\uFFFF_-]/g, '_');
            const ext = path.extname(safeName) || '.' + (mimeType.split('/')[1]?.split(';')[0] || 'bin');
            const filePath = `/tmp/dash-file-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
            fs.writeFileSync(filePath, req.body);
            res.json({ success: true, token: storePendingImage(filePath) });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });
    app.post('/api/upload-image', uploadHandler, (req, res) => res.redirect(307, '/api/upload-file'));

    // ── Phone Management ──────────────────────────────────────

    app.get('/api/phones', requireAuth, (req, res) => {
        try { res.json(store.getAllowedPhones()); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });
    app.post('/api/phones', requireAuth, requireAdmin, (req, res) => {
        try {
            const { phone, label, userId } = req.body;
            if (!phone) return res.status(400).json({ error: 'phone is required' });
            store.addAllowedPhone(String(phone).trim(), label || '', userId || null);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });
    app.delete('/api/phones/:phone', requireAuth, requireAdmin, (req, res) => {
        try { store.removeAllowedPhone(req.params.phone); res.json({ success: true }); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });
    app.post('/api/phones/:phone/ping', requireAuth, requireAdmin, async (req, res) => {
        try {
            if (!wa) return res.status(503).json({ error: 'WhatsApp not connected' });
            await wa.sendMessage(req.params.phone, `👋 You've been added to WhatsApp AI Engineer.`);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Workspace File Browser ────────────────────────────────

    app.get('/api/workspace/files', requireAuth, (req, res) => {
        try {
            const baseDir = path.resolve(config.DEFAULT_WORKING_DIR);
            const targetDir = req.query.dir ? path.resolve(baseDir, req.query.dir) : baseDir;
            if (!targetDir.startsWith(baseDir)) return res.status(403).json({ error: 'Access denied' });
            if (!fs.existsSync(targetDir)) return res.json([]);
            const items = fs.readdirSync(targetDir, { withFileTypes: true });
            const list = items.map(item => {
                let size = 0, lastModified = 0;
                try { const s = fs.statSync(path.join(targetDir, item.name)); size = s.size; lastModified = s.mtimeMs; } catch (_) { }
                return { name: item.name, isDirectory: item.isDirectory(), size, lastModified, path: path.relative(baseDir, path.join(targetDir, item.name)).replace(/\\/g, '/') };
            }).sort((a, b) => b.isDirectory - a.isDirectory || a.name.localeCompare(b.name));
            res.json(list);
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.get('/api/workspace/download', requireAuth, (req, res) => {
        try {
            const baseDir = path.resolve(config.DEFAULT_WORKING_DIR);
            const file = req.query.path;
            if (!file) return res.status(400).send('Missing file path');
            const targetPath = path.resolve(baseDir, file);
            if (!targetPath.startsWith(baseDir)) return res.status(403).send('Access denied');
            if (!fs.existsSync(targetPath)) return res.status(404).send('File not found');
            res.download(targetPath);
        } catch (err) { res.status(500).send(err.message); }
    });

    app.listen(port, () => console.log(`[Dashboard] 🌐 Web Dashboard running on port ${port}`));
}
