import { describe, expect, it } from 'vitest';
import { createHash, timingSafeEqual } from 'node:crypto';

describe('Constant time equal logic (isolated)', () => {
  it('rejects different length', () => {
    const supplied = 'a';
    const configured = 'ab';
    const providedBytes = Buffer.from(supplied, 'utf8');
    const configuredBytes = Buffer.from(configured, 'utf8');
    const providedHash = createHash('sha256').update(providedBytes).digest();
    const configuredHash = createHash('sha256')
      .update(configuredBytes)
      .digest();
    const hashesEqual = timingSafeEqual(providedHash, configuredHash);
    expect(
      hashesEqual && providedBytes.byteLength === configuredBytes.byteLength,
    ).toBe(false);
  });

  it('accepts same length and value', () => {
    const supplied = 'ab';
    const configured = 'ab';
    const providedBytes = Buffer.from(supplied, 'utf8');
    const configuredBytes = Buffer.from(configured, 'utf8');
    const providedHash = createHash('sha256').update(providedBytes).digest();
    const configuredHash = createHash('sha256')
      .update(configuredBytes)
      .digest();
    const hashesEqual = timingSafeEqual(providedHash, configuredHash);
    expect(
      hashesEqual && providedBytes.byteLength === configuredBytes.byteLength,
    ).toBe(true);
  });

  it('rejects same length different value', () => {
    const supplied = 'aa';
    const configured = 'ab';
    const providedBytes = Buffer.from(supplied, 'utf8');
    const configuredBytes = Buffer.from(configured, 'utf8');
    const providedHash = createHash('sha256').update(providedBytes).digest();
    const configuredHash = createHash('sha256')
      .update(configuredBytes)
      .digest();
    const hashesEqual = timingSafeEqual(providedHash, configuredHash);
    expect(
      hashesEqual && providedBytes.byteLength === configuredBytes.byteLength,
    ).toBe(false);
  });

  it('rejects non-ascii different length', () => {
    const supplied = 'a';
    const configured = 'åäö';
    const providedBytes = Buffer.from(supplied, 'utf8');
    const configuredBytes = Buffer.from(configured, 'utf8');
    const providedHash = createHash('sha256').update(providedBytes).digest();
    const configuredHash = createHash('sha256')
      .update(configuredBytes)
      .digest();
    const hashesEqual = timingSafeEqual(providedHash, configuredHash);
    expect(
      hashesEqual && providedBytes.byteLength === configuredBytes.byteLength,
    ).toBe(false);
  });
});
