// fetch falso: cada teste diz quais URLs respondem e o quê. O resto falha com "Rede bloqueada".
export const chamadas = []; // [{url, metodo, headers, corpo}]
let rotas = [];

const casa = (m, url, req) => typeof m === 'string' ? url.startsWith(m) : m instanceof RegExp ? m.test(url) : m(url, req);

// resposta: Response | objeto (vira JSON 200) | string (texto 200) | função (req) => um desses | {status, json|texto, headers}
export function simular(m, resposta) { rotas.unshift([m, resposta]); }
export function limparRede() { rotas = []; chamadas.length = 0; }

async function paraResponse(r, req) {
  if (typeof r === 'function') r = await r(req);
  if (r instanceof Response) return r;
  if (r instanceof Error) throw r;
  if (typeof r === 'string') return new Response(r, { status: 200 });
  if (r && (r.status || r.texto != null || r.json !== undefined) && Object.keys(r).every(k => ['status', 'json', 'texto', 'headers'].includes(k))) {
    const corpo = r.texto != null ? r.texto : r.json !== undefined ? JSON.stringify(r.json) : null;
    return new Response(corpo, { status: r.status || 200, headers: r.headers || (r.json !== undefined ? { 'content-type': 'application/json' } : {}) });
  }
  return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
}

export function bloquearRede() {
  globalThis.fetch = async (entrada, init = {}) => {
    const url = typeof entrada === 'string' ? entrada : entrada.url ?? String(entrada);
    const metodo = (init.method || entrada.method || 'GET').toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers || entrada.headers || {}).entries());
    let corpo = init.body ?? null;
    if (corpo instanceof URLSearchParams) corpo = corpo.toString();
    const req = { url, metodo, headers, corpo, json: () => JSON.parse(corpo) };
    chamadas.push(req);
    const rota = rotas.find(([m]) => casa(m, url, req));
    if (!rota) throw new TypeError(`Rede bloqueada nos testes: ${metodo} ${url}`);
    return paraResponse(rota[1], req);
  };
}
export const chamadasPara = m => chamadas.filter(c => casa(m, c.url, c));
