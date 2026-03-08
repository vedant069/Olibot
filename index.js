// ============================================================
// index.js — OliBot Entry Point
// ============================================================
//
// Ties together:
//   WhatsApp (Baileys) ↔ Gemini Orchestrator ↔ Claude Code CLI
// ============================================================

import './polyfill.js';
import WhatsAppBridge from './whatsapp.js';
import Orchestrator from './orchestrator.js';
import ClaudeManager from './claude_manager.js';
import SessionStore from './session_store.js';
import config from './config.js';
import { startDashboard } from './dashboard.js';

// ── Initialize components ─────────────────────────────────────

const store = new SessionStore();
const orphans = store.cleanOrphanedSessions();
if (orphans > 0) {
    console.log(`[Main] Cleaned up ${orphans} orphaned running sessions on startup.`);
}

// Seed allowed phones from env config into DB (non-destructive; won't delete existing entries)
if (config.ALLOWED_PHONES.length > 0) {
    store.seedAllowedPhones(config.ALLOWED_PHONES);
    console.log(`[Main] Seeded ${config.ALLOWED_PHONES.length} phone(s) from ALLOWED_PHONES env.`);
}

// ── First-boot admin seeding ────────────────────────────────
if (config.ADMIN_EMAIL) {
    const existingAdmins = store.getAdmins();
    if (existingAdmins.length === 0) {
        const { generatePassword, sendWelcomeEmail } = await import('./auth.js');
        const password = generatePassword();
        const passwordHash = SessionStore.hashPassword(password);
        store.createUser({
            email: config.ADMIN_EMAIL.toLowerCase().trim(),
            displayName: config.ADMIN_NAME || 'Admin',
            role: 'admin',
            isAdmin: 1,
            passwordHash,
        });
        console.log(`\n[Auth] ✅ Admin account created!`);
        console.log(`[Auth]    Email   : ${config.ADMIN_EMAIL}`);
        console.log(`[Auth]    Password: ${password}`);
        console.log(`[Auth]    (Change this after first login)\n`);
        // Also email the password if SMTP is configured
        if (config.SMTP_USER) {
            sendWelcomeEmail(config.ADMIN_EMAIL, config.ADMIN_NAME || 'Admin', password)
                .catch(e => console.warn('[Auth] Welcome email failed:', e.message));
        }
    }
}

const wa = config.WHATSAPP_ENABLED !== false ? new WhatsAppBridge(store) : null;
const orchestrator = new Orchestrator();
const claude = new ClaudeManager(store);

// ── Helpers ──────────────────────────────────────────────────

// Track last-sent content per session to prevent duplicate sends.
// Both assistant_message and result can contain the same text.
const lastSentContent = new Map();
const webMutedSessions = new Set();

// Per-phone serialization lock: ensures only ONE message per phone is processed at a time.
// If a second message arrives while the first is processing, it queues behind it.
const phoneProcessingQueues = new Map();

async function serializedMessageHandler(args) {
    const key = args.groupJid || args.phone;
    const queue = phoneProcessingQueues.get(key) || Promise.resolve();
    const next = queue.then(() => handleIncomingMessage(args)).catch(() => { });
    phoneProcessingQueues.set(key, next);
    await next;
    if (phoneProcessingQueues.get(key) === next) phoneProcessingQueues.delete(key);
}

const WA_MAX = 3800; // safe WhatsApp message size

/**
 * Send content directly to the user — NO Gemini summarization.
 * Chunks large outputs into sequential messages to avoid truncation.
 */
