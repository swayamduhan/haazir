# Haazir Review II Milestone — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A 3-organization Hyperledger Fabric network running locally with `IdentityRegistry` and `SessionManager` chaincode deployed under an enforced `AND(Registrar, ExamCell)` endorsement policy, demonstrated by a CLI script that includes two negative cases.

**Architecture:** One Fabric channel with three orgs (Registrar and ExamCell endorse; Audit commits and reads only). A single chaincode package containing multiple `Contract` classes. A shared TypeScript package holds canonical encoding, hashing, and nonce derivation so chaincode, backend, and (later) mobile cannot diverge. Session nonce seeds use a commit-reveal lifecycle: the seed's hash is committed at session creation and the seed itself revealed at close, making freshness verifiable by consensus rather than by a trusted server.

**Tech Stack:** Hyperledger Fabric 2.5.9 LTS, CouchDB state DB, Raft ordering, TypeScript 5.x, `fabric-contract-api` / `fabric-shim` 2.5.x, `@hyperledger/fabric-gateway` 1.x, Node 20 LTS, Jest + ts-jest, npm workspaces, WSL2 Ubuntu.

**Spec:** `docs/superpowers/specs/2026-09-09-attendance-chain-review-ii-design.md`

## Global Constraints

- **Repository root is `/home/swayam/haazir`, inside the WSL2 Ubuntu filesystem.** Never `/mnt/d`. Fabric bind-mounts TLS material whose `0600` permissions cannot be set under drvfs. (Spec §12)
- **Node 20 LTS.** `fabric-shim` 2.5.x targets Node 18/20. Do not use the system's Node 24. (Spec §12)
- **Fabric 2.5.9**, CA 1.5.12. Not Fabric 3.x. (Spec §2.4)
- **Determinism, in `packages/chaincode` and `packages/shared` only:** no `Math.random`, no `Date.now()`, no zero-argument `new Date()`, no network or filesystem access, no iteration over unordered collections where order affects output. Use `ctx.stub.getTxTimestamp()` for time and `ctx.stub.getTxID()` for unique identifiers. `new Date(deterministicMillis)` **is** permitted — the prohibition is on reading the clock, not on formatting a known instant. (Spec §10.3)
- **Every validation failure returns a specific machine-readable code**, never a generic error. The demo's value depends on showing exactly which check rejected a submission. (Spec §7)
- **Caller identity always comes from `ctx.clientIdentity`**, never from a transaction parameter. (Spec §7)
- **Endorsement policy for all deployed chaincode:** `AND('RegistrarMSP.peer','ExamCellMSP.peer')`. (Spec §4.3)
- **Nonce window epoch is `session.startTime`**, not the Unix epoch. Window length 10 seconds. (Spec §5.2)
- **Commit frequently** — every task ends with a commit. Fabric work is easy to break irrecoverably; commits are the undo button.

## Open Issue Discovered During Planning

**Binding on-chain identity IDs to X.509 client identities is unspecified.**

Spec §7.2 requires `closeSession` to verify that "the caller is the faculty who created it, or holds the `admin` role." This is not implementable as written. `session.facultyID` is an on-chain `identityID` derived from a transaction ID (§6.1); `ctx.clientIdentity.getID()` returns an X.509 distinguished name from the caller's MSP. Nothing in the `HANDOFF.md` §6 data model connects the two, and adding that binding is a real design decision affecting enrolment, key rotation, and every future authorization check.

**Resolution for this milestone:** `closeSession` and `expireSession` enforce the structural check that is genuinely available — the caller's MSP must be `RegistrarMSP` or `ExamCellMSP` — and record `closedBy` / `expiredBy` from `ctx.clientIdentity.getID()` for audit. Per-faculty authorization is deferred to Milestone 3 along with the identity-binding design.

This is a **deviation from spec §7.2** and is recorded as ADR-013 in Task 15. It does not weaken the Review II demonstration: the endorsement policy, not the caller check, is what proves no single party can write.

---

# SESSION 1 — Environment and Network

### Task 1: WSL Environment Preparation

**Files:**
- Create: `C:\Users\swaya\.wslconfig` (Windows side)
- Create: `scripts/verify-env.sh`

**Interfaces:**
- Consumes: nothing
- Produces: Node 20 on PATH in WSL, `peer`/`configtxgen`/`osnadmin` binaries on PATH, `fabric-samples/` cloned at `/home/swayam/fabric-samples`, working `docker` CLI inside WSL

- [ ] **Step 1: Enable Docker Desktop WSL integration**

Manual, on Windows: Docker Desktop → Settings → Resources → WSL Integration → enable **Ubuntu** → Apply & Restart.

- [ ] **Step 2: Set the WSL memory limit**

Create `C:\Users\swaya\.wslconfig`:

```ini
[wsl2]
memory=10GB
processors=8
swap=2GB
```

Then from Windows PowerShell: `wsl --shutdown` and reopen the WSL window. 10GB of 15.7GB leaves headroom for Windows; the network needs 6–8GB (spec §12).

- [ ] **Step 3: Install apt dependencies**

```bash
sudo apt update
sudo apt install -y jq curl git build-essential
```

- [ ] **Step 4: Install Node 20 via nvm**

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm install 20
nvm alias default 20
```

- [ ] **Step 5: Install Fabric 2.5.9 binaries, Docker images, and samples**

```bash
cd ~
curl -sSLO https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh
chmod +x install-fabric.sh
./install-fabric.sh --fabric-version 2.5.9 --ca-version 1.5.12 docker samples binary
echo 'export PATH=$HOME/fabric-samples/bin:$PATH' >> ~/.bashrc
echo 'export FABRIC_CFG_PATH=$HOME/fabric-samples/config' >> ~/.bashrc
source ~/.bashrc
```

This downloads several GB of Docker images. Expect 5–15 minutes.

- [ ] **Step 6: Write the environment verification script**

Create `scripts/verify-env.sh`:

```bash
#!/usr/bin/env bash
# Verifies the WSL toolchain is ready for Fabric work. Exits non-zero on any failure.
set -uo pipefail
fail=0
check() {
  local label="$1" actual="$2" expected="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    printf '  OK    %-22s %s\n' "$label" "$actual"
  else
    printf '  FAIL  %-22s got "%s", want "%s"\n' "$label" "$actual" "$expected"
    fail=1
  fi
}

echo "Environment check:"
check "node"        "$(node --version 2>/dev/null)"        "v20."
check "peer"        "$(peer version 2>/dev/null | head -1)" "2.5"
check "docker"      "$(docker --version 2>/dev/null)"      "Docker version"
check "configtxgen" "$(command -v configtxgen)"            "configtxgen"
check "jq"          "$(jq --version 2>/dev/null)"          "jq-"

