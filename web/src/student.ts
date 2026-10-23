import { canonicalize } from '@shared/canonical';
import './style.css';
import { openCamera, runLiveness, scanForCode } from './camera';
import {
  api, ApiError, badge, currentPosition, explain, h, mount, randomHex, short, store, topbar,
} from './lib';
import { generateDeviceKey, hashIdentity, sha256Hex, signClaim, toE7 } from './protocol';

/**
 * Everything about the student that exists, kept on this phone. The ledger
 * holds only the identity hash and the public key; the name, registration
 * number, salt and private key never leave the device.
 */
interface Student {
  identityID: string;
  name: string;
  regNo: string;
  salt: string;
  secretKeyHex: string;
  publicKeyHex: string;
  courses: string[];
}

interface Mark { sessionID: string; courseID: string; at: string; ok: boolean; detail: string }

const STUDENT_KEY = 'haazir.student';
const HISTORY_KEY = 'haazir.student.history';

const app = document.getElementById('app')!;
document.body.prepend(topbar('Student'));

function route(): void {
  const s = store.get<Student>(STUDENT_KEY);
  if (s) renderHome(s); else renderOnboarding();
}

// -------------------------------------------------------------- onboarding
function renderOnboarding(): void {
  const name = h('input', { id: 'name', autocomplete: 'name', placeholder: 'Swayam Duhan' });
  const reg = h('input', { id: 'reg', placeholder: '23BKT0085', autocapitalize: 'characters' });
  const status = h('div');
  const go = h('button', { class: 'btn block', onclick: async () => {
    if (!name.value.trim() || !reg.value.trim()) return;
    go.disabled = true;
    try {
      const salt = randomHex(16);
      const key = generateDeviceKey();
      const { identityID } = await api<{ identityID: string }>('POST', '/identities', {
        identityHash: hashIdentity(name.value.trim(), reg.value.trim().toUpperCase(), salt),
        publicKey: key.publicKeyHex, role: 'student',
      });
      store.set(STUDENT_KEY, {
        identityID, name: name.value.trim(), regNo: reg.value.trim().toUpperCase(), salt,
        secretKeyHex: key.secretKeyHex, publicKeyHex: key.publicKeyHex, courses: [],
      } satisfies Student);
      route();
    } catch (err) {
      const e = explain(err);
      mount(status, h('div', { class: 'notice bad' }, `${e.code}: ${e.message}`));
      go.disabled = false;
    }
  } }, 'Register this phone');

  mount(app, h('div', { class: 'page narrow stack' },
    h('div', { class: 'card' },
      h('div', { class: 'eyebrow' }, 'One-time setup'),
      h('h1', {}, 'Register this phone'),
      h('p', { class: 'muted' }, 'This phone creates a signing key. Only the public half and a salted hash of your details go on the ledger — your name and number stay here.'),
      h('div', { class: 'field' }, h('label', { for: 'name' }, 'Full name'), name),
      h('div', { class: 'field' }, h('label', { for: 'reg' }, 'Registration number'), reg),
      go, status,
      h('p', { class: 'small muted' }, 'In production this happens once, in person, at the Registrar’s desk after your identity is checked. Self-registration is a demonstration shortcut.'))));
}

// -------------------------------------------------------------------- home
function renderHome(s: Student): void {
  const courseInput = h('input', { id: 'course', value: 'BCSE329L', autocapitalize: 'characters' });
  const courseStatus = h('div');
  const history = store.get<Mark[]>(HISTORY_KEY) ?? [];

  const enrol = h('button', { class: 'btn ghost', onclick: async () => {
    const c = courseInput.value.trim().toUpperCase();
    if (!c) return;
    enrol.disabled = true;
    try {
      await api('POST', `/courses/${encodeURIComponent(c)}/roster`, { studentID: s.identityID });
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'ALREADY_ENROLLED')) {
        const e = explain(err);
        mount(courseStatus, h('div', { class: 'notice bad small' }, `${e.code}: ${e.message}`));
        enrol.disabled = false;
        return;
      }
    }
    if (!s.courses.includes(c)) s.courses.push(c);
    store.set(STUDENT_KEY, s);
    renderHome(s);
  } }, 'Enrol');

  mount(app, h('div', { class: 'page narrow stack' },
    h('div', { class: 'card' },
      h('div', { class: 'eyebrow' }, 'This phone is registered'),
      h('h1', {}, s.name),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Reg. no.'), h('dd', {}, s.regNo),
        h('dt', {}, 'Ledger ID'), h('dd', { class: 'mono' }, short(s.identityID, 10)),
        h('dt', {}, 'Device key'), h('dd', { class: 'mono' }, short(s.publicKeyHex, 10))),
      h('button', { class: 'btn amber block', onclick: () => renderMark(s) }, 'Mark attendance')),
    h('div', { class: 'card' },
      h('h3', {}, 'Courses'),
      s.courses.length
        ? h('div', { class: 'row' }, ...s.courses.map((c) => badge('neutral', c)))
        : h('p', { class: 'small muted' }, 'Not enrolled in any course yet.'),
      h('div', { class: 'row' }, h('div', { class: 'field grow' }, courseInput), enrol),
      courseStatus,
      h('p', { class: 'small muted' }, 'Demonstration shortcut: in production the Exam Cell maintains the roster.')),
    history.length ? h('div', { class: 'card' },
      h('h3', {}, 'Recent'),
      h('table', { class: 'list' }, h('tbody', {}, ...history.slice(0, 8).map((m) => h('tr', {},
        h('td', {}, m.courseID, h('div', { class: 'small muted mono' }, m.sessionID)),
        h('td', {}, new Date(m.at).toLocaleString()),
        h('td', {}, m.ok ? badge('ok', 'present') : badge('bad', m.detail))))))) : null));
}

