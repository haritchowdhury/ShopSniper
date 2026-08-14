import { GetObjectCommand, ListObjectsV2Command, NoSuchKey, PutObjectCommand } from "@aws-sdk/client-s3";
import { TextDecoder } from "node:util";
import { PipelineContractError } from "../contracts/errors.js";
import { canonicalJson, sha256Hex } from "../core/canonical.js";

function artifactError(code = "PIPELINE_ARTIFACT_INVALID") {
  throw new PipelineContractError(code);
}

function parse(schema, value) {
  const result = schema?.safeParse?.(value);
  if (!result?.success) artifactError();
  return result.data;
}

function metadataFor(input, contentFingerprint) {
  return {
    "contract-version": String(input.contractVersion),
    "run-id": input.runId,
    stage: input.stage,
    generation: String(input.generation),
    "item-id": input.itemId,
    "input-sha256": input.inputFingerprint,
    "content-sha256": contentFingerprint,
    "produced-at": input.producedAt instanceof Date
      ? input.producedAt.toISOString()
      : input.producedAt
  };
}

function normalizedMetadata(value) {
  return Object.fromEntries(Object.entries(value || {}).map(([key, item]) => [key.toLowerCase(), String(item)]));
}

function sameMetadata(actual, expected) {
  const left = normalizedMetadata(actual);
  return Object.keys(expected).length === Object.keys(left).length &&
    Object.entries(expected).every(([key, value]) => left[key] === value);
}

async function boundedBody(body, maxBytes, declaredLength) {
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) artifactError();
  if (!body || typeof body[Symbol.asyncIterator] !== "function") artifactError();
  const chunks = [];
  let length = 0;
  try {
    for await (const rawChunk of body) {
      const chunk = Buffer.from(rawChunk);
      length += chunk.byteLength;
      if (length > maxBytes) artifactError();
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof PipelineContractError) throw error;
    artifactError();
  }
  if (Number.isFinite(declaredLength) && length !== declaredLength) artifactError();
  return Buffer.concat(chunks, length);
}

export class S3ArtifactStore {
  constructor({ client, bucket, maxBytes = 5000000 }) {
    if (!client || typeof client.send !== "function" || typeof bucket !== "string" || !bucket ||
        !Number.isInteger(maxBytes) || maxBytes < 1) artifactError();
    this.client = client;
    this.bucket = bucket;
    this.maxBytes = maxBytes;
  }

  async putImmutable(input) {
    const value = parse(input.schema, input.value);
    const body = canonicalJson(value);
    const bytes = Buffer.byteLength(body);
    if (bytes > this.maxBytes) artifactError();
    const contentFingerprint = sha256Hex(body);
    const metadata = metadataFor(input, contentFingerprint);
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: body,
        ContentType: "application/json",
        ServerSideEncryption: "AES256",
        IfNoneMatch: "*",
        Metadata: metadata
      }));
    } catch (error) {
      const status = error?.$metadata?.httpStatusCode ?? error?.statusCode;
      if (status !== 412 && error?.name !== "PreconditionFailed") throw error;
      const existing = await this.#read(input.key);
      if (!existing.body.equals(Buffer.from(body)) || !sameMetadata(existing.metadata, metadata)) {
        artifactError("PIPELINE_ARTIFACT_CONFLICT");
      }
    }
    return { key: input.key, contentFingerprint, bytes };
  }

  async #read(key, { allowMissing = false } = {}) {
    if (allowMissing) {
      let listed;
      try {
        listed = await this.client.send(new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: key,
          MaxKeys: 1
        }));
      } catch {
        artifactError();
      }
      const present = Array.isArray(listed?.Contents) &&
        listed.Contents.some((object) => object?.Key === key);
      if (!present) return null;
    }
    let response;
    try {
      response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      if (allowMissing && error instanceof NoSuchKey) return null;
      artifactError();
    }
    return {
      body: await boundedBody(response.Body, this.maxBytes, response.ContentLength),
      metadata: response.Metadata || {}
    };
  }

  #validateStored(stored, expected, schema) {
    let text;
    let raw;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(stored.body);
      raw = JSON.parse(text);
    } catch {
      artifactError();
    }
    const value = parse(schema, raw);
    const canonical = canonicalJson(value);
    if (canonical !== text) artifactError();
    const contentFingerprint = sha256Hex(canonical);
    const metadata = metadataFor(expected, contentFingerprint);
    if (!sameMetadata(stored.metadata, metadata)) artifactError("PIPELINE_ARTIFACT_CONFLICT");
    if (expected.contentFingerprint && expected.contentFingerprint !== contentFingerprint) {
      artifactError("PIPELINE_ARTIFACT_CONFLICT");
    }
    return { value, contentFingerprint, bytes: stored.body.byteLength };
  }

  async getValidated({ key, expected, schema }) {
    const stored = await this.#read(key);
    return this.#validateStored(stored, expected, schema);
  }

  async getOptionalValidated({ key, expected, schema }) {
    const stored = await this.#read(key, { allowMissing: true });
    if (stored === null) return { outcome: "missing" };
    return { outcome: "found", ...this.#validateStored(stored, expected, schema) };
  }
}
