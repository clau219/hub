// web-push falso para as funções que mandam notificação (wa-vigia). Guarda os envios em globalThis.__webpush;
// o teste pode definir __webpush.falhar(endpoint) => statusCode para simular inscrição vencida (410) etc.
const estado = () => (globalThis.__webpush ||= { envios: [], vapid: null, falhar: null });
export default {
  setVapidDetails(sujeito, pub, priv) { estado().vapid = { sujeito, pub, priv }; },
  async sendNotification(sub, payload) {
    const e = estado();
    const code = e.falhar?.(sub.endpoint);
    if (code) throw Object.assign(new Error('push falhou'), { statusCode: code });
    e.envios.push({ endpoint: sub.endpoint, ...JSON.parse(payload) });
  },
  generateVAPIDKeys: () => ({ publicKey: 'pub-gerada', privateKey: 'priv-gerada' }),
};
