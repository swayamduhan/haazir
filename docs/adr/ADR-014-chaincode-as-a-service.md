# ADR-014: Chaincode as a Service Instead of Peer-Built Images

**Status:** Accepted, implemented
**Discovered:** during Milestone 2 build, not planning

## Context

By default a Fabric peer builds the chaincode's Docker image itself: it
streams a build context to the Docker daemon and runs the resulting container.

On this environment that fails:

```
docker image build failed: write unix @->/var/run/docker.sock: write: broken pipe
```

Investigation isolated the fault precisely:

- The **legacy Docker build API works** — `DOCKER_BUILDKIT=0 docker build`
  succeeds, so this is not the BuildKit transition.
- **The same chaincode image builds by hand**, from `fabric-nodeenv:2.5`,
  with `npm install` completing normally.
- Memory was not the constraint: 5.2 GiB free, no OOM kills.
- `hyperledger/fabric-nodeenv:2.5` was present.

So the chaincode is fine, Docker is fine, and the incompatibility is
specifically between **Fabric 2.5.9's vendored Docker client** and **Docker
Desktop 29.6.1's daemon**. The peer streams the build context and the daemon
closes the connection mid-write.

## Decision

Deploy as Chaincode as a Service. We build the image and run the container;
the peer connects over gRPC to an address declared in the package's
`connection.json` and never builds anything.

**Each organization runs its own chaincode service, with its own package id.**

That second point is not incidental. A single shared container would mean one
party's process producing the endorsements of *both* endorsing organizations —
whoever operated it could return the same fabricated result to Registrar and
ExamCell alike, and the `AND` policy would be satisfied by one dishonest
party. It would hollow out precisely the guarantee ADR-008 exists to provide.
Package ids may legitimately differ per organization; only the chaincode
*definition* — name, version, sequence, policy — must agree.

## Consequences

**Immune to Docker version churn.** The peer no longer needs a compatible
Docker daemon at all, removing a whole class of environment fragility.

**A stronger story, not a workaround.** CCaaS is supported first-class in
Fabric 2.5 and is what production deployments use; peer-built images are the
development convenience. The external builder was already configured on the
peers — it declined only because our package was typed `node` rather than
`ccaas`.

**Deployment has more moving parts.** Three containers to build, run, and tear
down, and the package id must be known before the container starts, so
install must precede launch. `deploy-ccaas.sh` sequences this.

**Alternatives rejected.** Downgrading Docker Desktop would keep the original
plan but is disruptive to the machine and affects unrelated projects. Probing
Docker API version negotiation might have worked but leaves the deployment
permanently dependent on a version relationship outside our control.
