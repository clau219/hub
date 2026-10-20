// Carregado antes de cada arquivo de teste (node --import): deixa o ambiente previsível.
// - imports por URL (CDN, npm:, esm.sh) viram versões locais (ganchos.js)
// - relógio parado em 19/10/2026 12:00 de Pipa (segunda-feira), mudável com relogio.definir()
// - rede bloqueada: fetch só responde o que o teste simular (rede.js)
// - localStorage em memória (dom.js troca pelo do happy-dom)
import { register } from 'node:module';
import { bloquearRede } from './rede.js';

register('./ganchos.js', import.meta.url);

const DataReal = Date;
let agora = DataReal.parse('2026-10-19T15:00:00Z');
class DataFixa extends DataReal {
  constructor(...a) { if (a.length) super(...a); else super(agora); }
  static now() { return agora; }
}
globalThis.Date = DataFixa;
export const relogio = {
  definir(iso) { agora = DataReal.parse(iso); },
  avancar(ms) { agora += ms; },
  agora: () => agora,
};
globalThis.__relogio = relogio;

if (!globalThis.localStorage || typeof globalThis.localStorage.getItem !== 'function') {
  const m = new Map();
  const ls = {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    clear: () => m.clear(),
    key: i => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true, writable: true });
}

bloquearRede();

// console.warn/error do Hub (avisos esperados nos cenários de falha) ficam guardados em vez de poluir a saída.
// HUB_TESTE_LOG=1 mostra tudo.
export const logs = [];
if (!process.env.HUB_TESTE_LOG) {
  for (const k of ['warn', 'error']) console[k] = (...a) => logs.push([k, a.map(x => (x instanceof Error ? x.message : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')]);
}
globalThis.__logs = logs;
