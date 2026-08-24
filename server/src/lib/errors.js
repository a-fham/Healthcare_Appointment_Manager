export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

export function validationError(details) {
  return new AppError(400, 'VALIDATION_ERROR', `Validation failed: ${details}`);
}
