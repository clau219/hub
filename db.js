// Camada de dados: Supabase quando configurado, senão localStorage.
import { CONFIG } from './config.js';

let sb = null;
export let mode = 'local';

export async function init() {
  if (CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY) {
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
    sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
    mode = 'supabase';
  }
}
export const client = () => sb;

export const auth = {
  async session() {
    if (!sb) return { local: true };
    const { data } = await sb.auth.getSession();
    return data.session;
  },
  async signIn(email, password) {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
  },
  async signOut() { if (sb) await sb.auth.signOut(); },
};

const LS = 'hub:';
const ls = {
  get(t) { try { return JSON.parse(localStorage.getItem(LS + t)) || []; } catch { return []; } },
  set(t, v) { try { localStorage.setItem(LS + t, JSON.stringify(v)); } catch (e) { console.error(e); } },
};

export async function all(table) {
  if (sb) {
    const { data, error } = await sb.from(table).select('*');
    if (error) throw error;
    return data;
  }
  return ls.get(table);
}

export async function insert(table, row) {
  row = clean(row);
  if (sb) {
    const { data, error } = await sb.from(table).insert(row).select().single();
    if (error) throw error;
    return data;
  }
  const r = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...row };
  if (table === 'deals') r.updated_at = r.created_at;
  const a = ls.get(table); a.push(r); ls.set(table, a);
  return r;
}

export async function update(table, id, patch) {
  patch = clean(patch);
  if (sb) {
    const { data, error } = await sb.from(table).update(patch).eq('id', id).select().single();
    if (error) throw error;
    return data;
  }
  const a = ls.get(table);
  const i = a.findIndex(r => r.id === id);
  if (i < 0) throw new Error('Registro não encontrado');
  a[i] = { ...a[i], ...patch };
  if (table === 'deals') a[i].updated_at = new Date().toISOString();
  ls.set(table, a);
  return a[i];
}

// Insere várias linhas de uma vez (importação de CSV)
export async function insertMany(table, rows) {
  rows = rows.map(clean);
  if (sb) {
    const { error } = await sb.from(table).insert(rows);
    if (error) throw error;
    return;
  }
  const now = new Date().toISOString();
  ls.set(table, ls.get(table).concat(rows.map(r => ({ id: crypto.randomUUID(), created_at: now, ...r }))));
}

// Insere ou atualiza pela coluna única `key` (ex.: um snapshot por dia)
export async function upsert(table, row, key) {
  row = clean(row);
  if (sb) {
    const { data, error } = await sb.from(table).upsert(row, { onConflict: key }).select().single();
    if (error) throw error;
    return data;
  }
  const a = ls.get(table);
  const i = a.findIndex(r => r[key] === row[key]);
  if (i < 0) a.push({ id: crypto.randomUUID(), created_at: new Date().toISOString(), ...row }); else a[i] = { ...a[i], ...row };
  ls.set(table, a);
  return a[i < 0 ? a.length - 1 : i];
}

export async function remove(table, id) {
  if (sb) {
    const { error } = await sb.from(table).delete().eq('id', id);
    if (error) throw error;
    return;
  }
  ls.set(table, ls.get(table).filter(r => r.id !== id));
}

// Importa um backup/seed JSON {tabela: [linhas]} (modo local ou Supabase)
export async function bulkImport(obj) {
  for (const [t, rows] of Object.entries(obj)) {
    if (!Array.isArray(rows) || !rows.length) continue;
    if (sb) {
      const { error } = await sb.from(t).upsert(rows.map(clean));
      if (error) throw error;
    } else {
      const a = ls.get(t);
      const ids = new Set(a.map(r => r.id));
      ls.set(t, a.concat(rows.filter(r => !ids.has(r.id))));
    }
  }
}

// strings vazias viram null (o banco espera null em datas/números)
function clean(o) {
  const r = {};
  for (const [k, v] of Object.entries(o)) r[k] = v === '' ? null : v;
  return r;
}
