import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Temp store: token → imagePath (auto-expires after 5 min)
const pendingImages = new Map();
function storePendingImage(imagePath) {
    const token = `img-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingImages.set(token, imagePath);
    setTimeout(() => {
        const p = pendingImages.get(token);
        if (p) { try { fs.unlinkSync(p); } catch (_) { } }
        pendingImages.delete(token);
    }, 5 * 60 * 1000);
    return token;
}

export function startDashboard(store, messageHandler, port = 18790, wa = null) {
    const app = express();

    app.use(cors());
    app.use(express.json({ strict: false }));
    app.use(express.static(path.join(__dirname, 'public')));

    // API Routes
    app.get('/api/stats', (req, res) => {
        try {
            const totalCost = store.getTotalCost();
            const activeSessions = store.getAllActiveSessions();

            // Get all sessions to count total
            const allSessions = store.db.prepare('SELECT COUNT(*) as count FROM sessions').get().count;
            const allMessages = store.db.prepare('SELECT COUNT(*) as count FROM messages').get().count;

            res.json({
                totalCost,
                activeCount: activeSessions.length,
                totalSessions: allSessions,
                totalMessages: allMessages
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/api/sessions', (req, res) => {
        try {
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 20;
            const offset = (page - 1) * limit;

            const sessions = store.db.prepare(
                'SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ? OFFSET ?'
            ).all(limit, offset);

            const total = store.db.prepare('SELECT COUNT(*) as count FROM sessions').get().count;

            res.json({
                sessions,
                total,
                page,
                totalPages: Math.ceil(total / limit)
            });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/api/sessions/:id/messages', (req, res) => {
        try {
            const messages = store.getMessages(req.params.id, 100);
            res.json(messages);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/api/sessions/active', (req, res) => {
        try {
            const active = store.getAllActiveSessions();
            res.json(active);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // --- Web Chat Endpoints ---

    // Start a brand new session from the dashboard
    app.post('/api/sessions/start', async (req, res) => {
        try {
            const { phone, text } = req.body;
            if (!phone || !text) return res.status(400).json({ error: 'phone and text are required' });

            // Ensure we are explicitly instructing a start so the Orchestrator doesn't assume we want to resume
            const matchStart = String(text).match(/^(start fresh|new task|ignore previous)/i);
            const startInstruction = matchStart
                ? String(text)
                : `[start fresh] ${String(text)}`;

            // Resolve any attached images (array of tokens)
            const tokens = Array.isArray(req.body.imageTokens) ? req.body.imageTokens : (req.body.imageToken ? [req.body.imageToken] : []);
            const imagePaths = tokens.map(t => { const p = pendingImages.get(t); pendingImages.delete(t); return p; }).filter(Boolean);
            const imagePath = imagePaths[0] || null; // Claude gets the first; TODO: multi-image

            console.log(`[Dashboard] Dispatching START_SESSION for ${phone} with task: ${startInstruction}`);
            const result = await messageHandler({
                phone: String(phone),
                text: startInstruction,
                pushName: 'Web Dashboard',
                imagePath
            });

            console.log(`[Dashboard] messageHandler completed with result:`, result);
            res.json({ success: true, message: 'Start command dispatched', sessionId: result?.sessionId });
        } catch (error) {
            console.error(`[Dashboard] Error in /start:`, error);
            res.status(500).json({ error: error.message });
        }
    });

    // Send a message to an existing session from the dashboard
    app.post('/api/sessions/:id/message', async (req, res) => {
        try {
            const { phone, text } = req.body;
            const sessionId = req.params.id;
            if (!phone || !text) return res.status(400).json({ error: 'phone and text are required' });

            // Check if session exists
            const session = store.getSession(sessionId);
            if (!session) return res.status(404).json({ error: 'Session not found' });

            // Resolve any attached images (array of tokens)
            const tokens = Array.isArray(req.body.imageTokens) ? req.body.imageTokens : (req.body.imageToken ? [req.body.imageToken] : []);
            const imagePaths = tokens.map(t => { const p = pendingImages.get(t); pendingImages.delete(t); return p; }).filter(Boolean);
            const imagePath = imagePaths[0] || null;

            const resumeInstruction = `[resume ${sessionId}] ${text}`;

            await messageHandler({
                phone: String(phone),
                text: resumeInstruction,
                pushName: 'Web Dashboard',
                imagePath
            });

            res.json({ success: true, message: 'Message dispatched' });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // --- File Upload (any file type: images, Excel, Word, PDF, etc.) ---

    const uploadHandler = express.raw({ type: '*/*', limit: '50mb' });

    app.post('/api/upload-file', uploadHandler, (req, res) => {
        try {
            const mimeType = req.headers['x-mime-type'] || 'application/octet-stream';
            let origName = 'file';
            try {
                if (req.headers['x-file-name']) {
                    origName = decodeURIComponent(req.headers['x-file-name']);
                }
            } catch (e) {
                // Ignore invalid encoding
            }
            const safeName = origName.replace(/[^a-zA-Z0-9.\u0080-\uFFFF_-]/g, '_');
            const ext = path.extname(safeName) || '.' + (mimeType.split('/')[1]?.split(';')[0] || 'bin');
            const filePath = `/tmp/dash-file-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
            fs.writeFileSync(filePath, req.body);
            const token = storePendingImage(filePath);
            res.json({ success: true, token });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // Backward compat alias
    app.post('/api/upload-image', uploadHandler, (req, res) => res.redirect(307, '/api/upload-file'));

    // --- Phone Management Endpoints ---

    // List all allowed phone numbers
    app.get('/api/phones', (req, res) => {
        try {
            res.json(store.getAllowedPhones());
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // Add a phone number
    app.post('/api/phones', (req, res) => {
        try {
            const { phone, label } = req.body;
            if (!phone) return res.status(400).json({ error: 'phone is required' });
            store.addAllowedPhone(String(phone).trim(), label || '');
            res.json({ success: true, phone: String(phone).trim() });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // Remove a phone number
    app.delete('/api/phones/:phone', (req, res) => {
        try {
            store.removeAllowedPhone(req.params.phone);
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // Ping a phone number to verify it's reachable on WhatsApp
    app.post('/api/phones/:phone/ping', async (req, res) => {
        try {
            const phone = req.params.phone;
            if (!wa) return res.status(503).json({ error: 'WhatsApp bridge not available' });
            await wa.sendMessage(phone, `👋 Hi! You've been added as an authorized user on the WhatsApp AI Engineer. You can now send coding tasks directly to this number.`);
            res.json({ success: true, message: `Ping sent to ${phone}` });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // --- Workspace File Browser / Downloader ---

    app.get('/api/workspace/files', (req, res) => {
        try {
            const targetDir = req.query.dir ? path.resolve(config.DEFAULT_WORKING_DIR, req.query.dir) : config.DEFAULT_WORKING_DIR;
            // Prevent traversal outside the working directory explicitly
            if (!targetDir.startsWith(path.resolve(config.DEFAULT_WORKING_DIR))) {
                return res.status(403).json({ error: 'Access denied' });
            }
            if (!fs.existsSync(targetDir)) return res.json([]);

            const items = fs.readdirSync(targetDir, { withFileTypes: true });
            const list = items.map(item => {
                let size = 0;
                let lastModified = 0;
                try {
                    const stats = fs.statSync(path.join(targetDir, item.name));
                    size = stats.size;
                    lastModified = stats.mtimeMs;
                } catch (e) { }
                return {
                    name: item.name,
                    isDirectory: item.isDirectory(),
                    size,
                    lastModified,
                    path: path.relative(config.DEFAULT_WORKING_DIR, path.join(targetDir, item.name)).replace(/\\/g, '/')
                };
            }).sort((a, b) => b.isDirectory - a.isDirectory || a.name.localeCompare(b.name));

            res.json(list);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/api/workspace/download', (req, res) => {
        try {
            const file = req.query.path;
            if (!file) return res.status(400).send('Missing file path');
            const targetPath = path.resolve(config.DEFAULT_WORKING_DIR, file);
            if (!targetPath.startsWith(path.resolve(config.DEFAULT_WORKING_DIR))) return res.status(403).send('Access denied');
            if (!fs.existsSync(targetPath)) return res.status(404).send('File not found');
            res.download(targetPath);
        } catch (error) {
            res.status(500).send(error.message);
        }
    });

    app.listen(port, () => {
        console.log(`[Dashboard] 🌐 Web Dashboard is running on port ${port}`);
    });
}
