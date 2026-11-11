// Paper positions kept on the phone (nom.positions). Nothing here is sent anywhere.
import * as store from './store.js';

export const list = () => store.get('positions', []) || [];
const save = (all) => store.set('positions', all);

export function add(pos) {
  const p = { id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), createdAt: Date.now(), status: 'open', ...pos };
  save([p, ...list()]);
  return p;
}

export function update(id, patch) {
  save(list().map((p) => (p.id === id ? { ...p, ...patch } : p)));
}

export function remove(id) {
  save(list().filter((p) => p.id !== id));
}

export const get = (id) => list().find((p) => p.id === id) || null;

// Backup: everything the app keeps, as one JSON object (settings without the API secret unless asked).
export function exportAll({ withSecret = false } = {}) {
  const settings = { ...store.settings() };
  if (!withSecret) settings.apiSecret = '';
  return { app: 'nifty-options-mobile', version: 1, exportedAt: new Date().toISOString(), settings, positions: list(), builder: store.get('builder') };
}

export function importAll(data) {
  if (!data || data.app !== 'nifty-options-mobile') throw new Error('Not a backup of this app');
  if (!Array.isArray(data.positions)) throw new Error('The backup has no positions list');
  const keepSecret = store.settings().apiSecret;
  if (data.settings) store.set('settings', { ...store.DEFAULT_SETTINGS, ...data.settings, apiSecret: data.settings.apiSecret || keepSecret });
  const have = new Set(list().map((p) => p.id));
  save([...list(), ...data.positions.filter((p) => p && p.id && !have.has(p.id))]);
  if (data.builder) store.set('builder', data.builder);
  return data.positions.length;
}
