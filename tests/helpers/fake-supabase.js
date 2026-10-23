// Supabase falso, em memória. Substitui tanto o supabase-js do CDN (front) quanto o npm:@supabase/supabase-js
// das Edge Functions: os ganchos de módulo (ganchos.js) apontam os dois para este arquivo.
// O banco é global (globalThis.__banco) para o teste semear e conferir o que o código gravou.

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
// Erros como os do supabase-js (PostgrestError/AuthError herdam de Error)
const erro = (message, extra = {}) => Object.assign(new Error(message), extra);
const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));

export function criarBanco(tabelas = {}) {
  const b = {
    tabelas: Object.fromEntries(Object.entries(tabelas).map(([k, v]) => [k, clone(v)])),
    falhas: {}, // tabela -> mensagem de erro (toda consulta nela falha)
    funcoes: {}, // nome -> async (body, opts) => corpo da resposta (lançar = erro de rede/HTTP)
    rpcs: {}, // nome -> async (args) => data
    invocacoes: [], // [{nome, body}]
    consultas: [], // [{tabela, op}]
    aoConsultar: null, // (tabela, banco) => void, chamado a cada consulta (ex.: tirar uma falha depois de N tentativas)
    sessao: { access_token: 'token-teste', user: { id: 'u1', email: 'teste@hub.local' } },
    usuario: { id: 'u1', email: 'teste@hub.local' }, // devolvido por auth.getUser(jwt) quando jwt é válido
    jwtValido: jwt => jwt === 'token-teste',
    erroSessao: null,
    login: null, // [email, senha] do último signInWithPassword
    senhaCerta: 'senha-certa',
    // Valores padrão das colunas, como no banco real (supabase/*.sql): valem no insert quando a coluna não vem
    padroes: {
      wa_messages: { tipo: () => 'text', enviado_em: () => new Date().toISOString() },
      wa_contacts: { bot_pausado: () => false },
    },
    t(nome) { return (this.tabelas[nome] ||= []); },
  };
  return b;
}
export const banco = () => (globalThis.__banco ||= criarBanco());
export function novoBanco(tabelas) { globalThis.__banco = criarBanco(tabelas); return globalThis.__banco; }

