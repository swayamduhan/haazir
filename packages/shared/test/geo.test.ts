import { cosLatitudeScaled, distanceMetres, isWithinRadius, toE7 } from '../src';

/** 1e-7 degree of latitude is 11.132 mm, so 4491 microdegrees is very nearly 50 m. */
const CENTRE = { latE7: toE7(12.9716), lngE7: toE7(77.5946) };

const northOf = (metres: number) => ({
  latE7: CENTRE.latE7 + Math.round((metres * 1000) / 11.132),
  lngE7: CENTRE.lngE7,
});

describe('cosLatitudeScaled', () => {
  it('matches the table at whole degrees', () => {
    expect(cosLatitudeScaled(toE7(0))).toBe(1_000_000);
    expect(cosLatitudeScaled(toE7(60))).toBe(500_000);
    expect(cosLatitudeScaled(toE7(90))).toBe(0);
  });

  it('interpolates between degrees rather than stepping', () => {
    const at60 = cosLatitudeScaled(toE7(60));
    const at60Half = cosLatitudeScaled(toE7(60.5));
    const at61 = cosLatitudeScaled(toE7(61));
    expect(at60Half).toBeLessThan(at60);
    expect(at60Half).toBeGreaterThan(at61);
  });

  it('stays within 4e-5 of the true cosine, the interpolation error bound', () => {
    for (let tenths = 0; tenths <= 900; tenths += 1) {
      const degrees = tenths / 10;
      const approx = cosLatitudeScaled(toE7(degrees)) / 1_000_000;
      const exact = Math.cos((degrees * Math.PI) / 180);
      expect(Math.abs(approx - exact)).toBeLessThan(4e-5);
    }
  });

  it('treats northern and southern latitudes alike', () => {
    expect(cosLatitudeScaled(toE7(-45))).toBe(cosLatitudeScaled(toE7(45)));
  });
});

describe('isWithinRadius', () => {
  it('accepts the centre itself', () => {
    expect(isWithinRadius(CENTRE, CENTRE, 50)).toBe(true);
  });

  it('accepts inside and rejects outside, north-south', () => {
    expect(isWithinRadius(northOf(45), CENTRE, 50)).toBe(true);
    expect(isWithinRadius(northOf(56), CENTRE, 50)).toBe(false);
  });

  it('applies the cosine correction east-west', () => {
    // The same longitude offset spans half the ground distance at 60 degrees
    // as it does at the equator. Without the correction both would agree, and
    // one of the two answers would be wrong by a factor of two.
    const offset = 8_000;
    const equator = { latE7: 0, lngE7: 0 };
    const high = { latE7: toE7(60), lngE7: 0 };

    expect(isWithinRadius({ latE7: 0, lngE7: offset }, equator, 50)).toBe(false);
    expect(isWithinRadius({ latE7: toE7(60), lngE7: offset }, high, 50)).toBe(true);
  });

  it('rejects a point outside on one axis without squaring it', () => {
    expect(isWithinRadius(northOf(5_000), CENTRE, 50)).toBe(false);
  });

  it('reaches its verdict with integer arithmetic only', () => {
    // Every intermediate the decision depends on must be an exact integer:
    // a value one ulp apart on two peers is two different values, and the
    // endorsement mismatch that follows names no culprit. ADR-018.
    const spy = jest.spyOn(Math, 'sqrt');
    isWithinRadius(northOf(49), CENTRE, 50);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('refuses a radius that is not a positive integer', () => {
    expect(() => isWithinRadius(CENTRE, CENTRE, 0)).toThrow(/positive integer/);
    expect(() => isWithinRadius(CENTRE, CENTRE, 12.5)).toThrow(/positive integer/);
  });
});

describe('distanceMetres', () => {
  it('recovers a known north-south offset', () => {
    expect(distanceMetres(northOf(100), CENTRE)).toBe(100);
  });

  it('is symmetric', () => {
    expect(distanceMetres(northOf(75), CENTRE)).toBe(distanceMetres(CENTRE, northOf(75)));
  });
});
