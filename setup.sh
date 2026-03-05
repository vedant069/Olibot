#!/bin/bash
# =============================================================
# setup.sh — WhatsApp AI Engineer — Interactive Setup Wizard
# =============================================================
# Uses gum (https://github.com/charmbracelet/gum) for beautiful CLI UI.
# Usage: bash setup.sh
# =============================================================

set -e
cd "$(dirname "$0")"

# ── Colors & Helpers ──────────────────────────────────────────
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

print_banner() {
    echo ""
    echo -e "${BLUE}${BOLD}"
    echo "  ╔══════════════════════════════════════════════╗"
    echo "  ║      WhatsApp AI Engineer — Setup Wizard     ║"
    echo "  ╚══════════════════════════════════════════════╝"
    echo -e "${NC}"
}

step() { echo -e "\n${BLUE}${BOLD}▶ Step $1: $2${NC}"; }
ok()   { echo -e "${GREEN}✓ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠ $1${NC}"; }
fail() { echo -e "${RED}✗ $1${NC}"; exit 1; }

# ── Step 0: Install gum ───────────────────────────────────────
install_gum() {
    if command -v gum &>/dev/null; then return; fi
    warn "gum not found — installing..."
    if command -v apt-get &>/dev/null; then
        sudo mkdir -p /etc/apt/keyrings
        curl -fsSL https://repo.charm.sh/apt/gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/charm.gpg
        echo "deb [signed-by=/etc/apt/keyrings/charm.gpg] https://repo.charm.sh/apt/ * *" | sudo tee /etc/apt/sources.list.d/charm.list > /dev/null
        sudo apt-get update -q && sudo apt-get install -y -q gum
    elif command -v brew &>/dev/null; then
        brew install gum
    else
        # Fallback: download binary directly
        GUM_VERSION="0.14.5"
        GUM_ARCH="linux_amd64"
        GUM_URL="https://github.com/charmbracelet/gum/releases/download/v${GUM_VERSION}/gum_${GUM_VERSION}_${GUM_ARCH}.tar.gz"
        curl -fsSL "$GUM_URL" | sudo tar -xz -C /usr/local/bin gum
    fi
    ok "gum installed"
}

# ── Step 1: Install Node dependencies ─────────────────────────
install_deps() {
    step 1 "Install Node.js Dependencies"
    if ! command -v node &>/dev/null; then
        fail "Node.js not found! Please install Node.js 18+ first.\n  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -\n  sudo apt-get install -y nodejs"
    fi
    NODE_VER=$(node -v)
    ok "Node.js $NODE_VER found"

    gum spin --spinner dot --title "Installing npm packages..." -- npm install
    ok "npm packages installed"

    gum spin --spinner dot --title "Building native modules (node-pty)..." -- npm rebuild node-pty 2>/dev/null || warn "node-pty rebuild failed — build tools may be required"
    ok "Native modules ready"
}

# ── Step 2: Check Claude Code ─────────────────────────────────
check_claude() {
    step 2 "Check Claude Code Installation"
    CLAUDE_BIN=$(which claude 2>/dev/null || echo "")

    if [ -z "$CLAUDE_BIN" ]; then
        warn "Claude Code not found in PATH."
        gum confirm "Install Claude Code now?" && {
            curl -fsSL https://claude.ai/install.sh | sh || fail "Failed to install Claude Code"
            CLAUDE_BIN=$(which claude 2>/dev/null || echo "$HOME/.local/bin/claude")
        } || fail "Claude Code is required. Please install it manually: https://claude.ai/install"
    fi
    ok "Claude Code found at: $CLAUDE_BIN"

    # Check authentication
    if ! "$CLAUDE_BIN" --version &>/dev/null; then
        warn "Claude Code is not authenticated."
        echo -e "${YELLOW}Please authenticate now (follow the URL that appears):${NC}"
        "$CLAUDE_BIN" auth login || fail "Claude Code authentication failed."
    else
        ok "Claude Code is authenticated"
    fi
}

