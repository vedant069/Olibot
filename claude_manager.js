// ============================================================
// claude_manager.js — Spawns, resumes, and monitors Claude Code
// ============================================================
//
// KEY DESIGN PRINCIPLES:
//   - Claude Code manages ALL conversation history via its own
//     session store (~/.claude/). We use --resume <session_id>
//     where session_id comes from Claude's own JSON output.
//   - We do NOT replay history manually or relay output via files.
//   - node-pty provides the required pseudo-terminal (TTY).
//   - Cost tracking comes from Claude's `result` JSON event.
// ============================================================

import pty from 'node-pty';
import { EventEmitter } from 'events';
import config from './config.js';
import fs from 'fs';
import path from 'path';

// One-line KB hint prepended to every task. Tells Claude where to find domain
// docs without --add-dir loading everything into context upfront.
const KB_HINT = `[Context: Knowledge Base is at ${config.KB_DIR} - check relevant .md files there if you need domain knowledge.]`;

class ClaudeManager extends EventEmitter {
    constructor(sessionStore) {
        super();
        this.store = sessionStore;
        // Map: our session ID → { proc (PTY), costUsd, lineBuffer, lastOutput }
        this.processes = new Map();
        this._lastNotify = {};
    }

    // ── Public API ────────────────────────────────────────────

    /**
     * Start a brand-new Claude Code session.
     * Claude creates its OWN session ID (returned in stream-json result event),
     * which we store in SQLite for future --resume calls.
     */
    async startSession(userPhone, task, workingDir, imagePath = null) {
        const sessionId = `WA-${Date.now().toString(36)}`;
        const dir = workingDir || config.DEFAULT_WORKING_DIR;

        // claude_session_id starts null — filled once Claude emits its session_id
        this.store.createSession(sessionId, userPhone, task, null, dir);
        this.store.addMessage(sessionId, 'user', task);

        this._spawnNew(sessionId, task, dir, imagePath);
        return { sessionId };
    }

    /**
     * Resume an existing session with a follow-up message.
     * Uses Claude's --resume <claude_session_id> so full history is preserved by Claude.
     */
    async resumeSession(sessionId, followUp, imagePath = null) {
        const session = this.store.getSession(sessionId);
        if (!session) throw new Error(`Session ${sessionId} not found`);
        if (!session.claude_session_id) {
            throw new Error(`Session ${sessionId} has no Claude ID yet — it may still be initializing`);
        }
        if (this.isRunning(sessionId)) {
            throw new Error(`Session ${sessionId} is currently running. Please wait for it to finish or stop it first.`);
        }

        this.store.addMessage(sessionId, 'user', followUp);
        // Reopen the thread so subsequent messages go to this session
        this.store.updateSession(sessionId, { status: 'running', thread_open: 1 });
        this._spawnResume(sessionId, session.claude_session_id, followUp, session.working_dir, session.cost_usd || 0, imagePath);
        return { sessionId };
    }

    /**
     * Stop a session. Returns the total cost incurred so far.
     */
    stopSession(sessionId) {
        const entry = this.processes.get(sessionId);
        const session = this.store.getSession(sessionId);
        const costUsd = entry?.costUsd || session?.cost_usd || 0;

        if (entry?.proc) {
            try { entry.proc.kill(); } catch (_) { }
        }
        this.store.updateSession(sessionId, { status: 'stopped' });
        this.processes.delete(sessionId);
        return costUsd;
    }

    isRunning(sessionId) {
        return this.processes.has(sessionId);
    }

    getLastOutput(sessionId) {
        return this.processes.get(sessionId)?.lastOutput || null;
    }

    /**
     * Plan-first session — Claude produces a plan WITHOUT executing any changes.
     * Uses --permission-mode plan so Claude reads code but cannot write files or run commands.
     * The resulting session_id is stored so the user can say "go ahead" to execute it via --resume.
     */
    async planSession(userPhone, task, workingDir) {
        const sessionId = `WA-plan-${Date.now().toString(36)}`;
        const dir = workingDir || config.DEFAULT_WORKING_DIR;

        this.store.createSession(sessionId, userPhone, task, null, dir);
        this.store.addMessage(sessionId, 'user', task);

        this._spawnPlan(sessionId, task, dir);
        return { sessionId };
    }

