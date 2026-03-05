// ============================================================
// config.js — Central configuration for WhatsApp Engineer
// ============================================================

const config = {
    // Path to Claude Code binary
    CLAUDE_BIN: process.env.CLAUDE_BIN || '/home/ubuntu/.local/bin/claude',

    // Gemini API
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
    GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-3-flash-preview',

    // Allowed phone numbers (admin seed — also manageable via dashboard)
    ALLOWED_PHONES: (process.env.ALLOWED_PHONES || '').split(',').filter(Boolean),

    // Allowed WhatsApp group JIDs
    ALLOWED_GROUPS: (process.env.ALLOWED_GROUPS || '').split(',').filter(Boolean),

    // Bot aliases for group @mentions
    BOT_ALIASES: (process.env.BOT_ALIASES || 'Koach,PLBot').split(',').filter(Boolean),

    // Session defaults
    DEFAULT_WORKING_DIR: process.env.DEFAULT_WORKING_DIR || '/home/ubuntu',
    MAX_MESSAGE_LENGTH: 4000,
    CLAUDE_SESSION_TIMEOUT: 30 * 60 * 1000,

    // Knowledge Base
    GITHUB_KB_URL: process.env.GITHUB_KB_URL || '',
    KB_DIR: process.env.KB_DIR || './kb',

    // Paths
    AUTH_DIR: process.env.AUTH_DIR || './auth_info',
    DB_PATH: process.env.DB_PATH || './sessions.db',
    LOG_DIR: process.env.LOG_DIR || './logs',

    // ── Auth (JWT + Email/Nodemailer) ─────────────────────────
    JWT_SECRET: process.env.JWT_SECRET || 'change-me-in-production-please',

    SMTP_HOST: process.env.SMTP_HOST || 'smtp.gmail.com',
    SMTP_PORT: parseInt(process.env.SMTP_PORT || '587'),
    SMTP_SECURE: process.env.SMTP_SECURE === 'true', // true for port 465
    SMTP_USER: process.env.SMTP_USER || '',
    SMTP_PASS: process.env.SMTP_PASS || '',
};

export default config;
