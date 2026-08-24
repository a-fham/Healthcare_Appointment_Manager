import { z } from 'zod';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const envSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().min(1),
    JWT_SECRET: z.string().min(1),
    JOB_SECRET: z.string().min(1),
    COOKIE_NAME: z.string().min(1).default('hcm_session'),
    HOLD_MINUTES: z.coerce.number().int().min(1).default(5),
    EMAIL_FROM: z.string().email().optional(),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_REFRESH_TOKEN: z.string().optional(),
    GOOGLE_CALENDAR_ID: z.string().optional(),
    LLM_PROVIDER: z.enum(['none', 'openai', 'gemini']).default('none'),
    OPENAI_API_KEY: z.string().optional(),
    GEMINI_API_KEY: z.string().optional(),
    LLM_MODEL: z.string().optional(),
    LLM_BASE_URL: z.string().url().optional(),
    CRON_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
  });

export function loadConfig(env) {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const details = Object.entries(result.error.flatten().fieldErrors)
      .map(([key, msgs]) => `${key} (${msgs.join(', ')})`)
      .join('; ');
    throw new ConfigError(`Invalid configuration: ${details}`);
  }
  const e = result.data;
  return {
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    jwtSecret: e.JWT_SECRET,
    jobSecret: e.JOB_SECRET,
    cookieName: e.COOKIE_NAME,
    holdMinutes: e.HOLD_MINUTES,
    emailFrom: e.EMAIL_FROM,
    smtp: e.SMTP_HOST
      ? { host: e.SMTP_HOST, port: e.SMTP_PORT ?? 587, user: e.SMTP_USER, pass: e.SMTP_PASS }
      : {},
    google: {
      clientId: e.GOOGLE_CLIENT_ID,
      clientSecret: e.GOOGLE_CLIENT_SECRET,
      refreshToken: e.GOOGLE_REFRESH_TOKEN,
      calendarId: e.GOOGLE_CALENDAR_ID,
    },
    llm: {
      provider: e.LLM_PROVIDER,
      apiKey: e.OPENAI_API_KEY ?? e.GEMINI_API_KEY,
      model: e.LLM_MODEL,
      baseUrl: e.LLM_BASE_URL,
    },
    cronEnabled: e.CRON_ENABLED,
  };
}

let cached;

export function getConfig(env = process.env) {
  cached ??= loadConfig(env);
  return cached;
}
