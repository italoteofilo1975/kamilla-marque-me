// Backend do agente conversacional de dados públicos de educação.
//
// Recebe o histórico da conversa, roda Claude em um loop agêntico com:
//   - ferramentas de servidor da Anthropic (web_search / web_fetch) para
//     cobertura nacional ampla a partir de fontes oficiais; e
//   - ferramentas customizadas (IBGE, dados.gov.br, QEdu) para dados
//     estruturados confiáveis.
// Retorna o texto final do assistente.

import Anthropic from '@anthropic-ai/sdk';
import { customTools, executarFerramenta } from '../lib/sources.js';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
const MAX_LOOPS = 8;

const SYSTEM_PROMPT = `Você é o "Agente de Educação Pública", um assistente de IA especializado em dados públicos de educação das redes municipais e estaduais brasileiras.

Seu objetivo é responder perguntas sobre educação pública (IDEB, Censo Escolar, matrículas, número de escolas e docentes, IDEB, FUNDEB, repasses do FNDE, ENEM, SAEB etc.) usando dados abertos e oficiais, para qualquer município ou estado do Brasil.

Fontes que você pode usar:
- INEP (Censo Escolar, IDEB, SAEB, ENEM) — fonte primária de indicadores educacionais.
- IBGE — códigos de municípios/estados e dados demográficos de contexto.
- dados.gov.br — catálogo de dados abertos do governo federal.
- FNDE — repasses, merenda, transporte escolar.
- QEdu — camada amigável sobre os dados do INEP.

Ferramentas:
- resolver_localidade: SEMPRE use primeiro para obter o código IBGE de um município/estado antes de consultar dados que dependem dele.
- dados_demograficos: contexto populacional (IBGE).
- buscar_dados_abertos: descobrir bases no dados.gov.br.
- indicadores_educacionais: IDEB/Censo via QEdu (quando configurado).
- web_search / web_fetch: busque e leia fontes oficiais (gov.br/inep, qedu.org.br, fnde.gov.br) para obter números específicos, especialmente IDEB e Censo Escolar.

Diretrizes:
- SEMPRE cite a fonte e o ANO de referência de cada número (ex.: "IDEB 2023, fonte INEP").
- Se um município tiver homônimos, peça a UF para desambiguar.
- Seja honesto quando um dado não estiver disponível ou estiver desatualizado; nunca invente números. Se não tiver certeza, diga onde o usuário pode obter o dado.
- Formate números no padrão brasileiro (ex.: 1.234.567) e responda sempre em português do Brasil.
- Seja claro e direto; use tabelas quando comparar municípios/anos.`;

function getServerTools() {
  // web_search/web_fetch com filtragem dinâmica (modelos Opus 4.6+/Sonnet 4.6).
  return [
    { type: 'web_search_20260209', name: 'web_search', max_uses: 6 },
    { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 },
  ];
}

/** Normaliza o histórico vindo do cliente para o formato da API. */
function normalizarMensagens(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content }))
    .slice(-20); // limita o histórico para controlar custo/contexto
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ erro: 'Método não permitido. Use POST.' });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({
      erro: 'Servidor não configurado: defina a variável de ambiente ANTHROPIC_API_KEY.',
    });
    return;
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body || {};
  const mensagens = normalizarMensagens(body.messages);
  if (mensagens.length === 0 || mensagens[mensagens.length - 1].role !== 'user') {
    res.status(400).json({ erro: 'Envie "messages" com a última mensagem do usuário.' });
    return;
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const tools = [...getServerTools(), ...customTools];
  const ferramentasUsadas = [];

  try {
    let resposta = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      system: SYSTEM_PROMPT,
      tools,
      messages: mensagens,
    });

    let loops = 0;
    while (loops < MAX_LOOPS) {
      loops++;

      // Ferramentas de servidor (web_search/web_fetch) atingiram o limite interno.
      if (resposta.stop_reason === 'pause_turn') {
        mensagens.push({ role: 'assistant', content: resposta.content });
        resposta = await client.messages.create({
          model: MODEL,
          max_tokens: 4096,
          thinking: { type: 'adaptive' },
          system: SYSTEM_PROMPT,
          tools,
          messages: mensagens,
        });
        continue;
      }

      if (resposta.stop_reason !== 'tool_use') break;

      // Executa as ferramentas customizadas solicitadas.
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

      resposta = await client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        thinking: { type: 'adaptive' },
        system: SYSTEM_PROMPT,
        tools,
        messages: mensagens,
      });
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
