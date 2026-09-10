#!/usr/bin/env bash
# Checks nothing secret is tracked before publishing to a public remote.
# Publishing is hard to reverse: a key pushed once must be treated as leaked
# even if the commit is later removed.
set -uo pipefail
cd /home/swayam/haazir

echo "=== tracked files (count) ==="
git ls-files | wc -l

echo
echo "=== anything that looks like key or crypto material ==="
git ls-files | grep -iE '\.(key|pem|crt|cer|p12|pfx)$|keystore|signcerts|msp/|private' \
  || echo "  none"

echo
echo "=== .env / seed / wallet files ==="
git ls-files | grep -iE '(^|/)\.env|\.seed$|wallet/' || echo "  none"

echo
echo "=== PRIVATE KEY / BEGIN CERTIFICATE blocks in tracked content ==="
git grep -lE 'BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY|BEGIN CERTIFICATE' -- . \
  || echo "  none"

echo
echo "=== long hex/base64 literals outside tests (possible embedded secrets) ==="
git grep -nE '[A-Za-z0-9+/]{60,}={0,2}' -- . \
  ':(exclude)*.test.ts' ':(exclude)package-lock.json' ':(exclude)docs/*' \
  | head -10 || echo "  none"

echo
echo "=== node_modules or build dirs tracked by mistake ==="
git ls-files | grep -E '^(node_modules|build)/' || echo "  none"

echo
echo "=== repo size ==="
du -sh .git
