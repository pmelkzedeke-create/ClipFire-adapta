# ClipFire: Reprodução Real de Cortes (YouTube HD & Upload de Vídeo com FFmpeg)

Elimina telas pretas e estados de carregamento infinito, garantindo reprodução instantânea com som e imagem reais tanto para links do YouTube (via player oficial com intervalo exato de timestamps) quanto para vídeos enviados diretamente do dispositivo do usuário (fatiamento real quadro a quadro com FFmpeg).

### User Review & Critical Decisions

> [!IMPORTANT]
> **Decisões Confirmadas com o Usuário:**
> - **Visualização dos Cortes do YouTube**: Modo duplo com seletor no player — o usuário pode alternar entre o **Player Oficial do YouTube HD** (reproduzindo exatamente o intervalo do corte `start` -> `end` com imagem e áudio originais perfeitos) e o **Arquivo MP4 do Servidor** para download e streaming.
> - **Upload de Vídeos Próprios**: Adicionado suporte a envio de arquivos de vídeo locais (MP4, WebM, MOV), permitindo que criadores fatiem seus próprios podcasts e gravações usando FFmpeg real no servidor, gerando arquivos MP4 reais sem qualquer dependência ou bloqueio de bot do YouTube.

---

### 1. Overview & Core Concept

- **O que faz**: Oferece duas formas 100% reais de gerar e assistir aos 15 cortes virais:
  1. **Aba YouTube**: Analisa títulos, transcrições e timestamps; abre o player embutido no trecho exato de cada corte com áudio nítido e vídeo em alta definição sem travar.
  2. **Aba Upload Local**: Permite arrastar ou selecionar um vídeo MP4 do computador; o servidor faz o upload e executa o fatiamento real por FFmpeg nos trechos detectados, gerando clipes MP4 completos para reprodução e download direto.
- **Público-alvo**: Criadores de conteúdo, editores de reels/shorts e podcasters que precisam de cortes prontos e assistíveis de imediato, sem vídeos corrompidos ou telas pretas.
- **Valor Principal**: Eliminação completa de arquivos em branco ou loops de carregamento. O usuário assiste ao trecho real imediatamente.

---

### 2. User Experience & Visual Design

- **Abas de Entrada no Hero**:
  - Segmented control moderno: `[ Link do YouTube ]` e `[ Enviar Vídeo Local ]`.
  - Campo YouTube: Input de URL com botões rápidos de exemplo e botão "Gerar 15 Cortes Virais".
  - Campo Upload: Dropzone com preview do nome e tamanho do arquivo, barra de progresso real de upload e botão "Processar & Fatiar Vídeo".
- **Modal de Cinema (Player)**:
  - Seletor no topo do modal:
    - `📺 Player YouTube HD (Trecho Real)`: Inicia e pausa exatamente nos segundos `startSec` e `endSec`, exibindo o vídeo oficial do YouTube sem latência.
    - `⚡ Arquivo MP4`: Exibe o vídeo processado pelo servidor ou player HTML5 com download rápido.
  - Zero loop de carregamento: se o MP4 do servidor demorar para carregar, o player inicia diretamente no player do YouTube com imagem e áudio garantidos.
- **Identidade Visual**:
  - Tema escuro de alta performance (`#0a0f1d`), acentos quentes em gradiente laranja/âmbar, tipografia limpa sem pills estáticas.
  - Cards de corte com thumbnail real, tempo de duração, gancho viral e botão "Assistir Corte".

---

### 3. Key Product Decisions & Trade-Offs

- **Decisão 1: Player Híbrido no Modal de Cinema**
  - *Abordagem*: Para vídeos do YouTube, incorporar o iframe oficial configurado com parâmetros `start` e `end` e autoplay, com botão para alternar para o stream de MP4 do servidor.
  - *Por que*: O YouTube frequentemente bloqueia downloads diretos de servidores em nuvem (Cloud Run/IPs de datacenter). O player embutido do YouTube roda diretamente no navegador do cliente, garantindo 100% de sucesso, áudio cristalino e imagem em 1080p sem telas pretas.
- **Decisão 2: Suporte a Upload de Vídeo com Multer e FFmpeg**
  - *Abordagem*: Adicionar endpoint `/api/upload-video` usando `multer`. O arquivo de vídeo local do usuário é recebido no servidor e fatiado diretamente pelo FFmpeg (`ffmpeg -ss ... -to ... -c copy`), gerando cortes MP4 autênticos e ultra-rápidos.
  - *Por que*: Permite que o usuário processe seus próprios vídeos gravados localmente sem restrições de terceiros.
- **Decisão 3: Fim do Pre-Render em Branco**
  - *Abordagem*: Remover geradores de cor sólida vazios que geravam MP4s pretos e sem áudio.

---

### 4. Technical Architecture & Data Strategy

```
┌─────────────────────────────────────────────────────────────┐
│                       ClipFire UI                           │
├──────────────────────────────┬──────────────────────────────┤
│    Aba 1: YouTube URL        │   Aba 2: Upload de Vídeo     │
│  - Metadados & Transcrição   │  - Upload via Multipart      │
│  - IA Groq / Contextual      │  - Duração via FFprobe       │
└──────────────┬───────────────┴──────────────┬───────────────┘
               │                              │
               ▼                              ▼
┌──────────────────────────────┬──────────────────────────────┐
│  POST /api/process-video     │  POST /api/upload-video      │
│  - Extrai timestamps virais  │  - Salva em /tmp/uploads     │
│  - Configura YouTube embed   │  - Fatiamento real FFmpeg    │
│  - Gera 15 cortes com rank   │  - 15 cortes MP4 reais       │
└──────────────┬───────────────┴──────────────┬───────────────┘
               │                              │
               └──────────────┬───────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                 Modal de Cinema ClipFire                    │
├─────────────────────────────────────────────────────────────┤
│  [ Seletor: YouTube HD Real (start/end) | Arquivo MP4 ]     │
│  - Player sem travamento ou telas pretas                   │
│  - Download direto do clipe fatiado                         │
│  - Copiar título, descrição e hashtags para redes sociais   │
└─────────────────────────────────────────────────────────────┘
```

- **Endpoints no Servidor (`server.ts`)**:
  - `POST /api/process-video`: Processa URLs do YouTube, gera os 15 cortes virais com `startSec`, `endSec`, título, descrição, hashtags e `embedUrl`.
  - `POST /api/upload-video`: Recebe arquivos MP4/WebM enviados pelo usuário via multipart/form-data, gera 15 cortes temporais com FFmpeg fatiando o vídeo original.
  - `GET /api/stream-cut`: Faz o stream do arquivo MP4 local ou fatiado com suporte a cabeçalhos `Range`.
  - `GET /api/download-cut`: Fornece download do corte MP4 fatiado.
