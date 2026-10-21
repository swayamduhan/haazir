import './style.css';
import { api, ApiError, badge, explain, h, mount, short, topbar } from './lib';
import { generateDeviceKey } from './protocol';

document.body.prepend(topbar('Registrar desk'));
const app = document.getElementById('app')!;

const field = (id: string, label: string, attrs: Record<string, any> = {}) => {
  const input = h('input', { id, ...attrs });
  return { input, el: h('div', { class: 'field' }, h('label', { for: id }, label), input) };
};
const fail = (out: HTMLElement, err: unknown) => {
  const e = explain(err);
  mount(out, h('div', { class: 'notice bad small' }, `${e.code}: ${e.message}`));
};

// ------------------------------------------------------------ registration
function registerCard(): HTMLElement {
  const name = field('r-name', 'Full name', { placeholder: 'Aryan Saxena' });
  const reg = field('r-reg', 'Registration number', { placeholder: '23BKT0058' });
  const key = field('r-key', 'Device public key (shown on the student’s phone)', { placeholder: '64 hex characters', class: 'mono' });
  const out = h('div');
  const gen = h('button', { class: 'btn ghost', type: 'button', onclick: () => {
    key.input.value = generateDeviceKey().publicKeyHex;
  } }, 'Demo key');
  const go = h('button', { class: 'btn', onclick: async () => {
    go.disabled = true;
    try {
      const r = await api<{ identityID: string; identityHash: string }>('POST', '/registrar/students', {
        name: name.input.value.trim(), regNo: reg.input.value.trim().toUpperCase(), publicKey: key.input.value.trim(),
      });
      mount(out, h('div', { class: 'notice ok small' },
        h('strong', {}, 'Registered. '), 'Ledger ID ', h('code', {}, r.identityID),
        h('br'), 'On chain: only ', h('code', {}, short(r.identityHash, 10)),
        ' — the name and number are in the institution’s database, not the ledger.'));
    } catch (err) { fail(out, err); } finally { go.disabled = false; }
  } }, 'Register');
  return h('div', { class: 'card' },
    h('div', { class: 'eyebrow' }, 'Identity verified in person'),
    h('h2', {}, 'Register a student'),
    name.el, reg.el, h('div', { class: 'row' }, h('div', { class: 'grow' }, key.el), gen), go, out);
}

// --------------------------------------------------------------- exemption
function exemptionCard(): HTMLElement {
  const course = field('e-course', 'Course', { value: 'BCSE329L' });
  const student = field('e-student', 'Student ledger ID', { class: 'mono' });
  const session = field('e-session', 'Session ID', { placeholder: 'S-1a2b3c4d', class: 'mono' });
  const kind = h('select', { id: 'e-kind' },
    h('option', { value: 'medical' }, 'Medical'), h('option', { value: 'official_duty' }, 'On duty'),
    h('option', { value: 'institutional' }, 'Institutional'));
  const effect = h('select', { id: 'e-effect' },
    h('option', { value: 'excluded' }, 'Excuse'), h('option', { value: 'counts_present' }, 'Count as present'));
  const reason = field('e-reason', 'Reason', { placeholder: 'Hospital admission, certificate attached' });
  const file = h('input', { id: 'e-file', type: 'file', accept: '.pdf,image/*' });
  const out = h('div');
  const go = h('button', { class: 'btn', onclick: async () => {
    const doc = file.files?.[0];
    if (!doc) { mount(out, h('div', { class: 'notice warn small' }, 'Attach the supporting document.')); return; }
    go.disabled = true;
    try {
      const up = await fetch('/api/evidence', {
        method: 'POST', headers: { 'X-Filename': doc.name, 'Content-Type': doc.type || 'application/octet-stream' },
        body: await doc.arrayBuffer(),
      });
      const filed = await up.json();
      if (!up.ok) throw new ApiError(up.status, filed?.error?.code ?? 'HTTP', filed?.error?.detail ?? '');
      await api('POST', `/courses/${encodeURIComponent(course.input.value.trim())}/students/${encodeURIComponent(student.input.value.trim())}/exemptions`, {
        sessionID: session.input.value.trim(), kind: kind.value, effect: effect.value,
        evidenceCID: filed.cid, reason: reason.input.value.trim(),
      });
      mount(out, h('div', { class: 'notice ok small' },
        h('strong', {}, 'Exemption recorded. '), 'The certificate is on the private IPFS node; the ledger holds only its content identifier ',
        h('code', {}, short(filed.cid, 12)), '.'));
    } catch (err) { fail(out, err); } finally { go.disabled = false; }
  } }, 'File exemption');
  return h('div', { class: 'card' },
    h('div', { class: 'eyebrow' }, 'Exam Cell'),
    h('h2', {}, 'File an exemption'),
    h('div', { class: 'grid2' }, course.el, session.el), student.el,
    h('div', { class: 'grid2' },
      h('div', { class: 'field' }, h('label', { for: 'e-kind' }, 'Kind'), kind),
      h('div', { class: 'field' }, h('label', { for: 'e-effect' }, 'Effect'), effect)),
    reason.el,
    h('div', { class: 'field' }, h('label', { for: 'e-file' }, 'Supporting document'), file),
    go, out);
}

// ----------------------------------------------------------------- erasure
function erasureCard(): HTMLElement {
  const id = field('x-id', 'Student ledger ID', { class: 'mono' });
  const out = h('div', { class: 'stack' });

  async function show(): Promise<void> {
    const sid = id.input.value.trim();
    if (!sid) return;
    const [held, chain] = await Promise.all([
      api<any>('GET', `/registrar/students/${encodeURIComponent(sid)}`).catch((e) => e),
      api<any>('GET', `/identities/${encodeURIComponent(sid)}`).catch((e) => e),
    ]);
    const live = held && !(held instanceof Error) && 'name' in held;
    const erase = h('button', { class: 'btn danger', onclick: async () => {
      if (!confirm('Erase this student’s personal data? The ledger record stays, but nothing will link it to a person again.')) return;
      try { await api('DELETE', `/registrar/students/${encodeURIComponent(sid)}/pii`); await show(); } catch (err) { fail(out, err); }
    } }, 'Erase personal data');
    mount(out,
      h('dl', { class: 'kv' },
        h('dt', {}, 'Institution holds'),
        h('dd', {}, live ? `${held.name} · ${held.regNo}` : held instanceof ApiError ? badge('neutral', 'nothing') : badge('warn', `erased ${new Date(held.erasedAt).toLocaleString()}`)),
        h('dt', {}, 'Ledger holds'),
        h('dd', {}, chain instanceof Error ? badge('bad', 'no such identity') : h('span', {}, h('code', {}, short(chain.identityHash, 10)), ' ', badge('ok', 'unchanged')))),
      live ? erase : h('p', { class: 'small muted' }, 'The on-chain history is intact and still verifiable. It just no longer points at anyone: the salt that linked the hash to this person is gone.'));
  }

  return h('div', { class: 'card' },
    h('div', { class: 'eyebrow' }, 'DPDP Act 2023, s.12'),
    h('h2', {}, 'Right to erasure'),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, id.el),
      h('button', { class: 'btn ghost', onclick: () => { void show(); } }, 'Look up')),
    out);
}

mount(app, h('div', { class: 'page' },
  h('div', { class: 'hero' },
    h('h1', {}, 'Registrar desk'),
    h('p', {}, 'Personal data and documents stay with the institution, where they can be corrected and erased. The ledger only ever receives hashes and content identifiers.')),
  h('div', { class: 'home-grid' }, registerCard(), exemptionCard(), erasureCard())));
