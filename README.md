# Agente de Educação Pública

Agente de IA conversacional para consultar **dados públicos de educação das redes
municipais e estaduais brasileiras** — Censo Escolar, IDEB, matrículas, escolas,
docentes, financiamento (FNDE/FUNDEB) — com **cobertura nacional** (todos os 5.570
municípios e 27 UFs).

O agente é **pragmático e honesto**: trabalha **exclusivamente** com duas APIs
**públicas, oficiais e sem autenticação**, com as quais ele realmente estabelece
conexão e lê os dados — sem busca web genérica e sem fontes que exijam token.

## Fontes (APIs públicas oficiais)

| Fonte | API | Conteúdo |
|---|---|---|
| **IBGE** | `servicodados.ibge.gov.br` | Códigos oficiais de municípios/estados e demografia |
| **dados.gov.br** | CKAN (`/api/3/action/package_search`) | Catálogo oficial de dados abertos: bases do **INEP** (Censo Escolar, IDEB), **FNDE** e redes estaduais/municipais, com os arquivos (CSV/JSON) |

## Como funciona

```
Navegador (app.html) → /api/chat (serverless) → Claude (loop agêntico) ──┐
                                                                          ├─ resolver_localidade  → IBGE (código oficial)
                                                                          ├─ dados_demograficos   → IBGE (população)
                                                                          ├─ buscar_dados_abertos → dados.gov.br (catálogo)
                                                                          └─ ler_recurso          → baixa e lê o CSV/JSON oficial (*.gov.br)
```

Fluxo típico do agente:
1. `resolver_localidade` → código IBGE do município/estado.
2. `buscar_dados_abertos` → localiza a base oficial no dados.gov.br.
3. `ler_recurso` → **baixa e lê o arquivo de dados oficial** (restrito a domínios `*.gov.br`) e extrai os números.

O agente **sempre cita fonte e ano**, formata números no padrão brasileiro e **não
inventa dados**: se um número não veio de uma ferramenta, ele não o apresenta como
oficial. Quando o dado exige um arquivo de microdados grande, ele indica o link
oficial encontrado para download.

## Estrutura

| Arquivo | Função |
|---|---|
| `index.html` | Página inicial |
| `app.html` | Interface de chat (`/app`) |
| `api/chat.js` | Backend serverless: loop agêntico com a API da Anthropic |
| `lib/sources.js` | Ferramentas que conectam ao IBGE e ao dados.gov.br |
| `vercel.json` | Roteamento estático + função serverless |

## Configuração

1. Crie um projeto na [Vercel](https://vercel.com) apontando para este repositório.
2. Defina a variável de ambiente (ver `.env.example`):
   - `ANTHROPIC_API_KEY` — **obrigatória** ([console.anthropic.com](https://console.anthropic.com)).
   - `ANTHROPIC_MODEL` — opcional (padrão `claude-opus-4-8`).
3. Faça o deploy. A função `/api/chat` é criada automaticamente.

> **Tempo de execução:** ler arquivos do dados.gov.br pode levar alguns segundos. Em
> planos que limitam a duração da função (ex.: Hobby = 10s), prefira o plano Pro ou
> ajuste o limite de duração (`maxDuration`) da função `api/chat.js` no painel da Vercel.

## Desenvolvimento local

```bash
npm install
npm i -g vercel
vercel dev          # serve estático + /api/chat localmente (lê variáveis de .env)
```

Crie um arquivo `.env` a partir de `.env.example` com sua `ANTHROPIC_API_KEY`.

## Aviso

Ferramenta de apoio à consulta de dados públicos. Para usos oficiais, confirme os
números nos portais do INEP e do IBGE.
