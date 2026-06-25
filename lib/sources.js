// Fontes de dados públicos de educação — APIs oficiais, públicas e sem
// autenticação, com as quais o agente realmente estabelece conexão e puxa
// os dados:
//
//   1. IBGE (servicodados.ibge.gov.br) — códigos oficiais de municípios/
//      estados e demografia.
//   2. dados.gov.br (CKAN) — catálogo oficial de dados abertos do governo
//      federal, que hospeda as bases do INEP (Censo Escolar, IDEB), do FNDE
//      e das redes estaduais/municipais, incluindo os arquivos para download.
//
// A ferramenta `ler_recurso` baixa e mostra o conteúdo de um recurso de dados
// oficial (CSV/JSON), restrito a domínios *.gov.br — assim o agente lê o dado
// público de verdade, em vez de depender de busca web.

const UA = 'AgenteEducacaoPublica/1.0 (+dados abertos)';

/** fetch com timeout e tratamento de erro padronizado (JSON). */
async function fetchJSON(url, { timeoutMs = 12000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'User-Agent': UA, ...headers },
    });
    if (!resp.ok) return { _error: `HTTP ${resp.status} ao consultar ${url}` };
    return await resp.json();
  } catch (err) {
    return { _error: `Falha de rede ao consultar ${url}: ${err.message}` };
  } finally {
    clearTimeout(t);
  }
}

