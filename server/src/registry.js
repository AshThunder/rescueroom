// Vaults created by the Rescue Room factory, read from the factory contract (no keys needed).
export function createRegistry({ view, factory, intervalMs = 30_000, log = () => {} }) {
  const vaults = new Map();
  let lastSync = null;
  let lastError = null;
  async function refresh() {
    if (!factory) return [];
    const added = [];
    try {
      const n = await view(factory, 'vault_count');
      for (let i = 0; i < n; i += 100) {
        for (const v of await view(factory, 'list_vaults', { from_index: i, limit: 100 })) {
          if (!vaults.has(v.vault)) added.push(v.vault);
          vaults.set(v.vault, v);
        }
      }
      lastSync = Date.now();
      lastError = null;
      if (added.length) log(`registry: +${added.length} vault(s): ${added.join(', ')}`);
    } catch (e) {
      lastError = e.message;
    }
    return added;
  }
  let timer;
  return {
    refresh,
    start(onAdded) {
      const loop = async () => {
        const added = await refresh();
        if (added.length) onAdded?.(added);
        timer = setTimeout(loop, intervalMs);
      };
      loop();
      return this;
    },
    stop: () => clearTimeout(timer),
    get: (id) => vaults.get(id),
    all: () => [...vaults.values()],
    ids: () => [...vaults.keys()],
    state: () => ({ factory, vaults: vaults.size, demo: [...vaults.values()].filter((v) => v.demo).length, last_sync: lastSync, last_error: lastError }),
    async slug(s) {
      const id = `${s}.${factory}`;
      if (!vaults.has(id)) await refresh();
      return vaults.has(id) ? id : null;
    },
  };
}
