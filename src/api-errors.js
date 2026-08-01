export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class RunIntentNotFoundError extends Error {
  constructor() {
    super("Run intent not found");
    this.name = "RunIntentNotFoundError";
  }
}

export class RunAdmissionRejectedError extends Error {
  constructor() {
    super("Run admission capacity is unavailable");
    this.name = "RunAdmissionRejectedError";
  }
}

export class RunTerminalConflictError extends Error {
  constructor() {
    super("Run already has a different terminal result");
    this.name = "RunTerminalConflictError";
  }
}

export function errorPayload(error) {
  if (error instanceof ApiError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details })
      }
    };
  }
  return {
    error: {
      code: "INTERNAL_ERROR",
      message: "An unexpected backend error occurred."
    }
  };
}
