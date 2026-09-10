import { AttendanceRecorder } from './contracts/attendance-recorder';
import { CourseRoster } from './contracts/course-roster';
import { IdentityRegistry } from './contracts/identity-registry';
import { SessionManager } from './contracts/session-manager';

export { AttendanceRecorder, CourseRoster, IdentityRegistry, SessionManager };

/**
 * Fabric reads this export to discover the contracts in the package.
 *
 * One deployable package, several Contract classes — each keeps its own
 * namespace, so operations address as "IdentityRegistry:registerIdentity".
 * Four separate packages would mean twelve lifecycle operations per change
 * across three organisations. Spec section 4.4, ADR-011.
 */
export const contracts: unknown[] = [
  IdentityRegistry, SessionManager, CourseRoster, AttendanceRecorder,
];