    // ── Internal: spawn new session (execute immediately) ─────


    _spawnNew(sessionId, prompt, workingDir, imagePath = null) {
        const fileRef = this._prepareFile(imagePath, workingDir);
        const fullPrompt = fileRef
            ? `${KB_HINT}\n\n${fileRef}\n\n${prompt}`
            : `${KB_HINT}\n\n${prompt}`;
        const args = [
            '--print',
            '--model', 'opus',
            '--output-format', 'stream-json',
            '--verbose',
            '--dangerously-skip-permissions',
            fullPrompt
        ];

        console.log(`[Claude] NEW session ${sessionId} | cwd: ${workingDir}`);
        this._runPty(sessionId, config.CLAUDE_BIN, args, workingDir, 0);
    }

    // ── Internal: spawn plan-only session ─────────────────────

    _spawnPlan(sessionId, prompt, workingDir) {
        const planPrefix = '🗺️ PLANNING MODE: Read the codebase and relevant knowledge base docs, then write a detailed step-by-step plan of the changes you would make. Do NOT modify any files. Output the plan as a numbered list, then stop.';
        const args = [
            '--print',
            '--model', 'opus',
            '--output-format', 'stream-json',
            '--verbose',
            '--dangerously-skip-permissions',
            `${KB_HINT}\n\n${planPrefix}\n\nTask: ${prompt}`
        ];

        console.log(`[Claude] PLAN session ${sessionId} | cwd: ${workingDir}`);
        this._runPty(sessionId, config.CLAUDE_BIN, args, workingDir, 0);
    }

    // ── Internal: resume existing session ─────────────────────

    _spawnResume(sessionId, claudeSessionId, followUp, workingDir, baseCost = 0, imagePath = null) {
        const fileRef = this._prepareFile(imagePath, workingDir);
        const fullFollowUp = fileRef ? `${fileRef}\n\n${followUp}` : followUp;
        const args = [
            '--resume', claudeSessionId,
            '--print',
            '--model', 'opus',
            '--output-format', 'stream-json',
            '--verbose',
            '--dangerously-skip-permissions',
            fullFollowUp
        ];

        console.log(`[Claude] RESUME session ${sessionId} | claude_id: ${claudeSessionId} | base_cost: $${baseCost}`);
        this._runPty(sessionId, config.CLAUDE_BIN, args, workingDir, baseCost);
    }

    /**
     * Copy any file (image, PDF, Excel, Word, etc.) to the working directory
     * and return a reference string for the Claude prompt.
     * Returns null if no file provided.
     */
    _prepareFile(filePath, workingDir) {
        if (!filePath || !fs.existsSync(filePath)) return null;
        try {
            const ext = path.extname(filePath);
            const origName = path.basename(filePath);
            const destName = `context-file-${Date.now()}${ext}`;
            const dest = path.join(workingDir || config.DEFAULT_WORKING_DIR, destName);
            fs.copyFileSync(filePath, dest);
            // Clean up the tmp source
            try { fs.unlinkSync(filePath); } catch (_) { }
            const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'].includes(ext.toLowerCase());
            const hint = isImage
                ? `[Image attached — saved at: ${dest}. Please view/read this image as part of the task.]`
                : `[File attached (${origName}) — saved at: ${dest}. Please read/analyze this file as part of the task.]`;
            return hint;
        } catch (err) {
            console.error(`[Claude] Failed to prepare file: ${err.message}`);
            return null;
        }
    }

    // ── Internal: PTY runner ───────────────────────────────────

    _runPty(sessionId, bin, args, workingDir, baseCost = 0) {
        const entry = {
            proc: null,
            baseCost,
            costUsd: baseCost,
            lastOutput: '',
            lineBuffer: '',
            resultEmitted: false,  // guard against double-emit
        };
        this.processes.set(sessionId, entry);


        const proc = pty.spawn(bin, args, {
            name: 'xterm-color',
            cols: 1000000,   // wide columns prevent JSON from being line-wrapped by PTY
            rows: 50,
            cwd: workingDir || config.DEFAULT_WORKING_DIR,
            env: process.env,
        });
        entry.proc = proc;

        proc.on('data', (raw) => {
            // Strip ANSI escape codes emitted by the PTY terminal
            const text = raw.toString().replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
            entry.lastOutput += text;
            entry.lineBuffer += text;

            // Process complete lines
            const lines = entry.lineBuffer.split('\n');
            entry.lineBuffer = lines.pop(); // retain incomplete final line

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                try {
                    const event = JSON.parse(trimmed);
                    this._handleEvent(sessionId, event, entry);
                } catch (_) {
                    // Non-JSON: Claude UI/status text — safely ignore
                }
            }
        });

