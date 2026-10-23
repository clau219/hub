import { S, save, del, load, TABLES } from './store.js';
import * as db from './db.js';
import { h, fmtDate, localDate } from './util.js';
import { modal, toast, confirmInline } from './ui.js';
import { CONFIG } from './config.js';
import { enablePush, pushStatus, testPush } from './push.js';

export async function render(el) {
  // Se o service worker não responder, a tela não pode ficar em branco esperando
  const push = await Promise.race([pushStatus().catch(e => e.message), new Promise(r => setTimeout(() => r('Não foi possível verificar agora.'), 3000))]);
  let feed = 'SEU_FEED_TOKEN', gst = null, ist = null;
  if (db.mode === 'supabase') {
    const { data } = await db.client().from('app_config').select('key,value').in('key', ['feed_token', 'gcal_status', 'ical_status']);
    for (const c of data || []) {
      if (c.key === 'feed_token') feed = c.value;
      else try { if (c.key === 'gcal_status') gst = JSON.parse(c.value); else ist = JSON.parse(c.value); } catch { }
    }
  }
  const fn = CONFIG.SUPABASE_URL ? CONFIG.SUPABASE_URL.replace(/\/$/, '') + '/functions/v1' : null;
  el.innerHTML = `
  <div class="view-head"><h1>Ajustes</h1></div>

  <section class="block">
    <h2>Conexão</h2>
    <p>${db.mode === 'supabase' ? `Sincronizado com o Supabase. <button class="link-btn" id="logout">Sair</button>` : 'Modo local: os dados ficam só neste navegador. Preencha <code>js/config.js</code> para sincronizar entre aparelhos.'}</p>
  </section>

  <section class="block">
    <h2>Calendários externos</h2>
    <p class="muted">Cole aqui os links iCal. Eles são lidos a cada hora pelo servidor: o calendário de DJ do Google entra na agenda DJ, e cada link do Airbnb vira reservas da casa correspondente.</p>
    <table class="table"><thead><tr><th>Nome</th><th>Calendário</th><th>Tipo</th><th>Casa</th><th>Última leitura</th><th></th></tr></thead><tbody>
      ${S.calendar_sources.map(s => `<tr><td>${h(s.nome || '')}</td><td>${s.calendario === 'dj' ? 'DJ' : s.calendario === 'alugueis' ? 'Aluguéis' : 'Pessoal'}</td><td>${h(s.tipo)}</td><td>${h(s.property_id || '')}</td>
        <td>${s.ultimo_sync ? fmtDate(localDate(s.ultimo_sync)) : 'ainda não'}</td><td><button class="mini" data-del="${s.id}">Remover</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">Nenhum link cadastrado.</td></tr>'}
    </tbody></table>
    ${ist?.erros?.length ? `<p class="small late-lbl"><b>Problema na última leitura (${fmtDate(localDate(ist.em))}):</b> ${ist.erros.map(h).join(' · ')}</p>` : ''}
    <div class="row-btns"><button class="btn" id="srcNew">Adicionar link iCal</button>${fn && db.mode === 'supabase' ? '<button class="btn" id="syncNow">Ler agora</button>' : ''}</div>
  </section>

  <section class="block">
    <h2>Bloquear o Airbnb com as reservas diretas</h2>
    <p class="muted">Cada casa tem um endereço com as reservas que não vieram do Airbnb (diretas, Booking, bloqueios feitos no Hub). Importe no anúncio: Airbnb › Calendário › Disponibilidade › Conectar calendários › Importar calendário. Assim o Airbnb fecha essas datas sozinho e não aceita reserva dupla. Ele relê de algumas em algumas horas: num fechamento de última hora, bloqueie também à mão.</p>
    ${fn ? S.properties.map(p => `<p><b>${h(p.nome)}</b><br><code class="sel">${fn}/ical-feed?cal=diretas&casa=${encodeURIComponent(p.id)}&token=${feed}</code></p>`).join('') : '<p class="muted">Disponível depois de conectar o Supabase.</p>'}
  </section>

  <section class="block">
    <h2>Gigs no Google Agenda</h2>
    <p class="muted">Gigs fechadas, realizadas e pagas do Pipeline e os eventos que você cria na agenda DJ são gravados direto no calendário de DJ do Google, segundos depois de salvar. Mudar a data, apagar ou perder a gig no Hub muda lá também. Alterar um evento que veio do Google também altera o original.</p>
    <p class="small">${!gst ? 'Ainda não rodou.' : gst.erro ? `<b>Não está funcionando:</b> ${h(gst.erro)}` : `Última sincronização ${fmtDate(localDate(gst.em))}: ${gst.total} no Google (${gst.criados} criados, ${gst.alterados} alterados, ${gst.apagados} apagados).`}</p>
    ${db.mode === 'supabase' ? '<div class="row-btns"><button class="btn" id="gcalNow">Sincronizar agora</button></div>' : ''}
  </section>

  <section class="block">
    <h2>Levar o Hub para o Google Agenda</h2>
    <p class="muted">Assine estes endereços no Google Agenda (Outras agendas, “Do URL”). O Google atualiza assinaturas a cada algumas horas. Não assine o de Gigs se já usa a gravação direta acima: as gigs apareceriam duas vezes.</p>
    ${fn ? `<p><b>Aluguéis</b><br><code class="sel">${fn}/ical-feed?cal=alugueis&token=${feed}</code></p>
            <p><b>Gigs DJ</b><br><code class="sel">${fn}/ical-feed?cal=dj&token=${feed}</code></p>`
      : '<p class="muted">Disponível depois de conectar o Supabase.</p>'}
  </section>

  <section class="block" id="waBlock">
    <h2>WhatsApp das casas</h2>
    <p class="muted">Cada mensagem recebida vira uma oportunidade em Aluguéis. Perguntas de disponibilidade e valor são respondidas sozinhas com os preços do Airbnb; o resto fica para você. O robô nunca confirma reserva e fica quieto quando você responde pelo celular.</p>
    <div id="waCfg"><p class="muted small">${db.mode === 'supabase' ? 'Carregando…' : 'Disponível depois de conectar o Supabase.'}</p></div>
    ${fn ? `<p class="small"><b>URL do webhook</b> (para o painel da Meta)<br><code class="sel">${fn}/wa-webhook</code></p>` : ''}
  </section>

  <section class="block">
    <h2>Notificações</h2>
    <p>${push}</p>
    <div class="row-btns"><button class="btn" id="pushOn">Ativar notificações neste aparelho</button><button class="btn" id="pushTest">Enviar teste</button></div>
    <p class="muted small">Resumo às 7h30 e fechamento às 18h, com o que está atrasado, gigs e check-ins.</p>
  </section>

  <section class="block">
    <h2>Backup</h2>
    <div class="row-btns">
      <button class="btn" id="exp">Baixar backup (.json)</button>
      <label class="btn">Importar .json<input type="file" id="imp" accept=".json" hidden></label>
    </div>
    <p class="muted small">Use a importação para carregar o arquivo <code>seed.json</code> com seus orçamentos antigos.</p>
  </section>`;

  el.querySelector('#logout')?.addEventListener('click', async () => { await db.auth.signOut(); try { localStorage.removeItem('hub:snap'); } catch {} location.reload(); });
  el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { if (!confirmInline(b)) return; await del('calendar_sources', b.dataset.del); toast('Link removido'); });
  el.querySelector('#srcNew').onclick = () => modal('Adicionar link iCal', `
    <label>Nome<input name="nome" placeholder="ex.: Google DJ, Airbnb Casa Azul" required autofocus></label>
    <div class="grid2">
      <label>Tipo<select name="tipo"><option value="google">Google Agenda</option><option value="airbnb">Airbnb</option><option value="outro">Outro (Booking etc.)</option></select></label>
      <label>Vai para<select name="calendario"><option value="dj">Agenda DJ</option><option value="alugueis">Aluguéis</option><option value="pessoal">Pessoal</option></select></label>
      <label class="span2">Casa (para Airbnb/Booking)<select name="property_id"><option value="">—</option>${S.properties.map(p => `<option value="${p.id}">${h(p.nome)}</option>`).join('')}</select></label>
    </div>
    <label>Link iCal<input name="url" type="url" required placeholder="https://..."></label>
    <p class="muted small">Google: Configurações da agenda, “Endereço secreto no formato iCal”. Airbnb: Calendário do anúncio, Disponibilidade, “Exportar calendário”.</p>`, {
    onSubmit: async f => {
      if (['airbnb', 'outro'].includes(f.tipo) && !f.property_id) throw new Error('Escolha a casa deste link.');
      if (f.tipo === 'airbnb') f.calendario = 'alugueis';
      await save('calendar_sources', f); toast('Link adicionado');
    },
  });
  el.querySelector('#syncNow')?.addEventListener('click', async ev => {
    ev.target.disabled = true; ev.target.textContent = 'Lendo…';
    try {
      const { data, error } = await db.client().functions.invoke('ical-sync');
      if (error) throw error;
      await load(); toast(`Leitura concluída: ${data?.eventos ?? 0} eventos, ${data?.reservas ?? 0} reservas`);
    } catch (e) { toast('Falha na leitura: ' + e.message); ev.target.disabled = false; ev.target.textContent = 'Ler agora'; }
  });
  el.querySelector('#gcalNow')?.addEventListener('click', async ev => {
    ev.target.disabled = true; ev.target.textContent = 'Sincronizando…';
    const { data, error } = await db.client().functions.invoke('gcal-sync', { body: {} });
    toast(data?.erro || error ? 'Falha: ' + (data?.erro || error.message) : `Google Agenda em dia: ${data.criados} criados, ${data.alterados} alterados, ${data.apagados} apagados`, 6000);
    render(el);
  });
  if (db.mode === 'supabase') waConfig(el.querySelector('#waCfg'));
  el.querySelector('#pushOn').onclick = async () => { try { await enablePush(); toast('Notificações ativadas'); render(el); } catch (e) { toast(e.message); } };
  el.querySelector('#pushTest').onclick = async () => { try { const r = await testPush(); toast(r?.enviados ? 'Teste enviado' : 'Nenhum aparelho com notificação ativa'); } catch (e) { toast('Falha: ' + e.message); } };
  el.querySelector('#exp').onclick = () => {
    const blob = new Blob([JSON.stringify(Object.fromEntries(TABLES.map(t => [t, S[t]])), null, 1)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `hub-backup-${new Date().toISOString().slice(0, 10)}.json` });
    a.click(); URL.revokeObjectURL(a.href);
  };
  el.querySelector('#imp').onchange = async ev => {
    const f = ev.target.files[0]; if (!f) return;
    try { await db.bulkImport(JSON.parse(await f.text())); await load(); toast('Importação concluída'); }
    catch (e) { toast('Falha ao importar: ' + e.message); }
  };
}

// Liga/desliga do robô e limites (tabela wa_settings)
async function waConfig(el) {
  const sb = db.client();
  const [{ data: c, error }, { data: ult }] = await Promise.all([
    sb.from('wa_settings').select('*').eq('id', 1).maybeSingle(),
    sb.from('wa_messages').select('enviado_em').eq('autor', 'cliente').order('enviado_em', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (error || !c) { el.innerHTML = '<p class="muted small">Tabelas do WhatsApp ainda não criadas (supabase/2026-10-15_whatsapp.sql).</p>'; return; }
  el.innerHTML = `
    <label class="wa-switch"><input type="checkbox" name="bot_ativo" ${c.bot_ativo ? 'checked' : ''}> <b>Resposta automática ligada</b></label>
    <div class="grid2 wa-lims">
      <label>Silêncio depois que você responde (horas)<input type="number" name="horas_silencio" min="0" max="168" value="${c.horas_silencio}"></label>
      <label>Máximo de respostas automáticas por conversa em 24 h<input type="number" name="max_respostas_dia" min="1" max="20" value="${c.max_respostas_dia}"></label>
    </div>
    <p class="muted small">${ult ? `Última mensagem recebida: ${fmtDate(localDate(ult.enviado_em))}.` : 'Nenhuma mensagem recebida ainda.'}</p>
    ${'dono_wa' in c ? `<div class="wa-dono">
      <h3>Canal do dono</h3>
      <p class="muted small">Mande mensagem do seu WhatsApp pessoal para o número das casas e o Hub registra: “+dj Anabela 15/11 3500”, “recebi 1750 da Anabela”, “gastei 120 de faxina na Frida”, “me lembra de ligar pro contador amanhã”, “o que tenho hoje?”. Cada registro volta com um recibo; “desfaz” ou “o valor é 3800” corrigem.</p>
      <label>Seu número pessoal<input type="tel" name="dono_wa" inputmode="tel" placeholder="(84) 99999-0000" value="${h(foneBonito(c.dono_wa))}"></label>
      <label class="wa-switch"><input type="checkbox" name="dono_resumo" ${c.dono_resumo !== false ? 'checked' : ''}> <b>Resumo do dia no WhatsApp (7h30 e 18h)</b></label>
      <div class="row-btns"><button class="btn" type="button" id="donoResumo" ${c.dono_wa ? '' : 'disabled'}>Mandar resumo agora</button></div>
    </div>` : '<p class="muted small">Canal do dono: rode supabase/2026-10-23_dono.sql para ligar.</p>'}`;
  el.querySelectorAll('input').forEach(i => i.onchange = async () => {
    let v;
    if (i.name === 'dono_wa') {
      // Só dígitos, com o 55 do Brasil; vazio desliga o canal
      const d = i.value.replace(/\D/g, '');
      v = !d ? null : d.length === 10 || d.length === 11 ? '55' + d : d;
      if (v && !/^\d{12,13}$/.test(v)) return toast('Número incompleto: use DDD + número');
      i.value = foneBonito(v);
      el.querySelector('#donoResumo').disabled = !v;
    } else v = i.type === 'checkbox' ? i.checked : Math.max(+i.min, Math.min(+i.max, Math.round(+i.value || 0)));
    const { error: er } = await sb.from('wa_settings').update({ [i.name]: v, updated_at: new Date().toISOString() }).eq('id', 1);
    toast(er ? 'Não foi possível salvar' : i.name === 'bot_ativo' ? (v ? 'Robô ligado' : 'Robô desligado')
      : i.name === 'dono_wa' ? (v ? 'Canal do dono ligado: mande "oi" do seu WhatsApp para o número das casas' : 'Canal do dono desligado') : 'Salvo', 6000);
  });
  el.querySelector('#donoResumo')?.addEventListener('click', async ev => {
    ev.target.disabled = true;
    const { data, error } = await sb.functions.invoke('wa-dono', { body: { resumo: 'manha' } });
    toast(error || !data?.enviado ? 'Não foi possível mandar: ' + (data?.motivo || error?.message || 'erro') : 'Resumo enviado no seu WhatsApp', 6000);
    ev.target.disabled = false;
  });
}

const foneBonito = n => { const m = String(n || '').match(/^55(\d{2})(\d{4,5})(\d{4})$/); return m ? `(${m[1]}) ${m[2]}-${m[3]}` : n || ''; };