/** Remove acentos e normaliza para comparação. */
function normalizar(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

/** Verifica se um host é de um domínio oficial do governo brasileiro. */
function ehDominioOficial(hostname) {
  return /(^|\.)gov\.br$/i.test(hostname);
}

// Cache em escopo de módulo (persiste entre invocações no mesmo container).
let _municipiosCache = null;
let _estadosCache = null;

async function carregarEstados() {
  if (_estadosCache) return _estadosCache;
  const data = await fetchJSON(
    'https://servicodados.ibge.gov.br/api/v1/localidades/estados?orderBy=nome'
  );
  if (data._error || !Array.isArray(data)) return data;
  _estadosCache = data;
  return data;
}

async function carregarMunicipios() {
  if (_municipiosCache) return _municipiosCache;
  const data = await fetchJSON(
    'https://servicodados.ibge.gov.br/api/v1/localidades/municipios',
    { timeoutMs: 20000 }
  );
  if (data._error || !Array.isArray(data)) return data;
  _municipiosCache = data;
  return data;
}

// --------------------------------------------------------------------------
// Ferramenta 1: resolver_localidade (IBGE)
// --------------------------------------------------------------------------
async function resolverLocalidade({ termo, uf }) {
  const alvo = normalizar(termo);
  if (!alvo) return { erro: 'Informe o nome do município ou estado em "termo".' };

  const estados = await carregarEstados();
  if (Array.isArray(estados)) {
    const estado = estados.find(
      (e) => normalizar(e.nome) === alvo || normalizar(e.sigla) === alvo
    );
    if (estado) {
      return {
        tipo: 'estado',
        resultados: [
          { id: estado.id, nome: estado.nome, sigla: estado.sigla, regiao: estado.regiao?.nome },
        ],
      };
    }
  }

  let lista;
  if (uf) {
    const sigla = normalizar(uf).toUpperCase();
    const r = await fetchJSON(
      `https://servicodados.ibge.gov.br/api/v1/localidades/estados/${encodeURIComponent(sigla)}/municipios`
    );
    lista = Array.isArray(r) ? r : null;
  }
  if (!lista) {
    const todos = await carregarMunicipios();
    if (!Array.isArray(todos)) return { erro: todos._error || 'IBGE indisponível.' };
    lista = todos;
  }

  const correspondencias = lista.filter((m) => {
    const nome = normalizar(m.nome);
    return nome === alvo || nome.includes(alvo);
  });

  if (correspondencias.length === 0) {
    return {
      tipo: 'municipio',
      resultados: [],
      nota: `Nenhum município encontrado para "${termo}". Verifique a grafia ou informe a UF.`,
    };
  }

  correspondencias.sort((a, b) => {
    const ea = normalizar(a.nome) === alvo ? 0 : 1;
    const eb = normalizar(b.nome) === alvo ? 0 : 1;
    return ea - eb;
  });

  return {
    tipo: 'municipio',
    total: correspondencias.length,
    resultados: correspondencias.slice(0, 15).map((m) => {
      const ufObj = m.microrregiao?.mesorregiao?.UF || {};
      return {
        id: m.id,
        nome: m.nome,
        uf: ufObj.sigla,
        estado: ufObj.nome,
        regiao: ufObj.regiao?.nome,
      };
    }),
  };
}

// --------------------------------------------------------------------------
// Ferramenta 2: dados_demograficos (IBGE)
// --------------------------------------------------------------------------
async function dadosDemograficos({ codigo_municipio }) {
  const id = String(codigo_municipio || '').replace(/\D/g, '');
  if (!id) return { erro: 'Informe o código IBGE do município em "codigo_municipio".' };

  // Tabela 6579 = População residente estimada; variável 9324.
  const popResp = await fetchJSON(
    `https://servicodados.ibge.gov.br/api/v3/agregados/6579/periodos/-6/variaveis/9324?localidades=N6[${id}]`
  );

  let populacao = null;
  if (Array.isArray(popResp) && popResp[0]?.resultados?.[0]?.series?.[0]?.serie) {
    const serie = popResp[0].resultados[0].series[0].serie;
    const anos = Object.keys(serie).sort();
    const ultimoAno = anos[anos.length - 1];
    if (ultimoAno) populacao = { ano: ultimoAno, valor: Number(serie[ultimoAno]) || serie[ultimoAno] };
  }

  return {
    codigo_municipio: id,
    populacao_estimada: populacao,
    fonte: 'IBGE — Estimativas de população (tabela SIDRA 6579)',
    nota: populacao ? undefined : 'Não foi possível obter a estimativa populacional neste momento.',
  };
}

// --------------------------------------------------------------------------
// Ferramenta 3: buscar_dados_abertos (dados.gov.br / CKAN)
// --------------------------------------------------------------------------
async function buscarDadosAbertos({ termo }) {
  const q = String(termo || '').trim();
  if (!q) return { erro: 'Informe um termo de busca em "termo".' };

  const consulta = encodeURIComponent(`${q} educação`);
  const data = await fetchJSON(
    `https://dados.gov.br/api/3/action/package_search?q=${consulta}&rows=8`,
    { timeoutMs: 15000 }
  );

  if (data._error || !data.success) {
    return {
      erro: 'O catálogo dados.gov.br não respondeu. Tente novamente em instantes.',
      detalhe: data._error,
    };
  }

  const resultados = (data.result?.results || []).map((d) => ({
    titulo: d.title,
    organizacao: d.organization?.title,
    url_conjunto: `https://dados.gov.br/dados/conjuntos-dados/${d.name}`,
    recursos: (d.resources || [])
      .filter((r) => r.url)
      .slice(0, 6)
      .map((r) => ({ nome: r.name || r.format, formato: r.format, url: r.url })),
  }));

  return {
    total: data.result?.count ?? resultados.length,
    resultados,
    dica: 'Use a ferramenta ler_recurso com a "url" de um recurso (CSV/JSON) para ler o dado oficial.',
  };
}

// --------------------------------------------------------------------------
// Ferramenta 4: ler_recurso (baixa e mostra um dado oficial *.gov.br)
// --------------------------------------------------------------------------
async function lerRecurso({ url, max_linhas }) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    return { erro: 'URL inválida.' };
  }
  if (parsed.protocol !== 'https:' || !ehDominioOficial(parsed.hostname)) {
    return {
      erro: 'Por segurança, só leio recursos de domínios oficiais do governo (*.gov.br) via HTTPS.',
      host: parsed.hostname,
    };
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const resp = await fetch(parsed.toString(), {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA },
    });
    if (!resp.ok) return { erro: `HTTP ${resp.status} ao baixar o recurso.`, url: parsed.toString() };

    const tipo = resp.headers.get('content-type') || '';
    const bruto = await resp.text();
    const limiteChars = 12000;
    const truncadoTamanho = bruto.length > limiteChars;
    let conteudo = bruto.slice(0, limiteChars);

    // Para CSV/texto, limita por número de linhas (cabeçalho + amostra).
    const limiteLinhas = Math.min(Number(max_linhas) || 40, 100);
    if (/csv|text|plain/i.test(tipo) || /\.csv($|\?)/i.test(parsed.pathname)) {
      const linhas = conteudo.split(/\r?\n/);
      conteudo = linhas.slice(0, limiteLinhas).join('\n');
      return {
        url: parsed.toString(),
        content_type: tipo || 'text/csv',
        formato: 'csv/texto',
        linhas_mostradas: Math.min(linhas.length, limiteLinhas),
        truncado: truncadoTamanho || linhas.length > limiteLinhas,
        conteudo,
        nota: 'Amostra do início do arquivo oficial. Cite a fonte e o ano ao usar os números.',
      };
    }

    // JSON: tenta resumir.
    if (/json/i.test(tipo) || /\.json($|\?)/i.test(parsed.pathname)) {
      try {
        const obj = JSON.parse(bruto);
        const amostra = Array.isArray(obj) ? obj.slice(0, 20) : obj;
        return {
          url: parsed.toString(),
          content_type: tipo || 'application/json',
          formato: 'json',
          total_registros: Array.isArray(obj) ? obj.length : undefined,
          amostra,
        };
      } catch {
        // cai no retorno de texto bruto abaixo
      }
    }

    return {
      url: parsed.toString(),
      content_type: tipo,
      formato: 'texto',
      truncado: truncadoTamanho,
      conteudo,
    };
  } catch (err) {
    return { erro: `Falha ao baixar o recurso: ${err.message}`, url: parsed.toString() };
  } finally {
    clearTimeout(t);
  }
}