        proc.on('exit', (code) => {
            // node-pty passes exit code as a plain number
            const exitCode = typeof code === 'number' ? code : 0;
            console.log(`[Claude] Session ${sessionId} exited (code ${exitCode})`);

            // Flush remaining buffered line only if result hasn't been emitted yet
            const remaining = entry.lineBuffer.trim();
            if (remaining && !entry.resultEmitted) {
                try {
                    const event = JSON.parse(remaining);
                    this._handleEvent(sessionId, event, entry);
                } catch (_) { }
            }

            const status = exitCode === 0 ? 'completed' : 'failed';
            this.store.updateSession(sessionId, { status });
            this.processes.delete(sessionId);
            this.emit('session_end', { sessionId, code: exitCode, status, costUsd: entry.costUsd });
        });
    }

    // ── Internal: parse Claude stream-json events ──────────────

    _handleEvent(sessionId, event, entry) {
        // 1. Process cost updates from ANY event type (usage, progress, assistant, result)
        // Claude CLI emits total_cost_usd which is the cost for THIS command execution.
        const processCost = event.total_cost_usd ?? event.cost_usd ?? event.usage?.total_cost_usd;
        if (processCost != null && entry) {
            const totalSessionCost = entry.baseCost + processCost;
            if (totalSessionCost > entry.costUsd) {
                entry.costUsd = totalSessionCost;
                this.store.updateSession(sessionId, { cost_usd: totalSessionCost });
            }
        }

        // 2. Intermediate assistant message
        if (event.type === 'assistant' && event.message) {
            // Skip if result already sent — the final assistant message duplicates the result content
            if (entry?.resultEmitted) return;
            const content = this._extractText(event.message);
            if (content) {
                this.store.upsertLastAssistantMessage(sessionId, content);
                // Debounce intermediate WhatsApp notifications (max 1 per 10s)
                const now = Date.now();
                if (!this._lastNotify[sessionId] || (now - this._lastNotify[sessionId]) > 10000) {
                    this._lastNotify[sessionId] = now;
                    this.emit('assistant_message', { sessionId, content });
                }
            }
        }

        // 3. Final result event
        if (event.type === 'result') {
            // Guard: only process once even if event appears twice (data stream + exit lineBuffer flush)
            if (entry?.resultEmitted) return;
            if (entry) entry.resultEmitted = true;

            // Store Claude's own session_id so we can --resume this session later
            if (event.session_id) {
                this.store.updateSession(sessionId, { claude_session_id: event.session_id });
                if (entry) entry.claudeSessionId = event.session_id;
                console.log(`[Claude] Session ${sessionId} → claude_session_id: ${event.session_id}`);
            }

            // Cost is already handled at the top of _handleEvent, just emit the latest total
            const currentCost = entry?.costUsd || entry?.baseCost || 0;
            const content = this._extractText(event.result || event.message);
            if (content) {
                this.store.upsertLastAssistantMessage(sessionId, content);
                this.emit('result', { sessionId, content, costUsd: currentCost });
            }
        }

        // Error event
        if (event.type === 'error') {
            const errorMsg = event.error || event.message || 'Unknown error';
            console.error(`[Claude] Session ${sessionId} error: ${errorMsg}`);
            this.emit('session_error', { sessionId, error: errorMsg });
        }
    }

    _extractText(msg) {
        if (!msg) return null;
        if (typeof msg === 'string') return msg.trim() || null;
        if (Array.isArray(msg.content)) {
            const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
            return text || null;
        }
        if (typeof msg.content === 'string') return msg.content.trim() || null;
        if (msg.text) return msg.text.trim() || null;
        return null;
    }
}

export default ClaudeManager;
