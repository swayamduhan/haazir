import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { attempt, hex, Ledger, ledger, markArgs, newFaculty, newStudent, openSession, Student } from './common';

/**
 * Load and storage benchmark against the live network.
 *
 *   npm run bench --workspace @haazir/backend            # 30, 60, 120 students
 *   BENCH_SIZES=60 BENCH_RUNS=3 npm run bench ...
 *
 * The scenario is the worst case a class produces: every student submits in
 * the same instant, as if the whole room scanned the same code together. Each
 * latency is measured to commit, not to endorsement — Gateway submit returns
 * only once the transaction is validated and written to a block.
 *
 * Review I set the target: a class of 60 marked in under 30 seconds.
 */
const SIZES = (process.env.BENCH_SIZES ?? '30,60,120').split(',').map(Number);
const RUNS = Number(process.env.BENCH_RUNS ?? 2);
const CHAIN = '/var/hyperledger/production/ledgersData/chains/chains/attendance-channel';
const COUCH = 'http://localhost:5984/attendance-channel_haazir';
// The test network's CouchDB credentials, sent as a header: fetch rejects URLs with userinfo.
const COUCH_AUTH = { Authorization: `Basic ${Buffer.from('admin:adminpw').toString('base64')}` };

const ms = (t0: number) => performance.now() - t0;
const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const round = (n: number) => Math.round(n);

function chainBytes(): number {
  const out = execSync(`docker exec peer0.org1.example.com du -sb ${CHAIN}`).toString();
  return Number(out.split(/\s+/)[0]);
}

/** Creates N enrolled students, a few at a time so setup does not distort anything. */
async function students(l: Ledger, course: string, n: number): Promise<Student[]> {
  const all: Student[] = [];
  for (let i = 0; i < n; i += 15) {
    all.push(...await Promise.all(Array.from({ length: Math.min(15, n - i) }, () => newStudent(l, course))));
  }
  return all;
}

/** World-state bytes this session added, grouped by record type, from CouchDB itself. */
async function stateBytes(sessionID: string) {
  const res = await fetch(`${COUCH}/_all_docs?include_docs=true`, { headers: COUCH_AUTH });
  const body = (await res.json()) as { rows: { id: string; doc: Record<string, unknown> }[] };
  const sizes: Record<string, { docs: number; bytes: number }> = {};
  for (const row of body.rows) {
    if (!row.id.includes(sessionID)) continue;
    const type = row.id.split('\u0000').filter(Boolean)[0] ?? row.id;
    const { _id, _rev, '~version': _v, ...value } = row.doc as Record<string, unknown>;
    const bytes = Buffer.byteLength(JSON.stringify(value));
    sizes[type] = sizes[type] ?? { docs: 0, bytes: 0 };
    sizes[type].docs += 1;
    sizes[type].bytes += bytes;
  }
  return sizes;
}

async function single(l: Ledger, faculty: string): Promise<number[]> {
  const course = `B1-${hex(2)}`;
  const st = await students(l, course, 5);
  const s = await openSession(l, faculty, course);
  const out: number[] = [];
  for (const one of st) {
    const t0 = performance.now();
    await l.attendance.submit('markAttendance', ...markArgs(s, one));
    out.push(ms(t0));
  }
  return out;
}

async function burst(l: Ledger, faculty: string, n: number) {
  const course = `B${n}-${hex(2)}`;
  const st = await students(l, course, n);
  const s = await openSession(l, faculty, course);

  const before = chainBytes();
  const t0 = performance.now();
  const results = await Promise.all(st.map(async (one) => {
    const t = performance.now();
    const o = await attempt(() => l.attendance.submit('markAttendance', ...markArgs(s, one)));
    return { latency: ms(t), code: o.code };
  }));
  const wall = ms(t0);
  const after = chainBytes();

  const accepted = results.filter((r) => r.code === 'ACCEPTED');
  const failures: Record<string, number> = {};
  for (const r of results) if (r.code !== 'ACCEPTED') failures[r.code] = (failures[r.code] ?? 0) + 1;
  const lat = accepted.map((r) => r.latency).sort((a, b) => a - b);

  const tc = performance.now();
  await l.sessions.submit('closeSession', s.id, s.seed);
  const close = ms(tc);

  const q: number[] = [];
  for (let i = 0; i < 10; i += 1) {
    const t = performance.now();
    await l.policy.evaluate('computeEligibility', course, st[i % st.length].id);
    q.push(ms(t));
  }

  return {
    students: n,
    accepted: accepted.length,
    failures,
    wallMs: round(wall),
    throughputTps: Number((accepted.length / (wall / 1000)).toFixed(2)),
    latencyMs: {
      p50: round(pct(lat, 50)), p95: round(pct(lat, 95)), max: round(lat[lat.length - 1]),
      mean: round(lat.reduce((a, b) => a + b, 0) / lat.length),
    },
    closeSessionMs: round(close),
    eligibilityQueryMs: round(q.reduce((a, b) => a + b, 0) / q.length),
    ledgerBytesPerMark: round((after - before) / Math.max(1, accepted.length)),
    worldState: await stateBytes(s.id),
  };
}