async function sendContent(phone, content, prefix = '') {
    if (!content) return;
    const full = prefix ? `${prefix}\n\n${content}` : content;
    if (full.length <= WA_MAX) {
        await wa.sendMessage(phone, full);
        return;
    }
    // Split at paragraph / line boundaries
    const chunks = [];
    let remaining = content;
    while (remaining.length > 0) {
        if (remaining.length <= WA_MAX) { chunks.push(remaining); break; }
        let split = remaining.lastIndexOf('\n\n', WA_MAX);
        if (split === -1) split = remaining.lastIndexOf('\n', WA_MAX);
        if (split < 500) split = WA_MAX;
        chunks.push(remaining.slice(0, split));
        remaining = remaining.slice(split).trimStart();
    }
    for (let i = 0; i < chunks.length; i++) {
        const header = prefix && i === 0 ? `${prefix}\n\n` : '';
        const footer = chunks.length > 1 ? `\n\n_(${i + 1}/${chunks.length})_` : '';
        await wa.sendMessage(phone, `${header}${chunks[i]}${footer}`);
        if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 600));
    }
}

async function broadcastToSubscribers(session, message, prefix = '') {
    const phones = session.subscribers_arr || [session.user_phone];
    for (const phone of phones) {
        if (!phone) continue;
        if (prefix) {
            await sendContent(phone, message, prefix);
        } else {
            await wa.sendMessage(phone, message);
        }
    }
}

// ── Claude Code event handlers ────────────────────────────────

claude.on('result', async ({ sessionId, content, costUsd }) => {
    const session = store.getSession(sessionId);
    if (!session) return;
    console.log(`[Main] Session ${sessionId} done. Cost: $${costUsd || 0}`);

    // Web dashboard and WhatsApp routing
    if (webMutedSessions.has(sessionId)) return;

    if (!content) {
        await broadcastToSubscribers(session, `✅ *Done!*`);
        return;
    }

    // Dedup: if assistant_message already sent this content, only send the ✅ footer
    if (lastSentContent.get(sessionId) === content) {
        await broadcastToSubscribers(session, `✅ *Done!*`);
    } else {
        await broadcastToSubscribers(session, content, '✅ *Result:*');
        lastSentContent.set(sessionId, content);
    }
});

claude.on('assistant_message', async ({ sessionId, content }) => {
    if (!content || content.length < 30) return;

    if (webMutedSessions.has(sessionId)) return;
    const session = store.getSession(sessionId);
    if (!session) return;

    // Dedup: skip if same content was already sent
    if (lastSentContent.get(sessionId) === content) return;
    lastSentContent.set(sessionId, content);

    await broadcastToSubscribers(session, content, '🔄 *Working...*');
});

claude.on('session_end', async ({ sessionId, code, status, costUsd }) => {
    lastSentContent.delete(sessionId);

    const wasMuted = webMutedSessions.has(sessionId);
    if (wasMuted) webMutedSessions.delete(sessionId);

    const session = store.getSession(sessionId);
    if (!session) return;

    if (status === 'failed' && !wasMuted) {
        const costInfo = costUsd ? ` (cost: $${Number(costUsd).toFixed(4)})` : '';
        await broadcastToSubscribers(session,
            `❌ Session *${sessionId}* ended unexpectedly${costInfo}.\nSend a new task to start a fresh session.`
        );
    }
});

claude.on('session_error', async ({ sessionId, error }) => {
    if (webMutedSessions.has(sessionId)) return;
    const session = store.getSession(sessionId);
    if (!session) return;
    await broadcastToSubscribers(session, `⚠️ *Error:* ${error}`);
});

// ── WhatsApp message handler ──────────────────────────────────

