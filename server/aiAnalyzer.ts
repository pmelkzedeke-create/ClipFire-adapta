import fs from 'fs';
import { CutIntervalCandidate } from './types.js';

export function extractYouTubeId(url: string): string | null {
  if (!url) return null;
  const regExp = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  const match = url.trim().match(regExp);
  return match ? match[1] : null;
}

export function formatTime(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export async function fetchYouTubeOEmbed(videoId: string): Promise<{
  title?: string;
  author_name?: string;
  thumbnail_url?: string;
} | null> {
  try {
    const response = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClipFireBot/1.0)' },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export async function extractYouTubeTranscript(
  videoId: string
): Promise<{ text: string; lines: Array<{ start: number; dur: number; text: string }> } | null> {
  try {
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!pageRes.ok) return null;
    const html = await pageRes.text();

    const captionMatch = html.match(/"captionTracks":\s*(\[.*?\])/);
    if (!captionMatch) return null;

    const tracks = JSON.parse(captionMatch[1]);
    if (!tracks || tracks.length === 0) return null;

    const ptTrack = tracks.find((t: any) => t.languageCode?.startsWith('pt')) || tracks[0];
    if (!ptTrack || !ptTrack.baseUrl) return null;

    const timedTextUrl = ptTrack.baseUrl + '&fmt=json3';
    const subRes = await fetch(timedTextUrl, { signal: AbortSignal.timeout(10000) });
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
  } catch {
    return null;
  }
}

/**
 * Transcribes extracted audio directly via Groq Whisper API with real segment timestamps
 * when GROQ_API_KEY is configured.
 */
