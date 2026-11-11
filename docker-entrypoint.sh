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

# Older images kept the database, config and secret key in $HOME/.orc and used
# ORC_HOME only for daemon files. Adopt that state into the data root once; a
# failed move stops startup instead of opening an empty database.
adopt_legacy() {
  legacy=$1
  if [ -z "${ORC_HOME:-}" ] || [ "$ORC_HOME" = "$legacy" ] || [ ! -d "$legacy" ]; then
    return 0
  fi
  install -d "$ORC_HOME"
  if [ -e "$legacy/orc.db" ] && [ ! -e "$ORC_HOME/orc.db" ]; then
    for name in orc.db orc.db-wal orc.db-shm; do
      [ -e "$legacy/$name" ] || continue
      mv "$legacy/$name" "$ORC_HOME/$name" || {
        printf 'orc: could not move %s/%s to %s; refusing to start\n' "$legacy" "$name" "$ORC_HOME" >&2
        exit 1
      }
    done
  fi
  for name in config.json secret.key knowledge; do
    if [ -e "$legacy/$name" ] && [ ! -e "$ORC_HOME/$name" ]; then
      mv "$legacy/$name" "$ORC_HOME/$name" || {
        printf 'orc: could not move %s/%s to %s; refusing to start\n' "$legacy" "$name" "$ORC_HOME" >&2
        exit 1
      }
    fi
  done
}
adopt_legacy "${HOME:-/home/bun}/.orc"
adopt_legacy /home/bun/.orc

exec tini -- "$@"
