import { isContentIdentifier } from '../src';

describe('isContentIdentifier', () => {
  it('accepts a CIDv0', () => {
    expect(isContentIdentifier('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).toBe(true);
  });

  it('accepts a CIDv1 in lowercase base32', () => {
    expect(isContentIdentifier(
      'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['a URL, which is a location and not a hash', 'https://drive.example.com/cert.pdf'],
    ['a truncated CIDv0', 'QmYwAPJzv5CZsnA625'],
    ['base58 characters that do not exist', 'Qm0OIl' + 'A'.repeat(40)],
    ['uppercase base32, which is a different multibase prefix', `B${'A'.repeat(58)}`],
    ['a bare sha256 digest', 'a'.repeat(64)],
  ])('rejects %s', (_label, value) => {
    expect(isContentIdentifier(value)).toBe(false);
  });
});
