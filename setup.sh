#!/bin/bash
# =============================================================
# setup.sh — WhatsApp AI Engineer — Interactive Setup Wizard
# =============================================================
set -e
cd "$(dirname "$0")"

# ── Colors ────────────────────────────────────────────────────
BLUE='\033[0;34m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
print_banner() {
    echo ""; echo -e "${BLUE}${BOLD}"
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
        curl -fsSL https://repo.charm.sh/apt/gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/charm.gpg 2>/dev/null
        echo "deb [signed-by=/etc/apt/keyrings/charm.gpg] https://repo.charm.sh/apt/ * *" | sudo tee /etc/apt/sources.list.d/charm.list > /dev/null
        sudo apt-get update -q && sudo apt-get install -y -q gum
    elif command -v brew &>/dev/null; then
        brew install gum
    else
        GUM_VERSION="0.14.5"
        curl -fsSL "https://github.com/charmbracelet/gum/releases/download/v${GUM_VERSION}/gum_${GUM_VERSION}_linux_amd64.tar.gz" | sudo tar -xz -C /usr/local/bin gum
    fi
    ok "gum installed"
}

# ── Step 1: Install Node dependencies ─────────────────────────
install_deps() {
    step 1 "Install Node.js Dependencies"
    if ! command -v node &>/dev/null; then
        fail "Node.js not found! Install Node.js 18+ first:\n  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -\n  sudo apt-get install -y nodejs"
    fi
    ok "Node.js $(node -v) found"
    gum spin --spinner dot --title "Installing npm packages..." -- npm install
    ok "npm packages installed"
    npm rebuild node-pty 2>/dev/null && ok "Native modules ready" || warn "node-pty rebuild failed (build tools may be required — not critical)"
}

# ── Step 2: Check Claude Code ─────────────────────────────────
check_claude() {
    step 2 "Check Claude Code Installation"
    CLAUDE_BIN=$(which claude 2>/dev/null || echo "")
    if [ -z "$CLAUDE_BIN" ]; then
        warn "Claude Code not found."
        if gum confirm "Install Claude Code now?"; then
            curl -fsSL https://claude.ai/install.sh | bash || npm install -g @anthropic-ai/claude-code 2>/dev/null || {
                warn "Auto-install failed. Install manually: https://claude.ai/install"
            }
            CLAUDE_BIN=$(which claude 2>/dev/null || echo "$HOME/.local/bin/claude")
        else
            warn "Skipping Claude Code install. You'll need it to use AI sessions."
            CLAUDE_BIN="$HOME/.local/bin/claude"
        fi
    fi
    ok "Claude binary: ${CLAUDE_BIN}"

    if "$CLAUDE_BIN" --version &>/dev/null; then
        ok "Claude Code is authenticated"
    else
        warn "Claude is not authenticated. Starting login process..."
        "$CLAUDE_BIN" login
        if "$CLAUDE_BIN" --version &>/dev/null; then
            ok "Claude Code is now authenticated"
        else
            fail "Failed to authenticate Claude Code. Please run 'claude login' manually."
        fi
    fi
}

# ── Step 3: Choose access mode FIRST ─────────────────────────
choose_mode() {
    step 3 "Choose Access Mode"
    gum style --foreground 212 --bold "How do you want users to interact?"
    ACCESS_MODE=$(gum choose "WhatsApp (QR scan)" "Email (dashboard only)" "Both")
    case "$ACCESS_MODE" in
        "WhatsApp (QR scan)") ok "WhatsApp mode selected — QR code will be shown on start." ;;
        "Email (dashboard only)") ok "Email-only mode selected — no WhatsApp, no QR code." ;;
        "Both") ok "Both modes selected — WhatsApp + email dashboard." ;;
    esac
}

