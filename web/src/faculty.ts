import QRCode from 'qrcode';
import './style.css';
import {
  api, badge, currentPosition, explain, h, mount, randomHex, short, store, topbar,
} from './lib';
import {
  commitSeed, deriveNonce, encodeQr, generateDeviceKey, hashIdentity, NONCE_WINDOW_SEC,
  randomSeed, windowFor,
} from './protocol';

interface Faculty { identityID: string; name: string; staffID: string }

/**
 * The live session, persisted on this device. The seed is here and nowhere
 * else: the server only ever saw its hash. Losing this record before close
 * means the session can never be verified — so it survives a page reload.
 */
interface LiveSession {
  sessionID: string;
  courseID: string;
  room: string;
  startMs: number;
  durationSec: number;
  seed: string;
}

const FACULTY_KEY = 'haazir.faculty';
const SESSION_KEY = 'haazir.faculty.session';

const app = document.getElementById('app')!;
document.body.prepend(topbar('Faculty console'));

let ticker: number | undefined;
let poller: number | undefined;
const stopTimers = () => { window.clearInterval(ticker); window.clearInterval(poller); };

function route(): void {
  stopTimers();
  const faculty = store.get<Faculty>(FACULTY_KEY);
  const live = store.get<LiveSession>(SESSION_KEY);
  if (!faculty) renderRegister();
  else if (live) renderLive(faculty, live);
  else renderNewSession(faculty);
}

// --------------------------------------------------------------- register
function renderRegister(): void {
  const name = h('input', { id: 'name', placeholder: 'Dr. A. Kumar', autocomplete: 'name' });
  const staff = h('input', { id: 'staff', placeholder: 'FAC-1042' });
  const status = h('div');
  const button = h('button', { class: 'btn', onclick: async () => {
    if (!name.value.trim() || !staff.value.trim()) return;
    button.disabled = true;
    try {
      // Name and staff number stay on this device; the ledger sees a salted hash.
      const salt = randomHex(16);
      const key = generateDeviceKey();
      const { identityID } = await api<{ identityID: string }>('POST', '/identities', {
        identityHash: hashIdentity(name.value.trim(), staff.value.trim(), salt),
        publicKey: key.publicKeyHex, role: 'faculty',
      });
      store.set(FACULTY_KEY, { identityID, name: name.value.trim(), staffID: staff.value.trim() });
      route();
    } catch (err) {
      const e = explain(err);
      mount(status, h('div', { class: 'notice bad' }, `${e.code}: ${e.message}`));
      button.disabled = false;
    }
  } }, 'Register this device');

  mount(app, h('div', { class: 'page narrow stack' },
    h('div', { class: 'card' },
      h('div', { class: 'eyebrow' }, 'One-time setup'),
      h('h1', {}, 'Register as faculty'),
      h('p', { class: 'muted' }, 'Your name and staff number stay on this device. The ledger stores only a salted hash.'),
      h('div', { class: 'field' }, h('label', { for: 'name' }, 'Full name'), name),
      h('div', { class: 'field' }, h('label', { for: 'staff' }, 'Staff number'), staff),
      button, status)));
}

