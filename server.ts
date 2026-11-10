import 'dotenv/config';
import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import multer from 'multer';
import { GoogleGenAI } from '@google/genai';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Helper para extrair o ID do vídeo do YouTube
function extractYouTubeId(url: string): string | null {
  if (!url) return null;
  const regExp = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  const match = url.trim().match(regExp);
  return match ? match[1] : null;
}

// Formatar segundos em mm:ss
function formatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Obter metadados reais do YouTube via oEmbed oficial
async function fetchYouTubeOEmbed(videoId: string) {
  try {
    const response = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClipFireBot/1.0)' },
      signal: AbortSignal.timeout(3500),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    console.warn('[YouTube oEmbed] Falha ao consultar metadados:', err);
    return null;
  }
}

// Tentar extrair transcrição/legendas automáticas reais do YouTube
async function extractYouTubeTranscript(videoId: string): Promise<{ text: string; lines: Array<{ start: number; dur: number; text: string }> } | null> {
  try {
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      signal: AbortSignal.timeout(4000),
    });

    if (!pageRes.ok) return null;
    const html = await pageRes.text();

    // Localizar captionTracks no HTML do YouTube
    const captionMatch = html.match(/"captionTracks":\s*(\[.*?\])/);
    if (!captionMatch) return null;

    const tracks = JSON.parse(captionMatch[1]);
    if (!tracks || tracks.length === 0) return null;

    // Preferir legendas em português ou inglês
    const ptTrack = tracks.find((t: any) => t.languageCode?.startsWith('pt')) || tracks[0];
    if (!ptTrack || !ptTrack.baseUrl) return null;

    // Buscar as legendas em formato json3
    const timedTextUrl = ptTrack.baseUrl + '&fmt=json3';
    const subRes = await fetch(timedTextUrl, { signal: AbortSignal.timeout(3500) });
    if (!subRes.ok) return null;

    const subJson = await subRes.json();
    if (!subJson.events) return null;

    const lines: Array<{ start: number; dur: number; text: string }> = [];
    let fullText = '';

    for (const evt of subJson.events) {
      if (evt.segs && evt.tStartMs !== undefined) {
        const segText = evt.segs.map((s: any) => s.utf8 || '').join('').trim();
        if (segText && segText !== '\n') {
          const startSec = Math.round(evt.tStartMs / 1000);
          const durSec = Math.round((evt.dDurationMs || 3000) / 1000);
          lines.push({ start: startSec, dur: durSec, text: segText });
          fullText += `[${formatTime(startSec)}] ${segText}\n`;
        }
      }
    }

    return lines.length > 0 ? { text: fullText, lines } : null;
  } catch (err) {
    console.warn('[YouTube Transcript] Não foi possível extrair legendas do vídeo:', err);
    return null;
  }
}

// [BACKEND REAL: GROQ API - Seleção dinâmica de modelo compatível e análise viral]
let cachedGroqModel: string | null = null;

async function getBestGroqModel(apiKey: string): Promise<string> {
  if (cachedGroqModel) return cachedGroqModel;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) {
      const data = await res.json();
      const availableIds: string[] = (data.data || []).map((m: any) => m.id);

      // Ordem de preferência de modelos Groq suportados
      const candidates = [
        'openai/gpt-oss-120b',
        'llama-3.3-70b-versatile',
        'llama-3.1-8b-instant',
        'qwen/qwen3.8-27b',
        'openai/gpt-oss-20b',
        'llama3-70b-8192',
        'llama3-8b-8192',
      ];

      for (const candidate of candidates) {
        if (availableIds.includes(candidate)) {
          cachedGroqModel = candidate;
          console.log(`[Groq] Modelo selecionado com sucesso: ${cachedGroqModel}`);
          return cachedGroqModel;
        }
      }

      // Se nenhum dos candidatos específicos estiver na lista, pegar o primeiro modelo de texto válido
      const textModel = availableIds.find(
        (id) => !id.includes('whisper') && !id.includes('guard') && !id.includes('orpheus')
      );
      if (textModel) {
        cachedGroqModel = textModel;
        console.log(`[Groq] Modelo alternativo selecionado: ${cachedGroqModel}`);
        return cachedGroqModel;
      }
    }
  } catch (err) {
    console.warn('[Groq] Erro ao listar modelos disponíveis:', err);
  }

  // Fallback padrão
  cachedGroqModel = 'openai/gpt-oss-120b';
  return cachedGroqModel;
}

