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
