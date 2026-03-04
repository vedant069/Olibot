// ============================================================
// whatsapp.js — Baileys WhatsApp Multi-Device connection
// ============================================================

import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    downloadMediaMessage,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { EventEmitter } from 'events';
import config from './config.js';
import fs from 'fs';
import path from 'path';

class WhatsAppBridge extends EventEmitter {
    constructor(store = null) {
        super();
        this.sock = null;
        this.logger = pino({ level: 'error' });
        // Map LID → phone for reply routing
        this.lidToPhone = new Map();
        this.phoneToJid = new Map();  // phone → full JID for replies
        this.botNumber = null;        // bot's phone number
        this.botLid = null;           // bot's LID (multi-device identifier)
        this.store = store;           // SessionStore for DB-backed allowlist
        // Dedup: track processed message IDs to avoid double-processing
        // (Baileys can fire messages.upsert twice for the same message on delivery ACK)
        this._processedMsgIds = new Set();
    }

    _isAllowed(phone) {
        if (this.store) return this.store.isPhoneAllowed(phone);
        // Fallback to static config if no store is attached
        return config.ALLOWED_PHONES.length === 0 || config.ALLOWED_PHONES.includes(phone);
    }

    async connect() {
        // Fetch the latest WhatsApp version to avoid 405 protocol errors
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`[WhatsApp] Using WA version: ${version.join('.')} (latest: ${isLatest})`);

        const { state, saveCreds } = await useMultiFileAuthState(config.AUTH_DIR);