export async function transcribeAudioWithGroqWhisper(
  mp3FilePath: string,
  signal?: AbortSignal
): Promise<{ text: string; lines: Array<{ start: number; dur: number; text: string }> } | null> {
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) return null;

  try {
    const fileBuffer = await fs.promises.readFile(mp3FilePath);
    const blob = new Blob([fileBuffer], { type: 'audio/mpeg' });
    const form = new FormData();
    form.append('file', blob, 'audio.mp3');
    form.append('model', 'whisper-large-v3-turbo');
    form.append('response_format', 'verbose_json');

    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${groqApiKey}`,
      },
      body: form,
      signal,
    });

    if (!res.ok) return null;
    const data: any = await res.json();
    const segments: any[] = Array.isArray(data?.segments) ? data.segments : [];
    if (segments.length === 0 && !data?.text) return null;

    const lines: Array<{ start: number; dur: number; text: string }> = [];
    let fullText = '';

    for (const seg of segments) {
      const start = Math.max(0, Number(seg.start || 0));
      const end = Math.max(start + 0.5, Number(seg.end || start + 3));
      const txt = String(seg.text || '').trim();
      if (txt) {
        lines.push({
          start: Number(start.toFixed(2)),
          dur: Number((end - start).toFixed(2)),
          text: txt,
        });
        fullText += `[${formatTime(start)}] ${txt}\n`;
      }
    }

    if (!fullText && data.text) {
      fullText = String(data.text);
    }

    return { text: fullText, lines };
  } catch (err) {
    console.warn('[Groq Whisper] Falha ao transcrever áudio:', err);
    return null;
  }
}

let cachedGroqModel: string | null = null;

async function getBestGroqModel(apiKey: string): Promise<string> {
  if (cachedGroqModel) return cachedGroqModel;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json();
      const availableIds: string[] = (data.data || []).map((m: any) => m.id);

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
          return cachedGroqModel;
        }
      }

      const textModel = availableIds.find(
        (id) => !id.includes('whisper') && !id.includes('guard') && !id.includes('orpheus')
      );
      if (textModel) {
        cachedGroqModel = textModel;
        return cachedGroqModel;
      }
    }
  } catch {
    // ignore
  }

  cachedGroqModel = 'llama-3.3-70b-versatile';
  return cachedGroqModel;
}

/**
 * Determines how many distinct clips and what clip length range fits naturally
 * inside the real video duration from FFprobe so every rendered MP4 is non-empty and meaningful.
 */
function computeOptimalClipPlan(videoDurationSec: number, requestedMaxClips: number): {
  targetCount: number;
  minClipDur: number;
  maxClipDur: number;
} {
  if (videoDurationSec <= 8) {
    return {
      targetCount: 1,
      minClipDur: Math.max(1.5, Number((videoDurationSec * 0.7).toFixed(2))),
      maxClipDur: Number(videoDurationSec.toFixed(2)),
    };
  }
  if (videoDurationSec <= 25) {
    const count = Math.min(requestedMaxClips, Math.max(2, Math.floor(videoDurationSec / 5)));
    const slot = videoDurationSec / count;
    return {
      targetCount: count,
      minClipDur: Math.max(2.5, Number((slot * 0.72).toFixed(2))),
      maxClipDur: Math.max(3.5, Number((slot * 0.92).toFixed(2))),
    };
  }
  if (videoDurationSec <= 90) {
    const count = Math.min(requestedMaxClips, Math.max(3, Math.floor(videoDurationSec / 10)));
    const slot = videoDurationSec / count;
    return {
      targetCount: count,
      minClipDur: Math.max(5, Number((slot * 0.65).toFixed(2))),
      maxClipDur: Math.min(35, Math.max(8, Number((slot * 0.92).toFixed(2)))),
    };
  }
  if (videoDurationSec <= 600) {
    const count = Math.min(requestedMaxClips, Math.max(4, Math.floor(videoDurationSec / 28)));
    return {
      targetCount: count,
      minClipDur: 18,
      maxClipDur: Math.min(50, Math.max(24, Math.floor(videoDurationSec / count))),
    };
  }

  return {
    targetCount: requestedMaxClips,
    minClipDur: 30,
    maxClipDur: 55,
  };
}

/**
 * Normalizes and clamps AI-returned intervals strictly inside [0, videoDurationSec]
 * so FFmpeg always cuts valid footage from the real source video.
 */
function normalizeIntervalsToVideoDuration(
  rawCuts: Array<Partial<CutIntervalCandidate>>,
  videoDurationSec: number,
  targetCount: number,
  minClipDur: number,
  maxClipDur: number
): CutIntervalCandidate[] {
  const selected = rawCuts.slice(0, targetCount);
  const slotLen = videoDurationSec / Math.max(1, selected.length);

  return selected.map((c, idx) => {
    let start = Number(c.startSec);
    let end = Number(c.endSec);
    let dur = Number(c.duration);

    if (!Number.isFinite(dur) || dur <= 0) {
      dur = Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : (minClipDur + maxClipDur) / 2;
    }
    dur = Math.min(videoDurationSec, Math.max(minClipDur, Math.min(maxClipDur, dur)));

    // If AI returned out-of-bounds start/end, place inside proportional non-overlapping slot
    if (!Number.isFinite(start) || start < 0 || start + 1.2 > videoDurationSec) {
      start = idx * slotLen;
    }

    if (start + dur > videoDurationSec) {
      start = Math.max(0, videoDurationSec - dur);
    }

    start = Number(start.toFixed(2));
    end = Number(Math.min(videoDurationSec, start + dur).toFixed(2));
    const finalDur = Number(Math.max(0.5, end - start).toFixed(2));

    const score = Number.isFinite(Number(c.score))
      ? Math.min(99, Math.max(55, Math.round(Number(c.score))))
      : Math.max(64, 98 - idx * 2);

    return {
      rank: idx + 1,
      score,
      startSec: start,
      endSec: end,
      duration: Math.round(finalDur * 10) / 10,
      timeLabel: `${formatTime(start)} → ${formatTime(end)} · ${Math.round(finalDur)}s`,
      title: String(c.title || `Momento de Alto Impacto #${idx + 1}`).trim(),
      desc: String(c.desc || 'Trecho selecionado com alto potencial de retenção.').trim(),
      captionWords:
        Array.isArray(c.captionWords) && c.captionWords.length > 0
          ? c.captionWords.map((w) => String(w).toUpperCase())
          : ['O', 'MOMENTO', 'MAIS', 'VIRAL', 'DO', 'VÍDEO!'],
      tags:
        Array.isArray(c.tags) && c.tags.length > 0
          ? c.tags.map((t) => (String(t).startsWith('#') ? String(t) : `#${t}`))
          : ['#shorts', '#cortesvirais', '#viral', '#podcast', '#reels'],
    };
  });
}

