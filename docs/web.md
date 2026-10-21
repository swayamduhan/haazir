# Web clients

Four pages, served by Vite from `web/`, talking to the REST API (`docs/api.md`)
through a `/api` proxy so the browser sees a single HTTPS origin.

| Page | Who uses it | What it does |
|---|---|---|
| `/faculty.html` | Faculty, projected in class | Generates the session seed **on the device**, sends only its hash, projects a QR that rotates every 10 s, shows the live roster, closes the session by revealing the seed |
| `/student.html` | Student, on a phone | Creates an Ed25519 key on the phone, runs an on-device liveness check, reads GPS, scans the current code, signs the claim and submits it |
| `/registrar.html` | Registrar and Exam Cell staff | Registers students with their personal data held in PostgreSQL, files exemptions with the evidence on IPFS, and erases personal data on request — none of it touching the ledger's history |
| `/verify.html` | Anyone | Fetches a session and recomputes every check in the browser: seed vs commitment, each code vs the seed, each signature vs its key, each location vs the geofence — then compares with the verdicts the contract wrote |

## Running

```bash
./network/scripts/full-demo.sh     # network up, chaincode deployed
./network/scripts/offchain-up.sh   # PostgreSQL + private IPFS (for the Registrar desk)
./scripts/serve-web.sh             # API on :3000, web on https://localhost:5173
```

To use a real phone, run once in an **administrator** PowerShell on the laptop:

```powershell
.\scripts\expose-to-phone.ps1      # prints the URL to open on the phone
.\scripts\expose-to-phone.ps1 -Remove
```

HTTPS is required, not cosmetic: browsers only allow camera and location on
secure origins. The certificate is self-signed, so the phone shows a warning
once. If campus Wi-Fi blocks device-to-device traffic, join the phone to the
laptop's Mobile Hotspot.

## Demo sequence

1. Faculty console: register, *Use this device's location*, *Open session*. Project it.
2. Phone: register, enrol in the course, *Mark attendance* — blink when asked,
   allow location, point at the projected code.
3. The roster updates within three seconds.
4. *Close session & reveal seed* — the console reports verified or disputed.
5. *Verify independently* — every check recomputed in the browser.

## One definition of the protocol

The browser does not reimplement the protocol. The canonical encoding, the
signed payload and the integer geofence arithmetic are imported from
`packages/shared/src` source, the same code the chaincode runs. The remaining
primitives (SHA-256 commitment, HMAC nonce, Ed25519) use `@noble`, and
`web/test/protocol.test.ts` checks every one of them against the Node
implementation the contract uses — including signatures crossing in both
directions.

## Honest limits

- **Liveness proves a live face, not whose face.** It is a randomised blink
  challenge run on the device by MediaPipe's face landmarker; only a digest of
  the result is signed and sent. Matching the face against an enrolment
  template is future work.
- **The device key lives in browser storage**, not a secure element. It proves
  possession of this browser profile. A native client would use the platform
  keystore.
- **Self-registration from the student app is a demonstration shortcut;** the Registrar desk is the production path.
- **Self-enrolment is a demonstration shortcut.** The API
  has no end-user authentication yet; in production the Registrar enrols
  identities in person and the Exam Cell maintains rosters (ADR-013).
- **No BLE.** Browsers do not expose BLE advertising, so proximity is the
  geofence alone.
