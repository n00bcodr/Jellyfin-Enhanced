#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export DOTNET_PROCESSOR_COUNT="${DOTNET_PROCESSOR_COUNT:-2}"
# Shared checkout: serialize compilation with other rewrite validation workers.
flock "${JE_VALIDATION_LOCK:-$repo_root/../je-v12-validation.lock}" \
    dotnet run --project "$repo_root/tools/ClientContracts/ClientContracts.csproj" \
    --configuration Release -- "$repo_root" "$@"
