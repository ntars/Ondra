#!/bin/sh
set -eu
ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key
install -d -m 700 -o ondra -g ondra /home/ondra/.ssh
install -m 600 -o ondra -g ondra /fixture-key.pub /home/ondra/.ssh/authorized_keys
install -d -m 700 -o ondra -g ondra /home/ondra/workspace
exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
