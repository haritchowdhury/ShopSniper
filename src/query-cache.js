export class QueryProbeCache {
  #entries = new Map();

  get(query) {
    return this.#entries.get(query);
  }

  has(query) {
    return this.#entries.has(query);
  }

  set(query, value) {
    this.#entries.set(query, value);
    return value;
  }

  get size() {
    return this.#entries.size;
  }
}
