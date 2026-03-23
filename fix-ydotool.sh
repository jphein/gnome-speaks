#!/bin/bash
# Fix ydotoold to run as user service (not root)
# This lets ydotool connect to the socket without permission issues
set -e

echo "=== Stopping system ydotoold ==="
sudo systemctl stop ydotool.service 2>/dev/null || true
sudo systemctl disable ydotool.service 2>/dev/null || true
sudo rm -f /tmp/.ydotool_socket

echo "=== Creating user service ==="
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/ydotoold.service <<'EOF'
[Unit]
Description=ydotoold - ydotool daemon (user)

[Service]
ExecStart=/usr/local/bin/ydotoold
Restart=on-failure

[Install]
WantedBy=default.target
EOF

echo "=== Ensuring /dev/uinput access ==="
# Add user to input group and set udev rule for uinput
sudo usermod -aG input "$USER"
sudo tee /etc/udev/rules.d/80-uinput.rules > /dev/null <<'EOF'
KERNEL=="uinput", SUBSYSTEM=="misc", MODE="0660", GROUP="input"
EOF
sudo udevadm control --reload-rules
sudo udevadm trigger /dev/uinput

echo "=== Starting user ydotoold ==="
systemctl --user daemon-reload
systemctl --user enable --now ydotoold.service

sleep 1
echo "=== Verifying ==="
ls -la /run/user/$(id -u)/.ydotool_socket 2>/dev/null && echo "Socket OK" || echo "Socket not found (may need re-login for group change)"
ydotool type "test" 2>&1 && echo "ydotool works!" || echo "May need to log out and back in for input group"

echo ""
echo "=== Done! If ydotool still fails, log out and back in for the 'input' group to take effect ==="
echo "Then: systemctl --user restart gnome-speaks.service"
