// Importa um módulo do Hub (pasta hub/) pelo caminho relativo. Sempre dinâmico: o teste prepara o ambiente antes.
export const RAIZ = new URL('../../', import.meta.url);
export const hub = caminho => import(new URL(caminho, RAIZ).href);