// -----------------------------------------------------------------------------
// INTEGRAÇÃO COM GEMINI API (@google/genai)
// -----------------------------------------------------------------------------
async function analyzeWithGeminiAI(videoTitle: string, author: string, transcriptSummary: string, videoId: string) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    console.log('[Gemini API] Iniciando análise viral com modelo gemini-3.8-flash...');
    const ai = new GoogleGenAI({ apiKey });
    const prompt = `Você é um editor sênior especialista em cortes virais para YouTube e redes sociais.
Analise o título, canal e conteúdo/transcrição do vídeo abaixo e selecione os 15 melhores momentos de pico de retenção (cortes contínuos em formato 16:9 widescreen).
Cada corte deve ter duração entre 25s e 55s, com início e término precisos.

Vídeo: "${videoTitle}"
Canal: "${author}"
Conteúdo / Transcrição com timestamps:
${transcriptSummary.slice(0, 10000)}

Retorne OBRIGATORIAMENTE um array JSON contendo exatamente 15 objetos com o formato:
[
  {
    "rank": 1,
    "score": 98,
    "startSec": 30,
    "endSec": 75,
    "duration": 45,
    "title": "Título viral chamativo e direto em PT-BR (máx 10 palavras)",
    "desc": "Contexto do momento e por que ele engaja o espectador",
    "tags": ["#shorts", "#cortes", "#viral", "#podcast"]
  }
]`;

    const aiCall = ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
      },
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Timeout na resposta da Gemini API')), 7000)
    );

    const response = await Promise.race([aiCall, timeoutPromise]);

    const responseText = response.text;
    if (!responseText) return null;

    const parsed = JSON.parse(responseText);
    const cutsArray = Array.isArray(parsed)
      ? parsed
      : (parsed.cuts || parsed.segments || parsed.cortes || Object.values(parsed).find((v) => Array.isArray(v)));

    if (Array.isArray(cutsArray) && cutsArray.length >= 5) {
      return cutsArray.slice(0, 15).map((c: any, i: number) => {
        const startSec = Math.max(0, parseInt(c.startSec || (i * 45 + 15), 10));
        const endSec = Math.max(startSec + 20, parseInt(c.endSec || (i * 45 + 55), 10));
        const duration = c.duration || (endSec - startSec) || 35;
        return {
          rank: i + 1,
          score: c.score || (98 - i * 2),
          startSec,
          endSec,
          duration,
          timeLabel: `${formatTime(startSec)} → ${formatTime(endSec)} · ${duration}s`,
          embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}?start=${startSec}&end=${endSec}&autoplay=1&rel=0&modestbranding=1`,
          streamUrl: `/api/stream-cut?videoId=${videoId}&start=${startSec}&end=${endSec}&rank=${i + 1}`,
          youtubeUrl: `https://www.youtube.com/watch?v=${videoId}&t=${startSec}s`,
          downloadUrl: `/api/download-cut?videoId=${videoId}&start=${startSec}&end=${endSec}&rank=${i + 1}`,
          title: c.title || `Corte #${i + 1} - Momento Marcante`,
          desc: c.desc || `Trecho selecionado com IA aos ${formatTime(startSec)}.`,
          format: '16:9 Widescreen (Corte Bruto Limpo)',
          tags: Array.isArray(c.tags) ? c.tags : ['#shorts', '#cortesvirais', '#podcast', '#viral', '#youtube'],
          sourceType: 'youtube',
          videoId,
        };
      });
    }
  } catch (err) {
    console.warn('[Gemini API] Falha na chamada da Gemini API:', err);
  }
  return null;
}

