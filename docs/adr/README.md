# Architecture Decision Records

Each file records one decision: the context, what was chosen, and what it
costs. "We considered X, chose Y, because Z" is the form a viva examination
probes, so the reasoning is written down where it can be cited rather than
reconstructed under questioning.

| ADR | Decision | Source |
|---|---|---|
| [001](ADR-001-fabric-three-orgs.md) | Hyperledger Fabric, three organizations minimum | HANDOFF §2 |
| [002](ADR-002-typescript-chaincode.md) | TypeScript chaincode | HANDOFF §2 |
| [003](ADR-003-fabric-gateway.md) | `@hyperledger/fabric-gateway`, not the legacy SDK | HANDOFF §2 |
| [004](ADR-004-off-chain-nonce-rotation.md) | Nonce rotation computed, never written per tick | HANDOFF §2 |
| [005](ADR-005-biometrics-on-device.md) | Biometrics never leave the device | HANDOFF §2 |
| [006](ADR-006-append-only-corrections.md) | Corrections are superseding records, never edits | HANDOFF §2 |
| [007](ADR-007-commit-reveal-nonce.md) | Commit-reveal nonce seed | Defect C1 |
| [008](ADR-008-endorsement-policy.md) | `AND(Registrar, ExamCell)` endorsement policy | Defect C2 |
| [009](ADR-009-deterministic-identity-ids.md) | Identity ids derived from the transaction id | Defect C3 |
| [010](ADR-010-ledger-timestamps.md) | Ledger timestamps are authoritative | Defect C4 |
| [011](ADR-011-single-chaincode-package.md) | One chaincode package, several contract classes | Spec §4.4 |
| [012](ADR-012-fabric-25-lts.md) | Fabric 2.5 LTS rather than 3.x | Spec §2.4 |
| [013](ADR-013-org-level-authorisation.md) | Organisation-level authorisation for `closeSession` | Discovered in planning |
| [014](ADR-014-chaincode-as-a-service.md) | Chaincode as a Service instead of peer-built images | Discovered in build |
| [015](ADR-015-on-chain-course-roster.md) | The course roster lives on chain | HANDOFF §7 step 6 |
| [016](ADR-016-deferred-nonce-verification.md) | Nonces recorded at marking, verified at close | Follows ADR-007 |
| [017](ADR-017-device-signature-verification.md) | Device signature verified inside the contract | Spec §7.1 |
| [018](ADR-018-integer-geodistance.md) | Geofence distance computed in integers | Discovered in build |
