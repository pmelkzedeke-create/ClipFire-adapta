import React, { useState } from 'react';
import { 
  Flame, Sparkles, Youtube, Download, Play, CheckCircle2, 
  Copy, ShieldCheck, Zap, Video, ExternalLink, RefreshCw, 
  Check, X, Info, Award, CreditCard
} from 'lucide-react';

interface Clip {
  rank: number;
  score: number;
  startSec: number;
  endSec: number;
  duration: number;
  timeLabel: string;
  embedUrl: string;
  streamUrl: string;
  youtubeUrl: string;
  downloadUrl: string;
  title: string;
  desc: string;
  format: string;
  tags: string[];
  sourceType?: 'youtube' | 'upload';
  videoId?: string;
}

interface VideoInfo {
  id: string;
  url: string;
  title: string;
  author: string;
  thumbnail: string;
  hasRealTranscript: boolean;
  transcriptWordsCount: number;
  isUploaded?: boolean;
}

export default function App() {
  const [sourceTab, setSourceTab] = useState<'youtube' | 'upload'>('youtube');
  const [youtubeUrl, setYoutubeUrl] = useState('https://www.youtube.com/watch?v=7mwnXnTkGWo');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState('');
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [clips, setClips] = useState<Clip[]>([]);
  const [_provider, setProvider] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Modal player state
  const [playingClip, setPlayingClip] = useState<Clip | null>(null);
  const [playerMode, setPlayerMode] = useState<'youtube' | 'mp4'>('youtube');
  const [videoLoaded, setVideoLoaded] = useState(false);

  // Checkout modal state
  const [showCheckout, setShowCheckout] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<'Pro' | 'Turbo'>('Pro');
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [checkoutSuccess, setCheckoutSuccess] = useState<any | null>(null);

  // Toast notification
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  const sampleVideos = [
    { title: "Podcast de Tecnologia & IA", url: "https://www.youtube.com/watch?v=7mwnXnTkGWo" },
    { title: "Entrevista Inspiradora", url: "https://www.youtube.com/watch?v=f6DlwMjiMC4" },
    { title: "Debate de Alto Impacto", url: "https://www.youtube.com/watch?v=jfKfPfyJRdk" },
  ];

  const handleGenerate = async (urlToUse?: string) => {
    const targetUrl = urlToUse || youtubeUrl;
    if (!targetUrl.trim()) {
      setErrorMsg('Insira uma URL válida do YouTube.');
      return;
    }

    setLoading(true);
    setErrorMsg(null);
    setLoadingStep('Consultando metadados e legendas oficiais do YouTube...');

    try {
      const stepTimer1 = setTimeout(() => {
        setLoadingStep('Analisando transcrição e detectando ganchos virais com Groq IA...');
      }, 2000);

      const stepTimer2 = setTimeout(() => {
        setLoadingStep('Fatiando e renderizando os 15 cortes em tempo real com FFmpeg e yt-dlp...');
      }, 5000);

      const res = await fetch('/api/process-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl }),
      });

      clearTimeout(stepTimer1);
      clearTimeout(stepTimer2);

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Erro ao processar vídeo.');
      }

      setVideoInfo(data.video);
      setClips(data.cuts || []);
      setProvider(data.provider);
      showToast('15 cortes virais gerados e renderizados com sucesso!');
    } catch (err: any) {
      setErrorMsg(err.message || 'Erro de conexão ao processar o vídeo.');
    } finally {
      setLoading(false);
    }
  };

  const handleUpload = async () => {
    if (!selectedFile) {
      setErrorMsg('Selecione um arquivo de vídeo (MP4/WebM) para fatiar.');
      return;
    }

    setLoading(true);
    setErrorMsg(null);
    setLoadingStep('Enviando arquivo e inspecionando vídeo com FFprobe...');

    try {
      const stepTimer1 = setTimeout(() => {
        setLoadingStep('Fatiando os melhores cortes com FFmpeg no servidor...');
      }, 2500);

      const formData = new FormData();
      formData.append('video', selectedFile);

      const res = await fetch('/api/upload-video', {
        method: 'POST',
        body: formData,
      });

      clearTimeout(stepTimer1);

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Erro ao processar o upload do vídeo.');
      }

      setVideoInfo(data.video);
      setClips(data.cuts || []);
      setProvider(data.provider);
      showToast(`${data.cuts?.length || 15} cortes reais fatiados com FFmpeg com sucesso!`);
    } catch (err: any) {
      setErrorMsg(err.message || 'Erro ao processar o vídeo enviado.');
    } finally {
      setLoading(false);
    }
  };

  const copyClipInfo = (clip: Clip) => {
    const text = `${clip.title}\n\n${clip.desc}\n\nTags: ${clip.tags.join(' ')}\nLink: ${clip.youtubeUrl}`;
    navigator.clipboard.writeText(text);
    showToast(`Corte #${clip.rank} copiado para a área de transferência!`);
  };

  const handleCheckout = async (method: 'pix' | 'card') => {
    setCheckoutLoading(true);
    try {
      const res = await fetch('/api/checkout-simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: selectedPlan, method }),
      });
      const data = await res.json();
      if (data.success) {
        setCheckoutSuccess(data);
        showToast(`Plano ${selectedPlan} ativado com sucesso!`);
      }
    } catch {
      showToast('Erro ao processar pagamento simulado.');
    } finally {
      setCheckoutLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0f1d] text-slate-100 font-sans selection:bg-orange-500 selection:text-white pb-20">
      {/* Toast Notification */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 bg-orange-600 text-white px-5 py-3 rounded-xl shadow-2xl flex items-center space-x-3 border border-orange-400 animate-bounce">
          <CheckCircle2 className="w-5 h-5 text-white" />
          <span className="font-medium text-sm">{toast}</span>
        </div>
      )}

      {/* Header */}
      <header className="border-b border-slate-800 bg-[#0d1424]/80 backdrop-blur-md sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center justify-between">
          <div className="flex items-center space-x-3 cursor-pointer" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
            <div className="w-11 h-11 rounded-xl bg-gradient-to-tr from-orange-600 to-amber-500 flex items-center justify-center shadow-lg shadow-orange-500/30">
              <Flame className="w-6 h-6 text-white animate-pulse" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="text-xl font-black tracking-tight bg-gradient-to-r from-orange-400 via-amber-300 to-yellow-500 bg-clip-text text-transparent">
                  ClipFire
                </span>
                <span className="text-[10px] uppercase tracking-widest bg-orange-500/20 text-orange-400 px-2 py-0.5 rounded-full font-bold border border-orange-500/30">
                  AI Engine
                </span>
              </div>
              <p className="text-xs text-slate-400 hidden sm:block">Gerador Real de Cortes Virais com FFmpeg & Groq</p>
            </div>
          </div>

          <div className="flex items-center space-x-4">
            <div className="hidden md:flex items-center space-x-2 bg-slate-900/80 px-3 py-1.5 rounded-full border border-slate-800 text-xs text-slate-300">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span>
              <span>FFmpeg & yt-dlp Ativos</span>
            </div>
            <button 
              onClick={() => setShowCheckout(true)}
              className="bg-gradient-to-r from-orange-600 to-amber-600 hover:from-orange-500 hover:to-amber-500 text-white font-bold px-5 py-2.5 rounded-xl shadow-lg shadow-orange-600/20 transition-all transform hover:-translate-y-0.5 text-sm flex items-center space-x-2 cursor-pointer"
            >
              <Zap className="w-4 h-4 fill-white" />
              <span>Plano Pro & Ilimitado</span>
            </button>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative pt-12 pb-16 overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-orange-950/30 via-[#0a0f1d] to-[#0a0f1d] pointer-events-none"></div>
        <div className="max-w-4xl mx-auto px-4 sm:px-6 relative z-10 text-center">
          <div className="inline-flex items-center space-x-2 bg-orange-500/10 border border-orange-500/20 px-4 py-1.5 rounded-full text-orange-400 text-xs font-semibold mb-6">
            <Sparkles className="w-4 h-4" />
            <span>Processamento 100% Real no Servidor • Zero Simulações</span>
          </div>

          <h1 className="text-4xl sm:text-6xl font-black tracking-tight text-white mb-6 leading-tight">
            Transforme qualquer vídeo do YouTube em <span className="bg-gradient-to-r from-orange-400 via-amber-400 to-yellow-400 bg-clip-text text-transparent">15 Cortes Virais Prontos</span>
          </h1>

          <p className="text-base sm:text-lg text-slate-300 mb-10 max-w-2xl mx-auto">
            Cole o link do YouTube abaixo. Nossa IA analisa a transcrição e o motor FFmpeg fatia e renderiza os cortes em arquivos MP4 prontos para download e reprodução instantânea.
          </p>

          {/* Source Switcher Tabs */}
          <div className="flex justify-center items-center gap-2 mb-6">
            <button
              onClick={() => setSourceTab('youtube')}
              className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center space-x-2 transition-all cursor-pointer ${
                sourceTab === 'youtube'
                  ? 'bg-orange-600 text-white shadow-lg shadow-orange-600/30'
                  : 'bg-slate-900/80 text-slate-400 hover:text-white border border-slate-800'
              }`}
            >
              <Youtube className="w-4 h-4 text-red-500" />
              <span>Link do YouTube</span>
            </button>
            <button
              onClick={() => setSourceTab('upload')}
              className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center space-x-2 transition-all cursor-pointer ${
                sourceTab === 'upload'
                  ? 'bg-orange-600 text-white shadow-lg shadow-orange-600/30'
                  : 'bg-slate-900/80 text-slate-400 hover:text-white border border-slate-800'
              }`}
            >
              <Download className="w-4 h-4 text-orange-400 rotate-180" />
              <span>Upload de Vídeo Local (MP4)</span>
            </button>
          </div>

          {sourceTab === 'youtube' ? (
            /* URL Input Box */
            <div className="bg-slate-900/90 p-3 rounded-2xl border border-slate-800 shadow-2xl backdrop-blur-xl max-w-2xl mx-auto">
              <div className="flex flex-col sm:flex-row items-center gap-3">
                <div className="relative flex-1 w-full">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-slate-400">
                    <Youtube className="w-5 h-5 text-red-500" />
                  </div>
                  <input 
                    type="text"
                    value={youtubeUrl}
                    onChange={(e) => setYoutubeUrl(e.target.value)}
                    placeholder="https://www.youtube.com/watch?v=..."
                    className="w-full pl-12 pr-4 py-3.5 bg-slate-950 border border-slate-800 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-orange-500 transition-colors text-sm font-medium"
                  />
                </div>
                <button
                  onClick={() => handleGenerate()}
                  disabled={loading}
                  className="w-full sm:w-auto bg-gradient-to-r from-orange-600 to-amber-600 hover:from-orange-500 hover:to-amber-500 text-white font-bold px-8 py-3.5 rounded-xl shadow-xl shadow-orange-600/30 transition-all flex items-center justify-center space-x-2 disabled:opacity-50 text-sm whitespace-nowrap cursor-pointer"
                >
                  {loading ? (
                    <>
                      <RefreshCw className="w-5 h-5 animate-spin" />
                      <span>Processando...</span>
                    </>
                  ) : (
                    <>
                      <Flame className="w-5 h-5 fill-white" />
                      <span>Gerar 15 Cortes</span>
                    </>
                  )}
                </button>
              </div>

              {/* Quick Sample Links */}
              <div className="mt-3 pt-3 border-t border-slate-800/80 flex flex-wrap items-center justify-between text-xs text-slate-400 gap-2">
                <span className="font-semibold text-slate-400 flex items-center space-x-1">
                  <Video className="w-3.5 h-3.5 text-orange-400" />
                  <span>Vídeos de Exemplo:</span>
                </span>
                <div className="flex flex-wrap gap-2">
                  {sampleVideos.map((sample, idx) => (
                    <button
                      key={idx}
                      onClick={() => {
                        setYoutubeUrl(sample.url);
                        handleGenerate(sample.url);
                      }}
                      className="hover:text-orange-400 underline transition-colors cursor-pointer"
                    >
                      {sample.title}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            /* Upload Box */
            <div className="bg-slate-900/90 p-6 rounded-2xl border border-slate-800 shadow-2xl backdrop-blur-xl max-w-2xl mx-auto text-center">
              <input
                type="file"
                id="cf-file-upload-input"
                accept="video/mp4,video/webm,video/quicktime,video/x-matroska,.mp4,.webm,.mov,.mkv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) setSelectedFile(f);
                }}
              />
              <div 
                onClick={() => document.getElementById('cf-file-upload-input')?.click()}
                className="border-2 border-dashed border-orange-500/30 hover:border-orange-500/60 rounded-xl p-6 cursor-pointer transition-colors bg-slate-950/60 flex flex-col items-center justify-center space-y-3"
              >
                <div className="w-12 h-12 rounded-xl bg-orange-600/20 text-orange-400 flex items-center justify-center">
                  <Download className="w-6 h-6 rotate-180" />
                </div>
                <div>
                  <h4 className="text-white font-bold text-sm">Clique para selecionar seu vídeo MP4 ou WebM</h4>
                  <p className="text-xs text-slate-400 mt-1">Até 300MB • Fatiamento real via motor FFmpeg</p>
                </div>
                {selectedFile && (
                  <div className="inline-flex items-center space-x-2 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 px-3 py-1 rounded-full text-xs font-semibold">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>{selectedFile.name} ({(selectedFile.size / (1024 * 1024)).toFixed(1)} MB)</span>
                  </div>
                )}
              </div>
              <button
                onClick={handleUpload}
                disabled={loading || !selectedFile}
                className="mt-4 w-full bg-gradient-to-r from-orange-600 to-amber-600 hover:from-orange-500 hover:to-amber-500 text-white font-bold py-3.5 rounded-xl shadow-xl shadow-orange-600/30 transition-all flex items-center justify-center space-x-2 disabled:opacity-50 text-sm cursor-pointer"
              >
                {loading ? (
                  <>
                    <RefreshCw className="w-5 h-5 animate-spin" />
                    <span>Fatiando com FFmpeg...</span>
                  </>
                ) : (
                  <>
                    <Flame className="w-5 h-5 fill-white" />
                    <span>Fatiar Vídeo com FFmpeg</span>
                  </>
                )}
              </button>
            </div>
          )}

          {errorMsg && (
            <div className="mt-4 max-w-2xl mx-auto bg-red-950/80 border border-red-800 text-red-200 px-4 py-3 rounded-xl text-sm flex items-center space-x-2">
              <Info className="w-5 h-5 flex-shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {loading && (
            <div className="mt-8 max-w-md mx-auto bg-slate-900/80 border border-slate-800 p-6 rounded-2xl text-center space-y-3 animate-pulse">
              <div className="w-10 h-10 mx-auto rounded-full bg-orange-600/20 text-orange-500 flex items-center justify-center">
                <RefreshCw className="w-5 h-5 animate-spin" />
              </div>
              <p className="text-sm font-semibold text-slate-200">{loadingStep}</p>
              <p className="text-xs text-slate-400">O servidor FFmpeg está fatiando os trechos em alta velocidade.</p>
            </div>
          )}
        </div>
      </section>

      {/* Video Info & Results Section */}
      {videoInfo && (
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mb-16">
          {/* Original Video Banner */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 mb-8 backdrop-blur-xl flex flex-col md:flex-row items-center justify-between gap-6">
            <div className="flex items-center space-x-4">
              <img 
                src={videoInfo.thumbnail} 
                alt={videoInfo.title} 
                className="w-28 h-20 object-cover rounded-xl border border-slate-700 shadow-md"
              />
              <div>
                <div className="flex items-center space-x-2 mb-1">
                  <span className="bg-red-600 text-white text-[10px] font-bold px-2 py-0.5 rounded uppercase">YouTube</span>
                  <span className="text-xs text-slate-400 font-medium">{videoInfo.author}</span>
                </div>
                <h2 className="text-lg font-bold text-white line-clamp-1">{videoInfo.title}</h2>
                <p className="text-xs text-emerald-400 mt-1 flex items-center space-x-1">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>{videoInfo.hasRealTranscript ? 'Transcrição Oficial Encontrada' : 'Análise Contextual Ativa'} • {clips.length} cortes gerados e prontos</span>
                </p>
              </div>
            </div>

            <a 
              href={videoInfo.url} 
              target="_blank" 
              rel="noreferrer"
              className="bg-slate-800 hover:bg-slate-700 text-slate-200 px-4 py-2.5 rounded-xl text-xs font-semibold flex items-center space-x-2 transition-colors border border-slate-700"
            >
              <span>Ver no YouTube</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>

          {/* Cuts Grid */}
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-2xl font-black text-white flex items-center space-x-2">
              <Flame className="w-6 h-6 text-orange-500" />
              <span>Top 15 Cortes Virais Renderizados</span>
            </h3>
            <span className="text-xs font-bold bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-800 text-slate-400">
              Formato: 16:9 Widescreen (Pronto para YouTube / TikTok / Reels)
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {clips.map((clip) => (
              <div 
                key={clip.rank}
                className="bg-slate-900/90 border border-slate-800 hover:border-orange-500/50 rounded-2xl overflow-hidden shadow-xl transition-all duration-300 flex flex-col group"
              >
                {/* Clip Thumbnail / Header */}
                <div className="relative h-44 bg-slate-950 flex items-center justify-center overflow-hidden">
                  <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-slate-950/40 to-transparent z-10"></div>
                  
                  {/* Background cover / thumbnail representation */}
                  <img 
                    src={videoInfo.thumbnail} 
                    alt={clip.title}
                    className="w-full h-full object-cover opacity-40 group-hover:scale-105 transition-transform duration-500"
                  />

                  {/* Rank Badge */}
                  <div className="absolute top-3 left-3 z-20 bg-orange-600 text-white font-black text-xs px-3 py-1 rounded-lg shadow-lg flex items-center space-x-1">
                    <Award className="w-3.5 h-3.5" />
                    <span>CORTE #{clip.rank}</span>
                  </div>

                  {/* Virality Score */}
                  <div className="absolute top-3 right-3 z-20 bg-slate-900/90 backdrop-blur-md text-amber-400 font-bold text-xs px-3 py-1 rounded-lg border border-slate-700 shadow-lg flex items-center space-x-1">
                    <Zap className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                    <span>Score {clip.score}</span>
                  </div>

                  {/* Play Overlay Button */}
                  <button
                    onClick={() => setPlayingClip(clip)}
                    className="absolute z-20 w-12 h-12 rounded-full bg-orange-600 hover:bg-orange-500 text-white flex items-center justify-center shadow-xl shadow-orange-600/50 transform group-hover:scale-110 transition-transform cursor-pointer"
                  >
                    <Play className="w-5 h-5 fill-white ml-0.5" />
                  </button>

                  {/* Time Badge */}
                  <div className="absolute bottom-3 left-3 z-20 text-xs font-semibold text-slate-300 bg-slate-900/80 backdrop-blur-md px-2.5 py-1 rounded-md border border-slate-800">
                    ⏱ {clip.timeLabel}
                  </div>
                </div>

                {/* Content Body */}
                <div className="p-5 flex-1 flex flex-col justify-between">
                  <div>
                    <h4 className="font-bold text-white text-base mb-2 line-clamp-2 group-hover:text-orange-400 transition-colors">
                      {clip.title}
                    </h4>
                    <p className="text-xs text-slate-400 line-clamp-2 mb-4">
                      {clip.desc}
                    </p>

                    {/* Tags */}
                    <div className="flex flex-wrap gap-1.5 mb-4">
                      {clip.tags.slice(0, 3).map((tag, tIdx) => (
                        <span key={tIdx} className="text-[10px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded font-medium">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Action Buttons */}
                  <div className="grid grid-cols-3 gap-2 pt-3 border-t border-slate-800">
                    <button
                      onClick={() => {
                        setPlayingClip(clip);
                        setPlayerMode(clip.sourceType === 'upload' ? 'mp4' : 'youtube');
                        setVideoLoaded(false);
                        setTimeout(() => setVideoLoaded(true), 1000);
                      }}
                      className="bg-orange-600/20 hover:bg-orange-600/30 text-orange-400 text-xs font-semibold py-2 rounded-xl border border-orange-500/30 flex items-center justify-center space-x-1 transition-colors cursor-pointer"
                    >
                      <Play className="w-3.5 h-3.5" />
                      <span>Assistir</span>
                    </button>

                    <a
                      href={clip.downloadUrl}
                      className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold py-2 rounded-xl border border-slate-700 flex items-center justify-center space-x-1 transition-colors"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Baixar</span>
                    </a>

                    <button
                      onClick={() => copyClipInfo(clip)}
                      className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold py-2 rounded-xl border border-slate-700 flex items-center justify-center space-x-1 transition-colors cursor-pointer"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copiar</span>
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Video Player Modal (Cinema Mode) */}
      {playingClip && (
        <div id="cf-cinema-modal" className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-md flex items-center justify-center p-4 cf-cinema-modal">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-3xl w-full overflow-hidden shadow-2xl">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
              <div className="flex items-center space-x-2">
                <span className="bg-orange-600 text-white text-xs font-bold px-2.5 py-1 rounded-lg">
                  Corte #{playingClip.rank}
                </span>
                <h3 className="font-bold text-white text-sm sm:text-base line-clamp-1">{playingClip.title}</h3>
              </div>
              <button 
                onClick={() => { setPlayingClip(null); setVideoLoaded(false); }}
                className="w-8 h-8 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white flex items-center justify-center transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Player Switcher Tabs */}
            <div className="px-6 pt-3 flex items-center space-x-2 bg-slate-950/60 border-b border-slate-800/60">
              {playingClip.sourceType !== 'upload' && (
                <button
                  onClick={() => setPlayerMode('youtube')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                    playerMode === 'youtube'
                      ? 'bg-orange-600 text-white shadow'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  ▶ Player Oficial YouTube (Trecho Exato HD)
                </button>
              )}
              <button
                onClick={() => {
                  setPlayerMode('mp4');
                  setVideoLoaded(false);
                  setTimeout(() => setVideoLoaded(true), 1000);
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  playerMode === 'mp4'
                    ? 'bg-orange-600 text-white shadow'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                🎬 Vídeo MP4 do Servidor (FFmpeg)
              </button>
            </div>

            <div className="p-6 bg-black relative">
              <div className="aspect-video w-full bg-slate-950 rounded-2xl overflow-hidden border border-slate-800 flex items-center justify-center relative">
                
                {playerMode === 'youtube' && playingClip.sourceType !== 'upload' ? (
                  <iframe 
                    src={playingClip.embedUrl}
                    className="w-full h-full border-0"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                  />
                ) : (
                  <>
                    {!videoLoaded && (
                      <div className="absolute inset-0 z-30 backdrop-blur-2xl bg-slate-950/85 flex flex-col items-center justify-center p-6 space-y-4 text-center">
                        <div className="relative">
                          <div className="w-16 h-16 rounded-full bg-orange-600/20 border border-orange-500/40 flex items-center justify-center">
                            <Flame className="w-8 h-8 text-orange-500 animate-pulse" />
                          </div>
                          <div className="absolute inset-0 rounded-full border-2 border-orange-500 border-t-transparent animate-spin"></div>
                        </div>
                        <div>
                          <h4 className="text-white font-bold text-base mb-1">Carregando Corte do Servidor FFmpeg</h4>
                          <p className="text-xs text-slate-400 max-w-xs">Preparando o arquivo MP4 para reprodução instantânea...</p>
                        </div>
                      </div>
                    )}

                    <video 
                      src={playingClip.streamUrl}
                      controls
                      autoPlay
                      preload="auto"
                      onLoadedData={() => setVideoLoaded(true)}
                      onCanPlay={() => setVideoLoaded(true)}
                      onLoadedMetadata={() => setVideoLoaded(true)}
                      onError={() => setVideoLoaded(true)}
                      className="w-full h-full object-contain"
                    />
                  </>
                )}
              </div>
            </div>

            <div className="px-6 py-4 bg-slate-900 border-t border-slate-800 flex items-center justify-between">
              <span className="text-xs text-slate-400">⏱ Trecho: {playingClip.timeLabel}</span>
              <div className="flex items-center space-x-3">
                <a 
                  href={playingClip.downloadUrl}
                  className="bg-orange-600 hover:bg-orange-500 text-white font-bold px-4 py-2 rounded-xl text-xs flex items-center space-x-2 shadow-lg shadow-orange-600/30 transition-all"
                >
                  <Download className="w-4 h-4" />
                  <span>Baixar MP4</span>
                </a>
                <button
                  onClick={() => copyClipInfo(playingClip)}
                  className="bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold px-4 py-2 rounded-xl text-xs flex items-center space-x-2 transition-colors border border-slate-700"
                >
                  <Copy className="w-4 h-4" />
                  <span>Copiar Info</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Checkout / Pricing Modal */}
      {showCheckout && (
        <div className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-xl w-full overflow-hidden shadow-2xl p-6 sm:p-8">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center space-x-2">
                <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-orange-600 to-amber-500 flex items-center justify-center">
                  <Zap className="w-5 h-5 text-white" />
                </div>
                <h3 className="text-xl font-black text-white">ClipFire Pro & Turbo</h3>
              </div>
              <button 
                onClick={() => { setShowCheckout(false); setCheckoutSuccess(null); }}
                className="w-8 h-8 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white flex items-center justify-center transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {checkoutSuccess ? (
              <div className="text-center py-8 space-y-4">
                <div className="w-16 h-16 mx-auto bg-emerald-500/20 border border-emerald-500 text-emerald-400 rounded-full flex items-center justify-center">
                  <CheckCircle2 className="w-8 h-8" />
                </div>
                <h4 className="text-2xl font-black text-white">Pagamento Aprovado!</h4>
                <p className="text-slate-300 text-sm">Transação ID: <span className="text-orange-400 font-mono">{checkoutSuccess.transactionId}</span></p>
                <p className="text-xs text-slate-400">{checkoutSuccess.message}</p>
                <button
                  onClick={() => { setShowCheckout(false); setCheckoutSuccess(null); }}
                  className="mt-4 bg-orange-600 hover:bg-orange-500 text-white font-bold px-6 py-2.5 rounded-xl text-sm"
                >
                  Continuar Criando Cortes
                </button>
              </div>
            ) : (
              <div className="space-y-6">
                <div className="grid grid-cols-2 gap-4">
                  <div 
                    onClick={() => setSelectedPlan('Pro')}
                    className={`cursor-pointer border p-4 rounded-2xl transition-all ${selectedPlan === 'Pro' ? 'bg-orange-600/10 border-orange-500 shadow-lg shadow-orange-500/10' : 'bg-slate-950 border-slate-800'}`}
                  >
                    <div className="flex justify-between items-center mb-2">
                      <span className="font-bold text-white text-sm">Plano Pro</span>
                      {selectedPlan === 'Pro' && <Check className="w-4 h-4 text-orange-500" />}
                    </div>
                    <div className="text-2xl font-black text-white mb-1">R$ 29<span className="text-xs text-slate-400 font-normal">/mês</span></div>
                    <p className="text-[11px] text-slate-400">Gerações ilimitadas e exportação em 4K.</p>
                  </div>

                  <div 
                    onClick={() => setSelectedPlan('Turbo')}
                    className={`cursor-pointer border p-4 rounded-2xl transition-all ${selectedPlan === 'Turbo' ? 'bg-orange-600/10 border-orange-500 shadow-lg shadow-orange-500/10' : 'bg-slate-950 border-slate-800'}`}
                  >
                    <div className="flex justify-between items-center mb-2">
                      <span className="font-bold text-white text-sm">Plano Turbo</span>
                      {selectedPlan === 'Turbo' && <Check className="w-4 h-4 text-orange-500" />}
                    </div>
                    <div className="text-2xl font-black text-white mb-1">R$ 59<span className="text-xs text-slate-400 font-normal">/mês</span></div>
                    <p className="text-[11px] text-slate-400">IA prioritária Groq e legendas automáticas em lote.</p>
                  </div>
                </div>

                <div className="bg-slate-950 p-4 rounded-2xl border border-slate-800 space-y-3">
                  <div className="flex items-center justify-between text-xs text-slate-300">
                    <span>Valor Total ({selectedPlan}):</span>
                    <span className="font-bold text-white text-sm">{selectedPlan === 'Pro' ? 'R$ 29,00' : 'R$ 59,00'}</span>
                  </div>
                  <div className="flex items-center space-x-2 text-[11px] text-emerald-400">
                    <ShieldCheck className="w-4 h-4" />
                    <span>Ambiente seguro simulado com aprovação imediata</span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => handleCheckout('pix')}
                    disabled={checkoutLoading}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 rounded-xl text-sm flex items-center justify-center space-x-2 transition-all shadow-lg shadow-emerald-600/20 cursor-pointer"
                  >
                    <span>Pagar com Pix</span>
                  </button>
                  <button
                    onClick={() => handleCheckout('card')}
                    disabled={checkoutLoading}
                    className="bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 rounded-xl text-sm flex items-center justify-center space-x-2 transition-all shadow-lg shadow-blue-600/20 cursor-pointer"
                  >
                    <CreditCard className="w-4 h-4" />
                    <span>Cartão de Crédito</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-20 pt-8 border-t border-slate-800/80 text-center text-xs text-slate-500">
        <p>© {new Date().getFullYear()} ClipFire AI Engine. Todos os direitos reservados. Powered by FFmpeg & Groq.</p>
      </footer>
    </div>
  );
}
