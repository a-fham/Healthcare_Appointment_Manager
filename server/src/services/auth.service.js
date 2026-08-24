import { z } from 'zod';
import { AppError, validationError } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../lib/passwords.js';

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().min(1).max(120),
  phone: z
    .string()
    .trim()
    .regex(/^\d{7,15}$/)
    .optional()
    .nullable(),
  password: z.string().min(8).max(200),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(3).max(254),
  password: z.string().min(1).max(200),
});

function firstZodIssues(err) {
  return err.issues
    .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
    .join('; ');
}

export function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    phone: row.phone ?? null,
    createdAt: row.created_at,
  };
}

export async function registerPatient(query, input) {
  const parsed = registerSchema.safeParse(input);
  if (!parsed.success) throw validationError(firstZodIssues(parsed.error));
  const { email, name, phone, password } = parsed.data;

  const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rowCount > 0) {
    throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists.');
  }

  const hash = await hashPassword(password);
  const { rows } = await query(
    `INSERT INTO users (role, email, password_hash, name, phone)
     VALUES ('patient', $1, $2, $3, $4)
     RETURNING id, role, email, name, phone, created_at`,
    [email, hash, name, phone ?? null],
  );
  return rows[0];
}

export async function login(query, input) {
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) throw validationError(firstZodIssues(parsed.error));
  const { email, password } = parsed.data;

  const generic = new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
  const { rows } = await query(
    `SELECT id, role, email, name, phone, created_at, password_hash
     FROM users WHERE email = $1`,
    [email],
  );
  if (rows.length === 0) throw generic;
  const ok = await verifyPassword(password, rows[0].password_hash);
  if (!ok) throw generic;
  return rows[0];
}
