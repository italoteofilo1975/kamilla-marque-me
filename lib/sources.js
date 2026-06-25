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
// SIDRA / IBGE — indicadores educacionais por município (descoberta + consulta)
// --------------------------------------------------------------------------
let _catalogoCache = null;

async function carregarCatalogoAgregados() {
  if (_catalogoCache) return _catalogoCache;
  const cat = await fetchJSON('https://servicodados.ibge.gov.br/api/v3/agregados', {
    timeoutMs: 25000,
  });
  if (cat._error || !Array.isArray(cat)) return cat;
  const flat = [];
  for (const grupo of cat) {
    for (const a of grupo.agregados || []) {
      flat.push({ id: String(a.id), nome: a.nome, pesquisa: grupo.nome });
    }
  }
  _catalogoCache = flat;
  return flat;
}

// Ferramenta 5: buscar_agregados — descobre tabelas no catálogo oficial do IBGE.
async function buscarAgregados({ termo, pesquisa }) {
  const flat = await carregarCatalogoAgregados();
  if (!Array.isArray(flat)) return { erro: flat._error || 'Catálogo IBGE indisponível.' };

  const palavras = normalizar(termo).split(/\s+/).filter(Boolean);
  if (palavras.length === 0) return { erro: 'Informe um termo de busca em "termo".' };
  const filtroPesquisa = pesquisa ? normalizar(pesquisa) : null;

  const hits = flat.filter((a) => {
    const nomeN = normalizar(a.nome);
    const pesqN = normalizar(a.pesquisa);
    const casaTermo = palavras.every((p) => nomeN.includes(p) || pesqN.includes(p));
    const casaPesquisa = !filtroPesquisa || pesqN.includes(filtroPesquisa);
    return casaTermo && casaPesquisa;
  });

  return {
    total: hits.length,
    resultados: hits.slice(0, 20),
    dica:
      'Use metadados_agregado(agregado) para ver variáveis, períodos e níveis; depois consultar_sidra para os valores. ' +
      'Para indicadores educacionais municipais, prefira pesquisas como "Censo Demográfico" ou "PNAD Contínua".',
  };
}

// Ferramenta 6: metadados_agregado — variáveis/períodos/níveis de uma tabela.
async function metadadosAgregado({ agregado }) {
  const id = String(agregado || '').replace(/\D/g, '');
  if (!id) return { erro: 'Informe o id da tabela em "agregado".' };
  const m = await fetchJSON(
    `https://servicodados.ibge.gov.br/api/v3/agregados/${id}/metadados`
  );
  if (m._error || !m.id) return { erro: m._error || 'Tabela não encontrada no IBGE.' };

  return {
    id: m.id,
    nome: m.nome,
    pesquisa: m.pesquisa,
    assunto: m.assunto,
    url: m.URL,
    periodos: {
      inicio: m.periodicidade?.inicio,
      fim: m.periodicidade?.fim,
      frequencia: m.periodicidade?.frequencia,
    },
    niveis_territoriais: m.nivelTerritorial?.Administrativo || [],
    variaveis: (m.variaveis || []).map((v) => ({ id: v.id, nome: v.nome, unidade: v.unidade })),
    classificacoes: (m.classificacoes || []).map((c) => ({
      id: c.id,
      nome: c.nome,
      categorias: (c.categorias || []).slice(0, 10).map((cat) => ({ id: cat.id, nome: cat.nome })),
    })),
    nota: 'Para totais, normalmente use as categorias "Total" de cada classificação (ou omita classificacao em consultar_sidra).',
  };
}

