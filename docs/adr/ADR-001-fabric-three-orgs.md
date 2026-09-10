# ADR-001: Hyperledger Fabric, Three Organizations Minimum

**Status:** Accepted (retained from `HANDOFF.md` §2)

## Context

A single-organization Fabric network is cryptographically indistinguishable
from a signed, hash-chained log held by one party. If one institution runs
every peer, "the record cannot be altered" reduces to "we promise not to".

## Decision

Three organizations, each with its own peer and MSP: **Registrar** (identity
enrolment), **ExamCell** (policy and eligibility), and **Audit** (external
oversight — a student ombudsman committee or a UGC-facing node).

## Consequences

Multi-organization consensus is what makes "no single party holds the record"
literally true rather than rhetorical, and it is enforced by ADR-008.

Audit's value is structural: it is not trusted to *do* anything, it is
positioned so that it would *see* everything. Rewriting history requires
collusion between organizations with different institutional interests.

The cost is operational: three peers, three CouchDB instances, four CAs, and
an orderer — roughly ten containers, needing 6-8 GB to run locally.