// ---------- filtros ----------
const valor = (row, col) => col.split('->').reduce((o, k) => (o == null ? o : o[k]), row);
const like = (pad, ci) => new RegExp('^' + pad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', ci ? 'i' : '');
function op(nome, col, v) {
  switch (nome) {
    case 'eq': return r => valor(r, col) === v || (v != null && valor(r, col) != null && String(valor(r, col)) === String(v));
    case 'neq': return r => !(valor(r, col) === v || String(valor(r, col)) === String(v));
    case 'gt': return r => valor(r, col) != null && valor(r, col) > v;
    case 'gte': return r => valor(r, col) != null && valor(r, col) >= v;
    case 'lt': return r => valor(r, col) != null && valor(r, col) < v;
    case 'lte': return r => valor(r, col) != null && valor(r, col) <= v;
    case 'in': return r => v.map(String).includes(String(valor(r, col)));
    case 'is': return r => (v === null || v === 'null' ? valor(r, col) == null : valor(r, col) === v);
    case 'like': return r => like(v).test(String(valor(r, col) ?? ''));
    case 'ilike': return r => like(v, true).test(String(valor(r, col) ?? ''));
    case 'contains': return r => {
      const x = valor(r, col);
      if (Array.isArray(v)) return Array.isArray(x) && v.every(i => x.includes(i));
      return x && typeof x === 'object' && Object.entries(v).every(([k, w]) => JSON.stringify(x[k]) === JSON.stringify(w));
    };
    default: throw new Error(`fake-supabase: filtro ${nome} não implementado`);
  }
}
// "origem.is.null,origem.neq.airbnb"
function orExpr(s) {
  const partes = s.split(',').map(p => {
    const [col, nome, ...resto] = p.split('.');
    let v = resto.join('.');
    if (v === 'null') v = null; else if (v === 'true') v = true; else if (v === 'false') v = false;
    if (nome === 'in') v = v.replace(/^\(|\)$/g, '').split(',');
    return op(nome, col, v);
  });
  return r => partes.some(f => f(r));
}

// relação embutida: "*, contacts(nome)" -> row.contacts = {nome}
const FK = { contacts: 'contato_id', properties: 'property_id', deals: 'deal_id', wa_contacts: 'contact_id' };
function projetar(b, tabela, rows, cols) {
  if (!cols || cols.trim() === '*') return rows;
  const partes = [];
  let nivel = 0, cur = '';
  for (const ch of cols) {
    if (ch === '(') nivel++;
    if (ch === ')') nivel--;
    if (ch === ',' && !nivel) { partes.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) partes.push(cur.trim());
  const simples = partes.filter(p => !p.includes('('));
  const rel = partes.filter(p => p.includes('(')).map(p => { const m = p.match(/^(\w+)(?:!\w+)?\((.*)\)$/); return { t: m[1], cols: m[2] }; });
  return rows.map(r => {
    const o = simples.includes('*') ? { ...r } : Object.fromEntries(simples.map(c => [c.split(':').pop().trim(), r[c.split(':').pop().trim()]]));
    for (const { t, cols: c } of rel) {
      const fk = FK[t] || `${t.replace(/s$/, '')}_id`;
      const alvo = b.t(t).find(x => x.id === r[fk]);
      o[t] = alvo ? projetar(b, t, [alvo], c)[0] : null;
    }
    return o;
  });
}

class Consulta {
  constructor(cliente, tabela) {
    Object.assign(this, { cliente, tabela, filtros: [], ordem: [], faixa: null, lim: null, modo: 'select', cols: '*', um: null, opcoes: {}, retorna: false });
  }
  get b() { return banco(); }
  select(cols = '*', opcoes = {}) { if (this.modo === 'select') this.opcoes = opcoes; else this.retorna = true; this.cols = cols; return this; }
  insert(rows, opcoes = {}) { Object.assign(this, { modo: 'insert', dados: rows, opcoes }); return this; }
  upsert(rows, opcoes = {}) { Object.assign(this, { modo: 'upsert', dados: rows, opcoes }); return this; }
  update(patch) { Object.assign(this, { modo: 'update', dados: patch }); return this; }
  delete() { this.modo = 'delete'; return this; }
  eq(c, v) { this.filtros.push(op('eq', c, v)); return this; }
  neq(c, v) { this.filtros.push(op('neq', c, v)); return this; }
  gt(c, v) { this.filtros.push(op('gt', c, v)); return this; }
  gte(c, v) { this.filtros.push(op('gte', c, v)); return this; }
  lt(c, v) { this.filtros.push(op('lt', c, v)); return this; }
  lte(c, v) { this.filtros.push(op('lte', c, v)); return this; }
  in(c, v) { this.filtros.push(op('in', c, v)); return this; }
  is(c, v) { this.filtros.push(op('is', c, v)); return this; }
  like(c, v) { this.filtros.push(op('like', c, v)); return this; }
  ilike(c, v) { this.filtros.push(op('ilike', c, v)); return this; }
  contains(c, v) { this.filtros.push(op('contains', c, v)); return this; }
  match(o) { for (const [k, v] of Object.entries(o)) this.eq(k, v); return this; }
  filter(c, nome, v) { this.filtros.push(op(nome, c, v)); return this; }
  not(c, nome, v) { const f = op(nome, c, v); this.filtros.push(r => !f(r)); return this; }
  or(expr) { this.filtros.push(orExpr(expr)); return this; }
  order(col, { ascending = true } = {}) { this.ordem.push([col, ascending]); return this; }
  range(a, z) { this.faixa = [a, z]; return this; }
  limit(n) { this.lim = n; return this; }
  single() { this.um = 'single'; return this; }
  maybeSingle() { this.um = 'maybe'; return this; }
  throwOnError() { this.lancar = true; return this; }

  executar() {
    const b = this.b;
    b.consultas.push({ tabela: this.tabela, op: this.modo });
    b.aoConsultar?.(this.tabela, b);
    if (b.falhas[this.tabela]) return { data: null, error: erro(b.falhas[this.tabela], { code: 'TESTE' }) };
    const tab = b.t(this.tabela);
    const passa = r => this.filtros.every(f => f(r));
    let out;
    if (this.modo === 'select') {
      out = tab.filter(passa);
      for (const [col, asc] of [...this.ordem].reverse()) {
        out = [...out].sort((x, y) => { const a = valor(x, col), z = valor(y, col); if (a === z) return 0; if (a == null) return 1; if (z == null) return -1; return (a < z ? -1 : 1) * (asc ? 1 : -1); });
      }
      const count = out.length;
      if (this.faixa) out = out.slice(this.faixa[0], this.faixa[1] + 1);
      if (this.lim != null) out = out.slice(0, this.lim);
      out = clone(projetar(b, this.tabela, out, this.cols));
      if (this.opcoes.head) return { data: null, error: null, count };
      if (this.opcoes.count) return this.fim(out, count);
    } else if (this.modo === 'insert' || this.modo === 'upsert') {
      const lista = (Array.isArray(this.dados) ? this.dados : [this.dados]).map(clone);
      const chave = (this.opcoes.onConflict || 'id').split(',').map(s => s.trim());
      out = [];
      for (const r of lista) {
        const achado = this.modo === 'upsert' && tab.find(x => chave.every(k => r[k] !== undefined && String(x[k]) === String(r[k])));
        if (achado) {
          if (!this.opcoes.ignoreDuplicates) Object.assign(achado, r);
          out.push(achado);
        } else {
          const novo = { id: uuid(), created_at: new Date().toISOString(), ...r };
          if (novo.id == null) novo.id = uuid();
          for (const [k, f] of Object.entries(b.padroes[this.tabela] || {})) if (novo[k] === undefined) novo[k] = f();
          tab.push(novo); out.push(novo);
        }
      }
      out = clone(out);
    } else if (this.modo === 'update') {
      out = tab.filter(passa);
      out.forEach(r => Object.assign(r, clone(this.dados)));
      out = clone(out);
    } else if (this.modo === 'delete') {
      out = tab.filter(passa);
      b.tabelas[this.tabela] = tab.filter(r => !passa(r));
      out = clone(out);
    }
    if (this.modo !== 'select' && !this.retorna && !this.um) return { data: null, error: null };
    return this.fim(out);
  }
  fim(out, count) {
    if (this.um === 'single') {
      if (out.length !== 1) return { data: null, error: erro(`JSON object requested, multiple (or no) rows returned (${out.length})`, { code: 'PGRST116' }) };
      return { data: out[0], error: null };
    }
    if (this.um === 'maybe') {
      if (out.length > 1) return { data: null, error: erro('multiple rows', { code: 'PGRST116' }) };
      return { data: out[0] ?? null, error: null };
    }
    return count != null ? { data: out, error: null, count } : { data: out, error: null };
  }
  then(ok, falha) {
    return Promise.resolve().then(() => {
      const r = this.executar();
      if (this.lancar && r.error) throw r.error;
      return r;
    }).then(ok, falha);
  }
}

export function createClient(url, key, opcoes = {}) {
  const cliente = {
    url, key, opcoes,
    from: t => new Consulta(cliente, t),
    rpc: async (nome, args) => {
      const f = banco().rpcs[nome];
      if (!f) return { data: null, error: erro(`rpc ${nome} não simulada`) };
      try { return { data: await f(args), error: null }; } catch (e) { return { data: null, error: erro(e.message) }; }
    },
    functions: {
      invoke: async (nome, o = {}) => {
        const b = banco();
        b.invocacoes.push({ nome, body: o.body });
        const f = b.funcoes[nome];
        if (!f) return { data: null, error: erro(`Função ${nome} não simulada`) };
        try {
          return { data: await f(o.body, o), error: null }; // o handler devolve o corpo; erro de transporte = lançar
        } catch (e) { return { data: null, error: erro(e.message) }; }
      },
    },
    auth: {
      getSession: async () => {
        const b = banco();
        if (b.erroSessao) return { data: { session: null }, error: b.erroSessao };
        return { data: { session: b.sessao }, error: null };
      },
      getUser: async jwt => {
        const b = banco();
        const ok = jwt ? b.jwtValido(jwt) : !!b.sessao;
        return ok ? { data: { user: b.usuario }, error: null } : { data: { user: null }, error: erro('invalid JWT') };
      },
      signInWithPassword: async ({ email, password }) => {
        const b = banco();
        b.login = [email, password];
        if (password !== b.senhaCerta) return { data: null, error: erro('Invalid login credentials') };
        b.sessao = { access_token: 'token-teste', user: { id: 'u1', email } };
        return { data: { session: b.sessao }, error: null };
      },
      signOut: async () => { banco().sessao = null; return { error: null }; },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  };
  return cliente;
}
export default { createClient };