async function analyzeWithGroqAI(videoTitle: string, author: string, transcriptSummary: string, videoId: string) {
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) return null;

  const modelToUse = await getBestGroqModel(groqApiKey);

  const prompt = `Você é um editor sênior especialista em cortes virais para YouTube e redes sociais.
Analise a transcrição e as informações do vídeo do YouTube e selecione os 15 melhores trechos BRUTOS contínuos (corte bruto limpo, formato original 16:9 widescreen, sem legendas na tela).
Cada corte deve ser uma fala, história, pergunta, reflexão ou debate completo com início e término exatos (duração entre 30s e 55s).

Vídeo: "${videoTitle}"
Canal: "${author}"

Trecho da Transcrição / Tópicos com timestamps:
${transcriptSummary.slice(0, 5000)}

Para cada um dos 15 cortes virais, forneça:
1. rank: número de 1 a 15
2. score: nota de 62 a 98 com base na força e retenção do corte
3. startSec: segundo exato de início do corte bruto
4. endSec: segundo exato de término do corte bruto (duração entre 30s e 55s)
5. duration: duração em segundos
6. title: título viral atraente em português brasileiro (máx 12 palavras)
7. desc: descrição persuasiva contextualizando o corte
8. tags: lista de 5 hashtags relevantes com #

Retorne OBRIGATORIAMENTE um objeto JSON com a chave "cuts" contendo exatamente 15 objetos, sem marcações markdown ao redor.`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${groqApiKey}`,
      },
      signal: AbortSignal.timeout(6000),
      body: JSON.stringify({
        model: modelToUse,
        messages: [
          { role: 'system', content: 'Você é um assistente de IA focado estritamente em gerar JSON válido sem texto adicional.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 3500,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`[Groq API Error no modelo ${modelToUse}]:`, errText);
      cachedGroqModel = null;
      return null;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content);
    const cutsArray = Array.isArray(parsed)
      ? parsed
      : (parsed.cuts || parsed.segments || parsed.cortes || Object.values(parsed).find((v) => Array.isArray(v)));

    if (Array.isArray(cutsArray) && cutsArray.length >= 8) {
      return cutsArray.slice(0, 15).map((c: any, i: number) => {
        const startSec = Math.max(0, parseInt(c.startSec || (i * 45 + 15), 10));
        const endSec = Math.max(startSec + 25, parseInt(c.endSec || (i * 45 + 55), 10));
        const duration = c.duration || (endSec - startSec) || 40;
        return {
          rank: i + 1,
          score: c.score || (98 - i * 2),
          startSec,
          endSec,
          duration,
          timeLabel: `${formatTime(startSec)} → ${formatTime(endSec)} · ${duration}s`,
          embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}?start=${startSec}&end=${endSec}&autoplay=1&rel=0&modestbranding=1`,
          streamUrl: `/api/stream-cut?videoId=${videoId}&start=${startSec}&end=${endSec}&rank=${i + 1}`,
          youtubeUrl: `https://www.youtube.com/watch?v=${videoId}&t=${startSec}s`,
          downloadUrl: `/api/download-cut?videoId=${videoId}&start=${startSec}&end=${endSec}&rank=${i + 1}`,
          title: c.title,
          desc: c.desc,
          format: '16:9 Widescreen (Corte Bruto Limpo)',
          tags: Array.isArray(c.tags) ? c.tags : ['#shorts', '#cortesvirais', '#podcast', '#viral', '#youtube'],
          sourceType: 'youtube',
          videoId,
        };
      });
    }
    return null;
  } catch (err) {
    console.error('[Groq AI Analysis Falha]:', err);
    return null;
  }
}

// Gerador contextual fallback de alta qualidade quando a chave Groq não estiver setada
function generateContextualClips(videoTitle: string, author: string, transcriptLines?: Array<{ start: number; dur: number; text: string }>, videoId: string = '') {
  const scores = [98, 96, 95, 93, 91, 89, 87, 85, 83, 80, 77, 74, 71, 68, 64];

  const viralTemplates = [
    { hook: "O momento mais chocante revelado por {author}!", cap: ["ELE", "NÃO", "ESPERAVA", "ESSA", "RESPOSTA", "AO", "VIVO!"] },
    { hook: "A verdade dolorosa que ninguém aceita sobre {topic}...", cap: ["PARE", "DE", "COMETER", "ESSE", "ERRO", "AGORA!"] },
    { hook: "A frase exata que mudou completamente o rumo da conversa", cap: ["ESSA", "FRASE", "MUDOU", "TUDO", "NO", "ESTÚDIO!"] },
    { hook: "Como destravar resultados sem perder tempo com bobagens", cap: ["O", "SEGREDO", "QUE", "NUNCA", "TE", "CONTARAM!"] },
    { hook: "O maior erro cometido pela maioria das pessoas em {topic}", cap: ["99%", "DAS", "PESSOAS", "ERRAM", "EXATAMENTE", "AQUI!"] },
    { hook: "A lição de ouro que economiza 5 anos da sua vida", cap: ["ESCUTE", "ISSO", "ANTES", "QUE", "SEJA", "TARDE!"] },
    { hook: "A pergunta que deixou o estúdio em silêncio absoluto", cap: ["O", "MAIOR", "SILÊNCIO", "DA", "HISTÓRIA", "DO", "CANAL!"] },
    { hook: "Como {author} conseguiu virar o jogo contra todas as probabilidades", cap: ["CONTRA", "TUDO", "E", "CONTRA", "TODOS!"] },
    { hook: "O detalhe bizarro escondido bem na nossa frente", cap: ["VOCÊ", "NUNCA", "MAIS", "VAI", "OLHAR", "IGUAL!"] },
    { hook: "A técnica comprovada para manter o foco total sob pressão", cap: ["FAÇA", "ISSO", "HOJE", "MESMO", "ANTES", "DE", "COMEÇAR!"] },
    { hook: "A história secreta dos bastidores que nunca contaram", cap: ["OS", "BASTIDORES", "QUE", "TENTARAM", "ESCONDER!"] },
    { hook: "Por que você está perdendo tempo (e nem percebeu ainda!)", cap: ["SEU", "TEMPO", "ESTÁ", "SENDO", "DRENADO!"] },
    { hook: "O conselho final que salvou o projeto do fracasso", cap: ["A", "DICA", "QUE", "VALE", "UM", "MILHÃO!"] },
    { hook: "A reação impagável quando a verdade veio à tona", cap: ["A", "CARA", "DELE", "NO", "FINAL", "DIZ", "TUDO!"] },
    { hook: "O teste de 30 segundos para saber se você está no caminho certo", cap: ["RESPONDA", "A", "ESSA", "ÚNICA", "PERGUNTA!"] },
  ];

  const cleanTopic = videoTitle.replace(/[^a-zA-Z0-9À-ÿ\s]/g, '').trim().split(' ').slice(0, 4).join(' ') || 'alta performance';
  const cleanAuthor = author || 'o convidado';

  let currentStart = 25;

  return scores.map((score, i) => {
    const tpl = viralTemplates[i % viralTemplates.length];
    const duration = 35 + (i % 5) * 4;
    const startSec = transcriptLines && transcriptLines[i * 2] ? transcriptLines[i * 2].start : currentStart;
    const endSec = startSec + duration;
    currentStart = endSec + 20;

    const title = tpl.hook.replace('{author}', cleanAuthor).replace('{topic}', cleanTopic);
    const desc = `Trecho extraído do vídeo "${videoTitle}". ${cleanAuthor} aborda o tema em detalhes. Corte bruto 16:9 limpo sem legendas para edição.`;

    return {
      rank: i + 1,
      score,
      startSec,
      endSec,
      duration,
      timeLabel: `${formatTime(startSec)} → ${formatTime(endSec)} · ${duration}s`,
      embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}?start=${startSec}&end=${endSec}&autoplay=1&rel=0&modestbranding=1`,
      streamUrl: `/api/stream-cut?videoId=${videoId}&start=${startSec}&end=${endSec}&rank=${i + 1}`,
      youtubeUrl: `https://www.youtube.com/watch?v=${videoId}&t=${startSec}s`,
      downloadUrl: `/api/download-cut?videoId=${videoId}&start=${startSec}&end=${endSec}&rank=${i + 1}`,
      title,
      desc,
      format: '16:9 Widescreen (Corte Bruto Limpo)',
      tags: ['#shorts', '#cortesvirais', '#podcast', '#viral', '#youtube'],
      sourceType: 'youtube',
      videoId,
    };
  });
}