// --------------------------------------------------------------------------
// Definições das ferramentas (schema) e despachante.
// --------------------------------------------------------------------------
export const customTools = [
  {
    name: 'resolver_localidade',
    description:
      'Resolve o nome de um município ou estado para o código oficial do IBGE, com UF e região. ' +
      'Use SEMPRE antes de consultar dados que dependem de um código de município. ' +
      'Aceita nomes com ou sem acento. Para municípios homônimos, retorna várias opções — peça a UF se necessário.',
    input_schema: {
      type: 'object',
      properties: {
        termo: { type: 'string', description: 'Nome do município ou estado (ex.: "Fortaleza", "Ceará", "CE").' },
        uf: { type: 'string', description: 'Sigla da UF para desambiguar (ex.: "CE"). Opcional.' },
      },
      required: ['termo'],
    },
  },
  {
    name: 'dados_demograficos',
    description:
      'Retorna a estimativa de população do IBGE para um município, dado seu código IBGE. ' +
      'Útil como contexto para indicadores educacionais (ex.: matrículas por habitante).',
    input_schema: {
      type: 'object',
      properties: {
        codigo_municipio: { type: 'string', description: 'Código IBGE do município (obtido com resolver_localidade).' },
      },
      required: ['codigo_municipio'],
    },
  },
  {
    name: 'buscar_dados_abertos',
    description:
      'Busca conjuntos de dados oficiais de educação no portal dados.gov.br (CKAN) — inclui bases do INEP ' +
      '(Censo Escolar, IDEB), FNDE e redes estaduais/municipais. Retorna títulos, órgãos e URLs dos recursos ' +
      '(CSV/JSON) para leitura. Use antes de ler_recurso.',
    input_schema: {
      type: 'object',
      properties: {
        termo: { type: 'string', description: 'Termo de busca (ex.: "IDEB", "Censo Escolar matrículas", "FUNDEB").' },
      },
      required: ['termo'],
    },
  },
  {
    name: 'ler_recurso',
    description:
      'Baixa e mostra o conteúdo de um recurso de dados oficial (CSV/JSON) a partir de uma URL de domínio *.gov.br ' +
      '(tipicamente obtida em buscar_dados_abertos). Retorna uma amostra do arquivo para você extrair os números. ' +
      'É assim que você lê o dado público de verdade — sempre cite a fonte e o ano.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL do recurso de dados (deve ser HTTPS e de domínio *.gov.br).' },
        max_linhas: { type: 'integer', description: 'Máximo de linhas a mostrar para CSV/texto (padrão 40, máx. 100).' },
      },
      required: ['url'],
    },
  },
];

const despachante = {
  resolver_localidade: resolverLocalidade,
  dados_demograficos: dadosDemograficos,
  buscar_dados_abertos: buscarDadosAbertos,
  ler_recurso: lerRecurso,
};

export async function executarFerramenta(nome, input) {
  const fn = despachante[nome];
  if (!fn) return { erro: `Ferramenta desconhecida: ${nome}` };
  try {
    return await fn(input || {});
  } catch (err) {
    return { erro: `Erro ao executar ${nome}: ${err.message}` };
  }
}
