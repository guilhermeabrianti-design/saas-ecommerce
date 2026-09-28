// @vitest-environment node
import { CHECKOUT_LIMITS, clientIp, ipSubject } from '../../supabase/functions/_shared/ratelimit';

describe('limite por IP', () => {
  it('lê o IP do cliente dos cabeçalhos da borda', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe(
      '203.0.113.7',
    );
    expect(clientIp(new Headers({ 'x-forwarded-for': '2001:DB8::1' }))).toBe('2001:db8::1');
    expect(clientIp(new Headers({ 'cf-connecting-ip': '198.51.100.2' }))).toBe('198.51.100.2');
    expect(clientIp(new Headers({ 'x-forwarded-for': 'lixo<script>' }))).toBeNull();
    expect(clientIp(new Headers())).toBeNull();
  });

  it('guarda só o hash do IP', async () => {
    const h = await ipSubject('203.0.113.7');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain('203');
    expect(await ipSubject('203.0.113.7')).toBe(h);
    expect(await ipSubject('203.0.113.8')).not.toBe(h);
  });

  it('limites dentro das regras do banco', () => {
    for (const r of Object.values(CHECKOUT_LIMITS)) {
      expect(r.bucket).toMatch(/^[a-z_.]{3,40}$/);
      expect(r.limit).toBeGreaterThan(0);
      expect(r.windowSeconds).toBeLessThanOrEqual(86400);
    }
    // Pagamento é o mais restrito.
    expect(CHECKOUT_LIMITS.pay.limit).toBeLessThan(CHECKOUT_LIMITS.read.limit);
  });
});