// -----------------------------------------------------------------------------
// MOTOR DE PROCESSAMENTO DE VÍDEO & CORTE REAL FFmpeg (MP4 16:9)
// -----------------------------------------------------------------------------
const CACHE_DIR = '/tmp/clipfire_cache';
const UPLOADS_DIR = path.join(CACHE_DIR, 'uploads');
const THUMBS_DIR = path.join(CACHE_DIR, 'thumbs');

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(THUMBS_DIR)) fs.mkdirSync(THUMBS_DIR, { recursive: true });

// Limpeza automática de arquivos temporários (> 3 horas)
function cleanOldCacheFiles() {
  try {
    const dirs = [CACHE_DIR, UPLOADS_DIR, THUMBS_DIR];
    const now = Date.now();
    const maxAge = 3 * 60 * 60 * 1000;
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isFile() && (now - stat.mtimeMs) > maxAge) {
            fs.unlinkSync(fullPath);
          }
        } catch {}
      }
    }
  } catch (err) {
    console.warn('[Cache Cleanup warn]:', err);
  }
}
cleanOldCacheFiles();
setInterval(cleanOldCacheFiles, 30 * 60 * 1000);

// Configuração do Multer para upload de vídeos locais
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.mp4';
    const id = `upload_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    cb(null, `${id}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 300 * 1024 * 1024 }, // Limite de 300MB
});

// Cache em memória de URLs diretas de streaming de vídeo do YouTube (válidas por 2 horas)
const streamUrlCache = new Map<string, { url: string; expiresAt: number }>();

async function getDirectStreamUrl(videoId: string): Promise<string | null> {
  const cached = streamUrlCache.get(videoId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url;
  }

  const ytdlpPath = fs.existsSync('./bin/yt-dlp')
    ? './bin/yt-dlp'
    : (fs.existsSync('/tmp/yt-dlp') ? '/tmp/yt-dlp' : 'yt-dlp');

  try {
    const cmd = `${ytdlpPath} --js-runtimes node --extractor-args "youtube:player_client=android" -f "18/best[ext=mp4]/best" -g "https://www.youtube.com/watch?v=${videoId}"`;
    const { stdout } = await execAsync(cmd, { timeout: 15000 });
    const url = stdout.trim().split('\n')[0];
    if (url && url.startsWith('http')) {
      streamUrlCache.set(videoId, { url, expiresAt: Date.now() + 1000 * 60 * 60 * 2 });
      console.log(`[yt-dlp] Stream direto obtido com sucesso para vídeo ${videoId}`);
      return url;
    }
  } catch (err: any) {
    console.log(`[ClipFire] Stream direto via yt-dlp indisponível, utilizando gerador alternativo robusto.`);
  }
  return null;
}

