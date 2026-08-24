import { z } from 'zod';
import { AppError, validationError } from '../lib/errors.js';
import { hashPassword } from '../lib/passwords.js';
import { withTransaction } from '../db/tx.js';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const doctorCreateSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().regex(/^\d{7,15}$/).optional().nullable(),
  password: z.string().min(8).max(200),
  specialisation: z.string().trim().min(1).max(120),
  workingDays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  startsAt: z.string().regex(TIME_RE),
  endsAt: z.string().regex(TIME_RE),
  slotMinutes: z.coerce.number().int().min(1).max(240),
});

export const doctorUpdateSchema = doctorCreateSchema
  .omit({ password: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update.' });

function checkSchedule({ startsAt, endsAt }) {
  if (startsAt && endsAt && endsAt <= startsAt) {
    throw validationError('endsAt: must be after startsAt');
  }
}

export function mapDoctorRow(row) {
  return {
    userId: row.user_id,
    email: row.email,
    name: row.name,
    phone: row.phone ?? null,
    specialisation: row.specialisation,
    workingDays: row.working_days,
    startsAt: String(row.starts_at).slice(0, 5),
    endsAt: String(row.ends_at).slice(0, 5),
    slotMinutes: row.slot_minutes,
  };
}

const DOCTOR_SELECT = `
  SELECT u.id AS user_id, u.email, u.name, u.phone,
         d.specialisation, d.working_days, d.starts_at, d.ends_at, d.slot_minutes
  FROM doctors d JOIN users u ON u.id = d.user_id
`;

export async function createDoctor(pool, input) {
  const parsed = doctorCreateSchema.safeParse(input);
  if (!parsed.success) throw validationError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const data = parsed.data;
  checkSchedule(data);

  return withTransaction(pool, async (query) => {
    const dupe = await query('SELECT 1 FROM users WHERE email = $1', [data.email]);
    if (dupe.rowCount > 0) {
      throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists.');
    }
    const hash = await hashPassword(data.password);
    const user = await query(
      `INSERT INTO users (role, email, password_hash, name, phone)
       VALUES ('doctor', $1, $2, $3, $4) RETURNING id`,
      [data.email, hash, data.name, data.phone ?? null],
    );
    const profile = await query(
      `INSERT INTO doctors (user_id, specialisation, working_days, starts_at, ends_at, slot_minutes)
       VALUES ($1, $2, $3, $4::time, $5::time, $6)
       RETURNING user_id`,
      [user.rows[0].id, data.specialisation, data.workingDays, data.startsAt, data.endsAt, data.slotMinutes],
    );
    const { rows } = await query(`${DOCTOR_SELECT} WHERE d.user_id = $1`, [profile.rows[0].user_id]);
    return mapDoctorRow(rows[0]);
  });
}

export async function listDoctors(query) {
  const { rows } = await query(`${DOCTOR_SELECT} ORDER BY lower(u.name)`);
  return rows.map(mapDoctorRow);
}

const PUBLIC_SORTS = {
  name: 'lower(u.name)',
  specialisation: 'lower(d.specialisation)',
};

export async function listDoctorsPublic(query, { specialisation, sort } = {}) {
  let sql = DOCTOR_SELECT;
  const params = [];
  if (specialisation) {
    params.push(`%${String(specialisation).trim().toLowerCase()}%`);
    sql += ` WHERE lower(d.specialisation) LIKE $1`;
  }
  sql += ` ORDER BY ${PUBLIC_SORTS[sort] ?? PUBLIC_SORTS.name}`;
  const { rows } = await query(sql, params);
  return rows.map(mapDoctorRow);
}

export async function getDoctor(query, userId) {
  const { rows } = await query(`${DOCTOR_SELECT} WHERE d.user_id = $1`, [userId]);
  if (rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Doctor not found.');
  return mapDoctorRow(rows[0]);
}

export async function updateDoctor(pool, userId, patch) {
  const parsed = doctorUpdateSchema.safeParse(patch);
  if (!parsed.success) throw validationError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const data = parsed.data;
  checkSchedule(data);

  return withTransaction(pool, async (query) => {
    const exists = await query(`SELECT 1 FROM doctors WHERE user_id = $1`, [userId]);
    if (exists.rowCount === 0) throw new AppError(404, 'NOT_FOUND', 'Doctor not found.');

    if (data.email || data.name !== undefined || data.phone !== undefined) {
      if (data.email) {
        const dupe = await query('SELECT 1 FROM users WHERE email = $1 AND id <> $2', [
          data.email,
          userId,
        ]);
        if (dupe.rowCount > 0) {
          throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists.');
        }
      }
      await query(
        `UPDATE users SET
           name   = COALESCE($2, name),
           email  = COALESCE($3, email),
           phone  = COALESCE($4, phone)
         WHERE id = $1`,
        [userId, data.name ?? null, data.email ?? null, data.phone ?? null],
      );
    }

    await query(
      `UPDATE doctors SET
         specialisation = COALESCE($2, specialisation),
         working_days   = COALESCE($3, working_days),
         starts_at      = COALESCE($4::time, starts_at),
         ends_at        = COALESCE($5::time, ends_at),
         slot_minutes   = COALESCE($6, slot_minutes)
       WHERE user_id = $1`,
      [
        userId,
        data.specialisation ?? null,
        data.workingDays ?? null,
        data.startsAt ?? null,
        data.endsAt ?? null,
        data.slotMinutes ?? null,
      ],
    );

    const { rows } = await query(`${DOCTOR_SELECT} WHERE d.user_id = $1`, [userId]);
    return mapDoctorRow(rows[0]);
  });
}

export async function deleteDoctor(query, userId) {
  const future = await query(
    `SELECT 1 FROM appointments
     WHERE doctor_id = $1 AND status = 'confirmed' AND scheduled_at >= now()
     LIMIT 1`,
    [userId],
  );
  if (future.rowCount > 0) {
    throw new AppError(409, 'CONFLICT', 'Doctor has upcoming confirmed appointments.');
  }
  const res = await query('DELETE FROM users WHERE id = $1 AND role = \'doctor\' RETURNING id', [userId]);
  if (res.rowCount === 0) throw new AppError(404, 'NOT_FOUND', 'Doctor not found.');
}
