#!/bin/sh
# Railway/Docker entrypoint for the automation worker.
#
# The keypair loader reads a FILE path (env ADMIN_KEYPAIR). Containers have no
# persistent keypair file, so inject the secret as a JSON byte array in the
# ADMIN_KEYPAIR_JSON env var; we write it to a tmp file and point ADMIN_KEYPAIR
# at it. (Devnet test key — never a mainnet/real-funds key.)
set -e

if [ -n "$ADMIN_KEYPAIR_JSON" ]; then
  printf '%s' "$ADMIN_KEYPAIR_JSON" > /tmp/admin-keypair.json
  chmod 600 /tmp/admin-keypair.json
  export ADMIN_KEYPAIR=/tmp/admin-keypair.json
fi

exec "$@"
