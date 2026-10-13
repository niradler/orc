#!/bin/sh
set -eu

# A bind mount can present ownership or modes that OpenSSH rejects. Copy the
# read-only source into the container user's persistent home and harden it.
# OpenSSH uses the passwd database home, not an overridden HOME environment
# variable. The image always runs as the Bun image's `bun` user.
ssh_dir="/home/bun/.ssh"
if [ -n "${ORC_SSH_CONFIG:-}" ] && [ -f "$ORC_SSH_CONFIG" ]; then
  install -d -m 700 "$ssh_dir"
  install -m 600 "$ORC_SSH_CONFIG" "$ssh_dir/config"
fi

if [ -n "${ORC_SSH_SOURCE:-}" ] && [ -d "$ORC_SSH_SOURCE" ]; then
  install -d -m 700 "$ssh_dir"
  (
    cd "$ORC_SSH_SOURCE"
    find -L . -type d -exec mkdir -p "$ssh_dir"/{} \;
    find -L . -type f -exec cp -L {} "$ssh_dir"/{} \;
  )
  find "$ssh_dir" -type d -exec chmod 700 {} \;
  find "$ssh_dir" -type f -exec chmod 600 {} \;
  find "$ssh_dir" -type f -name '*.pub' -exec chmod 644 {} \;
fi

exec /sbin/tini -- "$@"
