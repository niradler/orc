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

# Older images kept the database, config and secret key in ~/.orc and used
# ORC_HOME only for daemon files. Adopt that state into the data root once, so
# an upgraded container keeps its projects, settings and encrypted secrets.
legacy_home="/home/bun/.orc"
if [ -n "${ORC_HOME:-}" ] && [ "$ORC_HOME" != "$legacy_home" ] && [ -d "$legacy_home" ]; then
  install -d "$ORC_HOME"
  for name in config.json secret.key orc.db orc.db-wal orc.db-shm; do
    if [ -e "$legacy_home/$name" ] && [ ! -e "$ORC_HOME/$name" ]; then
      mv "$legacy_home/$name" "$ORC_HOME/$name" ||
        printf 'orc: could not move %s/%s to %s\n' "$legacy_home" "$name" "$ORC_HOME" >&2
    fi
  done
  if [ -d "$legacy_home/knowledge" ] && [ ! -e "$ORC_HOME/knowledge" ]; then
    mv "$legacy_home/knowledge" "$ORC_HOME/knowledge" ||
      printf 'orc: could not move %s/knowledge to %s\n' "$legacy_home" "$ORC_HOME" >&2
  fi
fi

exec tini -- "$@"
