#!/usr/bin/env bash
# Per-account setup. Only the operator CLI uses a named AWS profile; runtime access is federated.
set -euo pipefail
exec node "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/setup-cli.mjs" "$@"
