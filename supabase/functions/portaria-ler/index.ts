// Lê prints (WhatsApp, Airbnb) e fotos/PDFs de documentos para o e-mail da portaria, só com o login do Claudio.
//   POST {arquivos: [{mime, base64}]} → {hospedes: [{nome, documento}], veiculos: [{modelo, placa}], casa, checkin, checkout, avisos}
// casa = id da casa (QS39/QS40/QS50) ou ""; datas em AAAA-MM-DD ou "". O Hub passa o resultado pelo mesmo leitor do texto
// colado (hospedagem.js), que formata CPF, nomes e órgão emissor, e mostra tudo editável antes de copiar.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import Anthropic from 'npm:@anthropic-ai/sdk@0.134.0';
import { zodOutputFormat } from 'npm:@anthropic-ai/sdk@0.134.0/helpers/zod';
import { z } from 'npm:zod@4.6.7';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const MAX_ARQ = 6;
const MAX_B64 = 6_800_000; // ~5 MB por arquivo, limite da API para imagem
const IMG = /^image\/(jpeg|png|gif|webp)$/;

// Sem campos nullable: "" quando não aparece (structured output aceita no máx. 16 campos com tipo união)
const LeituraSchema = z.object({
  hospedes: z.array(z.object({ nome: z.string(), documento: z.string() })),
  veiculos: z.array(z.object({ modelo: z.string(), placa: z.string() })),
  casa: z.string(),
  checkin: z.string(),
  checkout: z.string(),
  avisos: z.array(z.string()),
});

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'método não suportado' }, 405);
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt || jwt.startsWith('sb_') || !(await sb.auth.getUser(jwt)).data?.user) return json({ error: 'não autorizado' }, 401);
  if (!Deno.env.get('ANTHROPIC_API_KEY')) return json({ error: 'chave da Anthropic não cadastrada' }, 500);

  const b = await req.json().catch(() => ({}));
  const arquivos = Array.isArray(b.arquivos) ? b.arquivos : [];
  if (!arquivos.length) return json({ error: 'nenhum arquivo enviado' }, 400);
  if (arquivos.length > MAX_ARQ) return json({ error: `no máximo ${MAX_ARQ} arquivos por vez` }, 400);
  for (const a of arquivos) {
    if (!a || typeof a.base64 !== 'string' || !a.base64) return json({ error: 'arquivo vazio' }, 400);
    if (!IMG.test(a.mime) && a.mime !== 'application/pdf') return json({ error: `tipo de arquivo não aceito: ${a.mime || '?'} (use foto, print ou PDF)` }, 400);
    if (a.base64.length > MAX_B64) return json({ error: 'arquivo grande demais (máx. 5 MB)' }, 400);
  }
  try {
    const { data: casas } = await sb.from('properties').select('id,nome').order('id');
    return json(await ler(arquivos, casas || []));
  } catch (e) {
    console.error('portaria-ler', e);
    return json({ error: (e as Error).message }, 500);
  }
});

async function ler(arquivos: { mime: string; base64: string }[], casas: { id: string; nome: string }[]) {
  const listaCasas = casas.map(c => `- ${c.id}: ${c.nome} ${c.id} (também chamada de "${c.nome}", "Casa ${c.id.replace(/\D/g, '')}" ou "${c.id}")`).join('\n');
  const system = `Você extrai dados para a lista de hóspedes que o Claudio envia à portaria do Condomínio Pipa Natureza (Pipa/RN), onde ele aluga casas de temporada.
As imagens/PDFs podem ser: prints de conversa (WhatsApp, Airbnb), listas digitadas, fotos de documentos (RG, CPF, CNH, passaporte, RNM, DNI) ou de cartões de reserva do Airbnb.

Extraia:
- hospedes: cada pessoa com nome completo exatamente como escrito (sem abreviar nem corrigir) e documento no formato "TIPO NÚMERO" com o órgão emissor no fim quando aparecer, ex.: "CPF 433.935.708-11", "RG 2392336 SDS/PE", "CNH 01234567890", "Passaporte FX123456", "RNM V123456-7", "DNI 12345678". Copie os números dígito por dígito, sem completar o que não estiver legível. Pessoa sem documento visível: documento "". Foto de documento: use o nome do titular e o número principal (no RG, o número do registro geral; na CNH, prefira o CPF impresso nela, como "CPF ...").
- veiculos: modelo e placa, se aparecerem (placa em maiúsculas, sem hífen).
- casa: o id da casa (lista abaixo) se o print indicar qual é (título da reserva, nome do chat, texto da conversa); senão "".
- checkin e checkout: datas de entrada e saída no formato AAAA-MM-DD se aparecerem; ano ausente = o próximo a partir de hoje (${hoje()}); senão "".
- avisos: frases curtas em português sobre o que conferir (número cortado ou ilegível, nome incompleto, documento vencido, pessoa citada sem documento). Lista vazia se estiver tudo claro.
Não invente nada: o que não aparece fica "" ou fora da lista. Ignore o anfitrião (Claudio Braga) e mensagens que não sejam dados de hóspedes.

Casas:
${listaCasas || '(sem cadastro)'}`;
  const content: any[] = arquivos.map(a => a.mime === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.base64 } }
    : { type: 'image', source: { type: 'base64', media_type: a.mime, data: a.base64 } });
  content.push({ type: 'text', text: 'Extraia os hóspedes, documentos, veículos, casa e datas destes arquivos.' });
  const r = await new Anthropic().messages.parse({
    model: 'claude-haiku-5-5',
    max_tokens: 4000,
    output_config: { effort: 'low', format: zodOutputFormat(LeituraSchema) },
    system,
    messages: [{ role: 'user', content }],
  });
  if (r.stop_reason === 'refusal' || !r.parsed_output) throw new Error(`a IA não conseguiu ler (${r.stop_reason})`);
  const o = r.parsed_output;
  const iso = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '');
  let checkin = iso(o.checkin), checkout = iso(o.checkout);
  if (checkin && checkout && checkout <= checkin) checkout = '';
  return {
    hospedes: o.hospedes.map(x => ({ nome: x.nome.trim(), documento: x.documento.trim() })).filter(x => x.nome || x.documento),
    veiculos: o.veiculos.map(v => ({ modelo: v.modelo.trim(), placa: v.placa.replace(/[^A-Za-z0-9]/g, '').toUpperCase() })).filter(v => v.placa),
    casa: casas.some(c => c.id === o.casa) ? o.casa : '',
    checkin, checkout,
    avisos: o.avisos.map(a => a.trim()).filter(Boolean).slice(0, 6),
  };
}

const hoje = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
