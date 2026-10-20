# Testes do Hub

Testam cada parte do Hub isoladamente: sem internet, sem o Supabase real, sem a Meta, a Pluggy, o Garmin ou o Airbnb.
Cada arquivo roda num processo separado, com o relógio parado em **segunda, 19/10/2026, 12h em Pipa**.

## Rodar

```bash
cd hub/tests
npm install        # só na primeira vez (happy-dom, rrule, zod)
npm test           # tudo (~10 s)
npm run test:unit  # módulos puros, store, db, service worker
npm run test:telas # telas no navegador falso (happy-dom)
npm run test:funcoes # Edge Functions do Supabase
```

Um arquivo só: `node --import ./helpers/ambiente.js --experimental-transform-types --test telas/hoje.test.js`.
Para ver os `console.warn/error` do Hub: `HUB_TESTE_LOG=1 npm test`.

## O que cada pasta cobre

| Pasta | Arquivos |
|---|---|
| `unit/` | util (datas, WhatsApp, captura rápida), hospedagem, fin-calc, cripto, moeda, saude-insights, db (local e Supabase), store (local e Supabase), sw |
| `telas/` | app (abertura, login, offline), ui (formulários), Hoje, Pipeline (computador e celular), Agenda, Aluguéis, Tarefas/Contatos, paleta e hábitos, Cripto, Saúde, Finanças (com o Painel), Ajustes |
| `funcoes/` | airbnb-quote, cripto-carteiras, fin-sync, garmin-sync, gcal-sync, ical-feed, ical-sync, wa-webhook |

## Como funciona (pasta `helpers/`)

- `ambiente.js`: carregado antes de tudo; para o relógio, bloqueia a rede e guarda o console.
- `ganchos.js`: os imports por URL (supabase-js do CDN, `npm:` e `esm.sh` das funções) apontam para versões locais.
- `fake-supabase.js`: banco em memória com o mesmo jeito do supabase-js (select/insert/upsert/filtros, auth, functions.invoke).
- `rede.js`: `simular(url, resposta)` responde o que a função ou a tela buscaria na internet.
- `dom.js` / `tela.js`: navegador falso com o `index.html` real; `abrirHub()` carrega dados de teste.
- `funcao.js`: simula o `Deno` (env e `serve`) e carrega o `index.ts` da função direto no Node.

## Testes "todo" (bugs encontrados, ainda não corrigidos)

Aparecem como `todo` e não quebram a suíte. Quando o bug for corrigido, tire o `todo` do teste.

1. **Saúde** (`v-saude.js`, `carregar()`): se a leitura do banco falha, a tela tenta de novo sem parar (dezenas de consultas por segundo ao Supabase).
2. **Paleta Ctrl+K** (`palette.js`): Finanças não aparece em "Ir para".
3. **ical-feed**: reserva sem origem aparece como "Casa X: reserva (null)" no calendário de Aluguéis.
