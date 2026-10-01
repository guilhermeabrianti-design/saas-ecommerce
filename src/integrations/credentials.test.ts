// @vitest-environment node
import {
  decryptCredentials,
  encryptCredentials,
} from '../../supabase/functions/_shared/integrations/crypto';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));
const CONN = '11111111-2222-4333-8444-555555555555';

describe('criptografia de credenciais', () => {
  it('cifra e decifra, com IV novo a cada vez', async () => {
    const secret = JSON.stringify({ access_token: 'shpat_abc123' });
    const a = await encryptCredentials(KEY, secret, CONN);
    const b = await encryptCredentials(KEY, secret, CONN);
    expect(a).toMatch(/^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('shpat_abc123');
    expect(await decryptCredentials(KEY, a, CONN)).toBe(secret);
  });

  it('não decifra em outra conexão, com outra chave ou se for adulterado', async () => {
    const token = await encryptCredentials(KEY, 'segredo', CONN);
    await expect(
      decryptCredentials(KEY, token, '99999999-2222-4333-8444-555555555555'),
    ).rejects.toThrow(/decifrar/);
    const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    await expect(decryptCredentials(other, token, CONN)).rejects.toThrow(/decifrar/);
    const [v, iv, ct] = token.split('.');
    const flipped = `${v}.${iv}.${ct!.slice(0, -4)}AAAA`;
    await expect(decryptCredentials(KEY, flipped, CONN)).rejects.toThrow(/decifrar/);
  });

  it('recusa formato desconhecido e chave com tamanho errado', async () => {
    await expect(decryptCredentials(KEY, 'v2.a.b', CONN)).rejects.toThrow(/formato/);
    await expect(decryptCredentials(KEY, 'lixo', CONN)).rejects.toThrow(/formato/);
    await expect(encryptCredentials(btoa('curta'), 'x', CONN)).rejects.toThrow(/32 bytes/);
    await expect(encryptCredentials('***', 'x', CONN)).rejects.toThrow(/base64/);
  });
});
