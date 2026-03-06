#!/bin/bash
# start.sh — Start WhatsApp AI Engineer in background

# Move to the script execution directory
cd "$(dirname "$0")" || exit 1

echo "🚀 Starting WhatsApp AI Engineer..."

# Load environment variables if .env exists
if [ -f .env ]; then
    export $(grep -v '^#' .env | tr -d '\r' | xargs)
    echo "✅ Loaded environment variables from .env"
else
    echo "❌ No .env file found!"
    echo "👉 Please run './setup.sh' to configure your environment first."
    exit 1
fi

# Run npm install to ensure dependencies are up-to-date
if [ -f package.json ]; then
    echo "📦 Checking dependencies..."
    npm install --silent

    # node-pty is a native C++ addon — it requires build tools (python, make, gcc/MSVC).
    # Rebuild explicitly to catch failures early with a clear message.
    echo "🔧 Building native modules (node-pty)..."
    if ! npm rebuild node-pty --silent 2>/dev/null; then
        echo ""
        echo "❌ ERROR: Failed to build node-pty native addon."
        echo "   node-pty requires build tools. Please install them first:"
        echo ""
        echo "   Linux / macOS:"
        echo "     sudo apt-get install -y python3 make g++   (Debian/Ubuntu)"
        echo "     xcode-select --install                      (macOS)"
        echo ""
        echo "   Windows (run as Admin in PowerShell):"
        echo "     npm install -g windows-build-tools"
        echo "     npm install -g node-gyp"
        echo ""
        exit 1
    fi
    echo "✅ Dependencies ready."
fi

# Auto-sync Knowledge Base from GitHub if configured
if [ -n "$GITHUB_KB_URL" ]; then
    KB_PATH=${KB_DIR:-./kb}
    if [ ! -d "$KB_PATH/.git" ]; then
        echo "📥 Cloning Knowledge Base from $GITHUB_KB_URL to $KB_PATH..."
        git clone "$GITHUB_KB_URL" "$KB_PATH"
    else
        echo "🔄 Updating Knowledge Base in $KB_PATH..."
        git -C "$KB_PATH" pull
    fi
else
    echo "ℹ️  No GITHUB_KB_URL configured. Skipping Knowledge Base sync."
fi

# Kill any existing instance gently
echo "🛑 Stopping old instances..."
pkill -f "node index.js" 2>/dev/null || true
sleep 1

# Ensure a fresh log file exists
touch /tmp/wa-engineer.log
chmod 666 /tmp/wa-engineer.log

# Start in background with nohup
echo "🚀 Starting daemon..."
nohup node index.js > /tmp/wa-engineer.log 2>&1 &
echo "✅ Started PID=$!"

sleep 3
echo ""
echo "=== Last 60 log lines ==="
tail -60 /tmp/wa-engineer.log
echo "========================="
echo ""
echo "To monitor logs live, run: tail -f /tmp/wa-engineer.log"
