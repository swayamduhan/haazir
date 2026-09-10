/**
 * Determinism rules for packages/chaincode and packages/shared.
 *
 * Non-deterministic chaincode fails endorsement intermittently, because peers
 * disagree without any one being wrong. See docs/determinism-checklist.md.
 *
 * Replaces Slither/Mythril, which target the EVM and have no role in a
 * Fabric system.
 */
module.exports = {
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
};