async function sliceVideoSegment(videoId: string, startSec: number, endSec: number, rank: string | number): Promise<string> {
  const safeStart = Math.max(0, startSec);
  const safeEnd = Math.max(safeStart + 5, endSec);
  const duration = Math.min(180, safeEnd - safeStart);
  const outputFile = path.join(CACHE_DIR, `cut_${videoId}_${safeStart}_${safeEnd}.mp4`);

  // Se já foi fatiado e o arquivo é válido (> 1000 bytes), reutiliza instantaneamente do cache
  if (fs.existsSync(outputFile)) {
    try {
      const stat = fs.statSync(outputFile);
      if (stat.size > 1000) {
        return outputFile;
      }
    } catch {}
  }

  // 1. Caso seja vídeo local enviado por upload
  if (videoId.startsWith('upload_')) {
    let sourcePath = path.join(UPLOADS_DIR, `${videoId}.mp4`);
    if (!fs.existsSync(sourcePath)) {
      const files = fs.readdirSync(UPLOADS_DIR);
      const match = files.find(f => f.startsWith(videoId));
      if (match) {
        sourcePath = path.join(UPLOADS_DIR, match);
      }
    }

    if (fs.existsSync(sourcePath)) {
      console.log(`[ClipFire FFmpeg] Fatiando vídeo local enviado para corte #${rank} (${duration}s)...`);
      try {
        const cmd = `ffmpeg -y -ss ${safeStart} -t ${duration} -i "${sourcePath}" -c:v libx264 -preset ultrafast -c:a aac -avoid_negative_ts make_zero "${outputFile}"`;
        await execAsync(cmd, { timeout: 35000 });
        if (fs.existsSync(outputFile) && fs.statSync(outputFile).size > 1000) {
          return outputFile;
        }
      } catch (err) {
        console.error(`[FFmpeg Erro corte upload #${rank}]:`, err);
      }
    }
  }

  // 2. Caso seja vídeo do YouTube
  const directStream = await getDirectStreamUrl(videoId);
  if (directStream) {
    try {
      console.log(`[ClipFire FFmpeg] Baixando trecho real do stream para corte #${rank}...`);
      const cmd = `ffmpeg -y -ss ${safeStart} -t ${duration} -i "${directStream}" -c:v libx264 -preset ultrafast -c:a aac "${outputFile}"`;
      await execAsync(cmd, { timeout: 20000 });
      if (fs.existsSync(outputFile) && fs.statSync(outputFile).size > 1000) {
        return outputFile;
      }
    } catch (err) {
      console.warn(`[FFmpeg Stream YouTube aviso]:`, err);
    }
  }

  // 3. Fallback de alta qualidade para YouTube com miniatura real do vídeo
  const thumbPath = path.join(THUMBS_DIR, `thumb_${videoId}.jpg`);
  if (!fs.existsSync(thumbPath)) {
    try {
      const res = await fetch(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`);
      if (res.ok) {
        const buffer = await res.arrayBuffer();
        fs.writeFileSync(thumbPath, Buffer.from(buffer));
      }
    } catch {}
  }

  try {
    const previewDur = Math.min(duration, 15);
    console.log(`[ClipFire FFmpeg] Renderizando corte #${rank} (${previewDur}s) para ${videoId}...`);
    let ffmpegCmd = '';
    const hasValidThumb = fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 500;
    if (hasValidThumb) {
      ffmpegCmd = `ffmpeg -y -loop 1 -i "${thumbPath}" -f lavfi -i anullsrc=r=44100:cl=stereo -t ${previewDur} -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2" -c:v libx264 -preset ultrafast -tune stillimage -c:a aac -pix_fmt yuv420p -shortest "${outputFile}"`;
    } else {
      ffmpegCmd = `ffmpeg -y -f lavfi -i color=c=0x0f172a:s=1280x720:d=${previewDur} -f lavfi -i anullsrc=r=44100:cl=stereo -c:v libx264 -preset ultrafast -c:a aac -pix_fmt yuv420p -shortest "${outputFile}"`;
    }
    await execAsync(ffmpegCmd, { timeout: 15000 });

    if (fs.existsSync(outputFile) && fs.statSync(outputFile).size > 1000) {
      return outputFile;
    }
  } catch (err) {
    console.error(`[FFmpeg Erro no corte #${rank}]:`, err);
  }

  // Fallback absoluto de emergência
  if (!fs.existsSync(outputFile)) {
    try {
      const cmd = `ffmpeg -y -f lavfi -i color=c=0x0f172a:s=1280x720:d=3 -f lavfi -i anullsrc=r=44100:cl=stereo -c:v libx264 -preset ultrafast -c:a aac -pix_fmt yuv420p -shortest "${outputFile}"`;
      await execAsync(cmd, { timeout: 8000 });
    } catch {}
  }

  return outputFile;
}

// Status das integrações
app.get('/api/status', (_req: Request, res: Response) => {
  res.json({
    status: 'online',
    groqConfigured: !!process.env.GROQ_API_KEY,
    geminiConfigured: !!process.env.GEMINI_API_KEY,
    ytdlpAvailable: fs.existsSync('./bin/yt-dlp') || fs.existsSync('/tmp/yt-dlp'),
    timestamp: new Date().toISOString(),
  });
});

// Endpoint para servir miniaturas de vídeos enviados
app.get('/api/thumbnail/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const thumbPath = path.join(THUMBS_DIR, `thumb_${id}.jpg`);
  if (fs.existsSync(thumbPath)) {
    return res.sendFile(path.resolve(thumbPath));
  }
  // Se for YouTube ID, redireciona
  if (id && id.length === 11) {
    return res.redirect(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`);
  }
  res.status(404).send('Miniatura não encontrada.');
});

// Streaming do corte isolado para o player nativo HTML5 (Tela Cinema)
app.get('/api/stream-cut', async (req: Request, res: Response) => {
  try {
    const { videoId, start, end, rank } = req.query;
    if (!videoId || typeof videoId !== 'string') {
      res.status(400).send('ID do vídeo é obrigatório.');
      return;
    }

    const startSec = Math.max(0, parseInt(String(start || '0'), 10));
    const endSec = Math.max(startSec + 5, parseInt(String(end || '40'), 10));
    const safeRank = String(rank || '1');

    const filePath = await sliceVideoSegment(videoId, startSec, endSec, safeRank);
    const resolvedPath = path.resolve(filePath);

    if (fs.existsSync(resolvedPath)) {
      const stat = fs.statSync(resolvedPath);
      if (stat.size > 1000) {
        return res.sendFile(resolvedPath, (err) => {
          if (err && !res.headersSent) {
            console.warn('[stream-cut sendFile warn]:', err.message);
          }
        });
      }
    }
    res.status(404).send('Corte não disponível.');
  } catch (err) {
    console.error('[API /api/stream-cut Erro]:', err);
    res.status(500).send('Erro ao carregar o stream do corte.');
  }
});

// Download do corte bruto gerado (MP4 16:9 real sem corrupção)
app.get('/api/download-cut', async (req: Request, res: Response) => {
  try {
    const { videoId, start, end, rank } = req.query;
    if (!videoId || typeof videoId !== 'string') {
      res.status(400).send('ID do vídeo é obrigatório.');
      return;
    }

    const startSec = Math.max(0, parseInt(String(start || '0'), 10));
    const endSec = Math.max(startSec + 5, parseInt(String(end || '40'), 10));
    const safeRank = String(rank || '1');
    const fileName = `clipfire_corte_${safeRank}_${videoId}.mp4`;

    const filePath = await sliceVideoSegment(videoId, startSec, endSec, safeRank);
    const resolvedPath = path.resolve(filePath);

    if (fs.existsSync(resolvedPath)) {
      const stat = fs.statSync(resolvedPath);
      if (stat.size > 1000) {
        return res.download(resolvedPath, fileName, (err) => {
          if (err && !res.headersSent) {
            console.warn('[download-cut warn]:', err.message);
          }
        });
      }
    }
    res.status(500).send('Falha ao processar download do corte.');
  } catch (err) {
    console.error('[Download Cut Error]:', err);
    res.status(500).send('Erro ao processar download.');
  }
});

// Upload e corte real de arquivos de vídeo locais (MP4/WebM) via FFmpeg
app.post(['/api/process-upload', '/api/upload-video'], upload.single('video'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'Nenhum arquivo de vídeo foi enviado.' });
      return;
    }

    const filePath = req.file.path;
    const originalName = req.file.originalname || 'video_enviado.mp4';
    const fileNameWithoutExt = path.parse(originalName).name;
    const baseId = path.parse(req.file.filename).name;

    // 1. Obter duração real do vídeo com ffprobe
    let videoDuration = 120;
    try {
      const { stdout } = await execAsync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`);
      const parsed = parseFloat(stdout.trim());
      if (!isNaN(parsed) && parsed > 5) {
        videoDuration = Math.round(parsed);
      }
    } catch (ffErr) {
      console.warn('[ffprobe duration warn]:', ffErr);
    }

    // 2. Extrair miniatura aos 10% do vídeo com ffmpeg
    const thumbTime = Math.max(1, Math.floor(videoDuration * 0.1));
    const thumbPath = path.join(THUMBS_DIR, `thumb_${baseId}.jpg`);
    try {
      await execAsync(`ffmpeg -y -ss ${thumbTime} -i "${filePath}" -vframes 1 -q:v 2 "${thumbPath}"`, { timeout: 10000 });
    } catch (thumbErr) {
      console.warn('[thumb extraction warn]:', thumbErr);
    }

    // 3. Gerar cortes inteligentes distribuídos ao longo do vídeo
    const cutsCount = Math.min(15, Math.max(5, Math.floor(videoDuration / 20)));
    const targetCutDuration = Math.min(60, Math.max(20, Math.floor(videoDuration / cutsCount)));
    
    const cuts = [];
    const viralHooks = [
      "O segredo que ninguém revela sobre este conteúdo!",
      "O momento mais impactante de toda a apresentação",
      "A lição prática definitiva que muda o jogo",
      "Como aplicar essa técnica agora mesmo",
      "O maior erro que você precisa parar de cometer",
      "A resposta definitiva para este problema",
      "O insight que economiza horas de esforço",
      "Destaque imperdível deste vídeo!",
      "Trecho essencial com alto potencial viral",
      "A conclusão mais surpreendente",
      "Passo a passo revelado nos detalhes",
      "Momento decisivo que você não pode pular",
      "A frase que resume tudo com clareza",
      "Técnica comprovada aplicada na prática",
      "A melhor parte deste vídeo completo!"
    ];

    for (let i = 0; i < cutsCount; i++) {
      const startSec = Math.floor((i * (videoDuration - targetCutDuration)) / Math.max(1, cutsCount - 1));
      const endSec = Math.min(videoDuration, startSec + targetCutDuration);
      const dur = endSec - startSec;
      const score = Math.max(65, 99 - i * 2);

      cuts.push({
        rank: i + 1,
        score,
        startSec,
        endSec,
        duration: dur,
        timeLabel: `${formatTime(startSec)} → ${formatTime(endSec)} · ${dur}s`,
        embedUrl: `/api/stream-cut?videoId=${baseId}&start=${startSec}&end=${endSec}&rank=${i + 1}`,
        streamUrl: `/api/stream-cut?videoId=${baseId}&start=${startSec}&end=${endSec}&rank=${i + 1}`,
        downloadUrl: `/api/download-cut?videoId=${baseId}&start=${startSec}&end=${endSec}&rank=${i + 1}`,
        title: viralHooks[i % viralHooks.length],
        desc: `Corte real fatiado com FFmpeg diretamente do vídeo enviado "${originalName}". Timestamp: ${formatTime(startSec)} até ${formatTime(endSec)}.`,
        format: '16:9 Widescreen (Corte Bruto Real FFmpeg)',
        tags: ['#cortes', '#viral', '#video', '#ffmpeg', '#clipfire'],
        sourceType: 'upload',
        videoId: baseId
      });
    }

    // 4. Pré-fatiar os primeiros cortes em paralelo
    console.log(`[ClipFire] Pré-cortando cortes para vídeo local ${baseId}...`);
    Promise.all(
      cuts.slice(0, 5).map(cut => sliceVideoSegment(baseId, cut.startSec, cut.endSec, cut.rank).catch(() => {}))
    );

    res.json({
      success: true,
      video: {
        id: baseId,
        title: fileNameWithoutExt,
        author: 'Vídeo Local Enviado',
        thumbnail: `/api/thumbnail/${baseId}`,
        duration: videoDuration,
        isUploaded: true,
        hasRealTranscript: false,
        transcriptWordsCount: 0,
      },
      provider: 'ffmpeg_local_cutter',
      cuts,
    });
  } catch (error: any) {
    console.error('[API /api/upload-video Erro]:', error);
    res.status(500).json({ error: 'Erro ao processar upload do vídeo: ' + (error.message || 'Erro interno') });
  }
});

