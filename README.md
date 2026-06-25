# Agente de Educação Pública

Agente de IA conversacional para consultar **dados públicos de educação das redes
municipais e estaduais brasileiras** — IDEB, Censo Escolar, matrículas, escolas,
docentes, financiamento (FNDE/FUNDEB) — com **cobertura nacional** (todos os 5.570
municípios e 27 UFs) e citação das fontes oficiais.

## Como funciona

```
Navegador (app.html)  →  /api/chat (serverless)  →  Claude (loop agêntico) ──┐
                                                                              ├─ web_search / web_fetch  → INEP, QEdu, FNDE…
                                                                              ├─ resolver_localidade     → IBGE (códigos)
                                                                              ├─ dados_demograficos      → IBGE
                                                                              ├─ buscar_dados_abertos    → dados.gov.br (CKAN)
                                                                              └─ indicadores_educacionais → QEdu (opcional)
```

O agente combina:

- **Ferramentas de busca/leitura web** da Anthropic (`web_search` / `web_fetch`) —
  dão cobertura ampla, lendo números direto das fontes oficiais (gov.br/INEP, QEdu, FNDE).
- **Ferramentas customizadas** (`lib/sources.js`) — dados estruturados e confiáveis do
  **IBGE** (resolução de município/estado → código oficial, demografia) e descoberta de
  bases no **dados.gov.br**; consulta opcional ao **QEdu** quando há token.

Ele **sempre cita a fonte e o ano**, formata números em padrão brasileiro e é honesto
quando um dado não está disponível — não inventa números.

## Estrutura

| Arquivo | Função |
|---|---|
| `index.html` | Página inicial |
| `app.html` | Interface de chat (`/app`) |
| `api/chat.js` | Backend serverless: loop agêntico com a API da Anthropic |
| `lib/sources.js` | Ferramentas de dados (IBGE, dados.gov.br, QEdu) |
| `vercel.json` | Roteamento estático + função serverless |

## Configuração

1. Crie um projeto na [Vercel](https://vercel.com) apontando para este repositório.
2. Defina as variáveis de ambiente (ver `.env.example`):
   - `ANTHROPIC_API_KEY` — **obrigatória** ([console.anthropic.com](https://console.anthropic.com)).
   - `ANTHROPIC_MODEL` — opcional (padrão `claude-opus-4-8`).
   - `QEDU_API_TOKEN` — opcional; habilita consulta direta de IDEB/Censo via QEdu.
3. Faça o deploy. A função `/api/chat` é criada automaticamente.

> **Tempo de execução:** consultas com busca web podem levar alguns segundos. Em planos
> que limitam a duração da função (ex.: Hobby = 10s), prefira o plano Pro ou ajuste o
> limite de duração (`maxDuration`) da função `api/chat.js` no painel da Vercel.

## Desenvolvimento local

```bash
npm install
npm i -g vercel
vercel dev          # serve estático + /api/chat localmente (lê variáveis de .env)
```

Crie um arquivo `.env` a partir de `.env.example` com sua `ANTHROPIC_API_KEY`.

## Fontes de dados

| Fonte | Conteúdo | Acesso |
|---|---|---|
| INEP | Censo Escolar, IDEB, SAEB, ENEM | busca web + microdados |
| IBGE | Códigos de municípios/estados, população | API pública aberta |
| dados.gov.br | Catálogo de dados abertos federais | API CKAN |
| FNDE | Repasses, merenda, transporte escolar | busca web |
| QEdu | Camada amigável sobre dados do INEP | API (token opcional) |

## Aviso

Ferramenta de apoio à consulta de dados públicos. Para usos oficiais, confirme os
números nos portais do INEP e do IBGE.
