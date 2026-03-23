#!/bin/bash
# Install ydotool v1.0+ from source (replaces Ubuntu's outdated 0.1.8)
# Includes ydotoold daemon for instant keystroke injection
set -e

echo "=== Installing build dependencies ==="
sudo apt install -y cmake scdoc git build-essential

echo "=== Cloning ydotool ==="
cd /tmp
rm -rf ydotool
git clone https://github.com/ReimuNotMoe/ydotool.git
cd ydotool

echo "=== Building ==="
mkdir build && cd build
cmake ..
make -j$(nproc)

echo "=== Installing (replaces old 0.1.8) ==="
sudo make install

echo "=== Enabling ydotoold daemon ==="
sudo systemctl enable --now ydotool.service 2>/dev/null || {
    # If no system service file, create one
    sudo tee /etc/systemd/system/ydotool.service > /dev/null <<'EOF'
[Unit]
Description=ydotoold - ydotool daemon
After=multi-user.target

[Service]
ExecStart=/usr/local/bin/ydotoold
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    sudo systemctl enable --now ydotool.service
}

echo "=== Verifying ==="
ydotool --version 2>&1 || ydotoold --help 2>&1 | head -1
pidof ydotoold && echo "ydotoold is running!" || echo "WARNING: ydotoold not running"

echo ""
echo "=== Done! Restart gnome-speaks service: ==="
echo "systemctl --user restart gnome-speaks.service"
