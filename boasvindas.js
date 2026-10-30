// Mensagem de boas-vindas (perto da chegada): localização, horários, cofre, Wi-Fi e regras da casa.
// Usada na aba WhatsApp (resposta pronta) e na reserva em Aluguéis (copiar para o chat do Airbnb).
// Os dados vêm da base das casas (app_config 'wa_base'); cofre_senha, lixo e pets ficam fora do que o robô lê.
import * as db from './db.js';

const CASA = { QS39: 'Casa Frida', QS40: 'Casa Azul', QS50: 'Casa Terracota' };

export async function lerBase() {
  if (db.mode !== 'supabase') return {};
  const { data, error } = await db.client().from('app_config').select('value').eq('key', 'wa_base').maybeSingle();
  if (error) throw error;
  try { return JSON.parse(data?.value || '{}') || {}; } catch { return {}; }
}

// { texto } ou { falta: 'campo (casa)' }. Sem datas, ficam [dd/mm/aaaa]; nome vazio ou "Hóspede Airbnb", sem nome.
export function textoBoasVindas({ base = {}, casa, nomeCasa, checkin, checkout, nome }) {
  const g = base.geral || {};
  nomeCasa ||= CASA[casa] || casa;
  const x = base.casas?.[casa] || {};
  const v = k => String(x[k] || '').trim();
  if (!g.checkin?.trim() || !g.checkout?.trim()) return { falta: !g.checkin?.trim() ? 'Horário de check-in' : 'Horário de check-out' };
  for (const [k, rot] of [['localizacao', 'Link da localização'], ['cofre_senha', 'Senha do cofre'], ['wifi_rede', 'Wi-Fi (rede)'], ['wifi_senha', 'Wi-Fi (senha)'], ['lixo', 'Onde fica o lixo']]) {
    if (!v(k)) return { falta: `${rot} (${nomeCasa})` };
  }
  const data = iso => iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '[dd/mm/aaaa]';
  const primeiro = /^h[óo]spede\b/i.test(String(nome || '').trim()) ? '' : String(nome || '').trim().split(/\s+/)[0];
  const cap = v('capacidade').match(/\d+/)?.[0];
  const pets = v('pets') || g.pets?.trim();
  return { texto: `Olá${primeiro ? `, ${primeiro}` : ''}! 😊 Que alegria receber você na ${nomeCasa}!

🏡 ${nomeCasa.toUpperCase()} ${casa}
Condomínio Pipa Natureza – Praia da Pipa, Tibau do Sul/RN
📍 Localização: ${v('localizacao')}
Na portaria, informe seu nome e a casa. Seu acesso já estará liberado.

📅 CHECK-IN
${data(checkin)}, a partir das ${g.checkin.trim()}
🔑 Ao chegarem, a chave estará no cofre da frente.
Senha do cofre: ${v('cofre_senha')}
Me avise o horário previsto de chegada, por favor.

📅 CHECK-OUT
${data(checkout)}, até as ${g.checkout.trim()}
Deixe a chave de volta no cofre e confira se portas e janelas ficaram fechadas.

📶 WI-FI
Rede: ${v('wifi_rede')}
Senha: ${v('wifi_senha')}

📋 REGRAS DA CASA
${[cap ? `• Até ${cap} hóspedes. Visitas só com aviso prévio, porque o condomínio exige autorização na portaria` : '• Visitas só com aviso prévio, porque o condomínio exige autorização na portaria',
  '• Silêncio a partir das 22h', '• Proibido fumar dentro da casa', '• Festas e eventos não são permitidos',
  pets ? `• ${pets}` : '', '• Ao sair, desligue o ar-condicionado e as luzes', `• Lixo: ${v('lixo')}`,
  '• Danos a móveis e utensílios serão cobrados'].filter(Boolean).join('\n')}

Qualquer dúvida, é só me chamar por aqui. Boa estadia! 🌴
Claudio` };
}
