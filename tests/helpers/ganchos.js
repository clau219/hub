// Ganchos de carregamento de módulos (node:module register): os imports por URL do Hub e das Edge Functions
// apontam para versões locais. Nada é baixado: import https desconhecido falha de propósito.
const aqui = new URL('./', import.meta.url);
const raiz = new URL('../package.json', import.meta.url).href; // pacotes reais (zod) saem de tests/node_modules

const MAPA = [
  [/^https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@[^/]+\/\+esm$/, new URL('fake-supabase.js', aqui).href],
  [/^npm:@supabase\/supabase-js(@[^/]+)?$/, new URL('fake-supabase.js', aqui).href],
  [/^npm:@anthropic-ai\/sdk(@[^/]+)?\/helpers\/zod$/, new URL('fake-anthropic.js', aqui).href],
  [/^npm:@anthropic-ai\/sdk(@[^/]+)?$/, new URL('fake-anthropic.js', aqui).href],
  [/^npm:zod(@[^/]+)?$/, 'zod'],
  [/^npm:web-push(@[^/]+)?$/, new URL('fake-webpush.js', aqui).href],
  [/^npm:nodemailer(@[^/]+)?$/, new URL('fake-nodemailer.js', aqui).href],
  [/^https:\/\/esm\.sh\/rrule@[^/]+$/, new URL('rrule.js', aqui).href], // adaptador: o pacote é CommonJS
];

export async function resolve(especificador, ctx, proximo) {
  for (const [re, alvo] of MAPA) {
    if (re.test(especificador)) {
      if (alvo.startsWith('file:')) return { url: alvo, shortCircuit: true };
      return proximo(alvo, { ...ctx, parentURL: raiz });
    }
  }
  if (/^(https?|npm|jsr):/.test(especificador)) throw new Error(`Import externo não simulado nos testes: ${especificador}`);
  return proximo(especificador, ctx);
}
