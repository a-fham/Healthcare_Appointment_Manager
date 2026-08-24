import jwt from 'jsonwebtoken';
import { parseCookies } from '../lib/cookies.js';
import { AppError } from '../lib/errors.js';

export function requireAuth({ jwtSecret, cookieName }) {
  return (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[cookieName];
    if (!token) return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required.'));
    try {
      const payload = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
      if (typeof payload.sub === 'undefined' || typeof payload.role !== 'string') {
        return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required.'));
      }
      req.user = { id: Number(payload.sub), role: payload.role };
      return next();
    } catch {
      return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required.'));
    }
  };
}

export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new AppError(403, 'FORBIDDEN', 'You do not have access to this resource.'));
    }
    return next();
  };
}
