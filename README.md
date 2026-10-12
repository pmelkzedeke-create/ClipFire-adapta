# 🔥 ClipFire — SaaS de Cortes Virais de YouTube com IA

SaaS completo para transformar vídeos longos do YouTube em **15 cortes virais ranqueados** com título, descrição, nota de 0 a 100, legendas dinâmicas estilo TikTok e hashtags otimizadas.

---

## 🚀 Como Rodar
Basta abrir o arquivo `index.html` diretamente em qualquer navegador moderno — a aplicação é 100% autossuficiente (HTML, CSS e JavaScript puros embutidos, sem dependências externas obrigatórias).

No ambiente de desenvolvimento do projeto:
```bash
npm run dev
```
O servidor Vite carregará a aplicação na porta `3000`.

---

## 🧠 Como Funciona o Pipeline

1. **Entrada do Vídeo**: O usuário cola o link de qualquer vídeo do YouTube (podcast, entrevista, aula, etc.).
2. **Download & Extração**: O fluxo baixa o áudio do vídeo em formato WAV de alta fidelidade.
3. **Transcrição Groq Whisper**: O áudio é transcrito palavra por palavra com timestamps milimétricos (minutos e segundos).
4. **Análise de Viralidade (LLM)**: O modelo de IA analisa o roteiro completo e seleciona os 15 melhores trechos com maior potencial de retenção.
5. **Corte e Renderização (FFmpeg)**: O vídeo é reenquadrado no formato vertical (9:16) com legendas dinâmicas animadas estilo TikTok.
6. **Entrega Pronta**: Cada corte é entregue com minutagem exata, nota preditiva (62–98), título atraente, descrição pronta e hashtags copiáveis.

---

## 🎨 Design & Identidade Visual
- **Tema Liquid Glass Laranja**: Fundo escuro profundo (`#0a0605`) com orbes de luz âmbar/laranja flutuando em segundo plano.
- **Vidro Translúcido**: Cards com `backdrop-filter: blur(30px)`, bordas refinadas de 1px `rgba(255,170,80,0.18)` e cantos arredondados de 28px.
- **Botões em Pílula 100px**: Gradiente vibrante (`#ff8a2a` → `#ff5e00`), efeito *sheen sweep* e feedback tátil.
- **Interações**: Glow pulsante no campo de URL ao digitar, entrada em cascata escalonada (70ms) dos cards e anel de progresso SVG com contagem animada.

---

## 📌 Status do Projeto
- ✅ **Fase 1: Frontend Completo**: SPA com 7 telas/seções (Landing Page, Login/Cadastro em localStorage, Dashboard com gerador, 15 cards com preview de legendas TikTok, Histórico de processamento, Tabela de Planos e Painel de Consumo de Cotas).
- 🔜 **Fase 2: Backend Real**: Integração com API Groq (`whisper-large-v3` + `llama-3.3-70b-versatile`) e pipeline FFmpeg.
- 🔜 **Fase 3: Pagamentos**: Checkout transparente via Stripe ou Mercado Pago.

---

## 🛠️ Marcações no Código (`index.html`)
Procure pelos comentários `// [BACKEND REAL: ...]` no código-fonte para plugar os serviços de produção:
- `// [BACKEND REAL: yt-dlp / stream downloader...]`: Download do fluxo de áudio
- `// [BACKEND REAL: GROQ WHISPER-LARGE-V3...]`: Transcrição palavra por palavra
- `// [BACKEND REAL: LLM GROQ LLaMA-3.3-70B...]`: Seleção dos ganchos e pontuação
- `// [BACKEND REAL: FFMPEG...]`: Corte vertical 9:16 e queima de legendas
- `// [BACKEND REAL: STRIPE / MERCADO PAGO...]`: Checkout e webhooks de assinatura
