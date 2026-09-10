#!/usr/bin/env bash
# Captures verbose jest output for the commit-reveal suite, for the report.
cd /home/swayam/haazir
npx jest --config packages/chaincode/jest.config.js --rootDir packages/chaincode \
  --verbose -t 'commit-reveal' 2>&1 \
  | grep -aE '✓|✗|commit-reveal|Tests:|Suites:'
