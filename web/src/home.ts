import './style.css';
import { api, badge, h, mount, topbar } from './lib';

document.body.prepend(topbar('Blockchain attendance'));
const status = h('span', {}, badge('neutral', 'checking ledger…'));

const tile = (href: string, eyebrow: string, title: string, text: string) =>
  h('a', { class: 'tile', href }, h('div', { class: 'card' },
    h('div', { class: 'eyebrow' }, eyebrow), h('h2', {}, title), h('p', { class: 'muted' }, text)));

mount(document.getElementById('app')!, h('div', { class: 'page' },
  h('div', { class: 'hero' },
    h('h1', {}, 'Attendance that no single office can rewrite'),
    h('p', {}, 'Every mark is signed by the student’s own device, checked against the classroom’s geofence and a code that rotates every ten seconds, and written only when the Registrar and the Exam Cell both agree.'),
    h('div', { class: 'row', style: 'margin-top:14px' }, status)),
  h('div', { class: 'home-grid' },
    tile('/faculty.html', 'Projected in class', 'Faculty console', 'Open a session, project the rotating code, watch the roster fill, then close and reveal the seed.'),
    tile('/student.html', 'On the student’s phone', 'Student app', 'Prove you are here: liveness on the device, location, the current code, all signed by your phone’s key.'),
    tile('/verify.html', 'Open to anyone', 'Verify a session', 'Recompute every code, signature and distance in your own browser. No trust in our server required.'),
    tile('/registrar.html', 'Institution only', 'Registrar desk', 'Register students, file exemptions with their evidence, and erase personal data on request — all without touching the ledger’s history.'))));

api('GET', '/health')
  .then(() => mount(status, badge('ok', 'ledger API reachable')))
  .catch(() => mount(status, badge('bad', 'ledger API unreachable — is the server running?')));
