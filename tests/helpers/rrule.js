// O ical-sync importa { RRule } de https://esm.sh/rrule@2.8.1; no Node o pacote é CommonJS, então expõe aqui.
import pkg from 'rrule';
export const { RRule, RRuleSet, rrulestr } = pkg;
export default pkg;
