# ADR-018: Geofence Distance Is Computed In Integers

**Status:** Accepted, implemented
**Extends:** the microdegree coordinate decision in the design spec section 6.3

## Context

Proximity is enforced by comparing the submitted location against the
session's geofence centre and radius. The textbook implementation is the
haversine formula, built from `Math.sin`, `Math.cos`, `Math.atan2` and
`Math.sqrt`.

Three of those four are a determinism hazard.

ECMAScript specifies `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`,
`exp`, `log` and `pow` as *implementation-approximated*: the standard permits
any implementation-defined approximation and does not require correct
rounding. Two peers on different Node builds, different libm versions or
different CPU architectures may legitimately return results that differ in the
last unit in the last place.

Most of the time that difference is invisible. At a geofence boundary it is
not: a submission whose true distance sits within an ulp of the radius can be
accepted by one endorsing peer and rejected by the other. Endorsement then
fails, with no peer being wrong and nothing in the logs suggesting why. It is
the rarest and most expensive class of Fabric bug, and following the obvious
implementation would have seeded it.

`Math.sqrt` is exempt — IEEE-754 requires it to be correctly rounded — but it
is not needed once distances are compared as squares.

## Decision

Distance is computed with integer arithmetic only, over the microdegree
coordinates already stored on chain.

- Latitude and longitude differences are converted to millimetres using the
  fixed scale of 11.132 mm per microdegree, applied as an integer multiply and
  a truncating divide.
- The longitude difference is scaled by the cosine of the latitude, read from
  a table of 91 integer values — one per whole degree, scaled by 1e6 — with
  linear interpolation between entries in integer arithmetic. Interpolating
  cosine across a one-degree step has a worst-case error under 4e-5, which is
  sub-millimetre at the radii this system uses.

  The table is held to six places rather than four for a reason found by the
  test that asserts the bound: at four places, rounding each entry costs up to
  5e-5 and *dominates* the interpolation error, so the paragraph above would
  have been false as written. The first draft of this ADR claimed 4e-5 while
  the implementation delivered 1.06e-4.
- The comparison is squared: latitude and longitude offsets in millimetres,
  squared and summed, against the radius in millimetres squared. Squares avoid
  `sqrt` entirely, and every operand is an exact integer well inside 2^53.

No transcendental function is called at any point.

## Consequences

**Every peer computes the same distance, bit for bit.** The boundary case that
would have produced intermittent endorsement failures cannot occur.

**Accuracy is more than sufficient, and bounded.** The equirectangular
approximation with a cosine correction is accurate to well under a metre over
the hundreds of metres a classroom geofence spans. It degrades over long
distances and near the poles; neither applies here, and both are stated in the
function's documentation rather than left as a trap.

**The lint rule now bans trigonometry.** `eslint.determinism.config.mjs` rejects
`Math.sin`, `Math.cos`, `Math.tan`, `Math.atan`, `Math.atan2`, `Math.asin`,
`Math.acos`, `Math.log`, `Math.exp` and `Math.pow` in chaincode and shared
code, so the obvious implementation cannot be reintroduced by someone who has
not read this file.

**The determinism checklist gains a row it was missing.** It already warned
against floating point "where exact equality matters". That framing was too
narrow: the hazard is not comparing floats for equality, it is that the floats
themselves may differ between peers. The checklist now says so.
