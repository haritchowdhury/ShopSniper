import { ApiError } from "./api-errors.js";

export const MAX_JSON_BODY_BYTES = 32 * 1024;

export async function readJsonBody(request, limit = MAX_JSON_BODY_BYTES) {
  const limitLabel = limit % 1024 === 0 ? `${limit / 1024} KiB` : `${limit} bytes`;
  const contentType = request.headers["content-type"] || "";
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    throw new ApiError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Content-Type must be application/json."
    );
  }

  const declaredLength = request.headers["content-length"];
  if (declaredLength != null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isFinite(parsedLength) || parsedLength < 0) {
      throw new ApiError(400, "INVALID_REQUEST_BODY", "Invalid Content-Length.");
    }
    if (parsedLength > limit) {
      throw new ApiError(
        413,
        "REQUEST_BODY_TOO_LARGE",
        `Request body must not exceed ${limitLabel}.`
      );
    }
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      throw new ApiError(
        413,
        "REQUEST_BODY_TOO_LARGE",
        `Request body must not exceed ${limitLabel}.`
      );
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
}
