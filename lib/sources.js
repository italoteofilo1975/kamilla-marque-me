// Fontes de dados públicos de educação (redes municipais e estaduais).
//
// Estas são as ferramentas customizadas do agente. Elas consultam APIs
// públicas abertas. As ferramentas de busca/leitura web (web_search /
// web_fetch) são fornecidas pela própria API da Anthropic e declaradas no
// handler — juntas dão cobertura nacional ampla (INEP/IDEB, Censo Escolar,
// FNDE, QEdu, etc.) a partir das fontes oficiais.

const UA = 'AgenteEducacaoPublica/1.0 (+dados abertos)';

/** fetch com timeout e tratamento de erro padronizado. */
async function fetchJSON(url, { timeoutMs = 12000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'User-Agent': UA, ...headers },
    });
    if (!resp.ok) {
      return { _error: `HTTP ${resp.status} ao consultar ${url}` };
    }
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
// Ferramenta 1: resolver_localidade
// --------------------------------------------------------------------------
async function resolverLocalidade({ termo, uf }) {
  const alvo = normalizar(termo);
  if (!alvo) return { erro: 'Informe o nome do município ou estado em "termo".' };

  // Estados
  const estados = await carregarEstados();
  if (Array.isArray(estados)) {
    const estado = estados.find(
      (e) => normalizar(e.nome) === alvo || normalizar(e.sigla) === alvo
    );
    if (estado) {
      return {
        tipo: 'estado',
        resultados: [
          {
            id: estado.id,
            nome: estado.nome,
            sigla: estado.sigla,
            regiao: estado.regiao?.nome,
          },
        ],
      };
    }
  }

  // Municípios — filtra por UF quando informada, para ser rápido e preciso.
  let lista;
  if (uf) {
    const sigla = normalizar(uf).toUpperCase();
    const r = await fetchJSON(
      `https://servicodados.ibge.gov.br/api/v1/localidades/estados/${encodeURIComponent(
        sigla
      )}/municipios`
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

  // Exatas primeiro; limita a 15 para não estourar contexto.
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
// Ferramenta 2: dados_demograficos (contexto socioeconômico via IBGE)
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
    if (ultimoAno) {
      populacao = { ano: ultimoAno, valor: Number(serie[ultimoAno]) || serie[ultimoAno] };
    }
  }

  return {
    codigo_municipio: id,
    populacao_estimada: populacao,
    fonte: 'IBGE — Estimativas de população (tabela SIDRA 6579)',
    nota: populacao
      ? undefined
      : 'Não foi possível obter a estimativa populacional neste momento.',
  };
}

// --------------------------------------------------------------------------
// Ferramenta 3: buscar_dados_abertos (catálogo dados.gov.br - CKAN)
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
      erro: 'O catálogo dados.gov.br não respondeu. Tente novamente ou use a busca web.',
      detalhe: data._error,
    };
  }

  const resultados = (data.result?.results || []).map((d) => ({
    titulo: d.title,
    organizacao: d.organization?.title,
    url: `https://dados.gov.br/dados/conjuntos-dados/${d.name}`,
    recursos: (d.resources || []).slice(0, 5).map((r) => ({
      nome: r.name || r.format,
      formato: r.format,
      url: r.url,
    })),
  }));

  return { total: data.result?.count ?? resultados.length, resultados };
}

// --------------------------------------------------------------------------
// Ferramenta 4: indicadores_educacionais (IDEB / Censo via QEdu, se configurado)
// --------------------------------------------------------------------------
async function indicadoresEducacionais({ tipo, codigo_municipio, uf }) {
  const token = process.env.QEDU_API_TOKEN;

  const linksOficiais = {
    ideb: 'https://www.gov.br/inep/pt-br/areas-de-atuacao/pesquisas-estatisticas-e-indicadores/ideb',
    censo:
      'https://www.gov.br/inep/pt-br/areas-de-atuacao/pesquisas-estatisticas-e-indicadores/censo-escolar',
    matriculas:
      'https://www.gov.br/inep/pt-br/acesso-a-informacao/dados-abertos/microdados/censo-escolar',
    qedu: 'https://qedu.org.br',
  };

  if (!token) {
    return {
      configurado: false,
      nota:
        'A consulta direta de indicadores (IDEB/Censo via API QEdu) requer a variável de ambiente QEDU_API_TOKEN, que não está configurada. ' +
        'Use as ferramentas de busca/leitura web para obter os números diretamente das fontes oficiais abaixo, ou configure o token.',
      fontes_oficiais: linksOficiais,
      tipo_solicitado: tipo,
    };
  }

  // Com token: consulta a API do QEdu (camada amigável sobre dados do INEP).
  const id = String(codigo_municipio || '').replace(/\D/g, '');
  const base = 'https://api.qedu.org.br/v1';
  let endpoint;
  if (id) endpoint = `${base}/ideb/cidade/${id}`;
  else if (uf) endpoint = `${base}/ideb/estado/${normalizar(uf).toUpperCase()}`;
  else return { erro: 'Informe codigo_municipio ou uf para consultar indicadores.' };

  const data = await fetchJSON(endpoint, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (data._error) {
    return {
      erro: 'Falha ao consultar a API QEdu.',
      detalhe: data._error,
      fontes_oficiais: linksOficiais,
    };
  }
  return { configurado: true, fonte: 'QEdu (dados INEP)', dados: data };
}

// --------------------------------------------------------------------------
// Definições das ferramentas (schema para a API) e despachante.
// --------------------------------------------------------------------------
export const customTools = [
  {
    name: 'resolver_localidade',
    description:
      'Resolve o nome de um município ou estado para o código oficial do IBGE, com a UF e a região. ' +
      'Use SEMPRE antes de consultar dados que dependem de um código de município. ' +
      'Aceita nomes com ou sem acento. Quando houver municípios homônimos, retorna várias opções — peça a UF ao usuário se necessário.',
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
      'Retorna dados demográficos de contexto (estimativa de população do IBGE) para um município, dado seu código IBGE. ' +
      'Útil para contextualizar indicadores educacionais (ex.: matrículas por habitante).',
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
      'Busca conjuntos de dados abertos relacionados a educação no portal oficial dados.gov.br (CKAN). ' +
      'Retorna títulos, órgãos responsáveis e links para download. Use para descobrir bases de dados de redes municipais/estaduais.',
    input_schema: {
      type: 'object',
      properties: {
        termo: { type: 'string', description: 'Termo de busca (ex.: "matrículas", "merenda escolar", "FUNDEB").' },
      },
      required: ['termo'],
    },
  },
  {
    name: 'indicadores_educacionais',
    description:
      'Consulta indicadores educacionais (IDEB, Censo Escolar, matrículas) via API QEdu/INEP, quando o token estiver configurado. ' +
      'Sem token configurado, retorna os links das fontes oficiais para que você os obtenha via busca web. ' +
      'Sempre cite a fonte e o ano de referência dos números.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: ['ideb', 'censo', 'matriculas'], description: 'Tipo de indicador.' },
        codigo_municipio: { type: 'string', description: 'Código IBGE do município. Opcional se informar uf.' },
        uf: { type: 'string', description: 'Sigla da UF (ex.: "SP"). Opcional se informar codigo_municipio.' },
      },
      required: ['tipo'],
    },
  },
];

const despachante = {
  resolver_localidade: resolverLocalidade,
  dados_demograficos: dadosDemograficos,
  buscar_dados_abertos: buscarDadosAbertos,
  indicadores_educacionais: indicadoresEducacionais,
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