if [[ "$PWD" == /mnt/* ]]; then
  echo "  FAIL  filesystem            repo is on /mnt (drvfs); must be in the Linux filesystem"
  fail=1
else
  printf '  OK    %-22s %s\n' "filesystem" "$PWD"
fi

if docker info >/dev/null 2>&1; then
  printf '  OK    %-22s reachable\n' "docker daemon"
else
  echo "  FAIL  docker daemon         not reachable — is Docker Desktop running with WSL integration on?"
  fail=1
fi

[[ $fail -eq 0 ]] && echo "Environment ready." || echo "Environment NOT ready."
exit $fail
```

- [ ] **Step 7: Run the verification script**

```bash
chmod +x scripts/verify-env.sh && ./scripts/verify-env.sh
```

Expected: every line `OK`, final line `Environment ready.`, exit 0. Do not proceed past this task until it passes.

- [ ] **Step 8: Commit**

```bash
git add scripts/verify-env.sh
git commit -m "chore: add WSL environment verification script"
```

---

### Task 2: Repository Scaffolding

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.editorconfig`
- Create: `packages/shared/{package.json,tsconfig.json,jest.config.js}`
- Create: `packages/chaincode/{package.json,tsconfig.json,jest.config.js}`
- Create: `backend/{package.json,tsconfig.json}`
- Create: `README.md`

**Interfaces:**
- Consumes: Task 1's Node 20
- Produces: npm workspace where `@haazir/shared` resolves from `packages/chaincode` and `backend`; `npm test` runs across all packages

- [ ] **Step 1: Create the root workspace manifest**

`package.json`:

```json
{
  "name": "haazir",
  "private": true,
  "version": "0.1.0",
  "description": "Blockchain-based student attendance ledger",
  "workspaces": ["packages/shared", "packages/chaincode", "backend"],
  "engines": { "node": ">=20 <21" },
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "test": "npm run test --workspaces --if-present",
    "lint": "npm run lint --workspaces --if-present"
  },
  "devDependencies": {
    "@types/jest": "^29.5.12",
    "@types/node": "^20.14.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.4",
    "typescript": "^5.4.5"
  }
}
```

- [ ] **Step 2: Create the shared TypeScript config**

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "declaration": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "resolveJsonModule": true
  }
}
```

`experimentalDecorators` is required by `fabric-contract-api`'s `@Transaction()` and `@Info()` decorators.

- [ ] **Step 3: Create the shared package manifest**

`packages/shared/package.json`:

```json
{
  "name": "@haazir/shared",
  "version": "0.1.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "jest"
  }
}
```

`packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*"]
}
```

`packages/shared/jest.config.js`:

```js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.test.ts'],
};
```

- [ ] **Step 4: Create the chaincode package manifest**

`packages/chaincode/package.json`:

```json
{
  "name": "@haazir/chaincode",
  "version": "0.1.0",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "test": "jest",
    "start": "fabric-chaincode-node start"
  },
  "dependencies": {
    "@haazir/shared": "0.1.0",
    "fabric-contract-api": "^2.5.4",
    "fabric-shim": "^2.5.4"
  }
}
```

The `start` script and `main` field are how Fabric launches the chaincode container. Both are mandatory.

`packages/chaincode/tsconfig.json` and `jest.config.js`: identical to Step 3's, adjusted for this directory.

- [ ] **Step 5: Create the backend manifest**

`backend/package.json`:

```json
{
  "name": "@haazir/backend",
  "version": "0.1.0",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "demo": "node dist/cli/demo.js"
  },
  "dependencies": {
    "@grpc/grpc-js": "^1.10.9",
    "@haazir/shared": "0.1.0",
    "@hyperledger/fabric-gateway": "^1.5.1"
  }
}
```

`backend/tsconfig.json`: as Step 3's, adjusted.

- [ ] **Step 6: Install and verify the workspace links**

```bash
npm install
ls -l node_modules/@haazir/shared
```

Expected: a symlink pointing to `../../packages/shared`. If it is a real directory, the workspace configuration is wrong.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold npm workspace with shared, chaincode, and backend packages"
```

---

### Task 3: Phase A — Three-Organization Network to Green

Spec §4.2: reach a working network using stock `fabric-samples` tooling *before* attempting any customization, and commit it as a fallback.

**Files:**
- Create: `network/scripts/network-up.sh`, `network/scripts/network-down.sh`
- Create: `network/README.md`

**Interfaces:**
- Consumes: Task 1's `fabric-samples` at `~/fabric-samples`
- Produces: a running network on channel `attendance-channel` with three peer organizations joined; `network-up.sh` / `network-down.sh` as the standard lifecycle commands

- [ ] **Step 1: Bring up the stock two-org network with CouchDB**

```bash
cd ~/fabric-samples/test-network
./network.sh down
./network.sh up createChannel -c attendance-channel -ca -s couchdb
```

Expected: containers for two peers, two CouchDB instances, one orderer, and three CAs. Verify with `docker ps --format '{{.Names}}'`.

Spec §4.1 requires CouchDB, and switching state databases later means rebuilding from scratch — hence `-s couchdb` now.

- [ ] **Step 2: Add the third organization**

```bash
cd ~/fabric-samples/test-network/addOrg3
./addOrg3.sh up -c attendance-channel -ca -s couchdb
```

- [ ] **Step 3: Verify all three organizations have joined the channel**

```bash
cd ~/fabric-samples/test-network
export PATH=$HOME/fabric-samples/bin:$PATH
export FABRIC_CFG_PATH=$HOME/fabric-samples/config
source ./scripts/envVar.sh

for org in 1 2 3; do
  setGlobals $org
  echo "=== Org$org ==="
  peer channel list
done
```

Expected: each org lists `attendance-channel`. This is the Phase A success condition.

- [ ] **Step 4: Write the network lifecycle wrapper scripts**

`network/scripts/network-up.sh`:

```bash
#!/usr/bin/env bash
# Brings up the 3-org attendance network. Idempotent: tears down first.
set -euo pipefail

FABRIC_SAMPLES="${FABRIC_SAMPLES:-$HOME/fabric-samples}"
CHANNEL="${CHANNEL:-attendance-channel}"
TEST_NETWORK="$FABRIC_SAMPLES/test-network"

if [[ ! -d "$TEST_NETWORK" ]]; then
  echo "fabric-samples not found at $FABRIC_SAMPLES — run scripts/verify-env.sh" >&2
  exit 1
fi

echo "==> Tearing down any existing network"
( cd "$TEST_NETWORK" && ./network.sh down )

echo "==> Starting 2-org network with CouchDB on channel $CHANNEL"
( cd "$TEST_NETWORK" && ./network.sh up createChannel -c "$CHANNEL" -ca -s couchdb )

echo "==> Adding third organization"
( cd "$TEST_NETWORK/addOrg3" && ./addOrg3.sh up -c "$CHANNEL" -ca -s couchdb )

echo "==> Network up. Containers:"
docker ps --format '  {{.Names}}'
```

`network/scripts/network-down.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
FABRIC_SAMPLES="${FABRIC_SAMPLES:-$HOME/fabric-samples}"
( cd "$FABRIC_SAMPLES/test-network" && ./network.sh down )
echo "==> Network down."
```

- [ ] **Step 5: Verify the wrapper scripts work from a clean state**

```bash
chmod +x network/scripts/*.sh
./network/scripts/network-down.sh
./network/scripts/network-up.sh
```

Expected: eleven-ish containers listed, no errors. Definition of Done item 1 (spec §1.2) requires this to work from a clean clone, so it must be the scripts that are exercised, not the raw commands.

- [ ] **Step 6: Commit the fallback**

```bash
git add network/
git commit -m "feat(network): 3-org network bring-up via fabric-samples addOrg3

Phase A per spec 4.2 — stock tooling, Org1/Org2/Org3 MSP IDs.
Committed as a working fallback before Phase B customization."
```

This commit is the safety net. If Task 4 goes badly, `git revert` returns here.

---

### Task 4: Phase B — Rename MSP IDs to Registrar, ExamCell, and Audit

Spec §4.2 calls for renaming the organizations. A full rename touches crypto material, container names, and every script — high risk on this timeline.

**This task renames only the MSP IDs.** The MSP ID is what appears in the endorsement policy (`AND('RegistrarMSP.peer','ExamCellMSP.peer')`), in `enrolledBy`, and in every authorization decision — that is, in all the places a Review II reviewer actually looks. Container and domain names remain `peer0.org1.example.com`, which appears only in infrastructure logs. This captures nearly all of Phase B's presentational value for a fraction of its risk.

**Files:**
- Create: `network/fabric-config/msp-mapping.md`
- Create: `network/scripts/set-org-env.sh`

**Interfaces:**
- Consumes: Task 3's running network
- Produces: `set-org-env.sh` exporting `CORE_PEER_LOCALMSPID` as `RegistrarMSP` / `ExamCellMSP` / `AuditMSP`; the canonical org-number-to-MSP mapping

- [ ] **Step 1: Document the mapping**

`network/fabric-config/msp-mapping.md`:

```markdown
# Organization to MSP Mapping

| Spec role (§3) | MSP ID | fabric-samples org | Peer address | Endorses |
|---|---|---|---|---|
| Registrar | `RegistrarMSP` | Org1 | `localhost:7051` | Yes — required |
| Exam Cell (COE) | `ExamCellMSP` | Org2 | `localhost:9051` | Yes — required |
| Audit | `AuditMSP` | Org3 | `localhost:11051` | No — commits and reads only |

Infrastructure names (`peer0.org1.example.com`) are inherited from
`fabric-samples` and appear only in container logs. The MSP ID is the
identity that appears in endorsement policies, chaincode authorization
checks, and the `enrolledBy` field — it is what carries meaning.
```

- [ ] **Step 2: Write the organization environment helper**

`network/scripts/set-org-env.sh`:

```bash
#!/usr/bin/env bash
# Usage: source network/scripts/set-org-env.sh <registrar|examcell|audit>
# Exports the peer CLI environment for the named organization.

FABRIC_SAMPLES="${FABRIC_SAMPLES:-$HOME/fabric-samples}"
TEST_NETWORK="$FABRIC_SAMPLES/test-network"
ORG_PATH="$TEST_NETWORK/organizations/peerOrganizations"

case "${1:-}" in
  registrar) _num=1; _msp="RegistrarMSP"; _port=7051  ;;
  examcell)  _num=2; _msp="ExamCellMSP";  _port=9051  ;;
  audit)     _num=3; _msp="AuditMSP";     _port=11051 ;;
  *) echo "Usage: source set-org-env.sh <registrar|examcell|audit>" >&2; return 1 ;;
esac

export PATH="$FABRIC_SAMPLES/bin:$PATH"
export FABRIC_CFG_PATH="$FABRIC_SAMPLES/config"
export CORE_PEER_TLS_ENABLED=true
export CORE_PEER_LOCALMSPID="$_msp"
export CORE_PEER_TLS_ROOTCERT_FILE="$ORG_PATH/org${_num}.example.com/peers/peer0.org${_num}.example.com/tls/ca.crt"
export CORE_PEER_MSPCONFIGPATH="$ORG_PATH/org${_num}.example.com/users/Admin@org${_num}.example.com/msp"
export CORE_PEER_ADDRESS="localhost:${_port}"
export ORDERER_CA="$TEST_NETWORK/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/msp/tlscacerts/tlsca.example.com-cert.pem"

echo "Environment set for $1 ($_msp) at localhost:$_port"
```

- [ ] **Step 3: Rename the MSP IDs in the channel configuration**

The MSP ID is declared per organization in `configtx.yaml`. Edit `~/fabric-samples/test-network/configtx/configtx.yaml` and change each organization's `ID` field — `Org1MSP` → `RegistrarMSP`, `Org2MSP` → `ExamCellMSP` — leaving `Name` and `MSPDir` untouched. Do the same for `Org3MSP` → `AuditMSP` in `~/fabric-samples/test-network/addOrg3/configtx.yaml`.

Then set the matching `CORE_PEER_LOCALMSPID` for each peer container in `~/fabric-samples/test-network/compose/compose-test-net.yaml` and `.../addOrg3/compose/compose-org3.yaml`.

- [ ] **Step 4: Rebuild the network with the new MSP IDs**

```bash
./network/scripts/network-up.sh
```

MSP IDs are baked into the genesis block, so the network must be rebuilt, not restarted.

- [ ] **Step 5: Verify each organization reports its new MSP ID**

```bash
source network/scripts/set-org-env.sh registrar && peer channel list
source network/scripts/set-org-env.sh examcell  && peer channel list
source network/scripts/set-org-env.sh audit     && peer channel list
```

Expected: all three list `attendance-channel` with no MSP mismatch errors.

**If this fails and is not resolved within about 30 minutes**, revert to Task 3's commit and proceed with Org1/Org2/Org3. Spec §14 makes this explicitly optional; the report names the organizations correctly regardless. Do not let this consume the session.

- [ ] **Step 6: Commit**

```bash
git add network/
git commit -m "feat(network): map organizations to Registrar, ExamCell, and Audit MSP IDs

Phase B per spec 4.2, scoped to MSP IDs only. Container and domain names
remain fabric-samples defaults; MSP IDs carry the semantics that appear
in endorsement policies and authorization checks."
```

---

### Task 5: Prove the Endorsement Policy

Spec §4.3: the negative demonstration is a required deliverable. This task proves the policy works using stock sample chaincode, before any project code depends on it.

**Files:**
- Create: `network/scripts/deploy-chaincode.sh`
- Create: `network/scripts/prove-endorsement-policy.sh`

**Interfaces:**
- Consumes: Task 4's network and `set-org-env.sh`
- Produces: `deploy-chaincode.sh <path> <name> <version>` — the reusable deployment command used again in Task 12

- [ ] **Step 1: Write the deployment script**

`network/scripts/deploy-chaincode.sh`:

```bash
#!/usr/bin/env bash
# Usage: deploy-chaincode.sh <chaincode-path> <name> <version> [sequence]
# Installs, approves for Registrar and ExamCell, and commits under the
# AND(Registrar, ExamCell) endorsement policy required by spec 4.3.
set -euo pipefail

CC_PATH="$1"; CC_NAME="$2"; CC_VERSION="$3"; CC_SEQUENCE="${4:-1}"
CHANNEL="${CHANNEL:-attendance-channel}"
POLICY="AND('RegistrarMSP.peer','ExamCellMSP.peer')"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Packaging $CC_NAME v$CC_VERSION (sequence $CC_SEQUENCE)"
source "$HERE/set-org-env.sh" registrar
peer lifecycle chaincode package "/tmp/${CC_NAME}.tar.gz" \
  --path "$CC_PATH" --lang node --label "${CC_NAME}_${CC_VERSION}"

for org in registrar examcell audit; do
  echo "==> Installing on $org"
  source "$HERE/set-org-env.sh" "$org"
  peer lifecycle chaincode install "/tmp/${CC_NAME}.tar.gz" 2>&1 | tail -2
done

source "$HERE/set-org-env.sh" registrar
PACKAGE_ID=$(peer lifecycle chaincode queryinstalled --output json \
  | jq -r ".installed_chaincodes[] | select(.label==\"${CC_NAME}_${CC_VERSION}\") | .package_id")
echo "==> Package ID: $PACKAGE_ID"

# Audit deliberately does NOT approve: it is not part of the endorsement policy (spec 3).
for org in registrar examcell; do
  echo "==> Approving for $org"
  source "$HERE/set-org-env.sh" "$org"
  peer lifecycle chaincode approveformyorg \
    -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
    --tls --cafile "$ORDERER_CA" --channelID "$CHANNEL" --name "$CC_NAME" \
    --version "$CC_VERSION" --package-id "$PACKAGE_ID" \
    --sequence "$CC_SEQUENCE" --signature-policy "$POLICY"
done

echo "==> Checking commit readiness"
peer lifecycle chaincode checkcommitreadiness --channelID "$CHANNEL" \
  --name "$CC_NAME" --version "$CC_VERSION" --sequence "$CC_SEQUENCE" \
  --signature-policy "$POLICY" --output json

echo "==> Committing"
source "$HERE/set-org-env.sh" registrar
REG_TLS="$CORE_PEER_TLS_ROOTCERT_FILE"
source "$HERE/set-org-env.sh" examcell
peer lifecycle chaincode commit \
  -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
  --tls --cafile "$ORDERER_CA" --channelID "$CHANNEL" --name "$CC_NAME" \
  --version "$CC_VERSION" --sequence "$CC_SEQUENCE" --signature-policy "$POLICY" \
  --peerAddresses localhost:7051 --tlsRootCertFiles "$REG_TLS" \
  --peerAddresses localhost:9051 --tlsRootCertFiles "$CORE_PEER_TLS_ROOTCERT_FILE"

echo "==> Deployed $CC_NAME v$CC_VERSION under policy: $POLICY"
```

- [ ] **Step 2: Deploy the sample chaincode**

```bash
chmod +x network/scripts/*.sh
./network/scripts/deploy-chaincode.sh \
  ~/fabric-samples/asset-transfer-basic/chaincode-typescript basic 1.0
```

Expected: `checkcommitreadiness` shows `RegistrarMSP: true`, `ExamCellMSP: true`, `AuditMSP: false`, and the commit succeeds. Audit showing `false` is correct — it is not in the policy.

- [ ] **Step 3: Write the endorsement policy proof script**

`network/scripts/prove-endorsement-policy.sh`:

```bash
#!/usr/bin/env bash
# Demonstrates that AND(Registrar, ExamCell) is enforced:
# a write endorsed by Registrar alone MUST be rejected.
set -uo pipefail

CHANNEL="${CHANNEL:-attendance-channel}"
CC_NAME="${CC_NAME:-basic}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

source "$HERE/set-org-env.sh" registrar
REG_TLS="$CORE_PEER_TLS_ROOTCERT_FILE"
source "$HERE/set-org-env.sh" examcell
EXAM_TLS="$CORE_PEER_TLS_ROOTCERT_FILE"
source "$HERE/set-org-env.sh" registrar

echo
echo "=============================================================="
echo " NEGATIVE CASE: write endorsed by Registrar ALONE"
echo " Expected: REJECTED — the policy requires both organizations"
echo "=============================================================="
if peer chaincode invoke -o localhost:7050 \
  --ordererTLSHostnameOverride orderer.example.com --tls --cafile "$ORDERER_CA" \
  -C "$CHANNEL" -n "$CC_NAME" \
  --peerAddresses localhost:7051 --tlsRootCertFiles "$REG_TLS" \
  -c '{"function":"CreateAsset","Args":["solo-1","blue","5","tomoko","300"]}' 2>&1
then
  echo ">>> UNEXPECTED SUCCESS — the endorsement policy is NOT being enforced."
  echo ">>> Check that deploy-chaincode.sh passed --signature-policy on commit."
  exit 1
else
  echo ">>> Correctly rejected. No single organization can write alone."
fi

echo
echo "=============================================================="
echo " POSITIVE CASE: write endorsed by Registrar AND ExamCell"
echo " Expected: ACCEPTED"
echo "=============================================================="
if peer chaincode invoke -o localhost:7050 \
  --ordererTLSHostnameOverride orderer.example.com --tls --cafile "$ORDERER_CA" \
  -C "$CHANNEL" -n "$CC_NAME" \
  --peerAddresses localhost:7051 --tlsRootCertFiles "$REG_TLS" \
  --peerAddresses localhost:9051 --tlsRootCertFiles "$EXAM_TLS" \
  -c '{"function":"CreateAsset","Args":["duo-1","blue","5","tomoko","300"]}' 2>&1
then
  echo ">>> Accepted, as expected."
else
  echo ">>> UNEXPECTED FAILURE — both organizations endorsed but the write failed."
  exit 1
fi
```

- [ ] **Step 4: Run the proof**

```bash
chmod +x network/scripts/prove-endorsement-policy.sh
./network/scripts/prove-endorsement-policy.sh
```

Expected: the negative case rejected with `ENDORSEMENT_POLICY_FAILURE`, the positive case accepted, exit 0.

This is the single most important result of Session 1. It is the direct evidence for the project's central claim (spec §1.2 item 4).

- [ ] **Step 5: Commit**

```bash
git add network/scripts/
git commit -m "feat(network): deploy under AND(Registrar,ExamCell) and prove enforcement

Adds the reusable deployment script and the negative demonstration
required by spec 1.2 item 4: a single-org write is rejected."
```

---

# SESSION 2 — Contracts, Demo, and Documentation

### Task 6: Shared Package — Canonical Encoding

Spec §8: signature verification breaks if any two consumers serialize a payload differently. One implementation, tested.

**Files:**
- Create: `packages/shared/src/canonical.ts`
- Test: `packages/shared/test/canonical.test.ts`

**Interfaces:**
- Consumes: Task 2's workspace
- Produces: `canonicalize(value: unknown): string`

- [ ] **Step 1: Write the failing test**

`packages/shared/test/canonical.test.ts`:

```ts
import { canonicalize } from '../src/canonical';

describe('canonicalize', () => {
  it('produces identical output regardless of key insertion order', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it('sorts keys lexicographically', () => {
    expect(canonicalize({ zebra: 1, apple: 2 })).toBe('{"apple":2,"zebra":1}');
  });

  it('sorts keys in nested objects', () => {
    expect(canonicalize({ outer: { b: 1, a: 2 } })).toBe('{"outer":{"a":2,"b":1}}');
  });

  it('preserves array order, which is semantic', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('omits undefined properties rather than emitting them', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('round-trips through JSON.parse', () => {
    const original = { session: 'S1', windows: [0, 1, 2], nested: { ok: true } };
    expect(JSON.parse(canonicalize(original))).toEqual(original);
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalize({ a: NaN })).toThrow(/non-finite/);
    expect(() => canonicalize({ a: Infinity })).toThrow(/non-finite/);
  });

  it('rejects non-integer numbers, whose formatting is not portable', () => {
    expect(() => canonicalize({ a: 1.5 })).toThrow(/integer/);
  });

  it('rejects integers beyond safe range', () => {
    expect(() => canonicalize({ a: Number.MAX_SAFE_INTEGER + 2 })).toThrow(/integer/);
  });
});
```

Floating-point values are rejected deliberately: their string formatting varies across platforms, which is exactly the divergence this module exists to prevent. Every numeric field in the spec §6 data model is an integer.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test --workspace @haazir/shared
```

Expected: FAIL — `Cannot find module '../src/canonical'`.

- [ ] **Step 3: Implement**

`packages/shared/src/canonical.ts`:

```ts
/**
 * Deterministic serialization for anything hashed or signed.
 *
 * Object keys are sorted lexicographically; arrays keep their order because
 * it is semantic; undefined properties are omitted. Numbers must be safe
 * integers — floating-point formatting is not portable across platforms,
 * and a mismatch here surfaces as "valid signatures are rejected", which is
 * expensive to diagnose. See spec section 8.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null) return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`canonicalize: non-finite number (${value})`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new Error(`canonicalize: number must be a safe integer (${value})`);
    }
    return value;
  }

  if (typeof value === 'string' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) return value.map(normalize);

  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      result[key] = normalize(source[key]);
    }
    return result;
  }

  throw new Error(`canonicalize: unsupported type ${typeof value}`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm test --workspace @haazir/shared
```

Expected: 9 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add canonical encoding for signed payloads"
```

---

### Task 7: Shared Package — Hashing, Nonce Derivation, and Types

**Files:**
- Create: `packages/shared/src/{config.ts,types.ts,hashing.ts,nonce.ts,index.ts}`
- Test: `packages/shared/test/{hashing.test.ts,nonce.test.ts}`

**Interfaces:**
- Consumes: `canonicalize` from Task 6
- Produces:
  - `sha256Hex(data: string | Buffer): string`
  - `commitSeed(seedHex: string): string`
  - `hashPublicKey(publicKeyHex: string): string`
  - `deriveIdentityId(txId: string): string`
  - `windowFor(nowMs: number, startTimeMs: number): number`
  - `deriveNonce(seedHex: string, window: number): string`
  - `isEd25519PublicKey(v: string): boolean`, `isSha256Hex(v: string): boolean`
  - Types `Identity`, `Session`, `KeyRevocationEvent`, `Role`, `SessionStatus`
  - Constants `NONCE_WINDOW_SEC = 10`, `DEFAULT_GRACE_PERIOD_SEC = 900`, `MAX_SESSION_DURATION_SEC = 14400`

- [ ] **Step 1: Write the failing tests**

`packages/shared/test/hashing.test.ts`:

```ts
import { sha256Hex, commitSeed, hashPublicKey, deriveIdentityId,
         isEd25519PublicKey, isSha256Hex } from '../src';

describe('sha256Hex', () => {
  it('matches the known digest of the empty string', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
  it('is deterministic across calls', () => {
    expect(sha256Hex('haazir')).toBe(sha256Hex('haazir'));
  });
});

describe('commitSeed', () => {
  const seed = 'a'.repeat(64);
  it('produces a 64-character hex digest', () => {
    expect(commitSeed(seed)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('hashes the seed bytes, not the hex text', () => {
    expect(commitSeed(seed)).toBe(sha256Hex(Buffer.from(seed, 'hex')));
  });
  it('differs for different seeds', () => {
    expect(commitSeed(seed)).not.toBe(commitSeed('b'.repeat(64)));
  });
  it('rejects a malformed seed', () => {
    expect(() => commitSeed('nothex')).toThrow(/32-byte hex/);
  });
});

describe('deriveIdentityId', () => {
  it('is deterministic for the same transaction id', () => {
    expect(deriveIdentityId('tx-abc')).toBe(deriveIdentityId('tx-abc'));
  });
  it('differs for different transaction ids', () => {
    expect(deriveIdentityId('tx-abc')).not.toBe(deriveIdentityId('tx-def'));
  });
  it('has UUID shape', () => {
    expect(deriveIdentityId('tx-abc')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe('validators', () => {
  it('accepts a 64-char hex ed25519 public key', () => {
    expect(isEd25519PublicKey('c'.repeat(64))).toBe(true);
  });
  it('rejects wrong length or non-hex', () => {
    expect(isEd25519PublicKey('c'.repeat(63))).toBe(false);
    expect(isEd25519PublicKey('z'.repeat(64))).toBe(false);
  });
  it('recognises a sha256 hex digest', () => {
    expect(isSha256Hex(sha256Hex('x'))).toBe(true);
    expect(isSha256Hex('abc')).toBe(false);
  });
});

describe('hashPublicKey', () => {
  it('produces a sha256 digest of the key', () => {
    const pk = 'c'.repeat(64);
    expect(hashPublicKey(pk)).toBe(sha256Hex(pk));
  });
});
```

`packages/shared/test/nonce.test.ts`:

```ts
import { windowFor, deriveNonce, NONCE_WINDOW_SEC } from '../src';

const START = Date.parse('2026-09-09T10:00:00.000Z');
const SEED = 'ab'.repeat(32);

describe('windowFor', () => {
  it('returns window 0 at the session start instant', () => {
    expect(windowFor(START, START)).toBe(0);
  });
  it('stays in window 0 until the window length elapses', () => {
    expect(windowFor(START + 9_999, START)).toBe(0);
  });
  it('advances to window 1 exactly at the boundary', () => {
    expect(windowFor(START + 10_000, START)).toBe(1);
  });
  it('counts from session start, not the unix epoch', () => {
    const otherStart = START + 3_600_000;
    expect(windowFor(otherStart + 25_000, otherStart)).toBe(2);
  });
  it('rejects a time before the session start', () => {
    expect(() => windowFor(START - 1, START)).toThrow(/before session start/);
  });
  it('uses a ten second window', () => {
    expect(NONCE_WINDOW_SEC).toBe(10);
  });
});

describe('deriveNonce', () => {
  it('is deterministic for the same seed and window', () => {
    expect(deriveNonce(SEED, 5)).toBe(deriveNonce(SEED, 5));
  });
  it('differs between adjacent windows, defeating replay', () => {
    expect(deriveNonce(SEED, 5)).not.toBe(deriveNonce(SEED, 6));
  });
  it('differs between seeds for the same window', () => {
    expect(deriveNonce(SEED, 5)).not.toBe(deriveNonce('cd'.repeat(32), 5));
  });
  it('produces a 64-character hex digest', () => {
    expect(deriveNonce(SEED, 0)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('rejects a negative or non-integer window', () => {
    expect(() => deriveNonce(SEED, -1)).toThrow(/window/);
    expect(() => deriveNonce(SEED, 1.5)).toThrow(/window/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test --workspace @haazir/shared
```

Expected: FAIL — module `../src` not found.

- [ ] **Step 3: Implement the configuration and types**

`packages/shared/src/config.ts`:

```ts
/** Nonce rotation window, in seconds. Spec section 5.2. */
export const NONCE_WINDOW_SEC = 10;

/** Default grace period for revealing a session seed after nominal end. Spec section 5.4. */
export const DEFAULT_GRACE_PERIOD_SEC = 900;

/** Upper bound on a single session's duration, as a sanity check. Spec section 7.2. */
export const MAX_SESSION_DURATION_SEC = 14_400;
```

`packages/shared/src/types.ts`:

```ts
export type Role = 'student' | 'faculty' | 'admin';
export type IdentityStatus = 'active' | 'revoked';
export type SessionStatus = 'open' | 'closed' | 'expired';
export type RevocationReason =
  'lost_device' | 'graduation' | 'compromise' | 'factory_reset';

export const ROLES: readonly Role[] = ['student', 'faculty', 'admin'];
export const REVOCATION_REASONS: readonly RevocationReason[] =
  ['lost_device', 'graduation', 'compromise', 'factory_reset'];

export interface Identity {
  identityID: string;
  identityHash: string;
  publicKey: string;
  role: Role;
  status: IdentityStatus;
  enrolledBy: string;
  enrolledAt: string;
}

export interface GeoPoint { lat: number; lng: number; }

export interface Session {
  sessionID: string;
  courseID: string;
  facultyID: string;
  room: string;
  /** Scheduled start; anchors the nonce window epoch. Spec section 6.2. */
  startTime: string;
  /** Ledger timestamp of the creating transaction. */
  createdAt: string;
  durationSec: number;
  gracePeriodSec: number;
  geofenceCenter: GeoPoint;
  geofenceRadiusM: number;
  /** SHA-256 of the seed, committed at creation. Never modified. */
  nonceSeedHash: string;
  /** Absent until closeSession reveals it. Spec section 5.2. */
  revealedSeed?: string;
  status: SessionStatus;
  closedAt?: string;
  closedBy?: string;
  expiredAt?: string;
  expiredBy?: string;
}

export interface KeyRevocationEvent {
  eventID: string;
  identityID: string;
  oldPublicKeyHash: string;
  newPublicKey: string;
  reason: RevocationReason;
  authorizedBy: string;
  timestamp: string;
}

/**
 * Verification state derived at read time, so a session past its grace
 * period is never reported as healthy merely because nobody has swept it.
 * Spec section 5.4.
 */
export type VerificationState =
  | 'in_progress'      // open, within its window
  | 'awaiting_reveal'  // open, past nominal end but inside the grace period
  | 'unverified'       // open or expired, past the grace period; seed never revealed
  | 'verified';        // closed, seed revealed and commitment checked
```

- [ ] **Step 4: Implement hashing**

`packages/shared/src/hashing.ts`:

```ts
import { createHash } from 'crypto';
import { canonicalize } from './canonical';

const HEX_64 = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: string): boolean {
  return HEX_64.test(value);
}

/** An ed25519 public key is 32 bytes, represented as 64 lowercase hex characters. */
export function isEd25519PublicKey(value: string): boolean {
  return HEX_64.test(value);
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * The commitment stored on-chain at session creation. Hashes the seed's
 * bytes rather than its hex text, so the commitment is over the value and
 * not over an encoding choice. Spec section 5.2.
 */
export function commitSeed(seedHex: string): string {
  if (!HEX_64.test(seedHex)) {
    throw new Error('commitSeed: seed must be 32-byte hex (64 lowercase hex characters)');
  }
  return sha256Hex(Buffer.from(seedHex, 'hex'));
}

export function hashPublicKey(publicKeyHex: string): string {
  return sha256Hex(publicKeyHex);
}

/** Salted hash linking an on-chain identity to its off-chain record. Spec section 6.1. */
export function hashIdentity(name: string, enrolmentNo: string, saltHex: string): string {
  return sha256Hex(`${canonicalize({ enrolmentNo, name })}|${saltHex}`);
}

/**
 * Derives an identity id from the transaction id.
 *
 * A random UUID cannot be used: every endorsing peer executes the
 * transaction independently and must produce byte-identical output, so any
 * randomness fails endorsement. The transaction id is unique, identical
 * across peers, and not predictable by the submitter. Spec section 6.1.
 */
export function deriveIdentityId(txId: string): string {
  const h = sha256Hex(`identity|${txId}`);
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16),
          h.slice(16, 20), h.slice(20, 32)].join('-');
}

