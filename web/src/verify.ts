import './style.css';
import { api, badge, explain, h, mount, short, topbar } from './lib';
import { commitSeed, deriveNonce, distanceMetres, isWithinRadius, verifyClaim } from './protocol';

document.body.prepend(topbar('Public verifier'));
const app = document.getElementById('app')!;

interface Check { pass: boolean | null; text: string }

const mark = (c: Check) => (c.pass === null ? badge('neutral', c.text) : badge(c.pass ? 'ok' : 'bad', c.text));

function render(initial = ''): void {
  const input = h('input', { id: 'sid', placeholder: 'S-1a2b3c4d', value: initial });
  const out = h('div', { class: 'stack' });
  const go = h('button', { class: 'btn', onclick: () => {
    const id = input.value.trim();
    if (!id) return;
    history.replaceState(null, '', `?session=${encodeURIComponent(id)}`);
    void verify(id, out);
  } }, 'Verify');
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });

  mount(app, h('div', { class: 'page stack' },
    h('div', { class: 'card' },
      h('div', { class: 'eyebrow' }, 'Trust nothing, recompute everything'),
      h('h1', {}, 'Verify a session'),
      h('p', { class: 'muted' }, 'This page fetches a session’s records and then checks them itself, in your browser: the seed against its commitment, every scanned code against the seed, every device signature against its key, and every location against the geofence. No step relies on our server’s say-so.'),
      h('div', { class: 'row' }, h('div', { class: 'field grow' }, input), go)),
    out));
  if (initial) go.click();
}

