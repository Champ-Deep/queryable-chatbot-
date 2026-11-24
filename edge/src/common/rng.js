// Seeded pseudo-random numbers (mulberry32) so the synthetic data is stable per seed.
// Mirrors the parts of Python's random.Random the Python version uses.

export class Rng {
  constructor(seed) {
    this.state = seed >>> 0;
  }

  /** Float in [0, 1). */
  random() {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [a, b] inclusive, like random.randint. */
  randint(a, b) {
    return a + Math.floor(this.random() * (b - a + 1));
  }

  uniform(a, b) {
    return a + (b - a) * this.random();
  }

  choice(items) {
    return items[Math.floor(this.random() * items.length)];
  }

  /** Weighted single choice, like random.choices(items, weights)[0]. */
  weighted(items, weights) {
    const total = weights.reduce((s, w) => s + w, 0);
    let r = this.random() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r < 0) return items[i];
    }
    return items[items.length - 1];
  }

  /** k distinct items, like random.sample. */
  sample(items, k) {
    const pool = [...items];
    const out = [];
    for (let i = 0; i < k && pool.length; i++) out.push(pool.splice(Math.floor(this.random() * pool.length), 1)[0]);
    return out;
  }

  /** Normal distribution (Box-Muller), like random.gauss. */
  gauss(mu, sigma) {
    const u = 1 - this.random();
    const v = this.random();
    return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Log-normal, like random.lognormvariate. */
  lognormvariate(mu, sigma) {
    return Math.exp(this.gauss(mu, sigma));
  }
}