/** Derives a revocation event id from the transaction id, for the same reason. */
export function deriveEventId(txId: string): string {
  return sha256Hex(`revocation|${txId}`).slice(0, 32);
}
```

- [ ] **Step 5: Implement nonce derivation**

`packages/shared/src/nonce.ts`:

```ts
import { createHmac } from 'crypto';
import { NONCE_WINDOW_SEC } from './config';

/**
 * The nonce window containing `nowMs`, counted from the session start.
 *
 * The epoch is the session start, NOT the unix epoch. Left unstated this
 * is the kind of ambiguity that produces intermittent mismatches between
 * the faculty device and any verifier. Spec section 5.2.
 */
export function windowFor(
  nowMs: number, startTimeMs: number, windowSec: number = NONCE_WINDOW_SEC,
): number {
  if (nowMs < startTimeMs) {
    throw new Error('windowFor: time is before session start');
  }
  return Math.floor((nowMs - startTimeMs) / (windowSec * 1000));
}

/**
 * nonce(w) = HMAC-SHA256(key = seed, message = decimal string of w)
 *
 * Computed locally by the faculty device every window, with no ledger
 * interaction — this is what keeps rotation off-chain. Once the seed is
 * revealed at session close, anyone can recompute every window and verify
 * any record without trusting a server. Spec section 5.2.
 */
export function deriveNonce(seedHex: string, window: number): string {
  if (!Number.isInteger(window) || window < 0) {
    throw new Error(`deriveNonce: window must be a non-negative integer (got ${window})`);
  }
  if (!/^[0-9a-f]{64}$/.test(seedHex)) {
    throw new Error('deriveNonce: seed must be 32-byte hex');
  }
  return createHmac('sha256', Buffer.from(seedHex, 'hex'))
    .update(String(window))
    .digest('hex');
}
```

- [ ] **Step 6: Create the package entry point**

`packages/shared/src/index.ts`:

```ts
export * from './canonical';
export * from './config';
export * from './hashing';
export * from './nonce';
export * from './types';
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npm test --workspace @haazir/shared && npm run build --workspace @haazir/shared
```

Expected: all tests passing, `dist/` produced.

- [ ] **Step 8: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add hashing, nonce derivation, types, and config"
```

