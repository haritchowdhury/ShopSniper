import { GOOGLE_SEARCH_CONTRACT_VERSION } from "./search.js";
import { normalizeGeneratedQuery } from "./query-validator.js";

export class QueryProbeCache {
  #entries = new Map();
  #contractVersion;

  constructor(contractVersion = GOOGLE_SEARCH_CONTRACT_VERSION) {
    this.#contractVersion = contractVersion;
  }

  #key(query, contractVersion = this.#contractVersion) {
    return `${contractVersion}\u0000${normalizeGeneratedQuery(query)}`;
  }

  get(query, contractVersion) {
    return this.#entries.get(this.#key(query, contractVersion));
  }

  has(query, contractVersion) {
    return this.#entries.has(this.#key(query, contractVersion));
  }

  set(query, value, contractVersion) {
    this.#entries.set(this.#key(query, contractVersion), value);
    return value;
  }

  async getOrCreate(query, create, contractVersion) {
    const key = this.#key(query, contractVersion);
    if (this.#entries.has(key)) {
      return { value: await this.#entries.get(key), cacheHit: true };
    }
    const pending = Promise.resolve().then(create);
    this.#entries.set(key, pending);
    const value = await pending;
    this.#entries.set(key, value);
    return { value, cacheHit: false };
  }

  get size() {
    return this.#entries.size;
  }
}
