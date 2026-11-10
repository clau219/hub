// Entrada do WhatsApp PESSOAL: o leitor (A:\Usuário\HUB\wa-leitor, Baileys rodando na máquina do Google Cloud)
// manda para cá o estado da conexão, as conversas e as mensagens. Só grava: nada sai daqui para o WhatsApp.
// Auth: header x-wp-token = app_secrets 'wp_leitor_token' (só o leitor tem).
// Corpo (qualquer combinação):
//   status:     {estado: 'conectando'|'qr'|'conectado'|'desconectado', qr?, numero?, motivo?, versao?}
//   chats:      [{id, nome?, grupo, ultima_msg_em?}]
//   mensagens:  [{chat_id, id, de_mim, autor?, tipo, texto?, segundos?, menciona_me?, responde_a_mim?, cita?, enviado_em}]
//   audios:     [{chat_id, id, mime, base64}] → transcritos (GROQ_API_KEY) e gravados no texto da mensagem
// Resposta: {ok, grupos: [ids acompanhados], ignorar: [ids ignorados]}: o leitor só manda mensagem de grupo acompanhado.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

type SB = ReturnType<typeof createClient>;
// Número das casas (+55 84 99111-8864): ali você manda comandos ao robô; fica fora do resumo de saída
const IGNORAR_FINAIS = ['91118864'];
const MAX_AUDIOS = 3;

Deno.serve(async req => {
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  if (req.method !== 'POST') return json({ error: 'use POST' }, 405);
  const tok = req.headers.get('x-wp-token');
  if (!tok) return json({ error: 'não autorizado' }, 401);
  const { data: seg } = await sb.from('app_secrets').select('value').eq('key', 'wp_leitor_token').maybeSingle();
  if (!seg?.value || seg.value !== tok) return json({ error: 'não autorizado' }, 401);

  const corpo = await req.json().catch(() => null);
  if (!corpo || typeof corpo !== 'object') return json({ error: 'corpo inválido' }, 400);
  const res: Record<string, unknown> = { ok: true };
  try {
    if (corpo.status) res.status = await gravarStatus(sb, corpo.status);
    if (Array.isArray(corpo.chats) && corpo.chats.length) res.chats = await gravarChats(sb, corpo.chats);
    if (Array.isArray(corpo.mensagens) && corpo.mensagens.length) res.mensagens = await gravarMensagens(sb, corpo.mensagens);
    if (Array.isArray(corpo.audios) && corpo.audios.length) res.audios = await transcreverAudios(sb, corpo.audios.slice(0, MAX_AUDIOS));
  } catch (e) {
    console.error('wp-ingest', e);
    return json({ error: (e as Error).message }, 500);
  }
  const { data: cs } = await sb.from('wp_chats').select('id,grupo,acompanhar,ignorar').or('acompanhar.eq.true,ignorar.eq.true');
  res.grupos = (cs || []).filter((c: any) => c.grupo && c.acompanhar && !c.ignorar).map((c: any) => c.id);
  res.ignorar = (cs || []).filter((c: any) => c.ignorar).map((c: any) => c.id);
  return json(res);
});

// ---------- estado da conexão ----------
async function gravarStatus(sb: SB, s: any) {
  const ESTADOS = ['conectando', 'qr', 'conectado', 'desconectado'];
  if (!ESTADOS.includes(s?.estado)) throw new Error('estado inválido');
  const { data } = await sb.from('app_config').select('value').eq('key', 'wp_status').maybeSingle();
  let antes: any = null; try { antes = data?.value ? JSON.parse(data.value) : null; } catch { /* estado antigo ilegível */ }
  const agora = new Date().toISOString();
  const novo = {
    estado: s.estado,
    qr: s.estado === 'qr' ? String(s.qr || '').slice(0, 20000) : null, // imagem PNG (data URL) do QR, só enquanto espera a leitura
    numero: s.numero || antes?.numero || null,
    motivo: s.motivo ? String(s.motivo).slice(0, 300) : null,
    versao: s.versao || null,
    em: agora,
    desde: antes?.estado === s.estado ? antes.desde || agora : agora,
    conectado_desde: s.estado === 'conectado' ? (antes?.estado === 'conectado' ? antes.conectado_desde || agora : agora) : antes?.conectado_desde || null,
  };
  await sb.from('app_config').upsert({ key: 'wp_status', value: JSON.stringify(novo) }, { onConflict: 'key' });
  return novo.estado;
}

// ---------- conversas ----------
async function gravarChats(sb: SB, lista: any[]) {
  const porId = new Map<string, any>();
  for (const c of lista) {
    if (!c?.id || typeof c.id !== 'string') continue;
    const a = porId.get(c.id) || {};
    porId.set(c.id, { id: c.id, grupo: !!(c.grupo ?? a.grupo), nome: limpar(c.nome) || a.nome || null, ultima_msg_em: maisRecente(a.ultima_msg_em, c.ultima_msg_em) });
  }
  const ids = [...porId.keys()];
  let gravados = 0;
  for (let i = 0; i < ids.length; i += 300) {
    const lote = ids.slice(i, i + 300);
    const { data: existentes, error } = await sb.from('wp_chats').select('*').in('id', lote);
    if (error) throw error;
    const ex = new Map((existentes || []).map((r: any) => [r.id, r]));
    const linhas = lote.map(id => {
      const n = porId.get(id), e: any = ex.get(id);
      return {
        id,
        nome: n.nome || e?.nome || null, // nunca apaga um nome conhecido
        grupo: n.grupo || !!e?.grupo,
        acompanhar: e?.acompanhar ?? false,
        ignorar: e ? e.ignorar : IGNORAR_FINAIS.some(f => id.split('@')[0].endsWith(f)),
        ultima_msg_em: maisRecente(e?.ultima_msg_em, n.ultima_msg_em),
        atualizado_em: new Date().toISOString(),
      };
    });
    const { error: e2 } = await sb.from('wp_chats').upsert(linhas, { onConflict: 'id' });
    if (e2) throw e2;
    gravados += linhas.length;
  }
  return gravados;
}