# ── Step 3: Configure .env ────────────────────────────────────
configure_env() {
    step 3 "Configure Environment Variables"

    if [ -f .env ]; then
        gum confirm ".env file already exists. Reconfigure it?" || return
    fi

    echo -e "${BLUE}I'll ask you a few questions to set up your environment.${NC}"
    echo -e "${BLUE}Press Enter to accept defaults shown in [brackets].${NC}\n"

    # Gemini API Key
    gum style --foreground 212 --bold "🔑  Gemini API Key (required)"
    GEMINI_KEY=$(gum input --placeholder "AIza..." --password)
    [ -z "$GEMINI_KEY" ] && fail "Gemini API key is required."

    # Allowed WhatsApp Numbers
    gum style --foreground 212 --bold "📱  Allowed WhatsApp numbers (comma-separated, with country code)"
    ALLOWED_PHONES=$(gum input --placeholder "91997XXXXXXX,91998XXXXXXX")

    # JWT Secret
    gum style --foreground 212 --bold "🔐  JWT Secret (for dashboard login sessions)"
    JWT_DEFAULT="$(openssl rand -hex 32 2>/dev/null || cat /dev/urandom | head -c 32 | base64)"
    JWT_SECRET=$(gum input --placeholder "$JWT_DEFAULT (auto-generated)")
    [ -z "$JWT_SECRET" ] && JWT_SECRET="$JWT_DEFAULT"

    # SMTP Settings
    gum style --foreground 212 --bold "📧  SMTP Email (for OTP login emails)"
    SMTP_USER=$(gum input --placeholder "you@gmail.com")

    gum style --foreground 212 --bold "📧  SMTP Password / App Password"
    SMTP_PASS=$(gum input --password --placeholder "your-app-password")

    gum style --foreground 212 --bold "📬  SMTP Host [smtp.gmail.com]"
    SMTP_HOST=$(gum input --placeholder "smtp.gmail.com")
    [ -z "$SMTP_HOST" ] && SMTP_HOST="smtp.gmail.com"

    # Default working directory
    gum style --foreground 212 --bold "📂  Default Claude working directory [/home/ubuntu]"
    WORKING_DIR=$(gum input --placeholder "/home/ubuntu")
    [ -z "$WORKING_DIR" ] && WORKING_DIR="/home/ubuntu"

    # Claude binary path
    CLAUDE_BIN_PATH=$(which claude 2>/dev/null || echo "$HOME/.local/bin/claude")
    gum style --foreground 212 --bold "🤖  Claude binary path [$CLAUDE_BIN_PATH]"
    CLAUDE_BIN_INPUT=$(gum input --placeholder "$CLAUDE_BIN_PATH")
    [ -z "$CLAUDE_BIN_INPUT" ] && CLAUDE_BIN_INPUT="$CLAUDE_BIN_PATH"

    # Write .env
    cat > .env << EOF
# WhatsApp AI Engineer — Environment Configuration
# Generated by setup.sh on $(date)

# === Core ===
GEMINI_API_KEY=$GEMINI_KEY
GEMINI_MODEL=gemini-3-flash-preview
CLAUDE_BIN=$CLAUDE_BIN_INPUT

# === Access Control ===
ALLOWED_PHONES=$ALLOWED_PHONES

# === Auth (JWT + Email OTP) ===
JWT_SECRET=$JWT_SECRET
SMTP_HOST=$SMTP_HOST
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=$SMTP_USER
SMTP_PASS=$SMTP_PASS

# === Paths ===
DEFAULT_WORKING_DIR=$WORKING_DIR
DB_PATH=./sessions.db
AUTH_DIR=./auth_info
LOG_DIR=./logs
EOF

    chmod 600 .env
    ok ".env created and secured (chmod 600)"
}

# ── Step 4: Access Mode ───────────────────────────────────────
configure_access_mode() {
    step 4 "Configure Access Mode"
    gum style --foreground 212 --bold "How do you want users to interact?"

    MODE=$(gum choose "WhatsApp (QR scan)" "Email (dashboard only)" "Both")
    case "$MODE" in
        "WhatsApp (QR scan)"|"Both")
            ok "WhatsApp mode: Bot will display a QR code on first start. Scan it to connect."
            echo -e "${YELLOW}ℹ  After setup, run ./start.sh and scan the QR code displayed in the logs.${NC}"
            ;;
    esac
    case "$MODE" in
        "Email (dashboard only)"|"Both")
            ok "Email mode: Users login via OTP email at /login.html on the dashboard."
            ;;
    esac
}

# ── Step 5: Start ─────────────────────────────────────────────
start_service() {
    step 5 "Start the Service"
    gum confirm "Start WhatsApp AI Engineer now?" && {
        bash ./start.sh
        ok "Started! Run 'tail -f /tmp/wa-engineer.log' to monitor."
        echo -e "\n${GREEN}${BOLD}✅ Setup complete!${NC}"
        echo -e "  Dashboard: ${BLUE}http://localhost:18790${NC}"
        echo -e "  Login:     ${BLUE}http://localhost:18790/login.html${NC}"
        echo -e "  Logs:      tail -f /tmp/wa-engineer.log\n"
    } || echo -e "\n${YELLOW}Run ./start.sh when you're ready.${NC}\n"
}

# ── Main ──────────────────────────────────────────────────────
print_banner
install_gum
install_deps
check_claude
configure_env
configure_access_mode
start_service
