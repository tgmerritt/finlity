#!/usr/bin/env bash
# scripts/ci-pip-audit.sh
#
# Runs pip-audit against the pinned set in requirements.txt.
#
# We pass `--disable-pip` so pip-audit does NOT spin up a sandbox venv and
# try to `pip install -r requirements.txt`. That sandbox install fails on
# this repo because requirements.txt is generated with `--generate-hashes`
# (require-hashes mode) and pip-audit's resolver can't satisfy hash mode
# without help. With `--disable-pip`, pip-audit resolves the listed packages
# against its own dependency-source backends (PyPI JSON / OSV) -- which is
# all we need for a vuln scan.
#
# Each non-comment, non-blank line in .pip-audit-ignore at the repo root is
# converted into a `--ignore-vuln <id>` flag. If the file is missing or has
# no entries, pip-audit is invoked with no ignore flags. Any vuln NOT listed
# fails the step (non-zero exit propagates).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IGNORE_FILE="${REPO_ROOT}/.pip-audit-ignore"

ignore_args=()
if [[ -f "${IGNORE_FILE}" ]]; then
    while IFS= read -r raw_line || [[ -n "${raw_line}" ]]; do
        # Strip everything after `#` (handles inline comments) and trim whitespace.
        line="${raw_line%%#*}"
        line="${line#"${line%%[![:space:]]*}"}"
        line="${line%"${line##*[![:space:]]}"}"
        if [[ -n "${line}" ]]; then
            ignore_args+=(--ignore-vuln "${line}")
        fi
    done < "${IGNORE_FILE}"
fi

echo "Running pip-audit on requirements.txt with $((${#ignore_args[@]} / 2)) ignore flags expanded from ${IGNORE_FILE}..."
# `${ignore_args[@]+...}` guard handles the empty-array case under `set -u`
# (older bash 3.2, including macOS, errors on bare ${arr[@]} when empty).
exec pip-audit -r "${REPO_ROOT}/requirements.txt" --desc --disable-pip --no-deps ${ignore_args[@]+"${ignore_args[@]}"}