        this.sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, this.logger),
            },
            printQRInTerminal: false,
            logger: this.logger,
            browser: ['WhatsApp Engineer', 'Chrome', '22.0'],
        });

        // ── Connection events ─────────────────────────────────
        this.sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('\n📱 Scan this QR code with WhatsApp:\n');
                qrcode.generate(qr, { small: true });
                console.log('\nOpen WhatsApp → Settings → Linked Devices → Link a Device\n');
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = reason !== DisconnectReason.loggedOut;
                console.log(`[WhatsApp] Connection closed. Reason: ${reason}. Reconnecting: ${shouldReconnect}`);
                if (shouldReconnect) {
                    setTimeout(() => this.connect(), 3000);
                } else {
                    console.log('[WhatsApp] Logged out. Delete auth_info/ and restart.');
                }
            }

            if (connection === 'open') {
                console.log('[WhatsApp] ✅ Connected successfully!');
                const me = state.creds?.me;
                if (me) {
                    // Phone-based JID: "918999489048:15@s.whatsapp.net" → "918999489048"
                    this.botNumber = (me.id || '').split(':')[0].split('@')[0];
                    // LID: Baileys stores it as me.lid in newer versions
                    if (me.lid) {
                        this.botLid = (me.lid || '').split(':')[0].split('@')[0];
                    }
                    console.log(`[WhatsApp] Bot number: ${this.botNumber}, LID: ${this.botLid || 'unknown'}`);
                }
                this.emit('ready');
            }
        });

        this.sock.ev.on('creds.update', saveCreds);

        // ── Message handling ──────────────────────────────────
        this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const msg of messages) {
                if (msg.key.remoteJid === 'status@broadcast') continue;
                if (msg.key.fromMe) continue;

                // ── Dedup: skip if this exact message was already processed ──
                const msgId = msg.key.id;
                if (this._processedMsgIds.has(msgId)) {
                    console.log(`[WhatsApp] Skipping duplicate message: ${msgId}`);
                    continue;
                }
                this._processedMsgIds.add(msgId);
                // Auto-expire after 5 min to prevent memory growth
                setTimeout(() => this._processedMsgIds.delete(msgId), 5 * 60 * 1000);
                const jid = msg.key.remoteJid;        // Full JID
                const isGroup = jid.endsWith('@g.us');

                // ── GROUP MESSAGE: only respond when @mentioned ──────────
                if (isGroup) {
                    // Always log group JID so user can find it and add to ALLOWED_GROUPS
                    console.log(`[WhatsApp] Group message | JID: ${jid} | participant: ${msg.key.participant || 'none'}`);

                    // Group allowlist check (if configured)
                    if (config.ALLOWED_GROUPS.length > 0 && !config.ALLOWED_GROUPS.includes(jid)) {
                        console.log(`[WhatsApp] Group ${jid} not in ALLOWED_GROUPS — ignoring`);
                        continue;
                    }

                    const mentionedJids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                    const rawText = msg.message?.extendedTextMessage?.text
                        || msg.message?.conversation || '';

                    console.log(`[WhatsApp] Group raw text: "${rawText.slice(0, 100)}" | mentions: ${JSON.stringify(mentionedJids)}`);

                    // Check if bot is mentioned:
                    // Primary A: mentionedJid contains the bot's phone number
                    // Primary B: mentionedJid contains the bot's LID (multi-device)
                    // Fallback:  raw text contains @<alias> matching BOT_ALIASES
                    const botMentionedByJid = mentionedJids.some(m => {
                        const num = m.split(':')[0].split('@')[0];
                        return (this.botNumber && num === this.botNumber) ||
                            (this.botLid && num === this.botLid);
                    });

                    // Build regex from BOT_ALIASES: matches @Koach, @PLBot, @8999489048 etc.
                    const aliasPattern = new RegExp(
                        '@(' + config.BOT_ALIASES.map(a => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b',
                        'i'
                    );
                    const mentionedByAlias = aliasPattern.test(rawText);

                    // Auto-discover bot's LID: if alias matched but JID didn't,
                    // the mentionedJid LID is likely ours — store it for future checks.
                    if (!this.botLid && mentionedByAlias && mentionedJids.length > 0) {
                        const lidJid = mentionedJids.find(m => m.endsWith('@lid'));
                        if (lidJid) {
                            this.botLid = lidJid.split(':')[0].split('@')[0];
                            console.log(`[WhatsApp] Auto-discovered bot LID: ${this.botLid}`);
                        }
                    }

                    if (!botMentionedByJid && !mentionedByAlias) {
                        console.log(`[WhatsApp] Group message skipped — not addressed to bot`);
                        continue;
                    }

                    // Get sender's phone from participant JID
                    const participantJid = msg.key.participant || '';
                    const senderPhone = participantJid.split('@')[0].split(':')[0];

                    // Sender allowlist: if group is in ALLOWED_GROUPS, trust all members
                    // (LIDs make per-sender phone matching unreliable in groups).
                    const groupIsAllowed = config.ALLOWED_GROUPS.includes(jid);
                    if (!groupIsAllowed && !this._isAllowed(senderPhone)) {
                        console.log(`[WhatsApp] Group msg blocked (sender not in allowlist): ${senderPhone}`);
                        continue;
                    }

                    // Strip the @alias mention from text so Claude gets the clean task.
                    // WA puts the saved contact name in the text (@Koach, @PLBot, etc.),
                    // not the phone number. Strip all known alias patterns + any LID-based
                    // @mentions matched by JID.
                    let text = rawText.replace(aliasPattern, '').trim();
                    // Also strip any remaining @mention tokens if bot was matched by JID
                    if (botMentionedByJid) {
                        text = text.replace(/@\S+/g, '').trim();
                    }

                    if (!text) continue;

                    // Store group JID for replies under sender's phone key
                    // We reply to the GROUP, not the individual sender
                    this.phoneToJid.set(senderPhone, jid);

                    console.log(`[WhatsApp] Group mention from ${senderPhone} in ${jid}: ${text.slice(0, 100)}`);
                    this.emit('message', { phone: senderPhone, text, raw: msg, pushName: msg.pushName, groupJid: jid });
                    continue;
                }

                // ── DIRECT MESSAGE ───────────────────────────────────────
                const idPart = jid.split('@')[0];
                const jidType = jid.split('@')[1];

                console.log(`[WhatsApp] Raw JID: ${jid} | participant: ${msg.key.participant || 'none'}`);

                let phone;
                if (jidType === 's.whatsapp.net') {
                    phone = idPart;
                } else if (jidType === 'lid') {
                    phone = this.lidToPhone.get(idPart);
                    if (!phone) {
                        console.log(`[WhatsApp] New LID: ${idPart} | pushName: ${msg.pushName || 'unknown'}`);
                        phone = idPart;
                    }
                } else {
                    phone = idPart;
                }

                this.phoneToJid.set(phone, jid);

                // Allowlist check (DB-backed, falls back to config)
                {
                    const resolvedPhone = (jidType === 's.whatsapp.net') ? phone : (this.lidToPhone.get(idPart) || phone);
                    const isAllowed = this._isAllowed(resolvedPhone) ||
                        [...this.lidToPhone.entries()].some(([lid, p]) => this._isAllowed(p) && lid === idPart);
                    if (!isAllowed) {
                        if (jidType === 'lid') {
                            console.log(`[WhatsApp] Allowing LID ${idPart} (cannot resolve to phone yet)`);
                        } else {
                            console.log(`[WhatsApp] Blocked: ${phone}`);
                            continue;
                        }
                    }
                }

                // Extract text — from plain DM, extended text, or image caption
                const text = msg.message?.conversation
                    || msg.message?.extendedTextMessage?.text
                    || msg.message?.imageMessage?.caption
                    || '';

                // Handle image/document messages — download and save to /tmp
                let imagePath = null;
                const imgMsg = msg.message?.imageMessage;
                const docMsg = msg.message?.documentMessage;

                if (imgMsg) {
                    try {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        const ext = imgMsg.mimetype?.split('/')?.[1]?.split(';')?.[0] || 'jpg';
                        imagePath = `/tmp/wa-img-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
                        fs.writeFileSync(imagePath, buffer);
                        console.log(`[WhatsApp] Image saved: ${imagePath}`);
                    } catch (err) {
                        console.error(`[WhatsApp] Failed to download image: ${err.message}`);
                    }
                } else if (docMsg) {
                    try {
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        // Use the original filename if available, otherwise derive from mimetype
                        const origName = docMsg.fileName || `document.${docMsg.mimetype?.split('/')?.[1]?.split(';')?.[0] || 'bin'}`;
                        const safeExt = path.extname(origName) || '.bin';
                        imagePath = `/tmp/wa-doc-${Date.now()}-${Math.random().toString(36).slice(2)}${safeExt}`;
                        fs.writeFileSync(imagePath, buffer);
                        console.log(`[WhatsApp] Document saved: ${imagePath} (${origName})`);
                    } catch (err) {
                        console.error(`[WhatsApp] Failed to download document: ${err.message}`);
                    }
                }

                if (!text.trim() && !imagePath) continue;

                console.log(`[WhatsApp] DM from ${phone} (${msg.pushName || 'unknown'}): ${text.slice(0, 100)}${imagePath ? ' [+image]' : ''}`);
                this.emit('message', { phone, text, raw: msg, pushName: msg.pushName, imagePath });
            }
        });
    }

    /**
     * Register a LID → phone mapping (call this after identifying a user).
     */
    mapLidToPhone(lid, phone) {
        this.lidToPhone.set(lid, phone);
        console.log(`[WhatsApp] Mapped LID ${lid} → ${phone}`);
    }

    /**
     * Send a text message using the stored JID or construct from phone.
     */
    async sendMessage(phone, text) {
        if (!this.sock) throw new Error('WhatsApp not connected');

        let jid = phone;
        // If the provided ID is just a phone number (no @), look it up or append default suffix
        if (!jid.includes('@')) {
            jid = this.phoneToJid.get(phone) || `${phone}@s.whatsapp.net`;
        }

        console.log(`[WhatsApp] Sending to: ${jid}`);

        const chunks = this._chunkText(text, config.MAX_MESSAGE_LENGTH);
        for (let i = 0; i < chunks.length; i++) {
            await this.sock.sendMessage(jid, { text: chunks[i] });
            if (i < chunks.length - 1) {
                await new Promise(r => setTimeout(r, 1500));
            }
        }
    }

    _chunkText(text, maxLen) {
        if (text.length <= maxLen) return [text];
        const chunks = [];
        let remaining = text;
        while (remaining.length > 0) {
            if (remaining.length <= maxLen) {
                chunks.push(remaining);
                break;
            }
            let breakAt = remaining.lastIndexOf('\n', maxLen);
            if (breakAt < maxLen / 2) breakAt = maxLen;
            chunks.push(remaining.slice(0, breakAt));
            remaining = remaining.slice(breakAt);
        }
        return chunks;
    }
}

export default WhatsAppBridge;
