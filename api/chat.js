// Backend do agente conversacional de dados públicos de educação.
//
// Recebe o histórico da conversa e roda Claude em um loop agêntico usando
// SOMENTE ferramentas que conectam a APIs públicas e oficiais (IBGE e
// dados.gov.br) e que leem os dados oficiais diretamente. Sem busca web
// genérica e sem fontes que exijam autenticação.
// Retorna o texto final do assistente.

import Anthropic from '@anthropic-ai/sdk';
import { customTools, executarFerramenta } from '../lib/sources.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
const MAX_LOOPS = 8;

const SYSTEM_PROMPT = `Você é o "Agente de Educação Pública", um assistente de IA especializado em dados públicos de educação das redes municipais e estaduais brasileiras.

Você responde a partir EXCLUSIVAMENTE de APIs públicas e oficiais, sem autenticação, que você consulta pelas ferramentas disponíveis:
- IBGE (servicodados.ibge.gov.br): códigos oficiais de municípios/estados, demografia e indicadores estatísticos (SIDRA) — incluindo educação (taxa de alfabetização, nível de instrução, anos de estudo) por município/UF, vindos do Censo Demográfico e da PNAD Contínua.
- dados.gov.br (catálogo de dados abertos do governo): hospeda as bases oficiais do INEP (Censo Escolar, IDEB), do FNDE e das redes estaduais/municipais, com os arquivos (CSV/JSON) para leitura.

Fluxo de trabalho:
1. Use resolver_localidade para obter o código IBGE do município/estado.
2. Para indicadores estatísticos do IBGE (alfabetização, instrução etc.): buscar_agregados (encontrar a tabela) → metadados_agregado (ver variável, período e nível) → consultar_sidra (obter os valores). Use dados_demograficos para população.
3. Para bases do INEP/FNDE e redes de ensino: buscar_dados_abertos (localizar a base) → ler_recurso (ler o arquivo CSV/JSON oficial e extrair os números).

Diretrizes:
- Trabalhe apenas com o que essas APIs retornam. NÃO invente números nem use conhecimento prévio para preencher dados — se o número não veio de uma ferramenta, não afirme que é oficial.
- SEMPRE cite a fonte (órgão/base) e o ANO de referência de cada número.
- Quando o dado exigir um arquivo grande de microdados ou não estiver no catálogo, seja honesto: explique isso e forneça o link do conjunto/recurso oficial que você encontrou para o usuário baixar.
- Para municípios homônimos, peça a UF para desambiguar.
- Formate números no padrão brasileiro (ex.: 1.234.567) e responda sempre em português do Brasil. Use tabelas ao comparar municípios/anos.`;

/** Normaliza o histórico vindo do cliente para o formato da API. */
function normalizarMensagens(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content }))
    .slice(-20);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ erro: 'Método não permitido. Use POST.' });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ erro: 'Servidor não configurado: defina a variável de ambiente ANTHROPIC_API_KEY.' });
    return;
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  const mensagens = normalizarMensagens(body.messages);
  if (mensagens.length === 0 || mensagens[mensagens.length - 1].role !== 'user') {
    res.status(400).json({ erro: 'Envie "messages" com a última mensagem do usuário.' });
    return;
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const ferramentasUsadas = [];

  const pedido = () =>
    client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      system: SYSTEM_PROMPT,
      tools: customTools,
      messages: mensagens,
    });

  try {
    let resposta = await pedido();

    let loops = 0;
    while (loops < MAX_LOOPS && resposta.stop_reason === 'tool_use') {
      loops++;

      const chamadas = resposta.content.filter((b) => b.type === 'tool_use');
      const resultados = [];
      for (const chamada of chamadas) {
        ferramentasUsadas.push(chamada.name);
        const saida = await executarFerramenta(chamada.name, chamada.input);
        resultados.push({
          type: 'tool_result',
          tool_use_id: chamada.id,
          content: JSON.stringify(saida),
        });
      }

      mensagens.push({ role: 'assistant', content: resposta.content });
      mensagens.push({ role: 'user', content: resultados });

      resposta = await pedido();
    }

    const texto = resposta.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    res.status(200).json({
      resposta: texto || 'Não consegui formular uma resposta. Reformule a pergunta, por favor.',
      ferramentas: [...new Set(ferramentasUsadas)],
    });
  } catch (err) {
    console.error('Erro no agente:', err);
    res.status(500).json({
      erro: 'Ocorreu um erro ao processar sua pergunta.',
      detalhe: err?.message || String(err),
    });
  }
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
