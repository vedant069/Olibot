# WhatsApp AI Engineer

A powerful, two-stage agentic coding assistant that lives in your WhatsApp messages.
Powered by **Gemini** (as the conversational and orchestration brain) and **Claude Code CLI** (as the execution engine).

The WhatsApp Engineer allows you to instruct a fully autonomous coding agent right from your phone. It supports long-running sessions, resuming tasks, real-time logging streamed back to your chats, and a web dashboard for deeper control.

---

## 🎯 Features

- **WhatsApp Interface**: Start, pause, plan, and monitor coding tasks via standard WhatsApp messages.
- **Bi-Directional Sync**: Interact with the agent via WhatsApp or the built-in Web Dashboard.
- **Persistent Sessions**: Disconnect your phone at any time. Claude keeps working on your server in the background and notifies you upon completion or error.
- **Cost Tracking**: Tracks LLM API spending across both Gemini orchestration and Claude execution automatically.
- **Dynamic Knowledge Base Integration**: Automatically pulls documentation from a specified GitHub repository to give Claude domain knowledge about your codebase.

---

## ⚙️ Prerequisites

1. **Node.js** (v18 or higher)
2. **SQLite3**
3. **Claude Code CLI**: Installed globally (`npm install -g @anthropic-ai/claude-code`)
   - Please ensure Claude is authenticated on the server (`claude login`).
4. **API Keys**:
   - [Gemini API Key](https://aistudio.google.com/) (Required for orchestration)
   - [Anthropic API Key](https://console.anthropic.com/) (Required for Claude execution)

---

## 🚀 Setup & Installation

**1. Clone the repository**
```bash
git clone https://github.com/your-org/whatsapp-engineer.git
cd whatsapp-engineer
npm install
```

**2. Configure Environment Variables**
Copy the `.env.example` file to create your `.env` file:
```bash
cp .env.example .env
```

Edit the `.env` file with your specific configurations:
```env
# Your Gemini API Key for Orchestration
GEMINI_API_KEY=AIzaSy...

# Allowlist: Comma-separated WhatsApp numbers (with country code, no '+') authorized to send tasks
# E.g., 14155552671
ALLOWED_PHONES=

# Working Directory where Claude Code should operate
DEFAULT_WORKING_DIR=/home/ubuntu/your-project

# (Optional) GitHub Knowledge Base URL
# The start script will automatically clone and pull updates from this repository
GITHUB_KB_URL=https://github.com/your-org/your-knowledge-base.git
KB_DIR=./kb
```

**3. Configure Model Context Protocol (MCP)**
We heavily recommend setting up Claude Code MCP servers (e.g., PostgreSQL, GitHub, Linear) to expand Claude's capabilities.
Configure these in `~/.claude.json` or by running `claude mcp` on your server directly before starting the application.

---

## 🖥️ Running the Application

We've provided a simple startup script that automatically handles loading the `.env` variables, updating your GitHub knowledge base, and launching the application in the background.

```bash
chmod +x start.sh
./start.sh
```

**Linking WhatsApp for the first time:**
1. Once you run the app, check the output logs:
   ```bash
   tail -f /tmp/wa-engineer.log
   ```
2. The logs will display a large QR code in the terminal.
3. Open WhatsApp on your primary "Bot" device.
4. Go to **Settings > Linked Devices > Link a Device** and scan the QR code.
5. You'll see `🤖 WhatsApp AI Engineer is ONLINE!` in the logs when the connection is successful.

---

## 📱 How to Use

From any phone listed in your `ALLOWED_PHONES` environment variable, send a message to the bot's WhatsApp number.

### Example Commands:
- **"Start fresh and analyze the backend logs for errors"**: Starts a brand new Claude Code session.
- **"Resume WA-xyz and fix the styling issues"**: Resumes a previously started Claude session with full context.
- **"What is the status?"**: Retrieves the current execution state of all running jobs.
- **"Stop WA-xyz"**: Kills a Claude session.
- **"Cost"**: Reports total API expenditure.

---

## 🔄 Resetting WhatsApp Authentication

If you need to switch the connected WhatsApp number (e.g., in a UAT or Staging environment where you've already scanned the QR code once), you must clear the saved authentication state.

Run the following commands on your server:

```bash
# Move to the project directory
cd whatsapp-engineer

# Stop the running application
pkill -f "node index.js"

# Delete the Baileys auth credentials folder
rm -rf auth_info/

# Restart the application
./start.sh
```

Upon restart, `tail -f /tmp/wa-engineer.log` will display a fresh QR code for you to scan with the new device.

---

## 🌐 Web Dashboard

The application runs a lightweight local dashboard on **port 18790** by default.
You can open this dashboard in your browser to view your complete session history, read raw Claude execution logs, and monitor API costs.

*(Tip: Setup an Nginx reverse proxy to forward port 18790 to a secure domain!)*
