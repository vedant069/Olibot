// ============================================================
// auth.js — Email OTP auth + JWT middleware (Nodemailer)
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
        auth: {
            user: config.SMTP_USER,
            pass: config.SMTP_PASS,
        },
    });
    return _transporter;
}

// ── Send OTP email ────────────────────────────────────────────

export async function sendOtpEmail(email, otp) {
    const transporter = getTransporter();
    const fromName = 'WhatsApp AI Engineer';
    const from = `"${fromName}" <${config.SMTP_USER}>`;

    await transporter.sendMail({
        from,
        to: email,
        subject: `Your login code: ${otp}`,
        html: `
        <div style="font-family: Inter, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; background: #f9f9fb; border-radius: 12px;">
            <div style="text-align: center; margin-bottom: 28px;">
                <h1 style="color: #3249d7; font-size: 24px; margin: 0;">WhatsApp AI Engineer</h1>
                <p style="color: #666; margin-top: 6px; font-size: 14px;">Your secure login code</p>
            </div>
            <div style="background: white; border-radius: 10px; padding: 32px 24px; text-align: center; border: 1px solid #e8eaf6;">
                <p style="color: #555; font-size: 15px; margin: 0 0 16px 0;">Your one-time login code is:</p>
                <div style="font-size: 42px; font-weight: 800; letter-spacing: 10px; color: #3249d7; background: #f0f3ff; padding: 16px 24px; border-radius: 8px; display: inline-block; font-family: monospace;">
                    ${otp}
                </div>
                <p style="color: #888; font-size: 13px; margin: 20px 0 0 0;">This code expires in <strong>15 minutes</strong>. Do not share it with anyone.</p>
            </div>
            <p style="color: #aaa; font-size: 11px; text-align: center; margin-top: 24px;">If you didn't request this, you can safely ignore this email.</p>
        </div>`,
        text: `Your WhatsApp AI Engineer login code is: ${otp}\n\nThis code expires in 15 minutes.`,
    });
}

// ── JWT helpers ───────────────────────────────────────────────

const JWT_SECRET = config.JWT_SECRET;
const JWT_MAX_AGE = '30d';

export function signJwt(payload) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_MAX_AGE });
}

export function verifyJwt(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (_) {
        return null;
    }
}

// ── Express middleware ────────────────────────────────────────

/**
 * requireAuth — Attaches req.user from JWT cookie or Authorization header.
 * Returns 401 to JSON consumers, redirect to /login.html for browser requests.
 */
export function requireAuth(req, res, next) {
    const token = req.cookies?.wa_token || req.headers.authorization?.replace('Bearer ', '');
    if (!token) return _deny(req, res);
    const payload = verifyJwt(token);
    if (!payload) return _deny(req, res);
    req.user = payload;
    next();
}

/**
 * optionalAuth — Attaches req.user if token is valid, never rejects.
 */
export function optionalAuth(req, res, next) {
    const token = req.cookies?.wa_token || req.headers.authorization?.replace('Bearer ', '');
    if (token) {
        const payload = verifyJwt(token);
        if (payload) req.user = payload;
    }
    next();
}

function _deny(req, res) {
    const acceptsHtml = req.headers.accept?.includes('text/html');
    if (acceptsHtml) return res.redirect('/login.html');
    return res.status(401).json({ error: 'Unauthorized. Please log in.' });
}
