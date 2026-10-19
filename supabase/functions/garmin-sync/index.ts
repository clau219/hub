// Traz do Garmin Connect os dados de saúde e as atividades e grava no Hub (health_daily, health_activities),
// marca os hábitos automáticos (habits.auto) e guarda o status em app_config 'garmin_status'.
// Agendada de hora em hora pelo pg_cron (x-hub-cron) e chamada pelo botão "Atualizar" da tela Saúde.
// O acesso ao Garmin (tokens) fica em garmin_tokens; é renovado aqui e gravado de volta.
// Primeiro login (senha + código) é feito no PC: garmin/garmin_login.py.
// Corpo opcional: { dias?: number (padrão 2), desde?: 'AAAA-MM-DD', renovar?: true (força renovar o acesso) }
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-hub-cron' };
const API = 'https://connectapi.garmin.com';
const DI_TOKEN_URL = 'https://diauth.garmin.com/di-oauth2-service/oauth/token';
// Mesmos cabeçalhos do app Android do Garmin Connect (como a biblioteca garminconnect 0.3.18)
const NATIVE = {
  'User-Agent': 'GCM-Android-5.23',
  'X-Garmin-User-Agent': 'com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0',
  'X-Garmin-Paired-App-Version': '10861', 'X-Garmin-Client-Platform': 'Android', 'X-App-Ver': '10861',
  'X-Lang': 'en', 'X-GCExperience': 'GC5', 'Accept-Language': 'en-US,en;q=0.9',
};
const TIPOS: Record<string, string[]> = {
  corrida: ['running', 'treadmill_running', 'trail_running', 'track_running', 'indoor_running'],
  forca: ['strength_training'],
  caminhada: ['walking', 'casual_walking', 'speed_walking'],
  trilha: ['hiking'],
  pedal: ['cycling', 'indoor_cycling', 'road_biking', 'mountain_biking', 'gravel_cycling', 'virtual_ride'],
  natacao: ['lap_swimming', 'open_water_swimming', 'swimming'],
};

type Tokens = { di_token: string; di_refresh_token: string; di_client_id: string };

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  if (!(await autorizado(req, sb))) return json({ error: 'não autorizado' }, 401);
  const body = await req.json().catch(() => ({}));
  const agora = new Date().toISOString();
  const status = (info: Record<string, unknown>) => sb.from('app_config').upsert({ key: 'garmin_status', value: JSON.stringify({ em: agora, ...info }) });

  try {
    const { data: tk } = await sb.from('garmin_tokens').select('tokens').eq('id', 1).maybeSingle();
    if (!tk) throw new Error('Sem acesso ao Garmin: rode garmin_login.py no PC uma vez.');
    const g = new Garmin(JSON.parse(tk.tokens));
    if (body.renovar) await g.renovar(); // teste da renovação do acesso

    const fim = hoje();
    let ini = body.desde || addDays(fim, -((body.dias || 2) - 1));
    if (!body.desde) {
      // Relógio que passou dias sem sincronizar manda tudo de uma vez: volta até o último dia com dado (máx. 60 dias)
      const { data: ult } = await sb.from('health_daily').select('dia').not('passos', 'is', null).order('dia', { ascending: false }).limit(1);
      if (ult?.[0]) ini = [ini, [ult[0].dia, addDays(fim, -60)].sort().at(-1)!].sort()[0];
    }

    const perfil = await g.get('/userprofile-service/socialProfile');
    const nome = perfil?.displayName;
    if (!nome) throw new Error('Garmin não devolveu o perfil');

    const dias: string[] = [];
    for (let d = ini; d <= fim; d = addDays(d, 1)) dias.push(d);
    const linhas = [];
    for (const d of dias) linhas.push(await diaGarmin(g, nome, d));
    await gravar(sb, 'health_daily', linhas, 'dia');

    const aIni = [ini, addDays(fim, -7)].sort()[0];
    const acts = await atividades(g, aIni, fim);
    if (acts.length) { const { error } = await sb.from('health_activities').upsert(acts, { onConflict: 'id' }); if (error) throw error; }

    if (g.renovado) await sb.from('garmin_tokens').upsert({ id: 1, tokens: JSON.stringify(g.t), atualizado_em: agora });
    const marcados = await marcarHabitos(sb, dias);
    const info = { de: ini, ate: fim, dias: dias.length, atividades: acts.length, habitos: marcados, onde: 'supabase' };
    await status(info);
    return json(info);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await status({ erro: msg });
    return json({ erro: msg }, 500);
  }
});

class Garmin {
  renovado = false;
  constructor(public t: Tokens) {}

