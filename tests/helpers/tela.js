// Abre o Hub num navegador falso com dados de teste: modo local (localStorage) ou Supabase falso.
import { montarDom, hub } from './dom.js';
import { novoBanco } from './fake-supabase.js';

export const CASAS = [{ id: 'QS39', nome: 'Casa Frida', cor: '#c2410c' }, { id: 'QS40', nome: 'Casa Azul', cor: '#1d4ed8' }, { id: 'QS50', nome: 'Casa Terracota', cor: '#a16207' }];

let mods = null;
export async function abrirHub({ tabelas = {}, supabase = false, hash = '', largura } = {}) {
  montarDom({ hash, largura });
  const db = await hub('db.js');
  if (supabase) { novoBanco(tabelas); await db.init(); } else semearLocal(tabelas);
  const store = await hub('store.js');
  await store.load();
  mods = { db, store, S: store.S };
  return mods;
}
export function semearLocal(tabelas) {
  localStorage.clear();
  for (const [k, v] of Object.entries({ properties: CASAS, ...tabelas })) localStorage.setItem('hub:' + k, JSON.stringify(v));
}
// Troca os dados (mesmo modo) e recarrega o estado
export async function trocarDados(tabelas = {}, { supabase = false } = {}) {
  if (supabase) novoBanco(tabelas); else semearLocal(tabelas);
  await mods.store.load();
}
export const guardado = t => JSON.parse(localStorage.getItem('hub:' + t) || '[]');
