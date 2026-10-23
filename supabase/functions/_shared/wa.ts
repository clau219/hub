// Peças comuns do WhatsApp das casas (wa-webhook e wa-responder): envio pela Z-API e a base de informações
// das casas (app_config 'wa_base', preenchida na aba WhatsApp > Informações das casas).

// Envia texto pela Z-API. Devolve o id da mensagem no WhatsApp ou null (o motivo vai para o log).
export async function enviarZapi(to: string, body: string, { digitando = 3 } = {}) {
  const r = await fetch(`https://api.z-api.io/instances/${Deno.env.get('ZAPI_INSTANCE')}/token/${Deno.env.get('ZAPI_TOKEN')}/send-text`, {
    method: 'POST', headers: { 'Client-Token': Deno.env.get('ZAPI_CLIENT_TOKEN') || '', 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: to, message: body, ...(digitando ? { delayTyping: digitando } : {}) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !(j.messageId || j.id)) { console.error('envio Z-API', r.status, JSON.stringify(j)); return null; }
  return { wamid: (j.messageId || j.id) as string };
}

export type Base = {
  geral?: Record<string, string>;
  casas?: Record<string, Record<string, string>>;
};
const CAMPOS_GERAL: [string, string][] = [
  ['endereco', 'Endereço'], ['localizacao', 'Link da localização'], ['checkin', 'Horário de check-in'], ['checkout', 'Horário de check-out'],
  ['pets', 'Pets'], ['regras', 'Regras da casa'], ['pagamento', 'Como funciona o pagamento'], ['outros', 'Outras informações'],
];
const CAMPOS_CASA: [string, string][] = [
  ['capacidade', 'Capacidade'], ['quartos', 'Quartos e camas'], ['comodidades', 'Comodidades'], ['wifi_rede', 'Wi-Fi (rede)'],
  ['wifi_senha', 'Wi-Fi (senha)'], ['observacoes', 'Observações'],
];

export async function lerBase(sb: any): Promise<Base> {
  const { data } = await sb.from('app_config').select('value').eq('key', 'wa_base').maybeSingle();
  try { return JSON.parse(data?.value || '{}') || {}; } catch { return {}; }
}

// Texto da base para o prompt. paraRobo: sem senha do Wi-Fi e sem dados de Pix (o robô nunca envia isso).
export function baseTexto(base: Base, casas: { id: string; nome: string }[], { paraRobo = false } = {}) {
  const linhas: string[] = [];
  const g = base.geral || {};
  for (const [k, rot] of CAMPOS_GERAL) if (g[k]?.trim()) linhas.push(`${rot}: ${g[k].trim()}`);
  if (!paraRobo && g.pix_chave?.trim()) linhas.push(`Chave Pix: ${g.pix_chave.trim()}${g.pix_nome ? ` (${g.pix_nome.trim()})` : ''}`);
  if (!paraRobo && g.sinal_pct) linhas.push(`Sinal para reservar: ${g.sinal_pct}% do total`);
  for (const c of casas) {
    const x = base.casas?.[c.id] || {};
    const cs = CAMPOS_CASA.filter(([k]) => x[k]?.trim() && !(paraRobo && k === 'wifi_senha')).map(([k, rot]) => `  ${rot}: ${x[k].trim()}`);
    if (cs.length) linhas.push(`${c.nome} (${c.id}):`, ...cs);
  }
  return linhas.join('\n');
}