// ------------------------------------------------------------ new session
function renderNewSession(faculty: Faculty): void {
  const course = h('input', { id: 'course', value: 'BCSE329L' });
  const room = h('input', { id: 'room', value: 'SJT 501' });
  const minutes = h('input', { id: 'minutes', type: 'number', value: '60', min: '1', max: '240' });
  const radius = h('input', { id: 'radius', type: 'number', value: '50', min: '10', max: '1000' });
  const lat = h('input', { id: 'lat', placeholder: '12.9692', inputmode: 'decimal' });
  const lng = h('input', { id: 'lng', placeholder: '79.1559', inputmode: 'decimal' });
  const fix = h('span', { class: 'small muted' });
  const status = h('div');

  const locate = h('button', { class: 'btn ghost', onclick: async () => {
    locate.disabled = true;
    fix.textContent = 'Locating…';
    try {
      const p = await currentPosition();
      lat.value = p.lat.toFixed(7);
      lng.value = p.lng.toFixed(7);
      fix.textContent = `±${Math.round(p.accuracy)} m`;
    } catch (err) {
      fix.textContent = (err as Error).message;
    } finally {
      locate.disabled = false;
    }
  } }, 'Use this device’s location');

  const open = h('button', { class: 'btn amber block', onclick: async () => {
    const latN = Number(lat.value);
    const lngN = Number(lng.value);
    if (!course.value.trim() || !lat.value || !lng.value || Number.isNaN(latN) || Number.isNaN(lngN)) {
      mount(status, h('div', { class: 'notice warn' }, 'Course and a geofence centre are required.'));
      return;
    }
    open.disabled = true;
    const seed = randomSeed();
    const startMs = Date.now();
    const live: LiveSession = {
      sessionID: `S-${randomHex(4)}`, courseID: course.value.trim(), room: room.value.trim() || '-',
      startMs, durationSec: Math.round(Number(minutes.value || 60) * 60), seed,
    };
    // Persist before the request: if the page dies mid-flight, the seed for a
    // session that may now exist on chain must not be lost with it.
    store.set(SESSION_KEY, live);
    try {
      await api('POST', '/sessions', {
        sessionID: live.sessionID, courseID: live.courseID, facultyID: faculty.identityID,
        room: live.room, startTime: new Date(startMs).toISOString(), durationSec: live.durationSec,
        gracePeriodSec: 900, geofenceCenter: { lat: latN, lng: lngN },
        geofenceRadiusM: Math.round(Number(radius.value || 50)),
        nonceSeedHash: commitSeed(seed),   // the hash, never the seed
      });
      route();
    } catch (err) {
      store.remove(SESSION_KEY);
      const e = explain(err);
      mount(status, h('div', { class: 'notice bad' }, `${e.code}: ${e.message}`));
      open.disabled = false;
    }
  } }, 'Open session');

  mount(app, h('div', { class: 'page narrow stack' },
    h('div', { class: 'card' },
      h('div', { class: 'eyebrow' }, `Signed in as ${faculty.name}`),
      h('h1', {}, 'Open a session'),
      h('div', { class: 'grid2' },
        h('div', { class: 'field' }, h('label', { for: 'course' }, 'Course'), course),
        h('div', { class: 'field' }, h('label', { for: 'room' }, 'Room'), room),
        h('div', { class: 'field' }, h('label', { for: 'minutes' }, 'Duration (minutes)'), minutes),
        h('div', { class: 'field' }, h('label', { for: 'radius' }, 'Geofence radius (m)'), radius)),
      h('h3', {}, 'Geofence centre'),
      h('div', { class: 'row' }, locate, fix),
      h('div', { class: 'grid2' },
        h('div', { class: 'field' }, h('label', { for: 'lat' }, 'Latitude'), lat),
        h('div', { class: 'field' }, h('label', { for: 'lng' }, 'Longitude'), lng)),
      h('div', { class: 'notice info small' },
        'A random seed is generated on this device. Only its SHA-256 hash is sent to the ledger; the seed is revealed when you close the session, and every code students scanned is then checked against it.'),
      open, status)));
}

