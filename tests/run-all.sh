#!/usr/bin/env bash
# Run each test file in its own process.
#
# Most tests run under tsx (Node runtime) because they use better-sqlite3,
# which is not yet supported under Bun. A small set of tests touch the TUI
# layer (@oh-my-pi/pi-tui), which transitively imports the `bun` module via
# @oh-my-pi/pi-utils/frontmatter — those must run under `bun test`.
set -euo pipefail

PASS=0

# Test files that pull in @oh-my-pi/pi-tui (→ bun) and need the Bun runtime.
BUN_TESTS=(
  "tests/handlers/resources-discover.test.ts"
  "tests/handlers/skills-command.test.ts"
)

is_bun_test() {
  local f="$1"
  for b in "${BUN_TESTS[@]}"; do
    if [ "$b" = "$f" ]; then return 0; fi
  done
  return 1
}

for f in $(find tests -name '*.test.ts' | sort); do
  echo "--- $f ---"
  if is_bun_test "$f"; then
    bun test "$f" || { echo "FAILED: $f"; exit 1; }
  else
    npx tsx --test "$f" || { echo "FAILED: $f"; exit 1; }
  fi
  PASS=$((PASS + 1))
done

echo "All $PASS test files passed"