---

### Task 8: Chaincode Scaffolding and Test Harness

**Files:**
- Create: `packages/chaincode/src/lib/{keys.ts,errors.ts,ledger-time.ts}`
- Create: `packages/chaincode/test/helpers/mock-context.ts`
- Test: `packages/chaincode/test/helpers/mock-context.test.ts`

**Interfaces:**
- Consumes: `@haazir/shared` from Task 7
- Produces:
  - `fail(code: string, message: string): never`, `ChaincodeError`
  - `identityKey(ctx, identityID)`, `identityHashIndexKey(ctx, identityHash)`, `sessionKey(ctx, sessionID)`, `revocationKey(ctx, eventID)`
  - `txTimestampMs(ctx): number`, `txTimestampIso(ctx): string`
  - `makeContext(opts?): Context`, `MockContextOptions`

- [ ] **Step 1: Write the failing test for the mock harness**

`packages/chaincode/test/helpers/mock-context.test.ts`:

```ts
import { makeContext } from './mock-context';
import { txTimestampIso, txTimestampMs } from '../../src/lib/ledger-time';

describe('mock context', () => {
  it('stores and retrieves state', async () => {
    const ctx = makeContext();
    await ctx.stub.putState('k', Buffer.from('v'));
    expect((await ctx.stub.getState('k')).toString()).toBe('v');
  });

  it('returns an empty buffer for a missing key, as Fabric does', async () => {
    const ctx = makeContext();
    expect((await ctx.stub.getState('missing')).length).toBe(0);
  });

  it('exposes a stable transaction id', () => {
    const ctx = makeContext({ txId: 'tx-1' });
    expect(ctx.stub.getTxID()).toBe('tx-1');
  });

  it('converts the ledger timestamp to milliseconds and ISO form', () => {
    const ms = Date.parse('2026-09-09T10:00:00.000Z');
    const ctx = makeContext({ timestampMs: ms });
    expect(txTimestampMs(ctx)).toBe(ms);
    expect(txTimestampIso(ctx)).toBe('2026-09-09T10:00:00.000Z');
  });

  it('exposes the caller MSP and identity', () => {
    const ctx = makeContext({ mspId: 'RegistrarMSP', clientId: 'x509::admin' });
    expect(ctx.clientIdentity.getMSPID()).toBe('RegistrarMSP');
    expect(ctx.clientIdentity.getID()).toBe('x509::admin');
  });

  it('isolates state between contexts', async () => {
    const a = makeContext();
    await a.stub.putState('k', Buffer.from('v'));
    expect((await makeContext().stub.getState('k')).length).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test --workspace @haazir/chaincode
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the error type**

`packages/chaincode/src/lib/errors.ts`:

```ts
/**
 * Every rejection carries a machine-readable code. Spec section 7 requires
 * fail-fast with a specific reason: the demo's value lies in showing which
 * check rejected a submission, not merely that one did.
 */
export class ChaincodeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ChaincodeError';
  }
}

export function fail(code: string, message: string): never {
  throw new ChaincodeError(code, message);
}
```

- [ ] **Step 4: Implement the key builders**

`packages/chaincode/src/lib/keys.ts`:

```ts
import { Context } from 'fabric-contract-api';

/**
 * All lookups use composite keys and plain state reads.
 *
 * Rich queries are deliberately avoided for existence checks: Fabric does
 * not include rich-query results in a transaction's read set, so they are
 * not revalidated at commit and two concurrent writes can both succeed.
 * A composite-key getState IS in the read set and is protected by MVCC.
 * Spec section 2.2, defect C6.
 */
export const IDENTITY = 'identity';
export const IDENTITY_HASH_INDEX = 'identityHash~id';
export const SESSION = 'session';
export const REVOCATION = 'revocation';

export const identityKey = (ctx: Context, identityID: string): string =>
  ctx.stub.createCompositeKey(IDENTITY, [identityID]);

export const identityHashIndexKey = (ctx: Context, identityHash: string): string =>
  ctx.stub.createCompositeKey(IDENTITY_HASH_INDEX, [identityHash]);

export const sessionKey = (ctx: Context, sessionID: string): string =>
  ctx.stub.createCompositeKey(SESSION, [sessionID]);

export const revocationKey = (ctx: Context, eventID: string): string =>
  ctx.stub.createCompositeKey(REVOCATION, [eventID]);

export async function exists(ctx: Context, key: string): Promise<boolean> {
  return (await ctx.stub.getState(key)).length > 0;
}

export async function readJson<T>(ctx: Context, key: string): Promise<T | undefined> {
  const bytes = await ctx.stub.getState(key);
  return bytes.length === 0 ? undefined : (JSON.parse(bytes.toString()) as T);
}
```

- [ ] **Step 5: Implement ledger time**

`packages/chaincode/src/lib/ledger-time.ts`:

```ts
import { Context } from 'fabric-contract-api';

/**
 * Time comes from the ledger, never from the system clock or a parameter.
 *
 * Date.now() would differ between endorsing peers and fail endorsement; a
 * client-supplied timestamp is a claim and permits backdating. Spec section
 * 2.1, defect C4.
 *
 * Note new Date(ms) with an explicit argument is deterministic and allowed;
 * the determinism rule prohibits READING the clock, not formatting a known
 * instant. Spec section 10.3.
 */
export function txTimestampMs(ctx: Context): number {
  const ts = ctx.stub.getTxTimestamp();
  return Number(ts.seconds) * 1000 + Math.round(ts.nanos / 1e6);
}

export function txTimestampIso(ctx: Context): string {
  return new Date(txTimestampMs(ctx)).toISOString();
}
```

- [ ] **Step 6: Implement the mock context**

`packages/chaincode/test/helpers/mock-context.ts`:

```ts
import { Context } from 'fabric-contract-api';

export interface MockContextOptions {
  txId?: string;
  timestampMs?: number;
  mspId?: string;
  clientId?: string;
}

/**
 * An in-memory stand-in for the Fabric chaincode stub, so contract logic
 * can be tested without a running network. Spec section 10.1 relies on
 * this: it decouples contract development from network bring-up, which is
 * the schedule risk.
 */
class MockStub {
  public readonly state = new Map<string, Buffer>();

  constructor(
    private readonly txId: string,
    private readonly timestampMs: number,
  ) {}

  createCompositeKey(objectType: string, attributes: string[]): string {
    return `\u0000${objectType}\u0000${attributes.join('\u0000')}\u0000`;
  }

  async getState(key: string): Promise<Buffer> {
    return this.state.get(key) ?? Buffer.alloc(0);
  }

  async putState(key: string, value: Buffer): Promise<void> {
    this.state.set(key, Buffer.from(value));
  }

  async deleteState(key: string): Promise<void> {
    this.state.delete(key);
  }

  getTxID(): string {
    return this.txId;
  }

  getTxTimestamp(): { seconds: number; nanos: number } {
    return {
      seconds: Math.floor(this.timestampMs / 1000),
      nanos: (this.timestampMs % 1000) * 1_000_000,
    };
  }
}

class MockClientIdentity {
  constructor(private readonly mspId: string, private readonly clientId: string) {}
  getMSPID(): string { return this.mspId; }
  getID(): string { return this.clientId; }
}

export function makeContext(options: MockContextOptions = {}): Context {
  const {
    txId = 'tx-default',
    timestampMs = Date.parse('2026-09-09T10:00:00.000Z'),
    mspId = 'RegistrarMSP',
    clientId = 'x509::CN=admin',
  } = options;

  return {
    stub: new MockStub(txId, timestampMs),
    clientIdentity: new MockClientIdentity(mspId, clientId),
  } as unknown as Context;
}

/** Continues a transaction against existing state, as a new transaction would. */
export function nextTx(previous: Context, options: MockContextOptions = {}): Context {
  const ctx = makeContext(options);
  const source = (previous.stub as unknown as MockStub).state;
  const target = (ctx.stub as unknown as MockStub).state;
  for (const [k, v] of source) target.set(k, v);
  return ctx;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npm test --workspace @haazir/chaincode
```

Expected: 6 passing.

- [ ] **Step 8: Commit**

```bash
git add packages/chaincode
git commit -m "feat(chaincode): add key builders, error codes, ledger time, and mock context"
```

---

### Task 9: IdentityRegistry Contract

**Files:**
- Create: `packages/chaincode/src/contracts/identity-registry.ts`
- Test: `packages/chaincode/test/identity-registry.test.ts`

**Interfaces:**
- Consumes: Tasks 7 and 8
- Produces: class `IdentityRegistry` with `registerIdentity(ctx, identityHash, publicKey, role): Promise<string>`, `getIdentityStatus(ctx, identityID): Promise<string>` (canonical JSON), `revokeAndReissueKey(ctx, identityID, oldPublicKeyHash, newPublicKey, reason): Promise<string>`

Note `revokeAndReissueKey` drops the `authorizedBy` parameter from `HANDOFF.md` §7: the authorizing party is taken from `ctx.clientIdentity`, never from a parameter, or it could be spoofed (spec §6.3).

- [ ] **Step 1: Write the failing tests**

`packages/chaincode/test/identity-registry.test.ts`:

```ts
import { IdentityRegistry } from '../src/contracts/identity-registry';
import { makeContext, nextTx } from './helpers/mock-context';
import { Identity, KeyRevocationEvent, hashPublicKey, sha256Hex } from '@haazir/shared';

const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);
const HASH = sha256Hex('student-1');

const cc = () => new IdentityRegistry();

