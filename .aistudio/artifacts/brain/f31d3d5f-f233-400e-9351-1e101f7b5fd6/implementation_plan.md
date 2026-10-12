# ClipFire — SaaS de Cortes Virais de YouTube com IA

Plano de arquitetura e implementação completa do ClipFire: um SaaS SPA completo em tema Liquid Glass Laranja, apresentando Landing Page, Autenticação, Dashboard com Gerador Inteligente de 15 Cortes Virais, Player com Legendas Dinâmicas estilo TikTok, Histórico de Processamento e Gestão de Planos.

## User Review & Critical Decisions

> [!IMPORTANT]
> Decisões alinhadas na Fase 1:
> - **Pré-visualização de cortes**: Player vertical integrado com miniatura de vídeo, tempo real e preview de legendas dinâmicas animadas estilo TikTok.
> - **Navegação do Dashboard**: Barra superior de abas fluida com transições suaves entre Gerador, Histórico e Meu Plano.
> - **Backend & Demonstração**: Modo demonstração rica em JavaScript local com dados realistas em pt-BR (notas 62-98, hashtags, títulos e descrições persuasivas), com marcações claras para integração futura com Groq Whisper, LLM, FFmpeg e Gateway de Pagamento.

---

## 1. Overview & Core Concept

- **O que faz**: O ClipFire permite que criadores de conteúdo colem o link de um vídeo longo do YouTube (podcasts, entrevistas, aulas) e recebam instantaneamente os 15 melhores trechos com maior potencial de viralizar no TikTok, YouTube Shorts e Instagram Reels.
- **Público-alvo**: Criadores de conteúdo, canais de cortes, editores de vídeo, agências de marketing e produtores de podcasts.
- **Valor Principal**: Redução de horas de garimpo manual para menos de 1 minuto, entregando minutagem exata de início/fim, título viral pronto, descrição persuasiva, nota preditiva de engajamento (0 a 100) e hashtags otimizadas.

---

## 2. User Experience & Visual Design

### Fluxos do Usuário
1. **Landing Page**: Apresentação visual da proposta de valor, como funciona em 3 passos, prova social de criadores, grade de preços (Free, Pro, Turbo) e chamada para ação.
2. **Entrar / Criar Conta**: Modal/tela de autenticação simulada que persiste a sessão do usuário e o histórico no `localStorage`.
3. **Dashboard Principal**:
   - Campo de entrada de URL com efeito glow pulsante ao digitar e varredura de luz ao colar.
   - Barra de progresso com 5 etapas realistas: Baixando vídeo → Transcrevendo com Groq Whisper → IA analisando retenção → FFmpeg cortando clipes → Finalizado.
   - Botão de ação com feedback de clique e estado "Pensando" com 3 pontos animados em onda.
4. **Grade de 15 Cortes Virais**:
   - Entrada em cascata com atraso escalonado (stagger de 70ms).
   - Anel de progresso SVG com contagem numérica animada de 0 até o valor da nota (62–98).
   - Player vertical com miniatura estilizada e simulação de legendas dinâmicas sincronizadas no centro.
   - Botões de ação rápida para copiar hashtags individuais, copiar pacote completo de descrição e disparar download simulado.
5. **Histórico de Vídeos**: Listagem de vídeos processados anteriormente com data, status, contagem de clipes e botão para reabrir os cortes.
6. **Gestão do Plano & Consumo**: Painel demonstrativo com plano ativo (Free / Pro / Turbo), barra de cota mensal (ex: 2 de 3 vídeos usados no Free) e modal de upgrade com tabela comparativa.

### Identidade Visual & Tema Liquid Glass Laranja
- **Fundo**: `#0a0605` (preto profundo com leve tonalidade âmbar) com orbes flutuantes com gradientes radiais quentes em movimento sutil.
- **Superfícies de Vidro Líquido**: `backdrop-filter: blur(30px)`, bordas refinadas de 1px `rgba(255, 170, 80, 0.18)`, cantos arredondados de 28px e reflexo de luz interna no topo.
- **Tipografia**: Sistema Apple (`-apple-system, SF Pro Display, BlinkMacSystemFont`), títulos expressivos com `text-wrap: balance` e números tabulares (`tabular-nums`) para tempos e métricas.
- **Acentos e Botões**: Gradiente laranja de alta energia (`#ff8a2a` → `#ff5e00`), formato pílula, com efeito sheen sweep no hover e feedback tátil no clique.
- **Acessibilidade**: Conformidade integral com `prefers-reduced-motion`.

---

## 3. Key Product Decisions & Trade-Offs

- **Formato Único e Autossuficiente**: Toda a aplicação será condensada em código limpo, sem dependências de pacotes externos pesados, garantindo carregamento instantâneo e portabilidade máxima.
- **Persistência em localStorage**: Usuários, planos e histórico de vídeos processados são mantidos de forma reativa no navegador do usuário.
- **Comentários Arquiteturais de Backend**: O código incluirá blocos comentados demonstrando os endpoints exatos de backend para quando o usuário desejar conectar sua chave da Groq API (`whisper-large-v3`), modelo de LLM (`llama-3.3-70b-versatile`), script FFmpeg para split de vídeo e Webhooks do Stripe/Mercado Pago.

---

## 4. Technical Architecture & Component Hierarchy

```
┌────────────────────────────────────────────────────────┐
│                   ClipFire SPA Canvas                  │
├────────────────────────────────────────────────────────┤
│  Top Navigation (Brand Wordmark, Links, Auth Status)   │
├────────────────────────────────────────────────────────┤
│  View Router:                                          │
│  ├── [Landing View]                                    │
│  │   ├── Hero Section com CTA                          │
│  │   ├── Como Funciona (3 Etapas)                      │
│  │   ├── Prova Social & Depoimentos                    │
│  │   └── Tabela de Planos (Free, Pro R$29, Turbo R$59) │
│  │                                                     │
│  ├── [Auth View]                                       │
│  │   ├── Alternância Login / Cadastro                  │
│  │   └── Persistência no localStorage                  │
│  │                                                     │
│  └── [Dashboard View]                                  │
│      ├── Sub-Navegação: Gerador | Histórico | Meu Plano│
│      ├── Gerador:                                      │
│      │   ├── Input Bar com Glow Laranja & Sheen        │
│      │   ├── Barra de Progresso com 5 Etapas           │
│      │   └── Grade dos 15 Cards de Cortes:             │
│      │       ├── Miniatura de Player Vertical          │
│      │       ├── Preview de Legendas Dinâmicas TikTok  │
│      │       ├── Score SVG Circular Animado (0-100)    │
│      │       ├── Timestamps Milimétricos               │
│      │       ├── Título & Descrição Virais             │
│      │       ├── Pílulas de Hashtags Copiáveis         │
│      │       └── Ações: Baixar Corte & Copiar Info     │
│      ├── Histórico de Processamento                    │
│      └── Painel do Usuário (Plano & Consumo de Cotas)  │
├────────────────────────────────────────────────────────┤
│  Floating UI: Toast com Bounce & Modal de Upgrade      │
└────────────────────────────────────────────────────────┘
```