// Ferramenta 7: consultar_sidra — valores de uma tabela por localidade/período.
async function consultarSidra({ agregado, variavel, nivel, localidade, periodo, classificacao }) {
  const ag = String(agregado || '').replace(/\D/g, '');
  const vr = String(variavel || '').replace(/\D/g, '');
  if (!ag) return { erro: 'Informe o id da tabela em "agregado" (use buscar_agregados/metadados_agregado).' };
  if (!vr) return { erro: 'Informe o id da variável em "variavel" (veja metadados_agregado).' };

  const niv = String(nivel || 'N6').toUpperCase();
  const per = String(periodo || '-1');
  const loc = String(localidade || '').replace(/[^\d,]/g, '');
  const locParam = loc ? `${niv}[${loc}]` : niv;

  let url =
    `https://servicodados.ibge.gov.br/api/v3/agregados/${ag}` +
    `/periodos/${encodeURIComponent(per)}/variaveis/${vr}?localidades=${locParam}`;
  if (classificacao) url += `&classificacao=${encodeURIComponent(String(classificacao))}`;

  const data = await fetchJSON(url, { timeoutMs: 20000 });
  if (data._error) return { erro: data._error };
  if (!Array.isArray(data) || data.length === 0) {
    return {
      erro: 'Sem dados para os parâmetros informados.',
      dica: 'Confira variável, nível territorial e período em metadados_agregado.',
    };
  }

  const linhas = [];
  for (const v of data) {
    for (const r of v.resultados || []) {
      const recorte = (r.classificacoes || []).map(
        (c) => `${c.nome}: ${Object.values(c.categoria || {}).join('/')}`
      );
      for (const s of r.series || []) {
        linhas.push({
          variavel: v.variavel,
          unidade: v.unidade,
          localidade: s.localidade?.nome,
          codigo: s.localidade?.id,
          nivel: s.localidade?.nivel?.nome,
          recorte: recorte.length ? recorte : undefined,
          valores: s.serie,
        });
      }
    }
  }

  return {
    agregado: ag,
    fonte: 'IBGE — SIDRA (servicodados.ibge.gov.br)',
    total: linhas.length,
    dados: linhas.slice(0, 60),
    truncado: linhas.length > 60,
  };
}

// --------------------------------------------------------------------------
// Fontes complementares: Wikipédia (API MediaWiki) e leitura de páginas HTML.
// São fontes SECUNDÁRIAS/de contexto — não substituem os dados oficiais.
// --------------------------------------------------------------------------

/** Bloqueia hosts internos/privados (proteção básica contra SSRF). */
function hostBloqueado(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === 'metadata.google.internal') return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // metadados de nuvem
  }
  if (h === '::1' || h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd')) return true;
  return false;
}