# ── Step 4: Configure .env ────────────────────────────────────
configure_env() {
    step 4 "Configure Environment Variables"

    if [ -f .env ]; then
        if ! gum confirm ".env already exists. Reconfigure it?"; then
            ok "Keeping existing .env"
            return 0
        fi
    fi

    echo -e "${BLUE}I'll ask a few questions to build your .env file.${NC}\n"

    gum style --foreground 212 --bold "🔑  Gemini API Key (required)"
    GEMINI_KEY=$(gum input --placeholder "AIza...")
    [ -z "$GEMINI_KEY" ] && fail "Gemini API key is required."

    gum style --foreground 212 --bold "👤  Admin Email (this account will have full admin access)"
    ADMIN_EMAIL=$(gum input --placeholder "admin@yourcompany.com")
    [ -z "$ADMIN_EMAIL" ] && fail "Admin email is required."

    gum style --foreground 212 --bold "👤  Admin Display Name"
    ADMIN_NAME=$(gum input --placeholder "Admin")
    [ -z "$ADMIN_NAME" ] && ADMIN_NAME="Admin"

    # Only ask for phone numbers if WhatsApp is enabled
    ALLOWED_PHONES_VAL=""
    if [ "$ACCESS_MODE" != "Email (dashboard only)" ]; then
        gum style --foreground 212 --bold "📱  Allowed WhatsApp numbers (comma-separated, with country code)"
        ALLOWED_PHONES_VAL=$(gum input --placeholder "91997XXXXXXX,91998XXXXXXX")
    fi

    gum style --foreground 212 --bold "🔐  JWT Secret (auto-generated if left empty)"
    JWT_DEFAULT="$(openssl rand -hex 32 2>/dev/null || echo "change-me-$(date +%s)")"
    JWT_SECRET=$(gum input --placeholder "Leave empty for auto-generated")
    [ -z "$JWT_SECRET" ] && JWT_SECRET="$JWT_DEFAULT"

    SMTP_USER=""; SMTP_PASS=""; SMTP_HOST="smtp.gmail.com"
    if [ "$ACCESS_MODE" != "WhatsApp (QR scan)" ]; then
        gum style --foreground 212 --bold "📧  SMTP Email (for OTP login emails)"
        SMTP_USER=$(gum input --placeholder "you@gmail.com")
        gum style --foreground 212 --bold "📧  SMTP App Password"
        SMTP_PASS=$(gum input --password --placeholder "your-app-password")
        gum style --foreground 212 --bold "📬  SMTP Host [smtp.gmail.com]"
        SMTP_HOST_INPUT=$(gum input --placeholder "smtp.gmail.com")
        [ -n "$SMTP_HOST_INPUT" ] && SMTP_HOST="$SMTP_HOST_INPUT"
    fi

    gum style --foreground 212 --bold "📂  Default Claude working directory [/home/ubuntu]"
    WORKING_DIR=$(gum input --placeholder "/home/ubuntu")
    [ -z "$WORKING_DIR" ] && WORKING_DIR="/home/ubuntu"

    CLAUDE_BIN_PATH=$(which claude 2>/dev/null || echo "$HOME/.local/bin/claude")
    gum style --foreground 212 --bold "🤖  Claude binary path [$CLAUDE_BIN_PATH]"
    CLAUDE_BIN_INPUT=$(gum input --placeholder "$CLAUDE_BIN_PATH")
    [ -z "$CLAUDE_BIN_INPUT" ] && CLAUDE_BIN_INPUT="$CLAUDE_BIN_PATH"

    # WHATSAPP_ENABLED flag
    WA_ENABLED="true"
    [ "$ACCESS_MODE" = "Email (dashboard only)" ] && WA_ENABLED="false"

    cat > .env << EOF
# WhatsApp AI Engineer — Environment Configuration
# Generated by setup.sh on $(date)

GEMINI_API_KEY=$GEMINI_KEY
GEMINI_MODEL=gemini-3-flash-preview
CLAUDE_BIN=$CLAUDE_BIN_INPUT

ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_NAME=$ADMIN_NAME

ALLOWED_PHONES=$ALLOWED_PHONES_VAL

JWT_SECRET=$JWT_SECRET
SMTP_HOST=$SMTP_HOST
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=$SMTP_USER
SMTP_PASS=$SMTP_PASS

DEFAULT_WORKING_DIR=$WORKING_DIR
DB_PATH=./sessions.db
AUTH_DIR=./auth_info
LOG_DIR=./logs

WHATSAPP_ENABLED=$WA_ENABLED
EOF

    chmod 600 .env
    ok ".env created (chmod 600)"
}

# ── Step 5: Start ─────────────────────────────────────────────
start_service() {
    step 5 "Start the Service"
    if gum confirm "Start WhatsApp AI Engineer now?"; then
        bash ./start.sh
        ok "Started! Run: tail -f /tmp/wa-engineer.log"
        echo ""
        echo -e "${GREEN}${BOLD}✅ Setup complete!${NC}"
        echo -e "  Dashboard: ${BLUE}http://localhost:18790${NC}"
        if [ "$ACCESS_MODE" != "WhatsApp (QR scan)" ]; then
            echo -e "  Login:     ${BLUE}http://localhost:18790/login.html${NC}"
        fi
        echo -e "  Logs:      tail -f /tmp/wa-engineer.log"
        echo ""
    else
        echo -e "\n${YELLOW}Run ./start.sh when ready.${NC}\n"
    fi
}

# ── Main ──────────────────────────────────────────────────────
print_banner
install_gum
install_deps
check_claude
choose_mode       # ← Mode is asked FIRST
configure_env     # ← Env questions depend on mode
start_service
