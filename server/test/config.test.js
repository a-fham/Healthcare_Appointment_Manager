import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

const VALID_ENV = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/hcm_dev',
  JWT_SECRET: 'test-secret-at-least-long',
  JOB_SECRET: 'job-secret-value',
};

describe('loadConfig', () => {
  it('parses a valid env into typed config', () => {
    const cfg = loadConfig(VALID_ENV);
    expect(cfg.databaseUrl).toBe('postgres://user:pass@localhost:5432/hcm_dev');
    expect(cfg.jwtSecret).toBe('test-secret-at-least-long');
    expect(cfg.jobSecret).toBe('job-secret-value');
    expect(cfg.port).toBe(3000);
  });

  it('applies documented defaults', () => {
    const cfg = loadConfig({ ...VALID_ENV });
    expect(cfg.holdMinutes).toBe(5);
    expect(cfg.cookieName).toBe('hcm_session');
    expect(cfg.cronEnabled).toBe(true);
    expect(cfg.llm.provider).toBe('none');
    expect(cfg.smtp.host).toBeUndefined();
    expect(cfg.google.calendarId).toBeUndefined();
  });

  it('throws ConfigError naming every missing required key', () => {
    try {
      loadConfig({});
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e.name).toBe('ConfigError');
      expect(e.message).toContain('DATABASE_URL');
      expect(e.message).toContain('JWT_SECRET');
      expect(e.message).toContain('JOB_SECRET');
    }
  });

  it('strips unknown keys instead of passing them through', () => {
    const cfg = loadConfig({ ...VALID_ENV, EVIL_EXTRA: 'x' });
    expect(cfg.evilExtra).toBeUndefined();
    expect(Object.keys(cfg)).not.toContain('EVIL_EXTRA');
  });

  it('rejects a holdMinutes below 1', () => {
    expect(() => loadConfig({ ...VALID_ENV, HOLD_MINUTES: '0' })).toThrow();
  });

  it('parses LLM provider allow-list strictly', () => {
    expect(() => loadConfig({ ...VALID_ENV, LLM_PROVIDER: 'skynet' })).toThrow();
    const cfg = loadConfig({ ...VALID_ENV, LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'k', LLM_MODEL: 'gpt-4o-mini' });
    expect(cfg.llm.provider).toBe('openai');
    expect(cfg.llm.apiKey).toBe('k');
    expect(cfg.llm.model).toBe('gpt-4o-mini');
  });

  it('parses SMTP block when present', () => {
    const cfg = loadConfig({
      ...VALID_ENV,
      SMTP_HOST: 'smtp.test',
      SMTP_PORT: '587',
      SMTP_USER: 'u',
      SMTP_PASS: 'p',
      EMAIL_FROM: 'noreply@ashgrove.health',
    });
    expect(cfg.smtp).toEqual({ host: 'smtp.test', port: 587, user: 'u', pass: 'p' });
    expect(cfg.emailFrom).toBe('noreply@ashgrove.health');
  });
});
