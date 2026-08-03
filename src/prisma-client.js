import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaClient } from "@prisma/client";

let sharedClient;
const clientSchemas = new WeakMap();

export function createPrismaClient(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  const schema = new URL(connectionString).searchParams.get("schema") || undefined;
  const adapter = new PrismaNeon(
    { connectionString },
    schema ? { schema } : undefined
  );
  const client = new PrismaClient({ adapter });
  clientSchemas.set(client, schema || "public");
  return client;
}

export function prismaSchemaForClient(client) {
  return clientSchemas.get(client) || "public";
}

export function getPrismaClient() {
  if (!sharedClient) sharedClient = createPrismaClient();
  return sharedClient;
}
