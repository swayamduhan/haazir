import { Context, Contract, Info, Returns, Transaction } from 'fabric-contract-api';
import { canonicalize, Identity, RosterEntry } from '@haazir/shared';
import { assertEndorsingOrg } from '../lib/authorisation';
import { fail } from '../lib/errors';
import { collectJson, identityKey, readJson, ROSTER, rosterKey } from '../lib/keys';
import { txTimestampIso } from '../lib/ledger-time';

/**
 * Course enrolment as ledger state.
 *
 * `HANDOFF.md` §7 checked enrolment in the backend before invoking. A check
 * the contract never sees is one a bypassed client skips, and the endorsement
 * policy attests nothing about it; moving the check inside is impossible
 * while the source of truth is an HTTP call, because chaincode may not reach
 * the network. So the roster comes on chain. See ADR-015.
 */
@Info({
  title: 'CourseRoster',
  description: 'Course enrolment, checked by markAttendance',
})
export class CourseRoster extends Contract {
  constructor() {
    super('CourseRoster');
  }

  /**
   * Enrols a student, or restores an entry previously dropped.
   *
   * Re-enrolment reuses the same key rather than writing a second entry, so
   * the membership check stays a single exact-key read.
   */
  @Transaction()
  @Returns('string')
  public async enrolStudent(
    ctx: Context,
    courseID: string,
    studentID: string,
  ): Promise<string> {
    assertEndorsingOrg(ctx);
    assertCourseID(courseID);

    const student = await readJson<Identity>(ctx, identityKey(ctx, studentID));
    if (!student) fail('STUDENT_NOT_FOUND', `no identity with id "${studentID}"`);
    if (student.role !== 'student') {
      fail('NOT_STUDENT', `identity "${studentID}" has role "${student.role}"`);
    }
    if (student.status !== 'active') {
      fail('STUDENT_NOT_ACTIVE', `identity "${studentID}" is ${student.status}`);
    }

    const key = rosterKey(ctx, courseID, studentID);
    const existing = await readJson<RosterEntry>(ctx, key);
    if (existing?.status === 'enrolled') {
      fail('ALREADY_ENROLLED', `"${studentID}" is already enrolled in "${courseID}"`);
    }

    const entry: RosterEntry = {
      courseID,
      studentID,
      status: 'enrolled',
      enrolledBy: ctx.clientIdentity.getID(),
      enrolledAt: txTimestampIso(ctx),
    };

    await ctx.stub.putState(key, Buffer.from(canonicalize(entry)));
    return canonicalize(entry);
  }

  /**
   * Removes a student from the course without erasing the fact of enrolment.
   *
   * The entry is marked dropped rather than deleted: an audit of a disputed
   * record needs to see that the student was once on the roster, and records
   * marked while they were enrolled remain valid. Deleting the key would make
   * both facts unrecoverable from state.
   */
  @Transaction()
  @Returns('string')
  public async dropStudent(
    ctx: Context,
    courseID: string,
    studentID: string,
  ): Promise<string> {
    assertEndorsingOrg(ctx);

    const key = rosterKey(ctx, courseID, studentID);
    const entry = await readJson<RosterEntry>(ctx, key);
    if (!entry) {
      fail('NOT_ENROLLED', `"${studentID}" has no enrolment record for "${courseID}"`);
    }
    if (entry.status !== 'enrolled') {
      fail('NOT_ENROLLED', `"${studentID}" is already dropped from "${courseID}"`);
    }

    entry.status = 'dropped';
    entry.droppedBy = ctx.clientIdentity.getID();
    entry.droppedAt = txTimestampIso(ctx);

    await ctx.stub.putState(key, Buffer.from(canonicalize(entry)));
    return canonicalize(entry);
  }

  @Transaction(false)
  @Returns('string')
  public async isEnrolled(
    ctx: Context,
    courseID: string,
    studentID: string,
  ): Promise<string> {
    const entry = await readJson<RosterEntry>(ctx, rosterKey(ctx, courseID, studentID));
    return String(entry?.status === 'enrolled');
  }

  @Transaction(false)
  @Returns('string')
  public async getEnrolment(
    ctx: Context,
    courseID: string,
    studentID: string,
  ): Promise<string> {
    const entry = await readJson<RosterEntry>(ctx, rosterKey(ctx, courseID, studentID));
    if (!entry) {
      fail('NOT_ENROLLED', `"${studentID}" has no enrolment record for "${courseID}"`);
    }
    return canonicalize(entry);
  }

  /**
   * The whole roster for a course, dropped students included, in key order.
   *
   * A range query rather than a rich query: range results are revalidated at
   * commit, rich-query results are not. Defect C6.
   */
  @Transaction(false)
  @Returns('string')
  public async getRoster(ctx: Context, courseID: string): Promise<string> {
    assertCourseID(courseID);
    const entries = await collectJson<RosterEntry>(ctx, ROSTER, [courseID]);
    return canonicalize({
      courseID,
      enrolled: entries.filter((e) => e.status === 'enrolled').length,
      entries,
    });
  }
}

/**
 * A composite key attribute may not contain U+0000, which Fabric uses as its
 * delimiter. An empty course id is also refused: it would make the partial
 * key in `getRoster` match every course.
 */
function assertCourseID(courseID: string): void {
  if (courseID.length === 0 || courseID.includes(String.fromCharCode(0))) {
    fail('INVALID_COURSE_ID', 'courseID must be non-empty and free of NUL characters');
  }
}
