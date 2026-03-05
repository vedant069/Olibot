import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import config from './config.js';
import { sendOtpEmail, signJwt, requireAuth, optionalAuth } from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Temp store: token → filePath (auto-expires after 5 min)
const pendingImages = new Map();
function storePendingImage(filePath) {
    const token = `img-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingImages.set(token, filePath);
    setTimeout(() => {
        const p = pendingImages.get(token);
        if (p) { try { fs.unlinkSync(p); } catch (_) { } }
        pendingImages.delete(token);
    }, 5 * 60 * 1000);
    return token;
}

export { pendingImages };

export function startDashboard(store, messageHandler, port = 18790, wa = null) {
    const app = express();

    app.use(cors({ origin: true, credentials: true }));
    app.use(express.json({ strict: false }));
    app.use(cookieParser());

    // Serve login page without auth
    app.use('/login.html', express.static(path.join(__dirname, 'public', 'login.html')));
    // Serve all other static files (index.html protected via client-side JWT check)
    app.use(express.static(path.join(__dirname, 'public')));

    // ── Auth Endpoints ────────────────────────────────────────

    /** Step 1: Request OTP — sends email */
    app.post('/api/auth/email/request', async (req, res) => {
        try {
            const { email } = req.body;
            if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
            const otp = store.createOtp(email.toLowerCase().trim());
            await sendOtpEmail(email.toLowerCase().trim(), otp);
            res.json({ success: true, message: 'OTP sent to ' + email });
        } catch (err) {
            console.error('[Auth] OTP send error:', err);
            res.status(500).json({ error: 'Failed to send OTP email. Check SMTP settings.' });
        }
    });

    /** Step 2: Verify OTP — issues JWT cookie */
    app.post('/api/auth/email/verify', (req, res) => {
        try {
            const { email, otp } = req.body;
            if (!email || !otp) return res.status(400).json({ error: 'email and otp required' });
            const normalEmail = email.toLowerCase().trim();
            const valid = store.verifyOtp(normalEmail, String(otp).trim());
            if (!valid) return res.status(401).json({ error: 'Invalid or expired OTP' });

            // Find or create user
            const user = store.upsertUserByEmail(normalEmail);
            const token = signJwt({ id: user.id, email: user.email, displayName: user.display_name, isAdmin: user.is_admin });

            res.cookie('wa_token', token, {
                httpOnly: true,
                sameSite: 'lax',
                maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
                secure: process.env.NODE_ENV === 'production',
            });
            res.json({ success: true, user: { id: user.id, email: user.email, displayName: user.display_name, isAdmin: user.is_admin } });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /** Logout */
    app.post('/api/auth/logout', (req, res) => {
        res.clearCookie('wa_token');
        res.json({ success: true });
    });

    /** Get current user from JWT */
    app.get('/api/me', requireAuth, (req, res) => {
        const user = store.getUserById(req.user.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ id: user.id, email: user.email, phone: user.phone, displayName: user.display_name, isAdmin: user.is_admin });
    });

    // ── Stats ─────────────────────────────────────────────────

    app.get('/api/stats', optionalAuth, (req, res) => {
        try {
            const totalCost = store.getTotalCost();
            const activeSessions = store.getAllActiveSessions();
            const allSessions = store.db.prepare('SELECT COUNT(*) as count FROM sessions').get().count;
            const allMessages = store.db.prepare('SELECT COUNT(*) as count FROM messages').get().count;
            res.json({ totalCost, activeCount: activeSessions.length, totalSessions: allSessions, totalMessages: allMessages });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // ── Sessions ──────────────────────────────────────────────

    app.get('/api/sessions', optionalAuth, (req, res) => {
        try {
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 20;
            const offset = (page - 1) * limit;

            let sessions, total;

            if (req.user) {
                // Authenticated: show only own + collaborative sessions
                sessions = store.getSessionsForUser(req.user.id, limit, offset);
                total = sessions.length; // approximate for now
            } else {
                // Unauthenticated fallback: show all (legacy mode for internal use)
                sessions = store.db.prepare(
                    `SELECT s.*, u.display_name as owner_name, u.email as owner_email
                     FROM sessions s LEFT JOIN users u ON s.owner_id = u.id
                     ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`
                ).all(limit, offset);
                total = store.db.prepare('SELECT COUNT(*) as count FROM sessions').get().count;
            }

            res.json({ sessions, total, page, totalPages: Math.ceil(total / limit) });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/api/sessions/active', optionalAuth, (req, res) => {
        try {
            res.json(store.getAllActiveSessions());
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/api/sessions/:id/messages', optionalAuth, (req, res) => {
        try {
            res.json(store.getMessages(req.params.id, 100));
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // ── Session Collaborators ─────────────────────────────────

    app.get('/api/sessions/:id/collaborators', requireAuth, (req, res) => {
        try {
            res.json(store.getCollaborators(req.params.id));
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/sessions/:id/grant-access', requireAuth, (req, res) => {
        try {
            const session = store.getSession(req.params.id);
            if (!session) return res.status(404).json({ error: 'Session not found' });
            if (session.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the session owner can grant access' });

            const { userId } = req.body;
            if (!userId) return res.status(400).json({ error: 'userId required' });
            store.addCollaborator(req.params.id, userId);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.delete('/api/sessions/:id/collaborators/:uid', requireAuth, (req, res) => {
        try {
            const session = store.getSession(req.params.id);
            if (!session) return res.status(404).json({ error: 'Session not found' });
            if (session.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the session owner can revoke access' });
            store.removeCollaborator(req.params.id, req.params.uid);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /** Request access to a session (creates WhatsApp OTP and notifies owner) */
    app.post('/api/sessions/:id/request-access', requireAuth, async (req, res) => {
        try {
            const session = store.getSession(req.params.id);
            if (!session) return res.status(404).json({ error: 'Session not found' });

            const requester = store.getUserById(req.user.id);
            const owner = session.owner_id ? store.getUserById(session.owner_id) : null;
            const ownerPhone = owner?.phone || session.user_phone;

            const { id, otp } = store.createAccessRequest(req.params.id, requester.phone);

            // Notify owner via WhatsApp if available
            if (wa && ownerPhone) {
                const requesterLabel = requester.email || requester.phone || 'Someone';
                await wa.sendMessage(ownerPhone,
                    `🔐 *Access Request* for session *${req.params.id}*\n\n` +
                    `*${requesterLabel}* wants access to this session.\n\n` +
                    `If you want to grant access, share this OTP with them:\n` +
                    `*${otp}*\n\n` +
                    `_(Expires in 10 minutes)_`
                );
            }

            res.json({ success: true, message: 'Access request sent to session owner via WhatsApp', requestId: id });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /** Claim access using an OTP received from the session owner */
    app.post('/api/sessions/:id/claim-access', requireAuth, (req, res) => {
        try {
            const { otp } = req.body;
            const requester = store.getUserById(req.user.id);
            const claimed = store.claimAccessWithOtp(req.params.id, requester.phone || '', otp);
            if (!claimed) return res.status(401).json({ error: 'Invalid or expired OTP' });
            store.addCollaborator(req.params.id, req.user.id);
            res.json({ success: true, message: 'Access granted!' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── Users ─────────────────────────────────────────────────

    /** Link email account ↔ phone number */
    app.post('/api/users/link-phone', requireAuth, (req, res) => {
        try {
            const { phone } = req.body;
            if (!phone) return res.status(400).json({ error: 'phone required' });
            store.linkPhoneToUser(req.user.id, phone);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/users', requireAuth, (req, res) => {
        try {
            const user = store.getUserById(req.user.id);
            if (!user?.is_admin) return res.status(403).json({ error: 'Admin only' });
            res.json(store.getAllUsers());
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── Web Chat Endpoints ────────────────────────────────────

    app.post('/api/sessions/start', optionalAuth, async (req, res) => {
        try {
            const { phone, text } = req.body;
            if (!phone || !text) return res.status(400).json({ error: 'phone and text are required' });
            const matchStart = String(text).match(/^(start fresh|new task|ignore previous)/i);
            const startInstruction = matchStart ? String(text) : `[start fresh] ${String(text)}`;

            const tokens = Array.isArray(req.body.imageTokens) ? req.body.imageTokens : (req.body.imageToken ? [req.body.imageToken] : []);
            const imagePaths = tokens.map(t => { const p = pendingImages.get(t); pendingImages.delete(t); return p; }).filter(Boolean);
            const imagePath = imagePaths[0] || null;

            const ownerId = req.user?.id || null;
            console.log(`[Dashboard] START_SESSION for ${phone}, owner: ${ownerId}`);
            const result = await messageHandler({
                phone: String(phone),
                text: startInstruction,
                pushName: 'Web Dashboard',
                imagePath,
                ownerId,
            });

            res.json({ success: true, message: 'Start command dispatched', sessionId: result?.sessionId });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.post('/api/sessions/:id/message', optionalAuth, async (req, res) => {
        try {
            const { phone, text } = req.body;
            const sessionId = req.params.id;
            if (!phone || !text) return res.status(400).json({ error: 'phone and text are required' });
            const session = store.getSession(sessionId);
            if (!session) return res.status(404).json({ error: 'Session not found' });
            const tokens = Array.isArray(req.body.imageTokens) ? req.body.imageTokens : (req.body.imageToken ? [req.body.imageToken] : []);
            const imagePaths = tokens.map(t => { const p = pendingImages.get(t); pendingImages.delete(t); return p; }).filter(Boolean);
            const imagePath = imagePaths[0] || null;
            await messageHandler({ phone: String(phone), text: `[resume ${sessionId}] ${text}`, pushName: 'Web Dashboard', imagePath });
            res.json({ success: true, message: 'Message dispatched' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
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
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    app.post('/api/upload-image', uploadHandler, (req, res) => res.redirect(307, '/api/upload-file'));

    // ── Phone Management ──────────────────────────────────────

    app.get('/api/phones', (req, res) => {
        try { res.json(store.getAllowedPhones()); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/phones', (req, res) => {
        try {
            const { phone, label, userId } = req.body;
            if (!phone) return res.status(400).json({ error: 'phone is required' });
            store.addAllowedPhone(String(phone).trim(), label || '', userId || null);
            res.json({ success: true, phone: String(phone).trim() });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.delete('/api/phones/:phone', (req, res) => {
        try { store.removeAllowedPhone(req.params.phone); res.json({ success: true }); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    app.post('/api/phones/:phone/ping', async (req, res) => {
        try {
            if (!wa) return res.status(503).json({ error: 'WhatsApp bridge not available' });
            await wa.sendMessage(req.params.phone, `👋 Hi! You've been added as an authorized user on the WhatsApp AI Engineer.`);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Workspace File Browser ────────────────────────────────

    app.get('/api/workspace/files', (req, res) => {
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

    app.get('/api/workspace/download', (req, res) => {
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

    app.listen(port, () => {
        console.log(`[Dashboard] 🌐 Web Dashboard running on port ${port}`);
    });
}
