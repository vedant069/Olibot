import { EventEmitter } from 'events';
import * as pty from 'node-pty';
import path from 'path';
import config from './config.js';

export default class OpenCodeManager extends EventEmitter {
    constructor(store) {
        super();
        this.store = store;
        this.sessions = new Map();
        console.log(`[OpenCodeManager] Initialized with OpenCode binary: ${config.CLAUDE_BIN}`);
    }

    async startSession(threadKey, task, workingDir = null, imagePath = null, ownerId = null) {
        return new Promise((resolve, reject) => {
            const sessionId = `OP-${Date.now()}`;
            const targetDir = workingDir || config.DEFAULT_WORKING_DIR;

            this.store.createSession(sessionId, threadKey, task, targetDir, ownerId);

            const args = [
                'run',
                '--print-logs',
                task
            ];

            const ptyProcess = pty.spawn(config.CLAUDE_BIN, args, {
                name: 'xterm-color',
                cols: 120,
                rows: 30,
                cwd: targetDir,
                env: { ...process.env, CI: '1', PAGER: 'cat' }
            });

            this.sessions.set(sessionId, ptyProcess);
            let resultBuffer = '';

            this.store.updateSession(sessionId, { status: 'running' });

            ptyProcess.onData((data) => {
                const text = data.toString();
                resultBuffer += text;
                // Since OpenCode doesn't have native headless JSON streaming,
                // we send intermittent status updates visually
                if (text.includes('Thinking') || text.includes('Running')) {
                    this.emit('assistant_message', { sessionId, content: '...\n' });
                }
            });

            ptyProcess.onExit(({ exitCode }) => {
                this.sessions.delete(sessionId);
                const status = exitCode === 0 ? 'completed' : 'failed';
                this.store.updateSession(sessionId, { status, thread_open: exitCode === 0 ? 1 : 0 });
                // Strip ANSI codes and filter out internal OpenCode/bun INFO/DEBUG log lines
                const lines = resultBuffer.split('\n');
                let cleanText = '';
                for (const line of lines) {
                    const cleanLine = line.replace(/\x1B\[\d+;?\d*m/g, '').trim();
                    if (cleanLine && !cleanLine.match(/^(INFO|DEBUG|WARN)\s+\d{4}-\d{2}-\d{2}T/)) {
                        cleanText += cleanLine + '\n';
                    }
                }
                const finalStr = cleanText.trim() || 'Task completed by OpenCode.';

                this.emit('session_end', { sessionId, exitCode, status, costUsd: 0 });
                this.emit('result', { sessionId, content: finalStr.substring(Math.max(0, finalStr.length - 1500)), costUsd: 0 });
            });

            resolve({ sessionId, ptyProcess });
        });
    }

    async resumeSession(sessionId, followUp, imagePath = null) {
        const session = this.store.getSession(sessionId);
        if (!session) throw new Error(`Session ${sessionId} not found`);
        if (session.status === 'running') throw new Error(`Session ${sessionId} is already running`);

        this.store.updateSession(sessionId, { status: 'running', updated_at: new Date().toISOString() });

        const args = [
            'run',
            '--print-logs',
            '-c', '-s', sessionId,
            followUp
        ];

        const ptyProcess = pty.spawn(config.CLAUDE_BIN, args, {
            name: 'xterm-color', cols: 120, rows: 30,
            cwd: session.working_dir || config.DEFAULT_WORKING_DIR,
            env: { ...process.env, CI: '1', PAGER: 'cat' }
        });

        this.sessions.set(sessionId, ptyProcess);
        let resultBuffer = '';

        ptyProcess.onData((data) => {
            const text = data.toString();
            resultBuffer += text;
        });

        ptyProcess.onExit(({ exitCode }) => {
            this.sessions.delete(sessionId);
            const status = exitCode === 0 ? 'completed' : 'failed';
            this.store.updateSession(sessionId, { status, thread_open: exitCode === 0 ? 1 : 0 });

            const lines = resultBuffer.split('\n');
            let cleanText = '';
            for (const line of lines) {
                const cleanLine = line.replace(/\x1B\[\d+;?\d*m/g, '').trim();
                if (cleanLine && !cleanLine.match(/^(INFO|DEBUG|WARN)\s+\d{4}-\d{2}-\d{2}T/)) {
                    cleanText += cleanLine + '\n';
                }
            }
            const finalStr = cleanText.trim() || 'Task continued by OpenCode.';

            this.emit('session_end', { sessionId, exitCode, status, costUsd: 0 });
            this.emit('result', { sessionId, content: finalStr.substring(Math.max(0, finalStr.length - 1500)), costUsd: 0 });
        });

        return { sessionId, ptyProcess };
    }

    stopSession(sessionId) {
        const proc = this.sessions.get(sessionId);
        if (proc) {
            proc.kill(9);
            this.sessions.delete(sessionId);
            this.store.updateSession(sessionId, { status: 'failed', thread_open: 0 });
            return true;
        }
        return false;
    }
}
