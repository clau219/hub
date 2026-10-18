// Moeda de exibição (R$ ou US$) de Finanças e Cripto, escolhida no botão R$/US$ e guardada neste navegador.
// Os dados ficam sempre em reais; a conversão usa a cotação do dólar de hoje (a mesma da tela Cripto),
// então valores antigos (gráficos de evolução) também são convertidos pela cotação de hoje.
const KEY = 'hub:moeda';
let salvo = 'BRL';
try { salvo = localStorage.getItem(KEY) === 'USD' ? 'USD' : 'BRL'; } catch {}
export const moeda = { cod: salvo, taxa: null }; // taxa = reais por dólar
export const emDolar = () => moeda.cod === 'USD' && moeda.taxa > 0;
export const cod = () => (emDolar() ? 'USD' : 'BRL');
export const conv = v => (v == null || isNaN(v) ? v : emDolar() ? v / moeda.taxa : v);
export const simbolo = () => (emDolar() ? 'US$' : 'R$');
export function definirTaxa(t) { if (t > 0) moeda.taxa = t; }
export function trocar(c) {
  moeda.cod = c === 'USD' ? 'USD' : 'BRL';
  try { localStorage.setItem(KEY, moeda.cod); } catch {}
}
// Sem cotação ainda (a tela Cripto nunca abriu): busca uma vez
let buscando = null;
export function garantirTaxa() {
  if (moeda.taxa) return Promise.resolve(moeda.taxa);
  buscando ||= fetch('https://economia.awesomeapi.com.br/json/last/USD-BRL').then(r => r.json())
    .then(j => { definirTaxa(+j.USDBRL?.bid); return moeda.taxa; })
    .catch(() => null).finally(() => { buscando = null; });
  return buscando;
}
// Botão R$ / US$ (o clique é ligado por ligarBotao)
export const botao = () => `<div class="seg seg-sm moeda-seg" role="group" aria-label="Moeda">${[['BRL', 'R$'], ['USD', 'US$']].map(([k, l]) =>
  `<button data-moeda="${k}" class="${moeda.cod === k ? 'on' : ''}" aria-pressed="${moeda.cod === k}">${l}</button>`).join('')}</div>`;
export function ligarBotao(el, depois) {
  el.querySelectorAll('[data-moeda]').forEach(b => b.onclick = async () => {
    trocar(b.dataset.moeda);
    if (moeda.cod === 'USD' && !(await garantirTaxa())) { trocar('BRL'); alert('Não foi possível obter a cotação do dólar agora. Tente de novo em instantes.'); }
    depois();
  });
}
export const notaCotacao = () => (emDolar() ? `US$ pela cotação de hoje (US$ 1 = ${moeda.taxa.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })})` : '');