// ------------------------------------------------------------ live session
function renderLive(faculty: Faculty, live: LiveSession): void {
  const canvas = h('canvas');
  const bar = h('div', { style: 'width:100%' });
  const windowLabel = h('div', { class: 'window-no' });
  const presentCount = h('div', { class: 'big-number' }, '0');
  const rosterBody = h('tbody');
  const status = h('div');
  let shownWindow = -1;

  const deadline = live.startMs + live.durationSec * 1000;

  function tick(): void {
    const now = Date.now();
    if (now > deadline) {
      windowLabel.textContent = 'Session time is over — close it to reveal the seed.';
      bar.style.width = '0%';
      return;
    }
    const w = windowFor(now, live.startMs);
    const into = (now - live.startMs) % (NONCE_WINDOW_SEC * 1000);
    bar.style.width = `${100 - (into / (NONCE_WINDOW_SEC * 1000)) * 100}%`;
    if (w !== shownWindow) {
      shownWindow = w;
      // Derived locally. Rotation costs no transaction at all.
      const text = encodeQr({ s: live.sessionID, c: live.courseID, w, n: deriveNonce(live.seed, w) });
      void QRCode.toCanvas(canvas, text, {
        errorCorrectionLevel: 'M', margin: 2, width: 440, color: { dark: '#1f2a5cff', light: '#ffffffff' },
      });
      windowLabel.textContent = `window ${w} · rotates every ${NONCE_WINDOW_SEC} s`;
    }
  }

  async function poll(): Promise<void> {
    try {
      const view = await api<{ present: number; entries: any[] }>('GET', `/sessions/${live.sessionID}/attendance`);
      presentCount.textContent = String(view.present);
      mount(rosterBody, ...view.entries.slice().reverse().map((e) => h('tr', {},
        h('td', { class: 'mono' }, short(e.studentID)),
        h('td', {}, new Date(e.updatedAt).toLocaleTimeString()),
        h('td', {}, e.currentStatus === 'present' ? badge('ok', 'present') : badge('neutral', e.currentStatus)))));
    } catch { /* transient; the next poll retries */ }
  }

  const close = h('button', { class: 'btn', onclick: async () => {
    if (!confirm('Close the session and reveal the seed? No further attendance will be accepted.')) return;
    close.disabled = true;
    try {
      await api('POST', `/sessions/${live.sessionID}/close`, { revealedSeed: live.seed });
      stopTimers();
      store.remove(SESSION_KEY);
      renderClosed(faculty, live);
    } catch (err) {
      const e = explain(err);
      mount(status, h('div', { class: 'notice bad' }, `${e.code}: ${e.message}`));
      close.disabled = false;
    }
  } }, 'Close session & reveal seed');

  const abandon = h('button', { class: 'btn ghost', onclick: () => {
    if (!confirm('Forget this session on this device? Its seed will be lost, it can never be closed, and it will be recorded as expired.')) return;
    store.remove(SESSION_KEY);
    route();
  } }, 'Abandon');

  mount(app, h('div', { class: 'page' },
    h('div', { class: 'console' },
      h('div', { class: 'card qr-panel' },
        h('div', { class: 'eyebrow' }, `${live.courseID} · ${live.room}`),
        h('h2', {}, 'Scan to mark attendance'),
        canvas, h('div', { class: 'ring' }, bar), windowLabel,
        h('p', { class: 'small muted center' },
          'A photo of this code is useless within seconds: it carries only this window’s code, and the window rotates.')),
      h('div', { class: 'stack' },
        h('div', { class: 'card' },
          h('div', { class: 'row' },
            h('div', { class: 'grow' }, h('div', { class: 'eyebrow' }, 'Present'), presentCount),
            badge('ok', 'open')),
          h('dl', { class: 'kv' },
            h('dt', {}, 'Session'), h('dd', { class: 'mono' }, live.sessionID),
            h('dt', {}, 'Started'), h('dd', {}, new Date(live.startMs).toLocaleTimeString()),
            h('dt', {}, 'Ends'), h('dd', {}, new Date(deadline).toLocaleTimeString()),
            h('dt', {}, 'Seed on chain'), h('dd', {}, 'hash only, until you close'))),
        h('div', { class: 'card' },
          h('h3', {}, 'Live roster'),
          h('div', { class: 'scroll-x' }, h('table', { class: 'list' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Student'), h('th', {}, 'Marked'), h('th', {}, 'Status'))),
            rosterBody)),
          h('p', { class: 'small muted' }, 'Students appear by ledger ID. Names never reach the chain.')),
        h('div', { class: 'row' }, close, abandon),
        status))));

  tick();
  void poll();
  ticker = window.setInterval(tick, 250);
  poller = window.setInterval(() => { void poll(); }, 3000);
}

// ------------------------------------------------------------------ closed
async function renderClosed(faculty: Faculty, live: LiveSession): Promise<void> {
  const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Reading the verdict from the ledger…'));
  mount(app, h('div', { class: 'page narrow stack' },
    h('div', { class: 'card' },
      h('div', { class: 'eyebrow' }, 'Session closed'),
      h('h1', {}, live.sessionID),
      body,
      h('div', { class: 'row' },
        h('a', { class: 'btn amber', href: `/verify.html?session=${encodeURIComponent(live.sessionID)}` }, 'Verify independently'),
        h('button', { class: 'btn ghost', onclick: () => renderNewSession(faculty) }, 'New session')))));

  try {
    const s = await api<any>('GET', `/sessions/${live.sessionID}`);
    const a = s.nonceAudit ?? { recordsChecked: 0, validCount: 0, invalidCount: 0 };
    const verdict = s.verificationState === 'verified'
      ? h('div', { class: 'notice ok' }, 'Verified. The revealed seed matched its commitment, and every code students submitted was genuine.')
      : h('div', { class: 'notice bad' }, `Disputed. ${a.invalidCount} submission(s) carried a code this session never displayed.`);
    mount(body,
      verdict,
      h('dl', { class: 'kv' },
        h('dt', {}, 'Codes checked'), h('dd', {}, String(a.recordsChecked)),
        h('dt', {}, 'Genuine'), h('dd', {}, String(a.validCount)),
        h('dt', {}, 'Forged'), h('dd', {}, String(a.invalidCount)),
        h('dt', {}, 'State'), h('dd', {}, s.verificationState)),
      h('p', { class: 'small muted' }, 'Both endorsing organisations recomputed every code in the same transaction that revealed the seed.'));
  } catch (err) {
    const e = explain(err);
    mount(body, h('div', { class: 'notice warn' }, `${e.code}: ${e.message}`));
  }
}

route();
