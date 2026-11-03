-- Relatório mensal para o proprietário de cada casa (rode uma vez no SQL Editor do Supabase).
-- dono:       {"nome":"Maria Souza","email":"maria@exemplo.com","comissao_pct":20}
-- relatorios: {"2026-10":{"ajustes":[{"descricao":"Faxina extra","valor":150}],"excluidas":["<fin_tx.id>"],
--              "enviado_em":"2026-11-02T13:00:00Z","para":"maria@exemplo.com","repasse":2780}}
-- properties já tem RLS com a política so_dono: colunas novas não precisam de política.
alter table properties add column if not exists dono jsonb not null default '{}'::jsonb;
alter table properties add column if not exists relatorios jsonb not null default '{}'::jsonb;
