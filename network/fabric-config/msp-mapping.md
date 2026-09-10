# Organization to MSP Mapping

| Spec role (§3) | MSP ID | fabric-samples org | Peer address | Endorses |
|---|---|---|---|---|
| Registrar | `RegistrarMSP` | Org1 | `localhost:7051` | Yes — required |
| Exam Cell (COE) | `ExamCellMSP` | Org2 | `localhost:9051` | Yes — required |
| Audit | `AuditMSP` | Org3 | `localhost:11051` | No — commits and reads only |

Infrastructure names (`peer0.org1.example.com`) are inherited from
`fabric-samples` and appear only in container logs. The **MSP ID** is the
identity that appears in endorsement policies, chaincode authorization checks,
and the `enrolledBy` field — it is what carries meaning.

The mapping is applied to `fabric-samples` by
`network/scripts/apply-msp-rename.sh` and read from
`network/fabric-config/msp-ids.env`, so switching between Phase A (stock
`Org1MSP` identifiers) and Phase B (these) is a single-file change.

## Why Audit's read-only status is not merely administrative

As a channel member, Audit can technically submit a transaction proposal. What
prevents any effect is that the endorsement policy does not include Audit, so
nothing it proposes can gather sufficient endorsement to commit. Enforcement is
cryptographic and consensus-level.

Audit still runs a chaincode service, installs the chaincode, and commits every
block — it holds a complete, independently verifiable copy of the ledger
without being able to authorise a single write. That asymmetry is the point.