export async function analyzeWithGroqAI(params: {
  videoTitle: string;
  author: string;
  transcriptSummary: string;
  videoDurationSec: number;
  maxClips: number;
  signal?: AbortSignal;
}): Promise<CutIntervalCandidate[] | null> {
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) return null;

  const plan = computeOptimalClipPlan(params.videoDurationSec, params.maxClips);
  const modelToUse = await getBestGroqModel(groqApiKey);

  const prompt = `Você é um editor sênior especialista em cortes virais para TikTok, Instagram Reels e YouTube Shorts.
Analise as informações e a transcrição real do vídeo abaixo e selecione exatamente ${plan.targetCount} momentos de maior potencial viral.

Vídeo: "${params.videoTitle}"
Canal / Autor: "${params.author}"
Duração REAL exata do arquivo de vídeo: ${params.videoDurationSec.toFixed(1)} segundos (0s até ${params.videoDurationSec.toFixed(1)}s).

IMPORTANTE: Todos os horários (startSec e endSec) DEVEM estar estritamente entre 0 e ${Math.floor(params.videoDurationSec)} segundos, com duração entre ${plan.minClipDur}s e ${plan.maxClipDur}s!

Transcrição / Segmentos com timestamps:
${params.transcriptSummary.slice(0, 6000)}

Para cada um dos ${plan.targetCount} cortes virais, forneça:
1. rank: número de 1 a ${plan.targetCount}
2. score: nota de 62 a 98 com base na força do gancho
3. startSec: segundo exato de início (dentro de 0 a ${Math.floor(params.videoDurationSec)})
4. endSec: segundo exato de término (<= ${params.videoDurationSec.toFixed(1)})
5. duration: duração em segundos (endSec - startSec)
6. title: título viral irresistível em português brasileiro (máx 12 palavras)
7. desc: descrição persuasiva com CTA para engajamento
8. captionWords: lista de 6 a 8 palavras-chave em caixa alta
9. tags: lista de 5 hashtags virais com #

Retorne OBRIGATORIAMENTE um objeto JSON com a chave "cuts" contendo ${plan.targetCount} objetos.`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${groqApiKey}`,
      },
      body: JSON.stringify({
        model: modelToUse,
        messages: [
          {
            role: 'system',
            content: 'Você é um assistente de IA focado estritamente em gerar JSON válido sem texto adicional.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.65,
        max_tokens: 3500,
        response_format: { type: 'json_object' },
      }),
      signal: params.signal,
    });

    if (!response.ok) {
      cachedGroqModel = null;
      return null;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content);
    const cutsArray = Array.isArray(parsed)
      ? parsed
      : parsed.cuts || parsed.segments || parsed.cortes || Object.values(parsed).find((v) => Array.isArray(v));

    if (Array.isArray(cutsArray) && cutsArray.length >= 1) {
      return normalizeIntervalsToVideoDuration(
        cutsArray,
        params.videoDurationSec,
        plan.targetCount,
        plan.minClipDur,
        plan.maxClipDur
      );
    }
    return null;
  } catch (err) {
    console.warn('[Groq AI Analysis Falha]:', err);
    return null;
  }
}

export function generateContextualClips(params: {
  videoTitle: string;
  author: string;
  videoDurationSec: number;
  maxClips: number;
  transcriptLines?: Array<{ start: number; dur: number; text: string }>;
}): CutIntervalCandidate[] {
  const scores = [98, 96, 95, 93, 91, 89, 87, 85, 83, 80, 77, 74, 71, 68, 64];

  const viralTemplates = [
    { hook: 'O momento mais impactante revelado por {author}!', cap: ['ELE', 'NÃO', 'ESPERAVA', 'ESSA', 'RESPOSTA', 'AO', 'VIVO!'] },
    { hook: 'A verdade direta sobre {topic} que poucos explicam', cap: ['PARE', 'DE', 'COMETER', 'ESSE', 'ERRO', 'AGORA!'] },
    { hook: 'A virada exata que mudou o rumo da explicação', cap: ['ESSA', 'FRASE', 'MUDOU', 'TUDO', 'NA', 'HORA!'] },
    { hook: 'Como destravar resultados práticos em {topic}', cap: ['O', 'SEGREDO', 'QUE', 'NUNCA', 'TE', 'CONTARAM!'] },
    { hook: 'O maior erro cometido pela maioria em {topic}', cap: ['99%', 'DAS', 'PESSOAS', 'ERRAM', 'EXATAMENTE', 'AQUI!'] },
    { hook: 'A lição prática que economiza anos de tentativa', cap: ['ESCUTE', 'ISSO', 'COM', 'MUITA', 'ATENÇÃO!'] },
    { hook: 'O argumento decisivo que chamou toda a atenção', cap: ['ESSE', 'PONTO', 'EXPLICOU', 'TUDO', 'DE', 'VEZ!'] },
    { hook: 'Como {author} estruturou essa estratégia passo a passo', cap: ['PASSO', 'A', 'PASSO', 'DIRETO', 'AO', 'PONTO!'] },
    { hook: 'O detalhe essencial escondido bem na nossa frente', cap: ['VOCÊ', 'NUNCA', 'MAIS', 'VAI', 'ESQUECER', 'ISSO!'] },
    { hook: 'A técnica comprovada para manter alta performance', cap: ['APLIQUE', 'ISSO', 'HOJE', 'MESMO', 'NO', 'PROJETO!'] },
    { hook: 'Os bastidores reais que quase ninguém mostra', cap: ['OS', 'BASTIDORES', 'REAIS', 'DA', 'OPERAÇÃO!'] },
    { hook: 'Por que você perde eficiência sem perceber em {topic}', cap: ['SEU', 'TEMPO', 'ESTÁ', 'SENDO', 'DRENADO!'] },
    { hook: 'O conselho chave que diferencia amadores e profissionais', cap: ['A', 'DICA', 'QUE', 'MUDA', 'O', 'JOGO!'] },
    { hook: 'A conclusão mais forte de {author} sobre {topic}', cap: ['O', 'RESUMO', 'DEFINITIVO', 'EM', 'SEGUNDOS!'] },
    { hook: 'O teste rápido para validar se você está no caminho certo', cap: ['RESPONDA', 'A', 'ESSA', 'ÚNICA', 'PERGUNTA!'] },
  ];

  const cleanTopic =
    params.videoTitle
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9À-ÿ\s]/g, ' ')
      .trim()
      .split(/\s+/)
      .slice(0, 4)
      .join(' ') || 'este conteúdo';
  const cleanAuthor = params.author || 'o apresentador';

  const plan = computeOptimalClipPlan(params.videoDurationSec, params.maxClips);
  const count = plan.targetCount;
  const slotSize = params.videoDurationSec / count;

  const validLines = (params.transcriptLines || []).filter(
    (l) => l.start >= 0 && l.start + 1.5 < params.videoDurationSec
  );

  const rawCandidates: Array<Partial<CutIntervalCandidate>> = [];

  for (let i = 0; i < count; i++) {
    const tpl = viralTemplates[i % viralTemplates.length];
    const windowStart = i * slotSize;
    const windowEnd = (i + 1) * slotSize;

    // Prefer snapping start to a real detected speech segment inside this time window
    const speechInWindow = validLines.find(
      (l) => l.start >= windowStart && l.start <= Math.max(windowStart, windowEnd - plan.minClipDur)
    );

    const targetDur = Math.min(
      plan.maxClipDur,
      Math.max(plan.minClipDur, Number((slotSize * 0.82).toFixed(2)))
    );

    let startSec = speechInWindow
      ? speechInWindow.start
      : Number((windowStart + Math.max(0, (slotSize - targetDur) * 0.25)).toFixed(2));

    if (startSec + targetDur > params.videoDurationSec) {
      startSec = Math.max(0, Number((params.videoDurationSec - targetDur).toFixed(2)));
    }
    const endSec = Number(Math.min(params.videoDurationSec, startSec + targetDur).toFixed(2));

    // Extract words from real speech transcript when available
    let captionWords = tpl.cap;
    if (speechInWindow && !speechInWindow.text.startsWith('Segmento de fala ativa')) {
      const words = speechInWindow.text
        .replace(/[^\wÀ-ÿ\s!?]/g, '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 7)
        .map((w) => w.toUpperCase());
      if (words.length >= 4) {
        captionWords = words;
      }
    }

    const title = tpl.hook.replace('{author}', cleanAuthor).replace('{topic}', cleanTopic);
    const desc = `Corte real extraído de "${params.videoTitle}" (${formatTime(startSec)} a ${formatTime(endSec)}). Compartilhe e comente sua opinião!`;

    rawCandidates.push({
      rank: i + 1,
      score: scores[i % scores.length],
      startSec,
      endSec,
      duration: Number((endSec - startSec).toFixed(2)),
      title,
      desc,
      captionWords,
      tags: ['#shorts', '#cortesvirais', '#viral', '#reels', '#tiktok'],
    });
  }

  return normalizeIntervalsToVideoDuration(
    rawCandidates,
    params.videoDurationSec,
    plan.targetCount,
    plan.minClipDur,
    plan.maxClipDur
  );
}