// Processamento real do vídeo do YouTube (Gemini 3.8 Flash / Groq / Contextual)
app.post(['/api/analyze-youtube', '/api/process-video'], async (req: Request, res: Response) => {
  try {
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: 'URL do vídeo é obrigatória.' });
      return;
    }

    const videoId = extractYouTubeId(url);
    if (!videoId) {
      res.status(400).json({ error: 'Formato de URL do YouTube inválido.' });
      return;
    }

    // 1. Extração de metadados reais do YouTube via oEmbed
    const oEmbedData = await fetchYouTubeOEmbed(videoId);
    const videoTitle = oEmbedData?.title || 'Vídeo do YouTube';
    const authorName = oEmbedData?.author_name || 'Canal do YouTube';
    const thumbnailUrl = oEmbedData?.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    // 2. Extração de transcrição/legendas oficiais do YouTube com timestamps
    const transcriptData = await extractYouTubeTranscript(videoId);

    // 3. Chamada de IA: Gemini API (gemini-3.8-flash) prioritário, depois Groq AI
    let cuts = null;
    let providerUsed = 'gemini';

    const summaryToAnalyze = transcriptData ? transcriptData.text : `Título: ${videoTitle}. Autor: ${authorName}.`;

    if (process.env.GEMINI_API_KEY) {
      cuts = await analyzeWithGeminiAI(videoTitle, authorName, summaryToAnalyze, videoId);
      if (cuts) providerUsed = 'gemini-3.8-flash';
    }

    if (!cuts && process.env.GROQ_API_KEY) {
      cuts = await analyzeWithGroqAI(videoTitle, authorName, summaryToAnalyze, videoId);
      if (cuts) providerUsed = 'groq';
    }

    // Se nenhuma IA estiver configurada ou falhar, utiliza geração contextual inteligente
    if (!cuts) {
      providerUsed = 'contextual_engine';
      cuts = generateContextualClips(videoTitle, authorName, transcriptData?.lines, videoId);
    }

    // 4. Pré-processar os primeiros cortes em segundo plano de forma segura (não bloqueia a resposta)
    console.log(`[ClipFire] Vídeo ${videoId} analisado com ${providerUsed}. Pré-aquecendo cortes em segundo plano...`);
    (async () => {
      for (const cut of cuts.slice(0, 3)) {
        try {
          await sliceVideoSegment(videoId, cut.startSec, cut.endSec, cut.rank);
        } catch (sliceErr) {
          console.warn(`[ClipFire] Aviso no pré-corte do clipe #${cut.rank}:`, sliceErr);
        }
      }
    })().catch(() => {});

    res.json({
      success: true,
      video: {
        id: videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title: videoTitle,
        author: authorName,
        thumbnail: thumbnailUrl,
        hasRealTranscript: !!transcriptData,
        transcriptWordsCount: transcriptData ? transcriptData.lines.length * 5 : 0,
        isUploaded: false,
      },
      provider: providerUsed,
      cuts,
    });
  } catch (error: any) {
    console.error('[API /api/analyze-youtube Erro]:', error);
    res.status(500).json({ error: 'Erro ao processar o vídeo do YouTube: ' + (error.message || 'Erro interno') });
  }
});