/** Extrai texto legível de um HTML (remove scripts/estilos/tags). */
function extrairTexto(html) {
  let t = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|br|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  t = t
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return t.replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

// Ferramenta 8: wikipedia — busca e extrato via API oficial do MediaWiki.
async function wikipedia({ termo, titulo, idioma, completo }) {
  const lang = /^[a-z]{2,3}$/i.test(String(idioma || '')) ? String(idioma).toLowerCase() : 'pt';
  const base = `https://${lang}.wikipedia.org/w/api.php`;

  let alvo = titulo;
  let busca = [];
  if (!alvo) {
    const q = String(termo || '').trim();
    if (!q) return { erro: 'Informe "termo" (busca) ou "titulo" (artigo).' };
    const s = await fetchJSON(
      `${base}?action=query&format=json&list=search&srlimit=5&srsearch=${encodeURIComponent(q)}`
    );
    busca = (s.query?.search || []).map((r) => r.title);
    if (busca.length === 0) return { idioma: lang, busca: [], nota: `Nada encontrado para "${q}".` };
    alvo = busca[0];
  }

  const exintro = completo ? '' : '&exintro=1';
  const e = await fetchJSON(
    `${base}?action=query&format=json&prop=extracts|info&inprop=url&explaintext=1&redirects=1${exintro}&titles=${encodeURIComponent(alvo)}`
  );
  if (e._error) return { erro: e._error };
  const pagina = Object.values(e.query?.pages || {})[0];
  if (!pagina || pagina.missing !== undefined) {
    return { idioma: lang, busca, titulo: alvo, nota: 'Artigo não encontrado.' };
  }

  const extrato = String(pagina.extract || '').slice(0, 6000);
  return {
    idioma: lang,
    busca,
    titulo: pagina.title,
    url: pagina.fullurl || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(pagina.title)}`,
    extrato,
    truncado: (pagina.extract || '').length > 6000,
    fonte: `Wikipédia (${lang}) — fonte secundária, não oficial`,
  };
}

// Ferramenta 9: ler_pagina — lê o texto de uma página HTML relevante.
async function lerPagina({ url }) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    return { erro: 'URL inválida.' };
  }
  if (parsed.protocol !== 'https:') return { erro: 'Só leio páginas via HTTPS.' };
  if (hostBloqueado(parsed.hostname)) {
    return { erro: 'Host bloqueado por segurança (endereço interno/privado).', host: parsed.hostname };
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const resp = await fetch(parsed.toString(), {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    });
    if (!resp.ok) return { erro: `HTTP ${resp.status} ao acessar a página.`, url: parsed.toString() };

    const bruto = (await resp.text()).slice(0, 400000);
    const tituloMatch = bruto.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const titulo = tituloMatch ? extrairTexto(tituloMatch[1]).slice(0, 200) : undefined;
    const texto = extrairTexto(bruto);
    const limite = 10000;

    return {
      url: parsed.toString(),
      host: parsed.hostname,
      titulo,
      texto: texto.slice(0, limite),
      truncado: texto.length > limite,
      fonte: `${parsed.hostname} — verifique se é uma fonte confiável e cite-a`,
    };
  } catch (err) {
    return { erro: `Falha ao acessar a página: ${err.message}`, url: parsed.toString() };
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
  {
    name: 'buscar_agregados',
    description:
      'Descobre tabelas estatísticas oficiais do IBGE (SIDRA) por palavra-chave, no catálogo oficial. ' +
      'Use para encontrar indicadores educacionais por município/estado (ex.: alfabetização, nível de instrução, anos de estudo). ' +
      'Retorna id, nome e pesquisa de cada tabela. Para educação, prefira as pesquisas "Censo Demográfico" e "PNAD Contínua".',
    input_schema: {
      type: 'object',
      properties: {
        termo: { type: 'string', description: 'Palavras-chave (ex.: "taxa de alfabetização", "nível de instrução").' },
        pesquisa: { type: 'string', description: 'Filtra por nome da pesquisa (ex.: "Censo Demográfico"). Opcional.' },
      },
      required: ['termo'],
    },
  },
  {
    name: 'metadados_agregado',
    description:
      'Mostra os metadados de uma tabela do IBGE (SIDRA): variáveis (com ids), períodos disponíveis, níveis ' +
      'territoriais (N6 = município, N3 = UF) e classificações. Use antes de consultar_sidra para saber quais ' +
      'ids de variável e período usar.',
    input_schema: {
      type: 'object',
      properties: {
        agregado: { type: 'string', description: 'Id da tabela (obtido em buscar_agregados).' },
      },
      required: ['agregado'],
    },
  },
  {
    name: 'consultar_sidra',
    description:
      'Consulta os VALORES de uma tabela do IBGE (SIDRA) para um ou mais municípios/estados. ' +
      'É assim que você obtém indicadores educacionais oficiais (ex.: taxa de alfabetização por município). ' +
      'Informe os ids de tabela e variável (via metadados_agregado), o nível territorial e os códigos IBGE das localidades. ' +
      'Sempre cite a fonte (IBGE/pesquisa) e o ano.',
    input_schema: {
      type: 'object',
      properties: {
        agregado: { type: 'string', description: 'Id da tabela.' },
        variavel: { type: 'string', description: 'Id da variável (veja metadados_agregado).' },
        nivel: { type: 'string', description: 'Nível territorial: "N6" (município, padrão), "N3" (UF), "N1" (Brasil).' },
        localidade: {
          type: 'string',
          description: 'Código(s) IBGE da(s) localidade(s), separados por vírgula (ex.: "2304400" ou "2304400,2611606").',
        },
        periodo: { type: 'string', description: 'Período/ano (ex.: "2022") ou "-1" para o mais recente (padrão).' },
        classificacao: { type: 'string', description: 'Filtro avançado de classificação (ex.: "2[6794]"). Opcional.' },
      },
      required: ['agregado', 'variavel'],
    },
  },
  {
    name: 'wikipedia',
    description:
      'Busca e lê artigos da Wikipédia pela API oficial (sem autenticação). Útil como fonte SECUNDÁRIA e de contexto ' +
      '(ex.: descrição de um município, histórico, dados gerais) quando as fontes oficiais não cobrem o ponto. ' +
      'Deixe claro que a Wikipédia não é fonte oficial e prefira IBGE/dados.gov.br para números autoritativos.',
    input_schema: {
      type: 'object',
      properties: {
        termo: { type: 'string', description: 'Termo de busca (ex.: "Fortaleza educação"). Use isto ou "titulo".' },
        titulo: { type: 'string', description: 'Título exato do artigo, se já souber.' },
        idioma: { type: 'string', description: 'Código do idioma da Wikipédia (padrão "pt").' },
        completo: { type: 'boolean', description: 'true para o texto completo; padrão só a introdução.' },
      },
    },
  },
  {
    name: 'ler_pagina',
    description:
      'Lê o texto de uma página HTML relevante (Wikipédia, portais, etc.) a partir de uma URL HTTPS, removendo o ' +
      'HTML. Use para fontes análogas quando não houver uma API. SEMPRE cite a página e avalie a confiabilidade; ' +
      'para números oficiais, prefira IBGE/dados.gov.br. Endereços internos/privados são bloqueados por segurança.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL HTTPS da página a ler.' },
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
  buscar_agregados: buscarAgregados,
  metadados_agregado: metadadosAgregado,
  consultar_sidra: consultarSidra,
  wikipedia: wikipedia,
  ler_pagina: lerPagina,
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