export async function handleIncomingMessage({ isWeb: explicitIsWeb, phone, text, pushName, groupJid, imagePath = null, ownerId = null }) {
    try {
        const isWeb = explicitIsWeb || pushName === 'Web Dashboard';
        // Use groupJid as the session owner if in a group, otherwise use personal phone
        const threadKey = groupJid || phone;
        // Reply to the group if we are in one, otherwise reply to the direct message
        const replyTo = groupJid || phone;

        const activeSessions = store.getActiveSessions(threadKey);
        const currentThread = store.getCurrentThread(threadKey);
        const intent = await orchestrator.classify(threadKey, text, activeSessions, currentThread);

        // Update cost for Gemini Orchestrator usage (~$0.002 per message overhead)
        if (currentThread) {
            store.incrementCost(currentThread.id, 0.002);
        } else if (intent.session_ref) {
            // If the user is referring to a session that isn't the current thread
            const session = store.getSession(intent.session_ref);
            if (session) store.incrementCost(session.id, 0.002);
        }

        let logPrefix = groupJid ? `[Group ${groupJid}]` : `[DM ${phone}]`;
        console.log(`${logPrefix} Intent: ${intent.action} | thread: ${currentThread?.id || 'none'}`);

        if (isWeb) {
            text = text.replace(/^\[start fresh\]\s*/i, '').replace(/^\[resume WA-[a-z0-9\-]+\]\s*/i, '').replace(/^\[resume\]\s*/i, '').trim();
            if (intent.task) {
                intent.task = intent.task.replace(/^\[start fresh\]\s*/i, '').replace(/^\[resume WA-[a-z0-9\-]+\]\s*/i, '').replace(/^\[resume\]\s*/i, '').trim();
            }
        }

        switch (intent.action) {

            case 'START_SESSION': {
                // Safety: if the user typed a WA- session ID in their message, they meant resume — not new.
                const idInText = text.match(/WA-[a-z0-9\-]+/i)?.[0];
                if (idInText) {
                    const targetSession = store.getSession(idInText) || (() => {
                        const all = store.getGlobalRecentSessions(50);
                        return all.find(s => s.id.toLowerCase() === idInText.toLowerCase());
                    })();
                    if (targetSession && targetSession.claude_session_id) {
                        if (currentThread && currentThread.id !== targetSession.id) store.closeThread(threadKey);
                        store.updateSession(targetSession.id, { thread_open: 1 });
                        const followUp = text.replace(/WA-[a-z0-9\-]+/gi, '').trim() || 'continue';

                        if (isWeb) {
                            webMutedSessions.add(targetSession.id);
                        } else {
                            webMutedSessions.delete(targetSession.id);
                            await wa.sendMessage(replyTo, `🔄 Resuming *${targetSession.id}*...`);
                        }

                        await claude.resumeSession(targetSession.id, followUp);
                        return { sessionId: targetSession.id };
                    }
                }

                // Close any existing thread before starting fresh
                if (currentThread) store.closeThread(threadKey);
                const task = intent.task || text;
                const { sessionId } = await claude.startSession(threadKey, task, null, imagePath, ownerId);

                if (isWeb) {
                    webMutedSessions.add(sessionId);
                } else {
                    webMutedSessions.delete(sessionId);
                    await wa.sendMessage(replyTo,
                        (intent.reply || '🚀 Starting Claude...') +
                        `\n📋 Session ID: *${sessionId}*`
                    );
                }
                return { sessionId };
            }

            case 'PLAN_SESSION': {
                if (currentThread) store.closeThread(threadKey);
                const task = intent.task || text;
                const { sessionId } = await claude.planSession(threadKey, task);

                if (isWeb) {
                    webMutedSessions.add(sessionId);
                } else {
                    webMutedSessions.delete(sessionId);
                    await wa.sendMessage(replyTo,
                        (intent.reply || '📐 Planning mode — Claude will analyze and write a plan, no changes yet.') +
                        `\n📋 Plan *${sessionId}* started. Say *"go ahead"* to execute.`
                    );
                }
                return { sessionId };
            }

            case 'RESUME_SESSION': {
                // Use explicit session_ref first, then fall back to regex matching in text,
                // then currentThread, then most recent.
                let target = null;
                const ref = intent.session_ref || (text.match(/WA-[a-z0-9\-]+/i)?.[0]);

                if (ref) {
                    // Try exact match first
                    target = store.getSession(ref) || store.getSession(ref.toUpperCase());

                    if (!target) {
                        // Fallback: search only this user's recent sessions (cross-user isolation)
                        const sessions = store.getRecentSessions(threadKey, 50);
                        target = sessions.find(s =>
                            s.id.toLowerCase() === ref.toLowerCase() ||
                            s.task?.toLowerCase().includes(ref.toLowerCase())
                        );
                    }
                }

                if (!target) target = currentThread;
                if (!target) {
                    await wa.sendMessage(replyTo, "No active session to continue. Send a task to start one!");
                    return { error: "No active session" };
                }

                // If we are resuming a session that is NOT the current active thread, 
                // we should close the other open thread first to avoid confusion.
                if (currentThread && currentThread.id !== target.id) {
                    store.closeThread(threadKey);
                }

                if (!target.claude_session_id) {
                    if (!isWeb) await wa.sendMessage(replyTo, `⏳ Session *${target.id}* is still initializing. Try again in a moment.`);
                    return { sessionId: target.id };
                }

                // If Gemini specifically set task to empty, the user is just switching threads silently 
                // without an actual coding command (e.g., "resume WA-123")
                if (intent.task === "") {
                    // Reroute replies to the person who is resuming
                    let subs = target.subscribers_arr || [target.user_phone];
                    if (!subs.includes(threadKey)) subs.push(threadKey);
                    store.updateSession(target.id, { thread_open: 1, user_phone: threadKey, subscribers_arr: subs });

                    if (isWeb) {
                        webMutedSessions.add(target.id);
                    } else {
                        webMutedSessions.delete(target.id);
                        await wa.sendMessage(replyTo, intent.reply || `🔄 Switched active thread to session *${target.id}*. What would you like to do?`);
                    }
                    return { sessionId: target.id };
                }

                if (isWeb) {
                    webMutedSessions.add(target.id);
                } else {
                    webMutedSessions.delete(target.id);
                    await wa.sendMessage(replyTo, intent.reply || `🔄 Continuing session *${target.id}*...`);
                }

                // Reroute replies to the person who is resuming this session, and add them as a subscriber
                let subs = target.subscribers_arr || [target.user_phone];
                if (!subs.includes(threadKey)) subs.push(threadKey);
                store.updateSession(target.id, { user_phone: threadKey, subscribers: JSON.stringify(subs) });

                // Fetch recent messages to generate an automatic recap of progress
                const messages = store.getMessages(target.id, 10);
                const recap = await orchestrator.recap(messages);
                if (recap && !isWeb) {
                    await wa.sendMessage(replyTo, `📝 *Last Progress:* ${recap}`);
                }

                // When resuming, we can optionally credit the individual user who sent the follow-up
                const followUpText = groupJid ? `[From ${pushName || phone}]: ${intent.task || text}` : (intent.task || text);
                await claude.resumeSession(target.id, followUpText, imagePath);
                return { sessionId: target.id };
            }

            case 'CLOSE_SESSION': {
                if (!currentThread) {
                    if (!isWeb) await wa.sendMessage(replyTo, "No open session to close.");
                    break;
                }
                store.closeThread(threadKey);
                if (!isWeb) await wa.sendMessage(replyTo, intent.reply || `✅ Thread closed. Send a new task to start fresh!`);
                break;
            }

            case 'STOP_SESSION': {
                if (activeSessions.length === 0) {
                    if (!isWeb) await wa.sendMessage(replyTo, "No active sessions to stop.");
                    break;
                }
                let toStop = activeSessions[0];
                if (intent.session_ref) {
                    const found = activeSessions.find(s => s.id === intent.session_ref);
                    if (found) toStop = found;
                }
                const costUsd = claude.stopSession(toStop.id);
                if (!isWeb) {
                    const costMsg = costUsd > 0 ? `\n💰 *Total: $${Number(costUsd).toFixed(4)}*` : '';
                    await wa.sendMessage(replyTo, `🛑 Session *${toStop.id}* stopped.${costMsg}`);
                }
                break;
            }

            case 'LIST_SESSIONS': {
                const recent = store.getGlobalRecentSessions(15);
                if (recent.length === 0) {
                    await wa.sendMessage(replyTo, "No sessions found in history. Send a task to start one!");
                    break;
                }
                const list = recent.map(s => {
                    const icon = s.status === 'running' ? '🟢' : '🔴';
                    return `${icon} *${s.id}* — ${(s.task || '').slice(0, 50)}`;
                }).join('\n');
                await wa.sendMessage(replyTo, `📋 *Global Recent Sessions:*\n\n${list}`);
                break;
            }

            case 'STATUS': {
                const allRunning = store.getAllActiveSessions();
                if (allRunning.length === 0) {
                    await wa.sendMessage(replyTo, "No sessions are currently running.");
                    break;
                }
                const statuses = allRunning.map(s => {
                    const running = claude.isRunning(s.id);
                    const preview = claude.getLastOutput(s.id)?.slice(-200) || 'No output yet';
                    return `🟢 *${s.id}*\nTask: ${(s.task || '').slice(0, 60)}\nRunning in bot memory: ${running}\nLast output: ${preview}`;
                }).join('\n\n');
                await wa.sendMessage(replyTo, statuses);
                break;
            }

            case 'GET_COST': {
                const totalCost = store.getTotalCost();
                const prefix = intent.reply ? intent.reply + '\n\n' : '';
                await wa.sendMessage(replyTo, `${prefix}💸 *Total API Spend:* $${totalCost.toFixed(4)}`);
                break;
            }

            case 'CHAT': {
                await wa.sendMessage(replyTo, intent.reply || "How can I help? Send me a coding task to get started! 🚀");
                break;
            }

            case 'START_AUTONOMOUS_SESSION': {
                if (currentThread) store.closeThread(threadKey);
                const task = intent.task || text;
                const { sessionId } = await claude.startAutonomousSession(threadKey, task);
                await wa.sendMessage(replyTo,
                    (intent.reply || '🚀 Starting Ralph Wiggum Autonomous Agent...') +
                    `\n📋 Session ID: *${sessionId}*\nRalph will self-loop and run background commands.`
                );
                break;
            }

            default:
                await wa.sendMessage(replyTo, "Send me a coding task or type 'sessions' to see your history.");
                return { action: intent.action, status: "default" };
        }
    } catch (err) {
        console.error('[Main] Error:', err);
        await wa.sendMessage(groupJid || phone, `❌ Error: ${err.message}`).catch(() => { });
        return { error: err.message };
    }
}