// -------------------------------------------------------------------- mark
type StepState = 'todo' | 'busy' | 'ok' | 'bad';

function renderMark(s: Student): void {
  const abort = new AbortController();
  const video = h('video', { playsinline: true, muted: true });
  const caption = h('div', { class: 'caption' });
  const viewer = h('div', { class: 'scanner', hidden: true }, video, h('div', { class: 'frame' }), caption);
  const result = h('div');

  const labels = ['Liveness: blink when asked', 'Location', 'Scan the code on screen', 'Sign and submit'];
  const dots = labels.map((_, i) => h('span', { class: 'dot' }, String(i + 1)));
  const notes = labels.map(() => h('span', { class: 'small muted' }));
  const set = (i: number, state: StepState, note = '') => {
    dots[i].className = `dot ${state === 'todo' ? '' : state}`;
    dots[i].textContent = state === 'ok' ? '✓' : state === 'bad' ? '✕' : String(i + 1);
    notes[i].textContent = note;
  };

  const cancel = h('button', { class: 'btn ghost', onclick: () => { abort.abort(); route(); } }, 'Cancel');

  mount(app, h('div', { class: 'page narrow stack' },
    h('div', { class: 'card' },
      h('div', { class: 'eyebrow' }, 'Marking attendance'),
      viewer,
      h('ul', { class: 'steps' }, ...labels.map((l, i) => h('li', {}, dots[i],
        h('div', { class: 'grow' }, l, h('div', {}, notes[i]))))),
      result,
      h('div', { class: 'row' }, cancel))));

  void (async () => {
    let stop: (() => void) | null = null;
    let step = 0;
    try {
      // 1. Liveness first: it is the slowest step, and the code must be the
      //    last thing captured so it is still current when it is submitted.
      set(0, 'busy');
      viewer.hidden = false;
      stop = await openCamera(video, 'user');
      const live = await runLiveness(video, (m) => { caption.textContent = m; set(0, 'busy', m); }, abort.signal);
      stop(); stop = null;
      set(0, 'ok', `${live.challenge.replace('-', ' ')} · on device`);
      // Only this digest is signed and sent: no image, no landmarks.
      const livenessHash = sha256Hex(canonicalize(live));

      step = 1;
      set(1, 'busy', 'Getting a fix…');
      viewer.hidden = true;
      const pos = await currentPosition();
      set(1, 'ok', `±${Math.round(pos.accuracy)} m`);

      step = 2;
      set(2, 'busy', 'Point the camera at the projected code');
      viewer.hidden = false;
      caption.textContent = 'Point at the code on screen';
      stop = await openCamera(video, 'environment');
      const qr = await scanForCode(video, abort.signal);
      stop(); stop = null;
      viewer.hidden = true;
      set(2, 'ok', `${qr.c} · window ${qr.w}`);

      step = 3;
      set(3, 'busy');
      const claim = {
        sessionID: qr.s, studentID: s.identityID, courseID: qr.c, claimedWindow: qr.w,
        claimedNonce: qr.n, latE7: toE7(pos.lat), lngE7: toE7(pos.lng), livenessHash,
      };
      const record = await api<any>('POST', `/sessions/${encodeURIComponent(qr.s)}/attendance`, {
        studentID: claim.studentID, claimedWindow: claim.claimedWindow, claimedNonce: claim.claimedNonce,
        latE7: claim.latE7, lngE7: claim.lngE7, livenessHash,
        deviceSignature: signClaim(s.secretKeyHex, claim),
      });
      set(3, 'ok', 'endorsed by Registrar and Exam Cell');
      remember({ sessionID: qr.s, courseID: qr.c, at: new Date().toISOString(), ok: true, detail: 'present' });
      mount(result, h('div', { class: 'notice ok' },
        h('strong', {}, 'Marked present. '),
        `Your claim is on the ledger as record ${short(record.recordID)}. The code you scanned is checked against the revealed seed when the session closes.`));
      cancel.textContent = 'Done';
    } catch (err) {
      stop?.();
      if ((err as Error)?.name === 'AbortError') return;
      viewer.hidden = true;
      const e = explain(err);
      set(step, 'bad', e.code);
      mount(result, h('div', { class: 'notice bad' }, h('strong', {}, `${e.code}. `), e.message));
      if (err instanceof ApiError) {
        remember({ sessionID: '-', courseID: '-', at: new Date().toISOString(), ok: false, detail: e.code });
      }
      cancel.textContent = 'Back';
    }
  })();
}

function remember(m: Mark): void {
  const history = store.get<Mark[]>(HISTORY_KEY) ?? [];
  history.unshift(m);
  store.set(HISTORY_KEY, history.slice(0, 20));
}

route();
