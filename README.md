# 🔥 ClipFire

SaaS de cortes virais de YouTube com IA. Cole um link, receba 15 cortes
ranqueados com título, descrição, nota de 0 a 100 e hashtags.

## 🚀 Como rodar
Basta abrir o index.html no navegador — é tudo um arquivo só, sem dependências.

## 🧠 Como funciona
1. O usuário cola o link do YouTube
2. (Fase 2) Backend transcreve o áudio palavra por palavra com timestamps via Groq Whisper
3. (Fase 2) IA analisa os melhores momentos e escolhe os 15 cortes com maior potencial viral
4. (Fase 2) ffmpeg corta os clipes brutos
5. Cada corte vem com: tempo exato, título viral, descrição, nota 0-100 e hashtags

## 📌 Status
- ✅ Fase 1: Frontend completo (modo demo)
- 🔜 Fase 2: Backend real (Groq + ffmpeg)
- 🔜 Fase 3: Pagamentos (Stripe / Mercado Pago)

## 🛠️ Marcações no código
Os comentários `// [BACKEND REAL: ...]` no index.html indicam onde cada
integração real entra.