if (wa) wa.on('message', serializedMessageHandler);

// ── Start ─────────────────────────────────────────────────

if (config.WHATSAPP_ENABLED === false) {
    // Email-only mode: skip WhatsApp, start dashboard immediately
    console.log('Starting OliBot (Email-only mode)...');
    const allowedPhones = store.getAllowedPhones().map(r => r.phone);
    console.log(`📱 Allowed phones: ${allowedPhones.length > 0 ? allowedPhones.join(', ') : 'none'}`);
    console.log(`🧠 Gemini model: ${config.GEMINI_MODEL}`);
    console.log(`🔧 Claude binary: ${config.CLAUDE_BIN}`);
    startDashboard(store, handleIncomingMessage, 18790, null, claude);
    console.log('🌐 Dashboard running at http://localhost:18790');
} else {
    // WhatsApp mode: wait for QR scan
    wa.on('ready', () => {
        console.log('🤖 OliBot is ONLINE!');
        const allowedPhones = store.getAllowedPhones().map(r => r.phone);
        console.log(`📱 Allowed phones: ${allowedPhones.length > 0 ? allowedPhones.join(', ') : 'OPEN (no filter)'}`);
        console.log(`🧠 Gemini model: ${config.GEMINI_MODEL}`);
        console.log(`🔧 Claude binary: ${config.CLAUDE_BIN}`);
        startDashboard(store, handleIncomingMessage, 18790, wa, claude);
    });

    console.log('Starting OliBot...');
    wa.connect().catch(err => {
        console.error('Failed to start:', err);
        process.exit(1);
    });
}
