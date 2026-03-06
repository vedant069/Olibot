// ============================================================
// auth.js — Password auth + JWT middleware (Nodemailer)
// ============================================================

import nodemailer from 'nodemailer';
import jwt from 'jsonwebtoken';
import config from './config.js';

// ── Nodemailer transporter ────────────────────────────────────

let _transporter = null;
function getTransporter() {
    if (_transporter) return _transporter;
    _transporter = nodemailer.createTransport({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        secure: config.SMTP_SECURE,
        auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
    });
    return _transporter;
}

const FROM = `"WhatsApp AI Engineer" <${config.SMTP_USER}>`;

// ── Emails ────────────────────────────────────────────────────

/** Welcome email with auto-generated password */
export async function sendWelcomeEmail(email, displayName, password) {
    await getTransporter().sendMail({
        from: FROM, to: email,
        subject: `You've been added to WhatsApp AI Engineer`,
        html: `
        <div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#f9f9fb;border-radius:12px;">
            <h1 style="color:#3249d7;font-size:22px;margin:0 0 6px;">WhatsApp AI Engineer</h1>
            <p style="color:#555;margin:0 0 28px;font-size:14px;">You've been added as a team member.</p>
            <div style="background:#fff;border-radius:10px;padding:24px;border:1px solid #e8eaf6;">
                <p style="color:#555;font-size:14px;margin:0 0 8px;">Hello <strong>${displayName}</strong>,</p>
                <p style="color:#555;font-size:14px;margin:0 0 20px;">Your account has been created. Use the credentials below to sign in:</p>
                <table style="width:100%;border-collapse:collapse;">
                    <tr><td style="padding:6px 0;color:#888;font-size:13px;">Email</td><td style="padding:6px 0;font-weight:600;font-size:13px;">${email}</td></tr>
                    <tr><td style="padding:6px 0;color:#888;font-size:13px;">Password</td><td style="padding:6px 0;font-weight:700;font-size:16px;font-family:monospace;color:#3249d7;letter-spacing:2px;">${password}</td></tr>
                </table>
                <p style="color:#e53935;font-size:12px;margin:16px 0 0;">Please keep this password safe. Contact your admin to reset it.</p>
            </div>
        </div>`,
        text: `Hello ${displayName},\n\nYou have been added to WhatsApp AI Engineer.\n\nEmail: ${email}\nPassword: ${password}\n\nLogin at the dashboard.`,
    });
}

/** Notify admin about an access request */
export async function sendAccessRequestEmail(adminEmail, requesterName, requesterEmail, sessionId, sessionTask) {
    const dashUrl = `${config.BASE_PATH || ''}/`;
    await getTransporter().sendMail({
        from: FROM, to: adminEmail,
        subject: `Access Request: ${requesterName} → Session ${sessionId.substring(0, 8)}`,
        html: `
        <div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#f9f9fb;border-radius:12px;">
            <h1 style="color:#3249d7;font-size:22px;margin:0 0 6px;">Access Request</h1>
            <div style="background:#fff;border-radius:10px;padding:24px;border:1px solid #e8eaf6;margin-top:16px;">
                <p style="color:#555;font-size:14px;margin:0 0 16px;"><strong>${requesterName}</strong> (${requesterEmail}) is requesting access to a session:</p>
                <div style="background:#f0f3ff;border-radius:8px;padding:12px;margin-bottom:16px;">
                    <p style="font-size:12px;color:#888;margin:0 0 4px;">Session ID</p>
                    <p style="font-family:monospace;font-size:13px;color:#3249d7;margin:0;">${sessionId}</p>
                    <p style="font-size:12px;color:#888;margin:8px 0 4px;">Task</p>
                    <p style="font-size:13px;color:#333;margin:0;">${sessionTask || 'No description'}</p>
                </div>
                <p style="color:#555;font-size:13px;">Open the dashboard to approve or reject this request.</p>
            </div>
        </div>`,
        text: `${requesterName} (${requesterEmail}) wants access to session ${sessionId}.\n\nTask: ${sessionTask}\n\nOpen the dashboard to approve or reject.`,
    });
}

// ── Password generator ────────────────────────────────────────

export function generatePassword(length = 12) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ── JWT helpers ───────────────────────────────────────────────

const JWT_SECRET = config.JWT_SECRET;

export function signJwt(payload) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

export function verifyJwt(token) {
    try { return jwt.verify(token, JWT_SECRET); } catch (_) { return null; }
}

// ── Express middleware ────────────────────────────────────────

export function requireAuth(req, res, next) {
    const token = req.cookies?.wa_token || req.headers.authorization?.replace('Bearer ', '');
    if (!token) return _deny(req, res);
    const payload = verifyJwt(token);
    if (!payload) return _deny(req, res);
    req.user = payload;
    next();
}

export function optionalAuth(req, res, next) {
    const token = req.cookies?.wa_token || req.headers.authorization?.replace('Bearer ', '');
    if (token) { const p = verifyJwt(token); if (p) req.user = p; }
    next();
}

export function requireAdmin(req, res, next) {
    if (!req.user?.isAdmin) return res.status(403).json({ error: 'Admin access required' });
    next();
}

function _deny(req, res) {
    if (req.headers.accept?.includes('text/html')) return res.redirect(config.BASE_PATH + '/login.html');
    return res.status(401).json({ error: 'Unauthorized. Please log in.' });
}