// ---------- mensagens ----------
async function gravarMensagens(sb: SB, lista: any[]) {
  const linhas = new Map<string, any>();
  for (const m of lista) {
    if (!m?.chat_id || !m?.id || !m?.enviado_em || isNaN(Date.parse(m.enviado_em))) continue;
    linhas.set(m.chat_id + '|' + m.id, {
      chat_id: String(m.chat_id), id: String(m.id), de_mim: !!m.de_mim,
      autor: limpar(m.autor) || null, tipo: String(m.tipo || 'texto').slice(0, 30),
      texto: m.texto ? corta(m.texto, 8000) : null,
      segundos: Number.isFinite(m.segundos) ? Math.round(m.segundos) : null,
      menciona_me: !!m.menciona_me, responde_a_mim: !!m.responde_a_mim,
      cita: m.cita ? corta(m.cita, 300) : null,
      enviado_em: new Date(m.enviado_em).toISOString(),
    });
  }
  const todas = [...linhas.values()];
  // Conversa nova chega junto com a primeira mensagem dela
  const ult = new Map<string, string>();
  for (const m of todas) ult.set(m.chat_id, maisRecente(ult.get(m.chat_id), m.enviado_em)!);
  await gravarChats(sb, [...ult].map(([id, em]) => ({ id, grupo: id.endsWith('@g.us'), ultima_msg_em: em })));
  for (let i = 0; i < todas.length; i += 500) {
    // Áudio já transcrito não perde o texto quando a mesma mensagem chega de novo (histórico repetido)
    const lote = todas.slice(i, i + 500);
    const audios = lote.filter(m => m.tipo === 'audio' && !m.texto);
    if (audios.length) {
      const { data: ja } = await sb.from('wp_mensagens').select('chat_id,id,texto').in('id', audios.map(m => m.id));
      for (const r of ja || []) { const m = linhas.get(r.chat_id + '|' + r.id); if (m && r.texto) m.texto = r.texto; }
    }
    const { error } = await sb.from('wp_mensagens').upsert(lote, { onConflict: 'chat_id,id' });
    if (error) throw error;
  }
  return todas.length;
}

// ---------- áudio → texto ----------
async function transcreverAudios(sb: SB, lista: any[]) {
  const chave = Deno.env.get('GROQ_API_KEY'), openai = Deno.env.get('OPENAI_API_KEY');
  if (!chave && !openai) return { erro: 'sem GROQ_API_KEY' };
  let feitos = 0;
  for (const a of lista) {
    if (!a?.chat_id || !a?.id || !a?.base64) continue;
    try {
      const bytes = Uint8Array.from(atob(a.base64), c => c.charCodeAt(0));
      if (bytes.length > 20 * 1024 * 1024) continue;
      const mime = String(a.mime || 'audio/ogg').split(';')[0];
      const fd = new FormData();
      fd.append('file', new Blob([bytes], { type: mime }), /mp4|m4a|aac/.test(mime) ? 'audio.m4a' : /mpeg|mp3/.test(mime) ? 'audio.mp3' : 'audio.ogg');
      fd.append('model', chave ? 'whisper-large-v3-turbo' : 'whisper-1');
      fd.append('language', 'pt');
      const r = await fetch(chave ? 'https://api.groq.com/openai/v1/audio/transcriptions' : 'https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: `Bearer ${chave || openai}` }, body: fd, signal: AbortSignal.timeout(60000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { console.error('transcrição', r.status, j?.error?.message); continue; }
      const texto = String(j.text || '').trim();
      if (!texto) continue;
      await sb.from('wp_mensagens').update({ texto }).eq('chat_id', a.chat_id).eq('id', a.id);
      feitos++;
    } catch (e) { console.error('áudio', (e as Error).message); }
  }
  return feitos;
}

const limpar = (s: unknown) => (typeof s === 'string' ? corta(s.replace(/\s+/g, ' ').trim(), 120) : '');
// Corta sem partir emoji ao meio (metade solta de um par UTF-16 quebra o JSON depois)
const corta = (s: unknown, n: number) => String(s).slice(0, n).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
function maisRecente(a?: string | null, b?: string | null) {
  const ta = a ? Date.parse(a) : NaN, tb = b ? Date.parse(b) : NaN;
  if (isNaN(ta)) return isNaN(tb) ? null : new Date(tb).toISOString();
  if (isNaN(tb)) return new Date(ta).toISOString();
  return new Date(Math.max(ta, tb)).toISOString();
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
