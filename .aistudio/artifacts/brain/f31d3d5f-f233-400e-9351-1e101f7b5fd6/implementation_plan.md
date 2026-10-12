# ClipFire — Implementação Full-Stack Funcional (Groq API + Transcrição YouTube)

Plano para transformar o ClipFire em uma aplicação full-stack 100% funcional com servidor Node.js/Express, extração direta de transcrições e legendas de vídeos do YouTube, análise analítica profunda com a IA do Groq (`llama-3.3-70b-versatile`) via chave de API no servidor, e simulador completo de fluxo de pagamentos e assinaturas.

## User Review & Critical Decisions

> [!IMPORTANT]
> Decisões confirmadas pelo usuário para a fase funcional:
> - **Provedor de IA**: API da Groq (`GROQ_API_KEY` configurada no ambiente do servidor) para análise semântica e seleção dos 15 cortes virais.
> - **Extração de Texto do Vídeo**: Extração direta de legendas e transcrições do YouTube no backend (com fallback inteligente caso o vídeo não possua legendas públicas geradas).
> - **Pagamentos**: Simulador completo e interativo de checkout e cobrança (Pix com QR Code gerado, Cartão de Crédito e upgrade instantâneo de cota/plano) sem exigência de gateway bancário real de imediato.

---

## 1. Overview & Core Concept

- **O que será implementado**:
  1. Criação do servidor backend em `server.ts` executando Express com integração ao Vite (`"dev": "tsx server.ts"`).
  2. Endpoint `/api/youtube-info`: obtém metadados reais do YouTube (título, autor, duração, miniaturas) e extrai a transcrição/legendas oficiais ou automáticas com timestamps.
  3. Endpoint `/api/generate-cuts`: recebe os trechos transcritos do vídeo, invoca a IA da Groq com prompt especializado em retenção e psicologia de conteúdo viral, e retorna os 15 cortes ranqueados com timestamps exatos, notas de 0 a 100, ganchos e hashtags.
  4. Fluxo de pagamento simulado realista com modal interativo de Pix (código copia-e-cola e QR Code visual) e Cartão de Crédito simulado, ativando os planos Pro e Turbo instantaneamente no perfil.

---

## 2. User Experience & Visual Design

### Fluxos Reais do Usuário
1. **Inserção do Link**: O usuário cola qualquer link legítimo do YouTube.
2. **Extração em Tempo Real**: O backend busca o título real do vídeo, duração e a transcrição temporal.
3. **Análise Neural com Groq**: A IA do Groq analisa os momentos de maior impacto e retorna 15 cortes estruturados em JSON estrito.
4. **Exibição dos Dados Reais**: Os cards exibem o título real do vídeo processado, timestamps precisos, pontuação de retenção e legendas dinâmicas.
5. **Checkout & Upgrade Simulado**: Ao clicar em assinar o plano Pro ou Turbo, o usuário escolhe Pix ou Cartão, visualiza a tela de pagamento e ao confirmar recebe a confirmação imediata com liberação de vídeos ilimitados.

---

## 3. Key Product Decisions & Trade-Offs

- **Servidor Express com Proxy de API**: A chave `GROQ_API_KEY` permanece 100% segura no backend em `server.ts`, sem qualquer exposição no cliente.
- **Extração de Legendas vs. Download de Vídeo**: A extração direta de transcrições e legendas do YouTube é ultrarrápida (menos de 2 segundos), economiza consumo de banda e CPU do servidor e entrega timestamps palavra por palavra com exatidão.
- **Graceful Fallback**: Se o vídeo fornecido não tiver legendas automáticas disponíveis no YouTube ou a chave da Groq não estiver preenchida nas variáveis de ambiente, o sistema avisa o usuário com elegância e permite ativar o modo assistido com exemplos reais.

---

## 4. Technical Architecture & Component Hierarchy

```
┌────────────────────────────────────────────────────────┐
│                   ClipFire Full-Stack                  │
├────────────────────────────────────────────────────────┤
│  Frontend (index.html SPA / Liquid Glass Laranja):     │
│  ├── Input de URL com Validação                        │
│  ├── Conexão com API /api/youtube-info & /api/cuts     │
│  ├── Exibição dos 15 Cortes com Timestamps Reais       │
│  └── Modal de Checkout Simulado (Pix & Cartão)         │
├────────────────────────────────────────────────────────┤
│  Backend Express (server.ts):                          │
│  ├── POST /api/process-video                           │
│  │   ├── 1. Extração de Metadados & Legendas YouTube   │
│  │   ├── 2. Chamada Groq API (LLaMA-3.3-70B)           │
│  │   └── 3. Sanitização e Retorno dos 15 Clipes        │
│  ├── POST /api/checkout-simulate                       │
│  │   └── Confirmação e Ativação de Plano               │
│  └── Vite Middlewares (Dev & Static Serving)           │
├────────────────────────────────────────────────────────┤
│  Variáveis de Ambiente (.env.example):                 │
│  ├── GROQ_API_KEY (Chave da API da Groq)               │
│  └── PORT=3000                                         │
└────────────────────────────────────────────────────────┘
```