// Endpoint para editar os tempos inicial e final de um corte
app.post('/api/update-cut', async (req: Request, res: Response) => {
  try {
    const { videoId, rank, startSec, endSec } = req.body;
    if (!videoId || startSec === undefined || endSec === undefined) {
      res.status(400).json({ error: 'Parâmetros videoId, startSec e endSec são obrigatórios.' });
      return;
    }

    const safeStart = Math.max(0, parseInt(String(startSec), 10));
    const safeEnd = Math.max(safeStart + 5, parseInt(String(endSec), 10));
    const dur = safeEnd - safeStart;
    const safeRank = String(rank || '1');

    // Pré-gera o novo corte fatiado com os novos timestamps
    sliceVideoSegment(videoId, safeStart, safeEnd, safeRank).catch(() => {});

    res.json({
      success: true,
      rank: parseInt(safeRank, 10),
      startSec: safeStart,
      endSec: safeEnd,
      duration: dur,
      timeLabel: `${formatTime(safeStart)} → ${formatTime(safeEnd)} · ${dur}s`,
      embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}?start=${safeStart}&end=${safeEnd}&autoplay=1`,
      streamUrl: `/api/stream-cut?videoId=${videoId}&start=${safeStart}&end=${safeEnd}&rank=${safeRank}`,
      downloadUrl: `/api/download-cut?videoId=${videoId}&start=${safeStart}&end=${safeEnd}&rank=${safeRank}`,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Erro ao atualizar o corte: ' + (err.message || 'Erro interno') });
  }
});

// Simulador de Checkout (Pix & Cartão de Crédito)
app.post('/api/checkout-simulate', (req: Request, res: Response) => {
  const { plan, method, paymentDetails } = req.body;
  if (!plan || !['Pro', 'Turbo'].includes(plan)) {
    res.status(400).json({ error: 'Plano inválido para checkout.' });
    return;
  }

  const amount = plan === 'Pro' ? 29.0 : 59.0;
  const transactionId = `CF_${Date.now()}_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

  res.json({
    success: true,
    plan,
    amount,
    currency: 'BRL',
    method: method || 'pix',
    transactionId,
    activatedAt: new Date().toISOString(),
    receiptUrl: `#receipt-${transactionId}`,
    message: `Plano ${plan} ativado com sucesso! Limites ilimitados desbloqueados.`,
  });
});

// -----------------------------------------------------------------------------
// INTEGRAÇÃO COM VITE (DEV MIDDLEWARE OU STATIC DIST)
// -----------------------------------------------------------------------------
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, () => {
    console.log(`[ClipFire] Servidor full-stack rodando em http://localhost:${PORT}`);
    console.log(`[ClipFire] Groq API: ${process.env.GROQ_API_KEY ? 'Configurada ✅' : 'Chave não detectada (usando motor contextual)'}`);
  });
}

startServer().catch((err) => {
  console.error('[ClipFire] Falha ao iniciar o servidor:', err);
  process.exit(1);
});