describe('registerIdentity', () => {
  it('returns a deterministic UUID-shaped identity id', async () => {
    const id = await cc().registerIdentity(makeContext({ txId: 'tx-1' }), HASH, PK_A, 'student');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('stores the identity as active with the ledger timestamp', async () => {
    const ctx = makeContext({ timestampMs: Date.parse('2026-09-09T10:00:00.000Z') });
    const id = await cc().registerIdentity(ctx, HASH, PK_A, 'student');
    const stored: Identity = JSON.parse(await cc().getIdentityStatus(nextTx(ctx), id));
    expect(stored.status).toBe('active');
    expect(stored.role).toBe('student');
    expect(stored.publicKey).toBe(PK_A);
    expect(stored.enrolledAt).toBe('2026-09-09T10:00:00.000Z');
  });

  it('records the enrolling organisation from the client identity', async () => {
    const ctx = makeContext({ mspId: 'RegistrarMSP' });
    const id = await cc().registerIdentity(ctx, HASH, PK_A, 'faculty');
    const stored: Identity = JSON.parse(await cc().getIdentityStatus(nextTx(ctx), id));
    expect(stored.enrolledBy).toContain('RegistrarMSP');
  });

  it('rejects an unknown role', async () => {
    await expect(cc().registerIdentity(makeContext(), HASH, PK_A, 'janitor'))
      .rejects.toThrow(/INVALID_ROLE/);
  });

  it('rejects a malformed public key', async () => {
    await expect(cc().registerIdentity(makeContext(), HASH, 'short', 'student'))
      .rejects.toThrow(/INVALID_PUBLIC_KEY/);
  });

  it('rejects a malformed identity hash', async () => {
    await expect(cc().registerIdentity(makeContext(), 'nothex', PK_A, 'student'))
      .rejects.toThrow(/INVALID_IDENTITY_HASH/);
  });

  it('rejects a duplicate enrolment for the same identity hash', async () => {
    const ctx = makeContext({ txId: 'tx-1' });
    await cc().registerIdentity(ctx, HASH, PK_A, 'student');
    await expect(
      cc().registerIdentity(nextTx(ctx, { txId: 'tx-2' }), HASH, PK_B, 'student'),
    ).rejects.toThrow(/IDENTITY_HASH_EXISTS/);
  });

  it('allows different students to enrol independently', async () => {
    const ctx = makeContext({ txId: 'tx-1' });
    await cc().registerIdentity(ctx, HASH, PK_A, 'student');
    const other = sha256Hex('student-2');
    await expect(
      cc().registerIdentity(nextTx(ctx, { txId: 'tx-2' }), other, PK_B, 'student'),
    ).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('getIdentityStatus', () => {
  it('rejects an unknown identity id', async () => {
    await expect(cc().getIdentityStatus(makeContext(), 'nope'))
      .rejects.toThrow(/IDENTITY_NOT_FOUND/);
  });
});

describe('revokeAndReissueKey', () => {
  const enrol = async () => {
    const ctx = makeContext({ txId: 'tx-1' });
    const id = await cc().registerIdentity(ctx, HASH, PK_A, 'student');
    return { ctx, id };
  };

  it('replaces the active public key', async () => {
    const { ctx, id } = await enrol();
    const ctx2 = nextTx(ctx, { txId: 'tx-2' });
    await cc().revokeAndReissueKey(ctx2, id, hashPublicKey(PK_A), PK_B, 'lost_device');
    const stored: Identity = JSON.parse(await cc().getIdentityStatus(nextTx(ctx2), id));
    expect(stored.publicKey).toBe(PK_B);
    expect(stored.status).toBe('active');
  });

  it('writes a revocation event naming the authorising client', async () => {
    const { ctx, id } = await enrol();
    const ctx2 = nextTx(ctx, { txId: 'tx-2', clientId: 'x509::CN=registrar-admin' });
    const raw = await cc().revokeAndReissueKey(
      ctx2, id, hashPublicKey(PK_A), PK_B, 'compromise');
    const event: KeyRevocationEvent = JSON.parse(raw);
    expect(event.oldPublicKeyHash).toBe(hashPublicKey(PK_A));
    expect(event.newPublicKey).toBe(PK_B);
    expect(event.reason).toBe('compromise');
    expect(event.authorizedBy).toBe('x509::CN=registrar-admin');
  });

  it('rejects a stale old key hash, preventing a rotation race', async () => {
    const { ctx, id } = await enrol();
    await expect(
      cc().revokeAndReissueKey(
        nextTx(ctx, { txId: 'tx-2' }), id, hashPublicKey(PK_B), PK_B, 'lost_device'),
    ).rejects.toThrow(/OLD_KEY_MISMATCH/);
  });

  it('rejects reissuing the same key', async () => {
    const { ctx, id } = await enrol();
    await expect(
      cc().revokeAndReissueKey(
        nextTx(ctx, { txId: 'tx-2' }), id, hashPublicKey(PK_A), PK_A, 'lost_device'),
    ).rejects.toThrow(/KEY_UNCHANGED/);
  });

  it('rejects an unknown revocation reason', async () => {
    const { ctx, id } = await enrol();
    await expect(
      cc().revokeAndReissueKey(
        nextTx(ctx, { txId: 'tx-2' }), id, hashPublicKey(PK_A), PK_B, 'bored'),
    ).rejects.toThrow(/INVALID_REASON/);
  });

  it('rejects an unknown identity', async () => {
    await expect(
      cc().revokeAndReissueKey(makeContext(), 'nope', hashPublicKey(PK_A), PK_B, 'lost_device'),
    ).rejects.toThrow(/IDENTITY_NOT_FOUND/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test --workspace @haazir/chaincode
```

Expected: FAIL — `identity-registry` not found.

- [ ] **Step 3: Implement the contract**

`packages/chaincode/src/contracts/identity-registry.ts`:

```ts
import { Context, Contract, Info, Returns, Transaction } from 'fabric-contract-api';
import {
  canonicalize, deriveEventId, deriveIdentityId, hashPublicKey,
  isEd25519PublicKey, isSha256Hex, Identity, KeyRevocationEvent,
  REVOCATION_REASONS, RevocationReason, Role, ROLES,
} from '@haazir/shared';
import { fail } from '../lib/errors';
import { exists, identityHashIndexKey, identityKey, readJson, revocationKey } from '../lib/keys';
import { txTimestampIso } from '../lib/ledger-time';

@Info({ title: 'IdentityRegistry', description: 'Pseudonymous identity enrolment and key rotation' })
export class IdentityRegistry extends Contract {
  constructor() {
    super('IdentityRegistry');
  }

  /**
   * Enrols a pseudonymous identity. No PII crosses the network: identityHash
   * is a salted hash computed off-chain and stored opaquely. Spec section 7.1.
   */
  @Transaction()
  @Returns('string')
  public async registerIdentity(
    ctx: Context, identityHash: string, publicKey: string, role: string,
  ): Promise<string> {
    if (!ROLES.includes(role as Role)) {
      fail('INVALID_ROLE', `role must be one of ${ROLES.join(', ')} (got "${role}")`);
    }
    if (!isSha256Hex(identityHash)) {
      fail('INVALID_IDENTITY_HASH', 'identityHash must be a 64-character hex sha256 digest');
    }
    if (!isEd25519PublicKey(publicKey)) {
      fail('INVALID_PUBLIC_KEY', 'publicKey must be a 64-character hex ed25519 key');
    }

    // Composite-key read, so the check is in the read set and MVCC-safe.
    const indexKey = identityHashIndexKey(ctx, identityHash);
    if (await exists(ctx, indexKey)) {
      fail('IDENTITY_HASH_EXISTS', 'an identity is already enrolled for this identity hash');
    }

    const identityID = deriveIdentityId(ctx.stub.getTxID());
    const identity: Identity = {
      identityID,
      identityHash,
      publicKey,
      role: role as Role,
      status: 'active',
      enrolledBy: ctx.clientIdentity.getMSPID(),
      enrolledAt: txTimestampIso(ctx),
    };

    await ctx.stub.putState(identityKey(ctx, identityID), Buffer.from(canonicalize(identity)));
    await ctx.stub.putState(indexKey, Buffer.from(identityID));
    return identityID;
  }

  @Transaction(false)
  @Returns('string')
  public async getIdentityStatus(ctx: Context, identityID: string): Promise<string> {
    const identity = await readJson<Identity>(ctx, identityKey(ctx, identityID));
    if (!identity) fail('IDENTITY_NOT_FOUND', `no identity with id "${identityID}"`);
    return canonicalize(identity);
  }

  /**
   * Rotates an identity's device key and records the event.
   *
   * The identity stays active — this is a rotation, not a revocation of the
   * person. authorizedBy is taken from the transaction's verified credentials
   * rather than a parameter, so it cannot be spoofed. Spec section 7.1.
   */
  @Transaction()
  @Returns('string')
  public async revokeAndReissueKey(
    ctx: Context, identityID: string, oldPublicKeyHash: string,
    newPublicKey: string, reason: string,
  ): Promise<string> {
    if (!REVOCATION_REASONS.includes(reason as RevocationReason)) {
      fail('INVALID_REASON', `reason must be one of ${REVOCATION_REASONS.join(', ')}`);
    }

    const key = identityKey(ctx, identityID);
    const identity = await readJson<Identity>(ctx, key);
    if (!identity) fail('IDENTITY_NOT_FOUND', `no identity with id "${identityID}"`);
    if (identity.status !== 'active') {
      fail('IDENTITY_NOT_ACTIVE', `identity "${identityID}" is ${identity.status}`);
    }
    if (!isEd25519PublicKey(newPublicKey)) {
      fail('INVALID_PUBLIC_KEY', 'newPublicKey must be a 64-character hex ed25519 key');
    }
    // Guards against two rotations racing: the caller must name the key it saw.
    if (hashPublicKey(identity.publicKey) !== oldPublicKeyHash) {
      fail('OLD_KEY_MISMATCH', 'oldPublicKeyHash does not match the currently active key');
    }
    if (newPublicKey === identity.publicKey) {
      fail('KEY_UNCHANGED', 'newPublicKey is identical to the current key');
    }

    const event: KeyRevocationEvent = {
      eventID: deriveEventId(ctx.stub.getTxID()),
      identityID,
      oldPublicKeyHash,
      newPublicKey,
      reason: reason as RevocationReason,
      authorizedBy: ctx.clientIdentity.getID(),
      timestamp: txTimestampIso(ctx),
    };

    identity.publicKey = newPublicKey;
    await ctx.stub.putState(key, Buffer.from(canonicalize(identity)));
    await ctx.stub.putState(revocationKey(ctx, event.eventID), Buffer.from(canonicalize(event)));
    return canonicalize(event);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test --workspace @haazir/chaincode
```

Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add packages/chaincode
git commit -m "feat(chaincode): implement IdentityRegistry contract

Deterministic identity ids from the transaction id (defect C3), ledger
timestamps (C4), and composite-key duplicate detection (C6 applied
preemptively). authorizedBy comes from client identity, not a parameter."
```

---

### Task 10: SessionManager — Creation and Retrieval

**Files:**
- Create: `packages/chaincode/src/contracts/session-manager.ts`
- Test: `packages/chaincode/test/session-manager.test.ts`

**Interfaces:**
- Consumes: Tasks 7, 8, 9
- Produces: class `SessionManager` with `createSession(ctx, sessionID, courseID, facultyID, room, startTime, durationSec, gracePeriodSec, geofenceJson, geofenceRadiusM, nonceSeedHash): Promise<string>` and `getSession(ctx, sessionID): Promise<string>` returning canonical JSON of `{ ...Session, verificationState }`

`geofenceCenter` is passed as a JSON string because Fabric transaction arguments are strings. `gracePeriodSec` is added to the `HANDOFF.md` §7 signature per spec §6.2.

- [ ] **Step 1: Write the failing tests**

`packages/chaincode/test/session-manager.test.ts`:

```ts
import { SessionManager } from '../src/contracts/session-manager';
import { IdentityRegistry } from '../src/contracts/identity-registry';
import { makeContext, nextTx } from './helpers/mock-context';
import { commitSeed, sha256Hex, Session, VerificationState } from '@haazir/shared';
import { Context } from 'fabric-contract-api';

const SEED = 'ab'.repeat(32);
const SEED_HASH = commitSeed(SEED);
const GEO = JSON.stringify({ lat: 12.97, lng: 77.59 });
const START = '2026-09-09T10:00:00.000Z';
const START_MS = Date.parse(START);
const PK = 'a'.repeat(64);

const sm = () => new SessionManager();

/** Enrols a faculty identity and returns a context carrying that state. */
async function withFaculty(): Promise<{ ctx: Context; facultyID: string }> {
  const ctx = makeContext({ txId: 'tx-fac', timestampMs: START_MS });
  const facultyID = await new IdentityRegistry()
    .registerIdentity(ctx, sha256Hex('faculty-1'), PK, 'faculty');
  return { ctx, facultyID };
}

async function createDefaultSession(base: Context, facultyID: string, id = 'S1') {
  const ctx = nextTx(base, { txId: `tx-${id}`, timestampMs: START_MS });
  await sm().createSession(ctx, id, 'CS101', facultyID, 'LH-3',
    START, 3600, 900, GEO, 50, SEED_HASH);
  return ctx;
}

const read = async (ctx: Context, id = 'S1') =>
  JSON.parse(await sm().getSession(ctx, id)) as Session & { verificationState: VerificationState };

describe('createSession', () => {
  it('stores the session as open with the seed hash and no seed', async () => {
    const { ctx, facultyID } = await withFaculty();
    const after = await createDefaultSession(ctx, facultyID);
    const s = await read(nextTx(after));
    expect(s.status).toBe('open');
    expect(s.nonceSeedHash).toBe(SEED_HASH);
    expect(s.revealedSeed).toBeUndefined();
  });

  it('records createdAt from the ledger, separate from the scheduled startTime', async () => {
    const { ctx, facultyID } = await withFaculty();
    const later = nextTx(ctx, { txId: 'tx-S9', timestampMs: START_MS + 60_000 });
    await sm().createSession(later, 'S9', 'CS101', facultyID, 'LH-3',
      START, 3600, 900, GEO, 50, SEED_HASH);
    const s = await read(nextTx(later), 'S9');
    expect(s.startTime).toBe(START);
    expect(s.createdAt).toBe('2026-09-09T10:01:00.000Z');
  });

  it('rejects a duplicate session id', async () => {
    const { ctx, facultyID } = await withFaculty();
    const after = await createDefaultSession(ctx, facultyID);
    await expect(
      sm().createSession(nextTx(after, { txId: 'tx-dup' }), 'S1', 'CS101', facultyID,
        'LH-3', START, 3600, 900, GEO, 50, SEED_HASH),
    ).rejects.toThrow(/SESSION_EXISTS/);
  });

  it('rejects an unknown faculty identity', async () => {
    const { ctx } = await withFaculty();
    await expect(
      sm().createSession(nextTx(ctx), 'S2', 'CS101', 'no-such-id', 'LH-3',
        START, 3600, 900, GEO, 50, SEED_HASH),
    ).rejects.toThrow(/FACULTY_NOT_FOUND/);
  });

  it('rejects an identity that is not faculty', async () => {
    const ctx = makeContext({ txId: 'tx-stu', timestampMs: START_MS });
    const studentID = await new IdentityRegistry()
      .registerIdentity(ctx, sha256Hex('student-9'), PK, 'student');
    await expect(
      sm().createSession(nextTx(ctx), 'S3', 'CS101', studentID, 'LH-3',
        START, 3600, 900, GEO, 50, SEED_HASH),
    ).rejects.toThrow(/NOT_FACULTY/);
  });

  it('rejects a non-positive or excessive duration', async () => {
    const { ctx, facultyID } = await withFaculty();
    await expect(
      sm().createSession(nextTx(ctx), 'S4', 'CS101', facultyID, 'LH-3',
        START, 0, 900, GEO, 50, SEED_HASH),
    ).rejects.toThrow(/INVALID_DURATION/);
    await expect(
      sm().createSession(nextTx(ctx), 'S5', 'CS101', facultyID, 'LH-3',
        START, 99_999, 900, GEO, 50, SEED_HASH),
    ).rejects.toThrow(/INVALID_DURATION/);
  });

  it('rejects a malformed seed commitment', async () => {
    const { ctx, facultyID } = await withFaculty();
    await expect(
      sm().createSession(nextTx(ctx), 'S6', 'CS101', facultyID, 'LH-3',
        START, 3600, 900, GEO, 50, 'nothex'),
    ).rejects.toThrow(/INVALID_SEED_HASH/);
  });

  it('rejects out-of-range geofence coordinates', async () => {
    const { ctx, facultyID } = await withFaculty();
    await expect(
      sm().createSession(nextTx(ctx), 'S7', 'CS101', facultyID, 'LH-3', START, 3600, 900,
        JSON.stringify({ lat: 200, lng: 77 }), 50, SEED_HASH),
    ).rejects.toThrow(/INVALID_GEOFENCE/);
  });

  it('rejects a malformed startTime', async () => {
    const { ctx, facultyID } = await withFaculty();
    await expect(
      sm().createSession(nextTx(ctx), 'S8', 'CS101', facultyID, 'LH-3',
        'not-a-time', 3600, 900, GEO, 50, SEED_HASH),
    ).rejects.toThrow(/INVALID_START_TIME/);
  });
});

describe('getSession', () => {
  it('rejects an unknown session id', async () => {
    await expect(sm().getSession(makeContext(), 'nope')).rejects.toThrow(/SESSION_NOT_FOUND/);
  });

  it('reports in_progress while the session is running', async () => {
    const { ctx, facultyID } = await withFaculty();
    const after = await createDefaultSession(ctx, facultyID);
    const s = await read(nextTx(after, { timestampMs: START_MS + 60_000 }));
    expect(s.verificationState).toBe('in_progress');
  });

  it('reports awaiting_reveal after nominal end but inside the grace period', async () => {
    const { ctx, facultyID } = await withFaculty();
    const after = await createDefaultSession(ctx, facultyID);
    const s = await read(nextTx(after, { timestampMs: START_MS + 3_700_000 }));
    expect(s.verificationState).toBe('awaiting_reveal');
  });

  it('reports unverified past the grace period even though nobody has swept it', async () => {
    const { ctx, facultyID } = await withFaculty();
    const after = await createDefaultSession(ctx, facultyID);
    const s = await read(nextTx(after, { timestampMs: START_MS + 9_000_000 }));
    expect(s.status).toBe('open');
    expect(s.verificationState).toBe('unverified');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test --workspace @haazir/chaincode
```

Expected: FAIL — `session-manager` not found.

- [ ] **Step 3: Implement creation, retrieval, and the derived state**

`packages/chaincode/src/contracts/session-manager.ts`:

```ts
import { Context, Contract, Info, Returns, Transaction } from 'fabric-contract-api';
import {
  canonicalize, isSha256Hex, GeoPoint, Identity, MAX_SESSION_DURATION_SEC,
  Session, VerificationState,
} from '@haazir/shared';
import { fail } from '../lib/errors';
import { exists, identityKey, readJson, sessionKey } from '../lib/keys';
import { txTimestampIso, txTimestampMs } from '../lib/ledger-time';

const ENDORSING_MSPS = ['RegistrarMSP', 'ExamCellMSP'];

@Info({ title: 'SessionManager', description: 'Class session lifecycle and nonce seed commitment' })
export class SessionManager extends Contract {
  constructor() {
    super('SessionManager');
  }

  /**
   * Opens a session, committing to a nonce seed without revealing it.
   *
   * Only SHA-256(seed) crosses the network. The faculty is now bound to a
   * seed chosen before any submission is seen and cannot substitute another
   * at reveal time. Spec section 5.2.
   */
  @Transaction()
  @Returns('string')
  public async createSession(
    ctx: Context, sessionID: string, courseID: string, facultyID: string, room: string,
    startTime: string, durationSec: number, gracePeriodSec: number,
    geofenceCenter: string, geofenceRadiusM: number, nonceSeedHash: string,
  ): Promise<string> {
    const key = sessionKey(ctx, sessionID);
    if (await exists(ctx, key)) {
      fail('SESSION_EXISTS', `a session with id "${sessionID}" already exists`);
    }

    const faculty = await readJson<Identity>(ctx, identityKey(ctx, facultyID));
    if (!faculty) fail('FACULTY_NOT_FOUND', `no identity with id "${facultyID}"`);
    if (faculty.status !== 'active') {
      fail('FACULTY_NOT_ACTIVE', `identity "${facultyID}" is ${faculty.status}`);
    }
    if (faculty.role !== 'faculty') {
      fail('NOT_FACULTY', `identity "${facultyID}" has role "${faculty.role}"`);
    }

    const startMs = Date.parse(startTime);
    if (Number.isNaN(startMs)) {
      fail('INVALID_START_TIME', `startTime must be an ISO-8601 instant (got "${startTime}")`);
    }

    const duration = Number(durationSec);
    if (!Number.isInteger(duration) || duration <= 0 || duration > MAX_SESSION_DURATION_SEC) {
      fail('INVALID_DURATION',
        `durationSec must be an integer in 1..${MAX_SESSION_DURATION_SEC} (got ${durationSec})`);
    }

    const grace = Number(gracePeriodSec);
    if (!Number.isInteger(grace) || grace < 0) {
      fail('INVALID_GRACE_PERIOD', `gracePeriodSec must be a non-negative integer`);
    }

    if (!isSha256Hex(nonceSeedHash)) {
      fail('INVALID_SEED_HASH', 'nonceSeedHash must be a 64-character hex sha256 digest');
    }

    const geo = parseGeofence(geofenceCenter);
    const radius = Number(geofenceRadiusM);
    if (!Number.isInteger(radius) || radius <= 0) {
      fail('INVALID_GEOFENCE', 'geofenceRadiusM must be a positive integer');
    }

    const session: Session = {
      sessionID, courseID, facultyID, room,
      startTime: new Date(startMs).toISOString(),
      createdAt: txTimestampIso(ctx),
      durationSec: duration,
      gracePeriodSec: grace,
      geofenceCenter: geo,
      geofenceRadiusM: radius,
      nonceSeedHash,
      status: 'open',
    };

    await ctx.stub.putState(key, Buffer.from(canonicalize(session)));
    return canonicalize(session);
  }

  /**
   * Returns the session with a verification state derived at read time, so
   * a session past its grace period is never reported as healthy merely
   * because nobody has invoked expireSession. Spec section 5.4.
   */
  @Transaction(false)
  @Returns('string')
  public async getSession(ctx: Context, sessionID: string): Promise<string> {
    const session = await this.load(ctx, sessionID);
    return canonicalize({
      ...session,
      verificationState: verificationStateOf(session, txTimestampMs(ctx)),
    });
  }

  protected async load(ctx: Context, sessionID: string): Promise<Session> {
    const session = await readJson<Session>(ctx, sessionKey(ctx, sessionID));
    if (!session) fail('SESSION_NOT_FOUND', `no session with id "${sessionID}"`);
    return session;
  }

  protected assertEndorsingOrg(ctx: Context): void {
    const msp = ctx.clientIdentity.getMSPID();
    if (!ENDORSING_MSPS.includes(msp)) {
      fail('UNAUTHORISED_ORG', `organisation "${msp}" may not perform this operation`);
    }
  }
}

function parseGeofence(raw: string): GeoPoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('INVALID_GEOFENCE', 'geofenceCenter must be JSON of the form {"lat":..,"lng":..}');
  }
  const point = parsed as Partial<GeoPoint>;
  const lat = Number(point?.lat);
  const lng = Number(point?.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    fail('INVALID_GEOFENCE', `lat must be within -90..90 (got ${point?.lat})`);
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    fail('INVALID_GEOFENCE', `lng must be within -180..180 (got ${point?.lng})`);
  }
  return { lat, lng };
}

export function deadlineOf(session: Session): number {
  return Date.parse(session.startTime)
    + session.durationSec * 1000
    + session.gracePeriodSec * 1000;
}

export function verificationStateOf(session: Session, nowMs: number): VerificationState {
  if (session.status === 'closed') return 'verified';
  if (nowMs > deadlineOf(session)) return 'unverified';
  if (nowMs > Date.parse(session.startTime) + session.durationSec * 1000) {
    return 'awaiting_reveal';
  }
  return 'in_progress';
}
```

Note `geofenceCenter` stores `lat`/`lng` as JavaScript numbers, and `canonicalize` rejects non-integers — so the `Session` object is stored via a small adaptation in Task 11's step 1. Handle this now by storing coordinates as fixed-precision integers scaled by 10^7 (the standard geodetic convention), which keeps canonical encoding portable.

- [ ] **Step 4: Apply the coordinate scaling fix**

Coordinates are the one genuinely fractional value in the data model, and `canonicalize` rejects floats deliberately (Task 6). Store them as integer microdegrees.

In `packages/shared/src/types.ts`, replace `GeoPoint` with:

```ts
/**
 * Coordinates as integer 1e-7 degrees ("microdegrees"), the standard
 * geodetic integer convention. Floats are not stored on-chain: their
 * string formatting is not portable, and canonical encoding rejects them.
 */
export interface GeoPoint { latE7: number; lngE7: number; }

export const toE7 = (degrees: number): number => Math.round(degrees * 1e7);
export const fromE7 = (e7: number): number => e7 / 1e7;
```

In `session-manager.ts`, update `parseGeofence` to accept `{"lat":..,"lng":..}` in degrees, validate the ranges as above, and return `{ latE7: toE7(lat), lngE7: toE7(lng) }`.

Add to `packages/shared/test/hashing.test.ts`:

```ts
import { toE7, fromE7 } from '../src';

describe('coordinate scaling', () => {
  it('round-trips a coordinate through integer microdegrees', () => {
    expect(fromE7(toE7(12.9716))).toBeCloseTo(12.9716, 6);
  });
  it('produces an integer, which canonical encoding accepts', () => {
    expect(Number.isInteger(toE7(77.5946))).toBe(true);
  });
});
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm test --workspace @haazir/chaincode && npm test --workspace @haazir/shared
```

Expected: all passing in both packages.

- [ ] **Step 6: Commit**

```bash
git add packages/
git commit -m "feat(chaincode): implement SessionManager creation and retrieval

Commits to a nonce seed hash without revealing the seed, and derives
verification state at read time so an unswept session past its grace
period is never reported as healthy. Coordinates stored as integer
microdegrees to keep canonical encoding portable."
```

---

### Task 11: SessionManager — Commit-Reveal Close and Expiry

The intellectual core of the milestone (spec §5).

**Files:**
- Modify: `packages/chaincode/src/contracts/session-manager.ts`
- Modify: `packages/chaincode/test/session-manager.test.ts`
- Create: `packages/chaincode/src/index.ts`

**Interfaces:**
- Consumes: Task 10
- Produces: `closeSession(ctx, sessionID, revealedSeed): Promise<string>`, `expireSession(ctx, sessionID): Promise<string>`, and `packages/chaincode/src/index.ts` exporting `contracts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/chaincode/test/session-manager.test.ts`:

```ts
import { deriveNonce } from '@haazir/shared';

describe('closeSession — commit-reveal', () => {
  const setup = async () => {
    const { ctx, facultyID } = await withFaculty();
    return createDefaultSession(ctx, facultyID);
  };

  it('accepts the seed whose hash was committed at creation', async () => {
    const after = await setup();
    const closing = nextTx(after, { txId: 'tx-close', timestampMs: START_MS + 3_600_000 });
    await sm().closeSession(closing, 'S1', SEED);
    const s = await read(nextTx(closing));
    expect(s.status).toBe('closed');
    expect(s.revealedSeed).toBe(SEED);
    expect(s.verificationState).toBe('verified');
  });

  it('rejects any other seed, blocking a retrofitted commitment', async () => {
    const after = await setup();
    await expect(
      sm().closeSession(nextTx(after, { timestampMs: START_MS + 3_600_000 }),
        'S1', 'cd'.repeat(32)),
    ).rejects.toThrow(/SEED_COMMITMENT_MISMATCH/);
  });

  it('leaves the session open when the reveal is rejected', async () => {
    const after = await setup();
    const bad = nextTx(after, { timestampMs: START_MS + 3_600_000 });
    await expect(sm().closeSession(bad, 'S1', 'cd'.repeat(32))).rejects.toThrow();
    expect((await read(nextTx(bad))).status).toBe('open');
  });

  it('records who closed it and when, from the ledger', async () => {
    const after = await setup();
    const closing = nextTx(after, {
      txId: 'tx-close', timestampMs: START_MS + 3_600_000, clientId: 'x509::CN=faculty-a',
    });
    await sm().closeSession(closing, 'S1', SEED);
    const s = await read(nextTx(closing));
    expect(s.closedBy).toBe('x509::CN=faculty-a');
    expect(s.closedAt).toBe('2026-09-09T11:00:00.000Z');
  });

  it('rejects a reveal after the grace period has elapsed', async () => {
    const after = await setup();
    await expect(
      sm().closeSession(nextTx(after, { timestampMs: START_MS + 9_000_000 }), 'S1', SEED),
    ).rejects.toThrow(/GRACE_PERIOD_ELAPSED/);
  });

  it('rejects closing a session twice', async () => {
    const after = await setup();
    const closing = nextTx(after, { timestampMs: START_MS + 3_600_000 });
    await sm().closeSession(closing, 'S1', SEED);
    await expect(
      sm().closeSession(nextTx(closing, { timestampMs: START_MS + 3_610_000 }), 'S1', SEED),
    ).rejects.toThrow(/SESSION_NOT_OPEN/);
  });

  it('rejects a caller from a non-endorsing organisation', async () => {
    const after = await setup();
    await expect(
      sm().closeSession(
        nextTx(after, { timestampMs: START_MS + 3_600_000, mspId: 'AuditMSP' }), 'S1', SEED),
    ).rejects.toThrow(/UNAUTHORISED_ORG/);
  });

  it('makes every window independently verifiable once revealed', async () => {
    const after = await setup();
    const closing = nextTx(after, { timestampMs: START_MS + 3_600_000 });
    await sm().closeSession(closing, 'S1', SEED);
    const s = await read(nextTx(closing));
    // Anyone holding only the ledger can now recompute any window's nonce.
    expect(deriveNonce(s.revealedSeed!, 7)).toBe(deriveNonce(SEED, 7));
  });
});

describe('expireSession', () => {
  const setup = async () => {
    const { ctx, facultyID } = await withFaculty();
    return createDefaultSession(ctx, facultyID);
  };

  it('rejects expiry before the grace period has elapsed', async () => {
    const after = await setup();
    await expect(
      sm().expireSession(nextTx(after, { timestampMs: START_MS + 3_600_000 }), 'S1'),
    ).rejects.toThrow(/GRACE_PERIOD_NOT_ELAPSED/);
  });

  it('marks the session expired once the grace period has passed', async () => {
    const after = await setup();
    const exp = nextTx(after, { txId: 'tx-exp', timestampMs: START_MS + 9_000_000 });
    await sm().expireSession(exp, 'S1');
    const s = await read(nextTx(exp, { timestampMs: START_MS + 9_100_000 }));
    expect(s.status).toBe('expired');
    expect(s.verificationState).toBe('unverified');
    expect(s.expiredBy).toBeDefined();
  });

  it('rejects expiring a closed session', async () => {
    const after = await setup();
    const closing = nextTx(after, { timestampMs: START_MS + 3_600_000 });
    await sm().closeSession(closing, 'S1', SEED);
    await expect(
      sm().expireSession(nextTx(closing, { timestampMs: START_MS + 9_000_000 }), 'S1'),
    ).rejects.toThrow(/SESSION_NOT_OPEN/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm test --workspace @haazir/chaincode
```

Expected: FAIL — `closeSession is not a function`.

- [ ] **Step 3: Implement close and expire**

Add to the `SessionManager` class in `packages/chaincode/src/contracts/session-manager.ts`:

```ts
  /**
   * Closes a session by revealing the nonce seed.
   *
   * The hash comparison is the load-bearing check: presenting a seed other
   * than the one committed at creation is an attempt to retrofit nonces
   * after seeing submissions, and must be rejected. Once revealed, anyone
   * holding only the ledger can recompute every window's nonce and verify
   * any record without trusting a server. Spec sections 5.2 and 5.3.
   *
   * Caller authorisation is organisation-level for this milestone: binding
   * on-chain identity ids to X.509 client identities is unspecified and
   * deferred to Milestone 3. See ADR-013.
   */
  @Transaction()
  @Returns('string')
  public async closeSession(
    ctx: Context, sessionID: string, revealedSeed: string,
  ): Promise<string> {
    this.assertEndorsingOrg(ctx);

    const session = await this.load(ctx, sessionID);
    if (session.status !== 'open') {
      fail('SESSION_NOT_OPEN', `session "${sessionID}" is ${session.status}`);
    }

    let commitment: string;
    try {
      commitment = commitSeed(revealedSeed);
    } catch {
      fail('INVALID_SEED', 'revealedSeed must be 32-byte hex (64 lowercase hex characters)');
    }
    if (commitment !== session.nonceSeedHash) {
      fail('SEED_COMMITMENT_MISMATCH',
        'the revealed seed does not match the commitment made at session creation');
    }

    const nowMs = txTimestampMs(ctx);
    if (nowMs > deadlineOf(session)) {
      fail('GRACE_PERIOD_ELAPSED',
        `the reveal window for session "${sessionID}" has closed`);
    }

    session.revealedSeed = revealedSeed;
    session.status = 'closed';
    session.closedAt = txTimestampIso(ctx);
    session.closedBy = ctx.clientIdentity.getID();

    await ctx.stub.putState(sessionKey(ctx, sessionID), Buffer.from(canonicalize(session)));
    return canonicalize(session);
  }

  /**
   * Marks a session expired after its grace period elapsed with no valid
   * reveal, converting a silent forgery risk into an attributable failure.
   *
   * No caller restriction beyond the grace-period check is imposed: ideally
   * the Audit organisation would invoke this alone, since it is the sanction
   * against the two interested parties. That requires per-function
   * endorsement, deferred to Milestone 3. Spec section 5.4.
   */
  @Transaction()
  @Returns('string')
  public async expireSession(ctx: Context, sessionID: string): Promise<string> {
    const session = await this.load(ctx, sessionID);
    if (session.status !== 'open') {
      fail('SESSION_NOT_OPEN', `session "${sessionID}" is ${session.status}`);
    }

    const nowMs = txTimestampMs(ctx);
    if (nowMs <= deadlineOf(session)) {
      fail('GRACE_PERIOD_NOT_ELAPSED',
        `session "${sessionID}" may still be closed by revealing its seed`);
    }

    session.status = 'expired';
    session.expiredAt = txTimestampIso(ctx);
    session.expiredBy = ctx.clientIdentity.getID();

    await ctx.stub.putState(sessionKey(ctx, sessionID), Buffer.from(canonicalize(session)));
    return canonicalize(session);
  }
```

Add `commitSeed` to the `@haazir/shared` import at the top of the file.

- [ ] **Step 4: Create the chaincode entry point**

`packages/chaincode/src/index.ts`:

```ts
import { IdentityRegistry } from './contracts/identity-registry';
import { SessionManager } from './contracts/session-manager';

export { IdentityRegistry, SessionManager };

/**
 * Fabric reads this export to discover the contracts in the package.
 * One deployable package, several Contract classes — each keeps its own
 * namespace, so operations address as "IdentityRegistry:registerIdentity".
 * Four separate packages would mean twelve lifecycle operations per change
 * across three organisations. Spec section 4.4.
 */
export const contracts: unknown[] = [IdentityRegistry, SessionManager];
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm test --workspace @haazir/chaincode && npm run build --workspace @haazir/chaincode
```

Expected: all passing, `dist/` produced.

- [ ] **Step 6: Commit**

```bash
git add packages/chaincode
git commit -m "feat(chaincode): implement commit-reveal session close and expiry

Resolves defect C1: freshness is verified against a commitment made
before any submission was seen, so nonce validation no longer depends on
a single trusted server. Adds expireSession so an unrevealed seed becomes
an attributable failure rather than a silent gap."
```

---

### Task 12: Deploy the Real Chaincode

**Files:**
- Create: `network/scripts/deploy-haazir.sh`

**Interfaces:**
- Consumes: Task 5's `deploy-chaincode.sh`, Task 11's built chaincode
- Produces: chaincode `haazir` committed on `attendance-channel` under the `AND` policy

- [ ] **Step 1: Write the deployment wrapper**

Fabric packages Node chaincode from source and runs `npm install` inside the container, so the workspace-linked `@haazir/shared` must be vendored into a self-contained build directory first.

`network/scripts/deploy-haazir.sh`:

```bash
#!/usr/bin/env bash
# Builds a self-contained chaincode package and deploys it.
# Fabric runs `npm install` inside the chaincode container, where the npm
# workspace symlink to @haazir/shared does not exist — so shared is built
# and vendored into the package as a file: dependency.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
BUILD="$ROOT/build/chaincode"
VERSION="${CC_VERSION:-1.0}"
SEQUENCE="${CC_SEQUENCE:-1}"

echo "==> Building workspace packages"
( cd "$ROOT" && npm run build --workspace @haazir/shared \
                && npm run build --workspace @haazir/chaincode )

echo "==> Assembling self-contained package at $BUILD"
rm -rf "$BUILD"
mkdir -p "$BUILD/vendor"
cp -r "$ROOT/packages/chaincode/dist" "$BUILD/dist"
cp "$ROOT/packages/chaincode/package.json" "$BUILD/package.json"
cp -r "$ROOT/packages/shared/dist" "$ROOT/packages/shared/package.json" "$BUILD/vendor/"

# Repoint @haazir/shared at the vendored copy.
jq '.dependencies["@haazir/shared"] = "file:./vendor"' \
  "$BUILD/package.json" > "$BUILD/package.json.tmp"
mv "$BUILD/package.json.tmp" "$BUILD/package.json"

echo "==> Deploying"
"$HERE/deploy-chaincode.sh" "$BUILD" haazir "$VERSION" "$SEQUENCE"
```

- [ ] **Step 2: Deploy**

```bash
chmod +x network/scripts/deploy-haazir.sh
./network/scripts/deploy-haazir.sh
```

Expected: `checkcommitreadiness` shows `RegistrarMSP: true`, `ExamCellMSP: true`, `AuditMSP: false`; commit succeeds.

- [ ] **Step 3: Smoke-test against the live network**

```bash
source network/scripts/set-org-env.sh registrar
REG_TLS="$CORE_PEER_TLS_ROOTCERT_FILE"
source network/scripts/set-org-env.sh examcell

peer chaincode invoke -o localhost:7050 \
  --ordererTLSHostnameOverride orderer.example.com --tls --cafile "$ORDERER_CA" \
  -C attendance-channel -n haazir \
  --peerAddresses localhost:7051 --tlsRootCertFiles "$REG_TLS" \
  --peerAddresses localhost:9051 --tlsRootCertFiles "$CORE_PEER_TLS_ROOTCERT_FILE" \
  -c '{"function":"IdentityRegistry:registerIdentity","Args":["'"$(printf 'a%.0s' {1..64})"'","'"$(printf 'b%.0s' {1..64})"'","student"]}'
```

Expected: `status:200` with a UUID-shaped payload. If the chaincode container fails to start, inspect it with `docker logs $(docker ps -aq --filter name=haazir | head -1)` — a missing `@haazir/shared` here means the vendoring step failed.

- [ ] **Step 4: Verify the endorsement policy still holds for the real chaincode**

```bash
CC_NAME=haazir ./network/scripts/prove-endorsement-policy.sh
```

This will fail at the positive case because the sample's `CreateAsset` function does not exist in `haazir`. Update the script's two `-c '{...}'` payloads to call `IdentityRegistry:registerIdentity` with distinct 64-hex identity hashes, then rerun.

Expected: negative case rejected with `ENDORSEMENT_POLICY_FAILURE`, positive case accepted.

- [ ] **Step 5: Commit**

```bash
git add network/scripts/ && git commit -m "feat(network): deploy haazir chaincode with vendored shared package"
```

---

### Task 13: Gateway Module

**Files:**
- Create: `backend/src/config.ts`, `backend/src/gateway/{connection.ts,errors.ts,index.ts}`

**Interfaces:**
- Consumes: Task 12's deployed chaincode
- Produces:
  - `connect(org: OrgName): Promise<GatewayHandle>` where `GatewayHandle = { contract(name: string): ContractHandle; close(): void }`
  - `ContractHandle = { submit(fn: string, ...args: string[]): Promise<string>; evaluate(fn: string, ...args: string[]): Promise<string> }`
  - `translateFabricError(err: unknown): FabricFailure` with `{ code: string; detail: string; raw: string }`

- [ ] **Step 1: Write the connection configuration**

`backend/src/config.ts`:

```ts
import * as path from 'path';
import * as os from 'os';

export type OrgName = 'registrar' | 'examcell' | 'audit';

const SAMPLES = process.env.FABRIC_SAMPLES ?? path.join(os.homedir(), 'fabric-samples');
const PEER_ORGS = path.join(SAMPLES, 'test-network', 'organizations', 'peerOrganizations');

export interface OrgConfig {
  mspId: string;
  peerEndpoint: string;
  peerHostAlias: string;
  cryptoPath: string;
}

export const ORGS: Record<OrgName, OrgConfig> = {
  registrar: {
    mspId: 'RegistrarMSP', peerEndpoint: 'localhost:7051',
    peerHostAlias: 'peer0.org1.example.com',
    cryptoPath: path.join(PEER_ORGS, 'org1.example.com'),
  },
  examcell: {
    mspId: 'ExamCellMSP', peerEndpoint: 'localhost:9051',
    peerHostAlias: 'peer0.org2.example.com',
    cryptoPath: path.join(PEER_ORGS, 'org2.example.com'),
  },
  audit: {
    mspId: 'AuditMSP', peerEndpoint: 'localhost:11051',
    peerHostAlias: 'peer0.org3.example.com',
    cryptoPath: path.join(PEER_ORGS, 'org3.example.com'),
  },
};

export const CHANNEL_NAME = process.env.CHANNEL ?? 'attendance-channel';
export const CHAINCODE_NAME = process.env.CC_NAME ?? 'haazir';
```

- [ ] **Step 2: Write the error translator**

`backend/src/gateway/errors.ts`:

```ts
export interface FabricFailure {
  code: string;
  detail: string;
  raw: string;
}

/**
 * Fabric errors arrive as nested endorsement structures that do not
 * obviously say which check rejected a submission. The demo's negative
 * cases are only convincing if the actual reason is legible, so this
 * extracts the chaincode's own error code. Spec section 9.1.
 */
export function translateFabricError(err: unknown): FabricFailure {
  const raw = err instanceof Error ? err.message : String(err);
  const details = (err as { details?: Array<{ message?: string }> })?.details ?? [];
  const combined = [raw, ...details.map((d) => d.message ?? '')].join(' | ');

  if (/ENDORSEMENT_POLICY_FAILURE|endorsement policy failure/i.test(combined)) {
    return {
      code: 'ENDORSEMENT_POLICY_FAILURE',
      detail: 'the endorsement policy was not satisfied — one organisation cannot write alone',
      raw: combined,
    };
  }

  // Chaincode errors are formatted "CODE: message" by lib/errors.ts.
  const match = combined.match(/([A-Z][A-Z0-9_]{3,}):\s*([^|]+)/);
  if (match) return { code: match[1], detail: match[2].trim(), raw: combined };

  return { code: 'UNKNOWN', detail: raw, raw: combined };
}
```

- [ ] **Step 3: Write the connection module**

`backend/src/gateway/connection.ts`:

```ts
import * as grpc from '@grpc/grpc-js';
import { connect as gatewayConnect, Identity, signers } from '@hyperledger/fabric-gateway';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { CHAINCODE_NAME, CHANNEL_NAME, ORGS, OrgName } from '../config';
import { translateFabricError } from './errors';

export interface ContractHandle {
  submit(fn: string, ...args: string[]): Promise<string>;
  evaluate(fn: string, ...args: string[]): Promise<string>;
}

export interface GatewayHandle {
  contract(name: string): ContractHandle;
  close(): void;
}

async function firstFileIn(dir: string): Promise<string> {
  const [entry] = (await fs.readdir(dir)).sort();
  if (!entry) throw new Error(`no files found in ${dir}`);
  return path.join(dir, entry);
}

export async function connect(org: OrgName): Promise<GatewayHandle> {
  const cfg = ORGS[org];
  const userMsp = path.join(cfg.cryptoPath, 'users',
    `Admin@${path.basename(cfg.cryptoPath)}`, 'msp');

  const tlsCert = await fs.readFile(
    path.join(cfg.cryptoPath, 'peers', cfg.peerHostAlias, 'tls', 'ca.crt'));
  const client = new grpc.Client(
    cfg.peerEndpoint,
    grpc.credentials.createSsl(tlsCert),
    { 'grpc.ssl_target_name_override': cfg.peerHostAlias },
  );

  const identity: Identity = {
    mspId: cfg.mspId,
    credentials: await fs.readFile(await firstFileIn(path.join(userMsp, 'signcerts'))),
  };
  const privateKey = crypto.createPrivateKey(
    await fs.readFile(await firstFileIn(path.join(userMsp, 'keystore'))));

  const gateway = gatewayConnect({
    client, identity, signer: signers.newPrivateKeySigner(privateKey),
  });
  const network = gateway.getNetwork(CHANNEL_NAME);

  return {
    contract(name: string): ContractHandle {
      const contract = network.getContract(CHAINCODE_NAME, name);
      return {
        async submit(fn, ...args) {
          try {
            return Buffer.from(await contract.submitTransaction(fn, ...args)).toString();
          } catch (err) {
            const f = translateFabricError(err);
            throw new Error(`${f.code}: ${f.detail}`);
          }
        },
        async evaluate(fn, ...args) {
          try {
            return Buffer.from(await contract.evaluateTransaction(fn, ...args)).toString();
          } catch (err) {
            const f = translateFabricError(err);
            throw new Error(`${f.code}: ${f.detail}`);
          }
        },
      };
    },
    close() {
      gateway.close();
      client.close();
    },
  };
}
```

`backend/src/gateway/index.ts`:

```ts
export * from './connection';
export * from './errors';
```

- [ ] **Step 4: Verify the gateway connects**

```bash
npm run build --workspace @haazir/backend
node -e "
const { connect } = require('./backend/dist/gateway');
connect('registrar').then(async g => {
  console.log('connected');
  g.close();
}).catch(e => { console.error('FAILED', e.message); process.exit(1); });
"
```

Expected: `connected`.

- [ ] **Step 5: Commit**

```bash
git add backend/
git commit -m "feat(backend): add fabric-gateway connection module with error translation"
```

---

### Task 14: CLI Demo

The Definition of Done deliverable (spec §9.2).

**Files:**
- Create: `backend/src/cli/demo.ts`

**Interfaces:**
- Consumes: Task 13's gateway module, `@haazir/shared`
- Produces: `npm run demo --workspace @haazir/backend`

- [ ] **Step 1: Write the demo script**

`backend/src/cli/demo.ts`:

```ts
import { randomBytes } from 'crypto';
import {
  commitSeed, deriveNonce, hashPublicKey, sha256Hex, windowFor,
} from '@haazir/shared';
import { connect } from '../gateway';

const line = (s = '') => console.log(s);
const rule = (title: string) => {
  line();
  line('='.repeat(66));
  line(`  ${title}`);
  line('='.repeat(66));
};
const ok = (s: string) => line(`  [ok]   ${s}`);
const info = (s: string) => line(`  ${s}`);

const hex = (n: number) => randomBytes(n).toString('hex');

async function main(): Promise<void> {
  const gw = await connect('registrar');
  const identities = gw.contract('IdentityRegistry');
  const sessions = gw.contract('SessionManager');

  try {
    rule('1. Enrol a student identity');
    const studentPk = hex(32);
    const studentId = await identities.submit(
      'registerIdentity', sha256Hex(`student-${hex(8)}`), studentPk, 'student');
    ok(`identityID = ${studentId}`);
    info('Derived from the transaction id — deterministic across endorsing peers.');

    rule('2. Read the identity back from the ledger');
    info(await identities.evaluate('getIdentityStatus', studentId));

    rule('3. Rotate the student device key');
    const newPk = hex(32);
    const event = await identities.submit(
      'revokeAndReissueKey', studentId, hashPublicKey(studentPk), newPk, 'lost_device');
    ok('revocation event recorded');
    info(event);

    rule('4. Enrol a faculty identity and open a session');
    const facultyId = await identities.submit(
      'registerIdentity', sha256Hex(`faculty-${hex(8)}`), hex(32), 'faculty');
    ok(`facultyID = ${facultyId}`);

    // The seed never leaves this process. Only its hash goes on-chain.
    const seed = hex(32);
    const seedHash = commitSeed(seed);
    const sessionId = `S-${hex(4)}`;
    const startTime = new Date(Date.now() - 60_000).toISOString();

    await sessions.submit('createSession', sessionId, 'CS101', facultyId, 'LH-3',
      startTime, '3600', '900', JSON.stringify({ lat: 12.9716, lng: 77.5946 }),
      '50', seedHash);
    ok(`session ${sessionId} open`);
    info(`committed seed hash = ${seedHash}`);
    info('The seed itself has not been transmitted.');

    rule('5. Read the session back');
    const stored = JSON.parse(await sessions.evaluate('getSession', sessionId));
    info(`status             = ${stored.status}`);
    info(`verificationState  = ${stored.verificationState}`);
    info(`revealedSeed       = ${stored.revealedSeed ?? '(not yet revealed)'}`);

    rule('6. Derive rotating nonces locally — no ledger interaction');
    const startMs = Date.parse(startTime);
    for (const w of [0, 1, 2]) {
      info(`window ${w}: ${deriveNonce(seed, w).slice(0, 32)}...`);
    }
    info(`current window = ${windowFor(Date.now(), startMs)}`);
    info('Rotation costs zero transactions. A screenshot expires in 10 seconds.');

    rule('7. NEGATIVE — close the session with the WRONG seed');
    try {
      await sessions.submit('closeSession', sessionId, hex(32));
      line('  [FAIL] accepted a seed that did not match the commitment');
      process.exitCode = 1;
    } catch (err) {
      ok(`rejected: ${(err as Error).message}`);
      info('The faculty cannot retrofit a seed after seeing submissions.');
    }

    rule('8. Close the session with the CORRECT seed');
    await sessions.submit('closeSession', sessionId, seed);
    const closed = JSON.parse(await sessions.evaluate('getSession', sessionId));
    ok(`status = ${closed.status}, verificationState = ${closed.verificationState}`);
    info(`revealed seed = ${closed.revealedSeed}`);

    rule('9. Anyone can now verify every nonce from the ledger alone');
    const w = 7;
    const fromLedger = deriveNonce(closed.revealedSeed, w);
    info(`recomputed window ${w} = ${fromLedger.slice(0, 32)}...`);
    ok(fromLedger === deriveNonce(seed, w)
      ? 'matches the faculty device — verification needs no trusted server'
      : 'MISMATCH');
  } finally {
    gw.close();
  }
}

main().catch((err) => {
  console.error('\nDemo failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the demo**

```bash
npm run build --workspace @haazir/backend
npm run demo --workspace @haazir/backend
```

Expected: all nine sections complete, step 7 shows `SEED_COMMITMENT_MISMATCH`, step 9 confirms the match, exit 0.

- [ ] **Step 3: Run both negative demonstrations together**

```bash
npm run demo --workspace @haazir/backend && \
  CC_NAME=haazir ./network/scripts/prove-endorsement-policy.sh
```

Expected: both exit 0. Together these satisfy Definition of Done items 3 and 4.

- [ ] **Step 4: Commit**

```bash
git add backend/
git commit -m "feat(backend): add CLI demo covering enrolment, rotation, and commit-reveal

Includes the negative case required by spec 9.2: a seed that does not
match the commitment is rejected."
```

---

### Task 15: Documentation

**Files:**
- Create: `docs/threat-model.md`, `docs/determinism-checklist.md`
- Create: `docs/adr/ADR-001..ADR-013.md`
- Create: `.eslintrc.determinism.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above
- Produces: Definition of Done item 5

- [ ] **Step 1: Write the threat model**

`docs/threat-model.md` reproduces the `HANDOFF.md` §11 table with a status column recording which rows are implemented, plus these amendments established during design review:

- **BLE relay / wormhole** — not defeated by BLE alone. Needs round-trip-time bounding or an NFC-tap fallback for high-stakes sessions. Named as a real gap.
- **Lent device with coerced liveness** — not defeated by any factor in this design. A social and policy problem more than a technical one. Named as a genuine open gap.
- **Key theft / device malware** — the residual risk is **higher than `HANDOFF.md` claims**. `tweetnacl` ed25519 private keys are stored as a Keystore-protected blob but enter JavaScript memory on every signature, so they are not hardware-bound. Acceptable for a pilot; must be stated rather than overclaimed (spec §2.3).
- **Deepfake via virtual camera** — not defeated by phone-camera active liveness; needs depth-sensing hardware.
- **Admin/insider tampering** — defeated by `AND(Registrar, ExamCell)`, demonstrated by `prove-endorsement-policy.sh`. The only row with executable evidence at this milestone.
- **Faculty forging attendance via the nonce seed** — a row `HANDOFF.md` does not contain, introduced by its own §9.3 design and closed by commit-reveal (spec §5).

The document states explicitly that the BLE-relay and coerced-liveness rows are unsolved. Spec §13 is right that reviewers look for exactly these, and naming them is worth more than a table with no gaps.

- [ ] **Step 2: Write the determinism checklist**

`docs/determinism-checklist.md` records the Global Constraints determinism rules, why each matters (non-deterministic chaincode fails endorsement intermittently, because peers disagree without any one being wrong), and the clarification that `new Date(ms)` with an explicit argument is permitted while `new Date()` is not.

- [ ] **Step 3: Add the determinism lint rule**

`.eslintrc.determinism.js`:

```js
/**
 * Determinism rules for packages/chaincode and packages/shared.
 * Spec section 10.3. Replaces Slither/Mythril, which target the EVM and
 * have no role in a Fabric system.
 */
module.exports = {
  rules: {
    'no-restricted-syntax': ['error',
      {
        selector: "NewExpression[callee.name='Date'][arguments.length=0]",
        message: 'Determinism: use txTimestampMs(ctx). new Date(ms) with an explicit argument is fine.',
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
```

- [ ] **Step 4: Write the ADRs**

One short file per decision, each stating context, decision, and consequences:

ADR-001 Fabric with three organisations · ADR-002 TypeScript chaincode · ADR-003 `fabric-gateway` over legacy SDKs · ADR-004 Off-chain nonce rotation · ADR-005 Biometrics never leave the device · ADR-006 Append-only corrections · ADR-007 Commit-reveal nonce seed (defect C1) · ADR-008 `AND(Registrar, ExamCell)` endorsement policy (C2) · ADR-009 Deterministic identity ids (C3) · ADR-010 Ledger timestamps (C4) · ADR-011 One chaincode package, several contracts · ADR-012 Fabric 2.5 LTS over 3.x · ADR-013 Organisation-level authorisation for `closeSession`, deferring X.509-to-identity binding.

- [ ] **Step 5: Write the README**

`README.md` covers: what the project is, prerequisites (`scripts/verify-env.sh`), the WSL filesystem requirement and why, and the command sequence — `network-up.sh`, `deploy-haazir.sh`, `npm run demo`, `prove-endorsement-policy.sh` — plus where the spec, plan, and threat model live.

- [ ] **Step 6: Verify the full path from a clean state**

```bash
./network/scripts/network-down.sh
./network/scripts/network-up.sh
./network/scripts/deploy-haazir.sh
npm run demo --workspace @haazir/backend
CC_NAME=haazir ./network/scripts/prove-endorsement-policy.sh
npm test
```

Expected: every command exits 0. This is the complete Definition of Done (spec §1.2) executed end to end.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "docs: add threat model, determinism checklist, ADRs, and README"
```

---

### Task 16 (Stretch): Express Routes

Build only if Session 2 has room. Spec §9.3.

**Files:**
- Create: `backend/src/routes/{identities.ts,sessions.ts,index.ts}`, `backend/src/server.ts`

**Interfaces:**
- Consumes: Task 13's gateway module
- Produces: `POST /auth/enrol`, `POST /sessions`, `POST /sessions/:id/close`, `GET /sessions/:id`, `GET /identities/:id`, `POST /keys/revoke-reissue`

- [ ] **Step 1: Add Express**

```bash
npm install express --workspace @haazir/backend
npm install -D @types/express --workspace @haazir/backend
```

- [ ] **Step 2: Implement the routes**

Each route is a thin wrapper: validate the request body, call `gateway.contract(name).submit(...)` or `.evaluate(...)`, and map a thrown `ChaincodeError` code to an HTTP status — `*_NOT_FOUND` to 404, `ENDORSEMENT_POLICY_FAILURE` to 403, every other code to 400. The response body carries `{ code, detail }` so the specific rejection reason survives to the client, as spec §7 requires.

- [ ] **Step 3: Verify against the running network**

Start the server and exercise each route with `curl`, confirming that a `closeSession` call with a wrong seed returns HTTP 400 with `SEED_COMMITMENT_MISMATCH`.

- [ ] **Step 4: Commit**

```bash
git add backend/ && git commit -m "feat(backend): add Express routes over the gateway module"
```

---

## Plan Self-Review

**Spec coverage.** §1.2 Definition of Done → Tasks 3, 5, 12, 14, 15. §4.1 topology → Task 3. §4.2 two-phase bring-up → Tasks 3, 4. §4.3 endorsement policy → Tasks 5, 12. §4.4 single package → Task 11 step 4. §5 commit-reveal → Tasks 7, 10, 11. §6 data model → Task 7 step 3, Task 10 step 4. §7 contract behaviour → Tasks 9, 10, 11. §8 shared library → Tasks 6, 7. §9 backend and demo → Tasks 13, 14, 16. §10 testing → every TDD task; §10.3 → Task 15 step 3. §11 layout → Task 2. §12 environment → Task 1. §13–14 deferred work and risks → Task 15 steps 1 and 4.

**Two spec sections have no task, deliberately.** §2.2 defects C5 and C6 concern deferred contracts; C6's mitigation is nonetheless applied preemptively in Task 9's composite-key duplicate check, and both are recorded in the threat model and ADRs.

**Type consistency.** `canonicalize`, `commitSeed`, `deriveNonce`, `windowFor`, `deriveIdentityId`, `hashPublicKey`, `isSha256Hex`, `isEd25519PublicKey` are defined in Tasks 6–7 and used with matching signatures in Tasks 9–11 and 14. `makeContext` / `nextTx` are defined in Task 8 and used in Tasks 9–11. `fail`, `readJson`, `exists`, and the key builders are defined in Task 8 and used in Tasks 9–11. `deadlineOf` and `verificationStateOf` are defined in Task 10 and used in Task 11. `GeoPoint` changes shape in Task 10 step 4; that step updates its only two consumers.

**One inconsistency found and fixed during review:** Task 10 originally stored geofence coordinates as floating-point degrees, which `canonicalize` rejects by design (Task 6). Resolved by integer microdegrees in Task 10 step 4, with round-trip tests.
