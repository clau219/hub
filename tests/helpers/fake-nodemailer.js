// nodemailer falso para a portaria-enviar. Guarda os e-mails em globalThis.__email.enviados e a configuração do
// transporte em __email.transporte; o teste pode definir __email.falhar = mensagem para simular erro do Gmail.
const estado = () => (globalThis.__email ||= { enviados: [], transporte: null, falhar: null });
export default {
  createTransport(opcoes) {
    estado().transporte = opcoes;
    return {
      async sendMail(msg) {
        const e = estado();
        if (e.falhar) throw new Error(e.falhar);
        e.enviados.push(msg);
        return { messageId: `<teste-${e.enviados.length}@gmail.com>`, accepted: [].concat(msg.to) };
      },
    };
  },
};
