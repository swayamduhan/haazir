import tsParser from '@typescript-eslint/parser';

/**
 * Determinism rules for packages/chaincode and packages/shared.
 *
 * Non-deterministic chaincode fails endorsement intermittently, because peers
 * disagree without any one being wrong. See docs/determinism-checklist.md.
 *
 * Replaces Slither/Mythril, which target the EVM and have no role in a
 * Fabric system.
 *
 * Run with `npm run lint:determinism`. Until that script existed this file
 * was documentation describing a check nobody could run.
 */
export default [
  {
    files: ['packages/chaincode/src/**/*.ts', 'packages/shared/src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    rules: {
      'no-restricted-syntax': ['error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            'Determinism: use txTimestampMs(ctx). new Date(ms) with an explicit argument is fine.',
        },
        {
          selector: "MemberExpression[object.name='Date'][property.name='now']",
          message: 'Determinism: use txTimestampMs(ctx) — peers would disagree.',
        },
        {
          selector: "MemberExpression[object.name='Math'][property.name='random']",
          message: 'Determinism: derive from ctx.stub.getTxID() instead.',
        },
        {
          // ECMAScript specifies these as implementation-approximated: any
          // approximation conforms and correct rounding is not required. Peers
          // on different Node builds may legitimately disagree in the last ulp,
          // which at a geofence boundary flips accept to reject. See ADR-018.
          selector:
            "MemberExpression[object.name='Math']"
            + "[property.name=/^(sin|cos|tan|asin|acos|atan|atan2|log|log2|log10|exp|pow|cbrt|hypot)$/]",
          message:
            'Determinism: Math trigonometrics and logarithms are '
            + 'implementation-approximated. Use integer arithmetic — see '
            + 'packages/shared/src/geo.ts and ADR-018.',
        },
      ],
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'fs', message: 'Determinism: chaincode must not touch the filesystem.' },
          { name: 'http', message: 'Determinism: chaincode must not make network calls.' },
          { name: 'https', message: 'Determinism: chaincode must not make network calls.' },
          { name: 'net', message: 'Determinism: chaincode must not make network calls.' },
        ],
      }],
    },
  },
];
