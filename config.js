// Preencha com os dados do seu projeto Supabase (Settings > API).
// A chave "anon" pode ficar pública: o acesso é protegido pelo login + RLS.
// Com os campos vazios, o Hub roda em modo local (dados só neste navegador).
export const CONFIG = {
  SUPABASE_URL: 'https://ovcetvmvbeskgonjruvq.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_vjs88mf-ECZU66wrPC6HIg_VnQ00Hot',
  // Chave pública VAPID para notificações push (veja README, passo 5)
  VAPID_PUBLIC_KEY: 'BCM-9I7Znn5SUeZGwgxzZGb08zXG4anthvtwcoxEHDYu4cw10Mtm302-jy5UDc0b64f42baR4nxxUxJGJT7-AYI',
  // Orçamento/negociação sem movimento há N dias aparece como "esquecido"
  DIAS_ESQUECIDO: 5,
  TZ: 'America/Sao_Paulo',
};
