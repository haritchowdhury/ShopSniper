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

export class RunLeaseLostError extends Error {
  constructor() {
    super("The worker no longer owns an active lease for this run");
    this.name = "RunLeaseLostError";
  }
}

export class QueryRevisionConflictError extends Error {
  constructor(currentRevision) {
    super("The query list has changed since it was loaded");
    this.name = "QueryRevisionConflictError";
    this.currentRevision = currentRevision;
  }
}

export class RunNotAwaitingQueryConfirmationError extends Error {
  constructor() {
    super("The run is not awaiting query confirmation");
    this.name = "RunNotAwaitingQueryConfirmationError";
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