  private expira() {
    try { return JSON.parse(atob(this.t.di_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000; } catch { return 0; }
  }

  async renovar() {
    const r = await fetch(DI_TOKEN_URL, {
      method: 'POST',
      headers: { ...NATIVE, Authorization: 'Basic ' + btoa(this.t.di_client_id + ':'), Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: this.t.di_client_id, refresh_token: this.t.di_refresh_token }),
    });
    if (!r.ok) throw new Error(`Garmin recusou renovar o acesso (${r.status}): rode garmin_login.py no PC.`);
    const d = await r.json();
    this.t = { ...this.t, di_token: d.access_token, di_refresh_token: d.refresh_token || this.t.di_refresh_token };
    this.renovado = true;
  }

  async get(path: string, params: Record<string, string> = {}): Promise<any> {
    if (Date.now() > this.expira() - 900e3) await this.renovar();
    const url = `${API}${path}${Object.keys(params).length ? '?' + new URLSearchParams(params) : ''}`;
    const ir = () => fetch(url, { headers: { ...NATIVE, Authorization: `Bearer ${this.t.di_token}`, Accept: 'application/json' } });
    let r = await ir();
    if (r.status === 401) { await this.renovar(); r = await ir(); }
    if (r.status === 204 || r.status === 404) return null;
    if (!r.ok) throw new Error(`Garmin ${r.status} em ${path}`);
    const txt = await r.text();
    return txt ? JSON.parse(txt) : null;
  }

  // Um dado que falha (ex.: relógio sem VFC) não derruba o dia
  async talvez(path: string, params?: Record<string, string>) {
    try { return await this.get(path, params); } catch (e) { console.warn(path, String(e)); return null; }
  }
}

async function diaGarmin(g: Garmin, nome: string, d: string) {
  const [u, sono, hrv, tr, mm, peso] = await Promise.all([
    g.talvez(`/usersummary-service/usersummary/daily/${nome}`, { calendarDate: d }),
    g.talvez(`/wellness-service/wellness/dailySleepData/${nome}`, { date: d, nonSleepBufferMinutes: '60' }),
    g.talvez(`/hrv-service/hrv/${d}`),
    g.talvez(`/metrics-service/metrics/trainingreadiness/${d}`),
    g.talvez(`/metrics-service/metrics/maxmet/daily/${d}/${d}`),
    g.talvez(`/weight-service/weight/dayview/${d}`, { includeAll: 'true' }),
  ]);
  const int = (v: any) => v == null ? null : Math.round(+v);
  const s = sono?.dailySleepDTO || {};
  const h = hrv?.hrvSummary || {};
  const trs = (Array.isArray(tr) ? tr : tr ? [tr] : []).filter((x: any) => x?.score != null)
    .sort((a: any, b: any) => String(a.timestamp || a.timestampLocal || '').localeCompare(String(b.timestamp || b.timestampLocal || '')));
  const m0 = Array.isArray(mm) ? mm[0] : mm;
  const iso = (ms: number) => ms ? new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z') : null;
  const linha: Record<string, unknown> = {
    dia: d, fonte: 'garmin-api', atualizado_em: new Date().toISOString(),
    passos: u?.totalSteps, meta_passos: u?.dailyStepGoal, distancia_m: u?.totalDistanceMeters,
    calorias: int(u?.totalKilocalories), calorias_ativas: int(u?.activeKilocalories),
    min_moderados: u?.moderateIntensityMinutes, min_intensos: u?.vigorousIntensityMinutes, andares: int(u?.floorsAscended),
    fc_repouso: u?.restingHeartRate, fc_max: u?.maxHeartRate,
    estresse_medio: (u?.averageStressLevel ?? -1) >= 0 ? u.averageStressLevel : null,
    bb_max: u?.bodyBatteryHighestValue, bb_min: u?.bodyBatteryLowestValue,
    spo2_medio: int(u?.averageSpo2), respiracao: u?.avgWakingRespirationValue,
    ...(s.sleepTimeSeconds ? {
      sono_seg: s.sleepTimeSeconds, sono_profundo_seg: s.deepSleepSeconds, sono_leve_seg: s.lightSleepSeconds,
      sono_rem_seg: s.remSleepSeconds, sono_acordado_seg: s.awakeSleepSeconds, sono_score: s.sleepScores?.overall?.value,
      sono_inicio: iso(s.sleepStartTimestampGMT), sono_fim: iso(s.sleepEndTimestampGMT),
    } : {}),
    hrv_noite: h.lastNightAvg, hrv_semana: h.weeklyAvg, hrv_status: h.status,
    prontidao: trs.at(-1)?.score,
    vo2max: m0?.generic?.vo2MaxPreciseValue || m0?.generic?.vo2MaxValue,
    peso_kg: peso?.totalAverage?.weight ? Math.round(peso.totalAverage.weight / 10) / 100 : null,
  };
  // Só os campos que vieram: um dia sem sono no relógio não apaga o que já está gravado
  return Object.fromEntries(Object.entries(linha).filter(([, v]) => v != null));
}

async function atividades(g: Garmin, ini: string, fim: string) {
  const out = [];
  for (let start = 0; start < 1000; start += 20) {
    const lote = await g.get('/activitylist-service/activities/search/activities', { startDate: ini, endDate: fim, start: String(start), limit: '20' }) || [];
    for (const a of lote) {
      if (!a.activityId || !a.startTimeGMT) continue;
      out.push({
        id: a.activityId, inicio: a.startTimeGMT.replace(' ', 'T') + 'Z', dia: (a.startTimeLocal || a.startTimeGMT).slice(0, 10),
        tipo: a.activityType?.typeKey ?? null, nome: a.activityName ?? null,
        duracao_seg: a.duration != null ? Math.round(a.duration) : null, distancia_m: a.distance ?? null,
        calorias: a.calories != null ? Math.round(a.calories) : null,
        fc_media: a.averageHR != null ? Math.round(a.averageHR) : null, fc_max: a.maxHR != null ? Math.round(a.maxHR) : null,
        elevacao_m: a.elevationGain ?? null, carga: a.activityTrainingLoad ?? null, te_aerobico: a.aerobicTrainingEffect ?? null,
        passos: a.steps ?? null, fonte: 'garmin-api', atualizado_em: new Date().toISOString(),
      });
    }
    if (lote.length < 20) break;
  }
  return out;
}

// Linhas com campos diferentes vão separadas: o upsert preencheria com nulo o campo que falta
async function gravar(sb: any, tabela: string, linhas: Record<string, unknown>[], chave: string) {
  const grupos = new Map<string, Record<string, unknown>[]>();
  for (const l of linhas) { const k = Object.keys(l).sort().join(','); grupos.set(k, [...(grupos.get(k) || []), l]); }
  for (const g of grupos.values()) { const { error } = await sb.from(tabela).upsert(g, { onConflict: chave }); if (error) throw error; }
}

// habits.auto: "passos>=8000" | "atividade>=30" | "atividade.corrida>=20" | "sono>=7" | "intensos>=20". Nunca desmarca.
async function marcarHabitos(sb: any, dias: string[]) {
  const { data: habitos } = await sb.from('habits').select('*').eq('ativo', true).not('auto', 'is', null);
  if (!habitos?.length || !dias.length) return 0;
  const ini = dias[0], fim = dias.at(-1)!;
  const { data: daily } = await sb.from('health_daily').select('*').gte('dia', ini).lte('dia', fim);
  const { data: acts } = await sb.from('health_activities').select('dia,tipo,duracao_seg').gte('dia', ini).lte('dia', fim);
  const por = Object.fromEntries((daily || []).map((r: any) => [r.dia, r]));
  const valor = (regra: string, d: string) => {
    const r = por[d] || {};
    if (regra === 'passos') return r.passos;
    if (regra === 'sono') return r.sono_seg ? r.sono_seg / 3600 : null;
    if (regra === 'intensos') return r.min_moderados == null && r.min_intensos == null ? null : (r.min_moderados || 0) + 2 * (r.min_intensos || 0);
    if (regra.startsWith('atividade')) {
      const tipos = TIPOS[regra.split('.')[1]];
      return (acts || []).filter((a: any) => a.dia === d && (!tipos || tipos.includes(a.tipo))).reduce((s: number, a: any) => s + (a.duracao_seg || 0), 0) / 60;
    }
    return null;
  };
  const novos = [];
  for (const h of habitos) {
    const [regra, alvoTxt] = String(h.auto).replace(/\s/g, '').split('>=');
    const alvo = parseFloat(alvoTxt); if (!(alvo > 0)) continue;
    const ds = (h.dias?.length ? h.dias : [0, 1, 2, 3, 4, 5, 6]).map(Number);
    for (const d of dias) {
      if (h.created_at && d < h.created_at.slice(0, 10)) continue;
      if (!ds.includes(new Date(d + 'T12:00:00Z').getUTCDay())) continue;
      const v = valor(regra, d);
      if (v != null && v >= alvo) novos.push({ habit_id: h.id, dia: d });
    }
  }
  if (novos.length) await sb.from('habit_logs').upsert(novos, { onConflict: 'habit_id,dia', ignoreDuplicates: true });
  return novos.length;
}

const hoje = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// Quem pode chamar: o agendamento (x-hub-cron) ou você logado no Hub
async function autorizado(req: Request, sb: any) {
  const cron = req.headers.get('x-hub-cron');
  if (cron) {
    const { data } = await sb.from('app_secrets').select('value').eq('key', 'cron_token').single();
    return !!data && data.value === cron;
  }
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt || jwt.startsWith('sb_')) return false;
  const { data } = await sb.auth.getUser(jwt);
  return !!data?.user;
}