/**
 * The realistic case: students arrive at random moments across a scan window
 * rather than all at once. Bursts fill 10-transaction blocks instantly; a
 * trickle leaves most blocks to be cut by the 2-second timeout, so this is
 * where per-student latency is actually decided.
 */
async function spread(l: Ledger, faculty: string, n: number, windowSec: number) {
  const course = `S${n}-${hex(2)}`;
  const st = await students(l, course, n);
  const s = await openSession(l, faculty, course);
  const t0 = performance.now();
  const results = await Promise.all(st.map(async (one) => {
    await new Promise((r) => setTimeout(r, Math.random() * windowSec * 1000));
    const t = performance.now();
    const o = await attempt(() => l.attendance.submit('markAttendance', ...markArgs(s, one)));
    return { latency: ms(t), code: o.code };
  }));
  const wall = ms(t0);
  const ok = results.filter((r) => r.code === 'ACCEPTED');
  const lat = ok.map((r) => r.latency).sort((a, b) => a - b);
  await l.sessions.submit('closeSession', s.id, s.seed);
  return {
    students: n, arrivalWindowSec: windowSec, accepted: ok.length,
    wholeClassMs: round(wall),
    latencyMs: { p50: round(pct(lat, 50)), p95: round(pct(lat, 95)), max: round(lat[lat.length - 1]) },
  };
}

async function main(): Promise<void> {
  const l = await ledger('registrar');
  const faculty = await newFaculty(l);

  console.log('Single student, sequential (5 marks)');
  const alone = (await single(l, faculty)).sort((a, b) => a - b);
  console.log(`  latency to commit: median ${round(pct(alone, 50))} ms, max ${round(alone[alone.length - 1])} ms\n`);

  const runs: Awaited<ReturnType<typeof burst>>[] = [];
  for (const n of SIZES) {
    for (let r = 1; r <= RUNS; r += 1) {
      process.stdout.write(`Burst: ${n} students at once, run ${r}/${RUNS} ... `);
      const res = await burst(l, faculty, n);
      runs.push(res);
      console.log(`${res.accepted}/${n} in ${(res.wallMs / 1000).toFixed(1)} s, `
        + `p95 ${res.latencyMs.p95} ms, ${res.throughputTps} tx/s, close ${res.closeSessionMs} ms`
        + (Object.keys(res.failures).length ? `, failures ${JSON.stringify(res.failures)}` : ''));
    }
  }
  const SPREAD = (process.env.BENCH_SPREAD ?? '60:20,120:30').split(',').map((x) => x.split(':').map(Number));
  const trickle: Awaited<ReturnType<typeof spread>>[] = [];
  for (const [n, w] of SPREAD) {
    process.stdout.write(`Trickle: ${n} students arriving over ${w} s ... `);
    const res = await spread(l, faculty, n, w);
    trickle.push(res);
    console.log(`${res.accepted}/${n}, whole class in ${(res.wholeClassMs / 1000).toFixed(1)} s, `
      + `per-student p50 ${res.latencyMs.p50} ms, p95 ${res.latencyMs.p95} ms`);
  }
  l.gw.close();

  const out = path.join(__dirname, '../../../docs/evidence/eval');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'bench.json'), JSON.stringify({
    ranAt: new Date().toISOString(),
    environment: {
      fabric: '2.5.9', orgs: 3, endorsementPolicy: 'AND(Registrar, ExamCell)',
      ordering: 'Raft, 1 node', batchTimeout: '2s', maxMessageCount: 10,
      host: 'single laptop, WSL2, Docker Desktop',
    },
    singleStudentMs: { median: round(pct(alone, 50)), max: round(alone[alone.length - 1]) },
    runs,
    trickle,
  }, null, 2));
  console.log(`\nWrote docs/evidence/eval/bench.json`);
}

main().catch((err) => {
  console.error('benchmark could not run:', err instanceof Error ? err.message : err);
  process.exit(1);
});
