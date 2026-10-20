// SDK da Anthropic falso para o wa-webhook. O teste define globalThis.__anthropic.responder(params) => objeto
// extraído (o que o Claude Haiku devolveria no structured output) e confere globalThis.__anthropic.chamadas.
const estado = () => (globalThis.__anthropic ||= { chamadas: [], responder: () => { throw new Error('IA não simulada neste teste'); } });

export default class Anthropic {
  constructor(opcoes = {}) {
    this.opcoes = opcoes;
    estado().opcoes = opcoes;
    const parse = async params => {
      const e = estado();
      e.chamadas.push(params);
      const r = await e.responder(params);
      return { parsed_output: r, content: [{ type: 'text', text: JSON.stringify(r) }], stop_reason: 'end_turn' };
    };
    this.messages = { parse, create: parse };
    this.beta = { messages: { parse, create: parse } };
  }
}
export const zodOutputFormat = (schema, nome) => ({ type: 'json_schema', schema, nome });
