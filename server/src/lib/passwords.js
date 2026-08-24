import bcrypt from 'bcryptjs';

const COST = 10;

export async function hashPassword(plain) {
  return bcrypt.hash(plain, COST);
}

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}