async function verify(sessionID: string, out: HTMLElement): Promise<void> {
  mount(out, h('div', { class: 'card muted' }, 'Fetching records…'));
  try {
    const session = await api<any>('GET', `/sessions/${encodeURIComponent(sessionID)}`);
    const index = await api<any>('GET', `/sessions/${encodeURIComponent(sessionID)}/attendance`);
    const views = await Promise.all(index.entries.map((e: any) =>
      api<any>('GET', `/sessions/${encodeURIComponent(sessionID)}/attendance/${encodeURIComponent(e.studentID)}`)));
    const audit = session.status === 'closed'
      ? await api<any>('GET', `/sessions/${encodeURIComponent(sessionID)}/nonce-audit`).catch(() => null)
      : null;

    const seed: string | undefined = session.revealedSeed;
    const commitment: Check = seed
      ? { pass: commitSeed(seed) === session.nonceSeedHash, text: commitSeed(seed) === session.nonceSeedHash ? 'seed matches commitment' : 'seed does NOT match' }
      : { pass: null, text: 'seed not yet revealed' };

    const rows: HTMLElement[] = [];
    let checked = 0;
    let failed = 0;
    let agreesWithLedger = 0;

    for (const view of views) {
      for (const r of view.history) {
        if (r.origin !== 'device') {
          rows.push(h('tr', {},
            h('td', { class: 'mono' }, short(r.studentID)),
            h('td', { colspan: '4' }, badge('neutral', `correction → ${r.status}`), ' ',
              h('span', { class: 'small muted' }, r.reason ?? '')),
            h('td', {}, r.seq === view.index.currentSeq ? badge('ok', 'current') : badge('neutral', 'superseded'))));
          continue;
        }
        checked += 1;
        const claim = {
          sessionID: r.sessionID, studentID: r.studentID, courseID: r.courseID,
          claimedWindow: r.claimedWindow, claimedNonce: r.claimedNonce,
          latE7: r.location.latE7, lngE7: r.location.lngE7, livenessHash: r.livenessHash,
        };
        const sig: Check = verifyClaim(r.devicePublicKey, claim, r.deviceSignature)
          ? { pass: true, text: 'valid' } : { pass: false, text: 'invalid' };
        const dist = distanceMetres(r.location, session.geofenceCenter);
        const geo: Check = isWithinRadius(r.location, session.geofenceCenter, session.geofenceRadiusM)
          ? { pass: true, text: `${dist} m` } : { pass: false, text: `${dist} m` };
        const nonce: Check = seed
          ? (deriveNonce(seed, r.claimedWindow) === r.claimedNonce
            ? { pass: true, text: `genuine (w${r.claimedWindow})` } : { pass: false, text: `forged (w${r.claimedWindow})` })
          : { pass: null, text: 'awaiting reveal' };

        const ledgerVerdict = audit?.verdicts.find((v: any) => v.recordID === r.recordID);
        const agree: Check = ledgerVerdict && nonce.pass !== null
          ? (ledgerVerdict.valid === nonce.pass ? { pass: true, text: 'agrees' } : { pass: false, text: 'DISAGREES' })
          : { pass: null, text: '—' };
        if (agree.pass) agreesWithLedger += 1;
        if (sig.pass === false || geo.pass === false || nonce.pass === false) failed += 1;

        rows.push(h('tr', {},
          h('td', { class: 'mono' }, short(r.studentID)),
          h('td', {}, mark(sig)),
          h('td', {}, mark(nonce)),
          h('td', {}, mark(geo)),
          h('td', {}, mark(agree)),
          h('td', {}, r.seq === view.index.currentSeq ? badge('ok', 'current') : badge('neutral', 'superseded'))));
      }
    }

    const headline = !seed
      ? h('div', { class: 'notice warn' }, 'The session is still open, so its seed is secret. Signatures and locations are checked now; codes can only be checked after the faculty reveals the seed at close.')
      : failed === 0 && commitment.pass
        ? h('div', { class: 'notice ok' }, h('strong', {}, 'Everything checks out. '), `${checked} device submission(s) recomputed in this browser: every signature is valid, every location is inside the geofence, and every code was genuinely displayed in its window.`)
        : h('div', { class: 'notice bad' }, h('strong', {}, `${failed} submission(s) failed a check. `), 'See the rows marked in red below. The ledger records them as they were submitted; this is the evidence.');

    mount(out,
      h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('div', { class: 'grow' }, h('div', { class: 'eyebrow' }, session.courseID), h('h2', {}, session.sessionID)),
          badge(session.verificationState === 'verified' ? 'ok' : session.verificationState === 'disputed' ? 'bad' : 'warn',
            `ledger says: ${session.verificationState}`)),
        headline,
        h('dl', { class: 'kv' },
          h('dt', {}, 'Commitment'), h('dd', {}, mark(commitment)),
          h('dt', {}, 'Geofence'), h('dd', {}, `${session.geofenceRadiusM} m around ${(session.geofenceCenter.latE7 / 1e7).toFixed(5)}, ${(session.geofenceCenter.lngE7 / 1e7).toFixed(5)}`),
          h('dt', {}, 'Opened'), h('dd', {}, new Date(session.startTime).toLocaleString()),
          audit ? h('dt', {}, 'Ledger agreement') : null,
          audit ? h('dd', {}, `${agreesWithLedger} of ${checked} verdicts recomputed here match the ones both organisations wrote at close`) : null)),
      h('div', { class: 'card' },
        h('h3', {}, 'Every submission, rechecked here'),
        h('div', { class: 'scroll-x' }, h('table', { class: 'list' },
          h('thead', {}, h('tr', {},
            h('th', {}, 'Student'), h('th', {}, 'Signature'), h('th', {}, 'Code'),
            h('th', {}, 'Distance'), h('th', {}, 'vs ledger'), h('th', {}, 'Record'))),
          h('tbody', {}, ...(rows.length ? rows : [h('tr', {}, h('td', { colspan: '6', class: 'muted' }, 'No submissions yet.'))])))),
        h('p', { class: 'small muted' }, 'The records were fetched through this site’s API. For a check that trusts no institutional server at all, point the same code at a peer you operate yourself — for instance the Audit organisation’s, which validates every block but can write nothing.')));
  } catch (err) {
    const e = explain(err);
    mount(out, h('div', { class: 'notice bad' }, `${e.code}: ${e.message}`));
  }
}

render(new URLSearchParams(location.search).get('session') ?? '');
