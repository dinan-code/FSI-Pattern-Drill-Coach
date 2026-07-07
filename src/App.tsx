import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Eye,
  Keyboard,
  Mic,
  MicOff,
  Pause,
  Play,
  RotateCcw,
  Settings,
  SkipForward,
  Trophy,
  Volume2,
  XCircle
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { drillSets, levelOrder } from "./data/drills";
import { useLocalStorage } from "./hooks/useLocalStorage";
import { useSpeechRecognition } from "./hooks/useSpeechRecognition";
import type { AppSettings, AttemptRecord, DrillMode, DrillProgress, FeedbackStatus } from "./types";
import { getAccuracy, scoreAnswer } from "./utils/scoring";

const DRILLS_PER_MODE = 20;

const defaultProgress: DrillProgress = {
  attempts: [],
  completedSets: [],
  lastSetId: drillSets[0].id
};

const defaultSettings: AppSettings = {
  autoSpeak: true,
  autoAdvance: true,
  voiceLoop: true,
  showBaseSentence: true,
  strictness: "standard",
  pace: "standard"
};

const paceDelay: Record<AppSettings["pace"], number> = {
  fast: 650,
  standard: 1000,
  slow: 1600
};

const modeCopy: Record<DrillMode, { label: string; short: string; description: string }> = {
  substitution: {
    label: "Substitution Drill",
    short: "替换",
    description: "听提示词，保持句型不变，只替换目标成分。"
  },
  transformation: {
    label: "Transformation Drill",
    short: "转换",
    description: "按提示改变时态、肯否定、疑问句或人称。"
  }
};

export default function App() {
  const [progress, setProgress] = useLocalStorage<DrillProgress>("fsi-drill-progress-v1", defaultProgress);
  const [settings, setSettings] = useLocalStorage<AppSettings>("fsi-drill-settings-v1", defaultSettings);
  const [selectedSetId, setSelectedSetId] = useState(() =>
    drillSets.some((set) => set.id === progress.lastSetId) ? progress.lastSetId : drillSets[0].id
  );
  const [mode, setMode] = useState<DrillMode>("substitution");
  const [stepIndex, setStepIndex] = useState(0);
  const [answer, setAnswer] = useState("");
  const [feedback, setFeedback] = useState<FeedbackStatus>("idle");
  const [lastScore, setLastScore] = useState(0);
  const [sessionStarted, setSessionStarted] = useState(false);
  const [sessionComplete, setSessionComplete] = useState(false);
  const [runAttempts, setRunAttempts] = useState<AttemptRecord[]>([]);
  const [promptStartedAt, setPromptStartedAt] = useState(Date.now());
  const [ttsMessage, setTtsMessage] = useState("");
  const advanceTimerRef = useRef<number | null>(null);
  const autoListenNextRef = useRef(false);
  const speechAutoSubmitRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const speechBeaconRef = useRef<HTMLImageElement | null>(null);
  const ttsFallbackTimerRef = useRef<number | null>(null);
  const ttsRequestIdRef = useRef(0);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const appSettings = useMemo<AppSettings>(() => ({ ...defaultSettings, ...settings }), [settings]);

  const selectedSet = useMemo(
    () => drillSets.find((set) => set.id === selectedSetId) ?? drillSets[0],
    [selectedSetId]
  );
  const drillGroups = useMemo(
    () =>
      levelOrder.map((level) => ({
        level,
        sets: drillSets.filter((set) => set.level === level)
      })),
    []
  );

  const modeItems = mode === "substitution" ? selectedSet.substitution : selectedSet.transformation;
  const currentCue = modeItems[Math.min(stepIndex, DRILLS_PER_MODE - 1)];
  const currentTarget = currentCue.target;
  const completedInMode = Math.min(stepIndex, DRILLS_PER_MODE);
  const totalCompleted = (mode === "transformation" ? DRILLS_PER_MODE : 0) + completedInMode;
  const currentSetAttempts = progress.attempts.filter((attempt) => attempt.setId === selectedSet.id);
  const weakAttempts = runAttempts.filter((attempt) => attempt.status === "retry").slice(-5);
  const overallAccuracy = getAccuracy(currentSetAttempts);
  const runAccuracy = getAccuracy(runAttempts);
  const hasPassedCurrent = feedback === "correct" || feedback === "almost" || feedback === "revealed";
  const runtimeRef = useRef({
    appSettings,
    currentCue,
    currentTarget,
    mode,
    promptStartedAt,
    selectedSetId: selectedSet.id,
    sessionComplete,
    sessionStarted,
    stepIndex
  });

  runtimeRef.current = {
    appSettings,
    currentCue,
    currentTarget,
    mode,
    promptStartedAt,
    selectedSetId: selectedSet.id,
    sessionComplete,
    sessionStarted,
    stepIndex
  };

  const clearAudioPlayback = useCallback(() => {
    if (ttsFallbackTimerRef.current) {
      window.clearTimeout(ttsFallbackTimerRef.current);
      ttsFallbackTimerRef.current = null;
    }
    if (audioSourceRef.current) {
      try {
        audioSourceRef.current.stop();
      } catch {
        // The source may have already ended.
      }
      audioSourceRef.current.disconnect();
      audioSourceRef.current = null;
    }
    if (speechBeaconRef.current) {
      speechBeaconRef.current.remove();
      speechBeaconRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
      audioRef.current.remove();
      audioRef.current = null;
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }, []);

  const pickEnglishVoice = useCallback(() => {
    if (!("speechSynthesis" in window)) return undefined;

    const voices = window.speechSynthesis.getVoices();
    return (
      voices.find((voice) => voice.lang.toLowerCase() === "en-us") ??
      voices.find((voice) => voice.lang.toLowerCase().startsWith("en")) ??
      voices[0]
    );
  }, []);

  const playLocalAudio = useCallback((
    spokenText: string,
    requestId: number,
    finish: (keepMessage?: boolean) => void
  ) => {
    const audioUrl = `/api/tts?text=${encodeURIComponent(spokenText)}`;
    const AudioContextClass =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

    const playWithMediaElement = () => {
      if (ttsRequestIdRef.current !== requestId) return;
      setTtsMessage("正在准备本地朗读...");
      clearAudioPlayback();

      const audio = document.createElement("audio");
      audio.preload = "auto";
      audio.src = audioUrl;
      audio.style.display = "none";
      audioRef.current = audio;
      document.body.appendChild(audio);

      audio.onplay = () => {
        if (ttsRequestIdRef.current === requestId) {
          setTtsMessage("正在朗读...");
        }
      };
      audio.onended = () => finish();
      audio.onerror = () => {
        if (ttsRequestIdRef.current === requestId) {
          setTtsMessage("本地音频播放失败。");
        }
        finish(true);
      };

      audio.load();
      audio.play().catch(() => {
        if (ttsRequestIdRef.current !== requestId) return;
        setTtsMessage("当前浏览器不支持系统朗读，本地朗读也没有启动。请刷新页面后重试。");
        finish(true);
      });
    };

    if (!AudioContextClass) {
      playWithMediaElement();
      return;
    }

    setTtsMessage("正在准备本地朗读...");
    clearAudioPlayback();

    const context = audioContextRef.current ?? new AudioContextClass();
    audioContextRef.current = context;
    context.resume()
      .then(() => fetch(audioUrl))
      .then((response) => {
        if (!response.ok) {
          throw new Error("Local TTS endpoint failed.");
        }
        return response.arrayBuffer();
      })
      .then((buffer) => context.decodeAudioData(buffer))
      .then((audioBuffer) => {
        if (ttsRequestIdRef.current !== requestId) return;

        const source = context.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(context.destination);
        source.onended = () => finish();
        audioSourceRef.current = source;
        setTtsMessage("正在朗读...");
        source.start();
      })
      .catch(playWithMediaElement);
  }, [clearAudioPlayback]);

  const playThroughDefaultDevice = useCallback((
    spokenText: string,
    requestId: number,
    finish: (keepMessage?: boolean) => void
  ) => {
    if (ttsRequestIdRef.current !== requestId) return;

    setTtsMessage("正在调用本机朗读...");
    clearAudioPlayback();

    const beacon = document.createElement("img");
    const fallbackTimer = window.setTimeout(() => {
      if (ttsRequestIdRef.current !== requestId) return;
      speechBeaconRef.current = null;
      beacon.remove();
      setTtsMessage("本机朗读响应超时，请检查 Windows 默认输出设备和系统音量。");
      finish(true);
    }, 12000);
    beacon.alt = "";
    beacon.style.display = "none";
    beacon.onload = () => {
      if (ttsRequestIdRef.current !== requestId) return;
      window.clearTimeout(fallbackTimer);
      speechBeaconRef.current = null;
      beacon.remove();
      finish();
    };
    beacon.onerror = () => {
      if (ttsRequestIdRef.current !== requestId) return;
      window.clearTimeout(fallbackTimer);
      speechBeaconRef.current = null;
      beacon.remove();
      playLocalAudio(spokenText, requestId, finish);
    };
    speechBeaconRef.current = beacon;
    document.body.appendChild(beacon);
    beacon.src = `/api/speak?text=${encodeURIComponent(spokenText)}&request=${requestId}-${Date.now()}`;
  }, [clearAudioPlayback, playLocalAudio]);

  const speak = useCallback((text: string, onEnd?: () => void) => {
    const spokenText = text.trim();
    const requestId = ttsRequestIdRef.current + 1;
    ttsRequestIdRef.current = requestId;

    if (!spokenText) {
      onEnd?.();
      return;
    }

    const finish = (keepMessage = false) => {
      if (ttsRequestIdRef.current !== requestId) return;
      if (ttsFallbackTimerRef.current) {
        window.clearTimeout(ttsFallbackTimerRef.current);
        ttsFallbackTimerRef.current = null;
      }
      utteranceRef.current = null;
      if (!keepMessage) {
        setTtsMessage("");
      }
      onEnd?.();
    };

    clearAudioPlayback();
    setTtsMessage("正在准备朗读...");

    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
      playThroughDefaultDevice(spokenText, requestId, finish);
      return;
    }

    const synth = window.speechSynthesis;
    const play = () => {
      if (ttsRequestIdRef.current !== requestId) return;

      const utterance = new SpeechSynthesisUtterance(spokenText);
      let started = false;
      const voice = pickEnglishVoice();
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      } else {
        utterance.lang = "en-US";
      }
      utterance.rate = 0.92;
      utterance.pitch = 1;
      utterance.volume = 1;
      utterance.onstart = () => {
        if (ttsRequestIdRef.current === requestId) {
          started = true;
          if (ttsFallbackTimerRef.current) {
            window.clearTimeout(ttsFallbackTimerRef.current);
            ttsFallbackTimerRef.current = null;
          }
          setTtsMessage("正在朗读...");
        }
      };
      utterance.onend = () => finish();
      utterance.onerror = () => playThroughDefaultDevice(spokenText, requestId, finish);
      utteranceRef.current = utterance;
      synth.speak(utterance);

      ttsFallbackTimerRef.current = window.setTimeout(() => {
        if (ttsRequestIdRef.current !== requestId || started) return;
        setTtsMessage("浏览器朗读无响应，正在切换到本机朗读...");
        synth.cancel();
        playThroughDefaultDevice(spokenText, requestId, finish);
      }, 1500);

      window.setTimeout(() => {
        if (ttsRequestIdRef.current === requestId && synth.paused) {
          synth.resume();
        }
      }, 80);
    };

    synth.cancel();
    window.setTimeout(play, 60);
  }, [clearAudioPlayback, pickEnglishVoice, playThroughDefaultDevice]);

  const handleFinalTranscript = useCallback((value: string) => {
    setAnswer(value);
    const runtime = runtimeRef.current;

    if (
      !runtime.appSettings.voiceLoop ||
      !runtime.sessionStarted ||
      runtime.sessionComplete ||
      speechAutoSubmitRef.current
    ) {
      return;
    }

    speechAutoSubmitRef.current = true;
    window.setTimeout(() => submitAnswer(value, { fromSpeech: true }), 0);
  }, []);

  const speech = useSpeechRecognition(handleFinalTranscript);

  useEffect(() => {
    if (speech.transcript) {
      setAnswer(speech.transcript);
    }
  }, [speech.transcript]);

  useEffect(() => {
    if ("speechSynthesis" in window) {
      const synth = window.speechSynthesis;
      const loadVoices = () => synth.getVoices();
      loadVoices();
      synth.addEventListener?.("voiceschanged", loadVoices);

      return () => {
        synth.removeEventListener?.("voiceschanged", loadVoices);
        ttsRequestIdRef.current += 1;
        utteranceRef.current = null;
        synth.cancel();
        clearAudioPlayback();
        if (advanceTimerRef.current) {
          window.clearTimeout(advanceTimerRef.current);
        }
      };
    }

    return () => {
      ttsRequestIdRef.current += 1;
      clearAudioPlayback();
      if (advanceTimerRef.current) {
        window.clearTimeout(advanceTimerRef.current);
      }
    };
  }, [clearAudioPlayback]);

  useEffect(() => {
    if (!sessionStarted || sessionComplete) {
      return;
    }

    const shouldAutoListen = autoListenNextRef.current && appSettings.voiceLoop && speech.isSupported;
    autoListenNextRef.current = false;

    if (shouldAutoListen) {
      const timer = window.setTimeout(() => speech.start(), 180);
      return () => window.clearTimeout(timer);
    }
  }, [
    appSettings.voiceLoop,
    mode,
    selectedSet.id,
    sessionComplete,
    sessionStarted,
    speech.isSupported,
    speech.start,
    stepIndex
  ]);

  function resetPromptState() {
    setAnswer("");
    setFeedback("idle");
    setLastScore(0);
    speechAutoSubmitRef.current = false;
    speech.resetTranscript();
    setPromptStartedAt(Date.now());
  }

  function startSession() {
    if (advanceTimerRef.current) window.clearTimeout(advanceTimerRef.current);
    autoListenNextRef.current = appSettings.voiceLoop && speech.isSupported;
    setMode("substitution");
    setStepIndex(0);
    setRunAttempts([]);
    setSessionComplete(false);
    setSessionStarted(true);
    resetPromptState();
  }

  function pauseSession() {
    if (advanceTimerRef.current) window.clearTimeout(advanceTimerRef.current);
    autoListenNextRef.current = false;
    ttsRequestIdRef.current += 1;
    setSessionStarted(false);
    setTtsMessage("");
    speech.stop();
    window.speechSynthesis?.cancel();
    clearAudioPlayback();
  }

  function changeSet(nextSetId: string) {
    if (advanceTimerRef.current) window.clearTimeout(advanceTimerRef.current);
    autoListenNextRef.current = false;
    ttsRequestIdRef.current += 1;
    setTtsMessage("");
    window.speechSynthesis?.cancel();
    clearAudioPlayback();
    setSelectedSetId(nextSetId);
    setProgress((current) => ({ ...current, lastSetId: nextSetId }));
    setMode("substitution");
    setStepIndex(0);
    setRunAttempts([]);
    setSessionStarted(false);
    setSessionComplete(false);
    resetPromptState();
  }

  function submitAnswer(answerOverride?: string, options?: { fromSpeech?: boolean }) {
    const runtime = runtimeRef.current;
    if (!runtime.sessionStarted || runtime.sessionComplete) return;

    const submittedAnswer = (answerOverride ?? answer).trim();
    if (!submittedAnswer) return;

    const result = scoreAnswer(submittedAnswer, runtime.currentTarget, runtime.appSettings.strictness);
    setAnswer(submittedAnswer);
    setFeedback(result.status);
    setLastScore(result.score);

    const attempt: AttemptRecord = {
      setId: runtime.selectedSetId,
      mode: runtime.mode,
      prompt: runtime.currentCue.cue,
      target: runtime.currentTarget,
      answer: submittedAnswer,
      status: result.status,
      score: result.score,
      elapsedMs: Date.now() - runtime.promptStartedAt,
      createdAt: new Date().toISOString()
    };

    setRunAttempts((current) => [...current, attempt]);
    setProgress((current) => ({
      ...current,
      lastSetId: runtime.selectedSetId,
      attempts: [...current.attempts, attempt].slice(-300),
      completedSets:
        runtime.mode === "transformation" && runtime.stepIndex === DRILLS_PER_MODE - 1 && result.status !== "retry"
          ? Array.from(new Set([...current.completedSets, runtime.selectedSetId]))
          : current.completedSets
    }));

    const shouldAutoAdvance =
      runtime.appSettings.autoAdvance &&
      (result.status === "correct" || (!options?.fromSpeech && result.status === "almost"));

    if (shouldAutoAdvance) {
      if (advanceTimerRef.current) window.clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = window.setTimeout(() => {
        goNext({
          continueVoice: Boolean(runtime.appSettings.voiceLoop && result.status === "correct")
        });
      }, paceDelay[runtime.appSettings.pace]);
    } else if (options?.fromSpeech) {
      speechAutoSubmitRef.current = false;
    }
  }

  function revealAnswer() {
    setAnswer(currentTarget);
    setFeedback("revealed");
    setLastScore(1);
  }

  function goNext(options?: { continueVoice?: boolean }) {
    const runtime = runtimeRef.current;
    if (advanceTimerRef.current) window.clearTimeout(advanceTimerRef.current);
    ttsRequestIdRef.current += 1;
    setTtsMessage("");
    window.speechSynthesis?.cancel();
    clearAudioPlayback();
    const shouldContinueVoice = options?.continueVoice ?? runtime.appSettings.voiceLoop;
    autoListenNextRef.current = Boolean(shouldContinueVoice && runtime.appSettings.voiceLoop && speech.isSupported);

    if (runtime.mode === "substitution" && runtime.stepIndex >= DRILLS_PER_MODE - 1) {
      setMode("transformation");
      setStepIndex(0);
      resetPromptState();
      return;
    }

    if (runtime.mode === "transformation" && runtime.stepIndex >= DRILLS_PER_MODE - 1) {
      autoListenNextRef.current = false;
      setSessionComplete(true);
      setSessionStarted(false);
      speech.stop();
      return;
    }

    setStepIndex((current) => current + 1);
    resetPromptState();
  }

  function skipCurrent() {
    autoListenNextRef.current = false;
    setFeedback("revealed");
    goNext();
  }

  function retryCurrent() {
    if (advanceTimerRef.current) window.clearTimeout(advanceTimerRef.current);
    autoListenNextRef.current = false;
    resetPromptState();
  }

  function updateSettings<T extends keyof AppSettings>(key: T, value: AppSettings[T]) {
    setSettings((current) => ({ ...defaultSettings, ...current, [key]: value }));
  }

  const feedbackView = getFeedbackView(feedback, lastScore);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <BookOpen size={22} aria-hidden="true" />
          </div>
          <div>
            <h1>FSI Pattern Drill Coach</h1>
            <p>口语句型自动化训练</p>
          </div>
        </div>

        <section className="panel">
          <div className="panel-title">句型组</div>
          <div className="library-summary">
            <strong>{drillSets.length}</strong>
            <span>A1-C2 句型组</span>
          </div>
          <div className="set-picker">
            <label className="field-label" htmlFor="drill-set-select">
              选择句型组
            </label>
            <select
              className="set-select"
              id="drill-set-select"
              onChange={(event) => changeSet(event.target.value)}
              value={selectedSet.id}
            >
              {drillGroups.map((group) => (
                <optgroup key={group.level} label={`${group.level} · ${group.sets.length} 组`}>
                  {group.sets.map((set) => (
                    <option key={set.id} value={set.id}>
                      {set.title} · {set.focus}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <div className="selected-set-card">
              <div className="selected-set-header">
                <span className="selected-set-level">{selectedSet.level}</span>
                <small>{selectedSet.focus}</small>
              </div>
              <strong>{selectedSet.title}</strong>
              <em>
                {selectedSet.substitution.length} Substitution + {selectedSet.transformation.length} Transformation
              </em>
            </div>
          </div>
        </section>

        <section className="panel settings-panel">
          <div className="panel-title with-icon">
            <Settings size={16} aria-hidden="true" />
            设置
          </div>
          <label className="toggle-row">
            <span>答对后自动下一题</span>
            <input
              checked={appSettings.autoAdvance}
              onChange={(event) => updateSettings("autoAdvance", event.target.checked)}
              type="checkbox"
            />
          </label>
          <label className="toggle-row">
            <span>语音正确后连续开麦</span>
            <input
              checked={appSettings.voiceLoop}
              onChange={(event) => updateSettings("voiceLoop", event.target.checked)}
              type="checkbox"
            />
          </label>
          <label className="toggle-row">
            <span>显示基础句型</span>
            <input
              checked={appSettings.showBaseSentence}
              onChange={(event) => updateSettings("showBaseSentence", event.target.checked)}
              type="checkbox"
            />
          </label>

          <label className="field-label" htmlFor="pace">节奏</label>
          <select
            id="pace"
            onChange={(event) => updateSettings("pace", event.target.value as AppSettings["pace"])}
            value={appSettings.pace}
          >
            <option value="slow">慢速</option>
            <option value="standard">标准</option>
            <option value="fast">快速</option>
          </select>

          <label className="field-label" htmlFor="strictness">反馈严格度</label>
          <select
            id="strictness"
            onChange={(event) => updateSettings("strictness", event.target.value as AppSettings["strictness"])}
            value={appSettings.strictness}
          >
            <option value="lenient">宽松</option>
            <option value="standard">标准</option>
            <option value="strict">严格</option>
          </select>
        </section>
      </aside>

      <section className="trainer">
        <header className="trainer-header">
          <div>
            <div className="eyebrow">{selectedSet.level} · {selectedSet.focus}</div>
            <h2>{selectedSet.baseSentence}</h2>
          </div>
          <div className="mode-switch" aria-label="Drill mode">
            {(["substitution", "transformation"] as DrillMode[]).map((item) => (
              <button
                className={mode === item ? "active" : ""}
                key={item}
                onClick={() => {
                  setMode(item);
                  setStepIndex(0);
                  setSessionStarted(false);
                  setSessionComplete(false);
                  resetPromptState();
                }}
                type="button"
              >
                {modeCopy[item].short}
              </button>
            ))}
          </div>
        </header>

        <div className="progress-block">
          <div className="progress-meta">
            <span>{modeCopy[mode].label}</span>
            <strong>{Math.min(stepIndex + 1, DRILLS_PER_MODE)} / {DRILLS_PER_MODE}</strong>
          </div>
          <div className="progress-track">
            <div style={{ width: `${(totalCompleted / (DRILLS_PER_MODE * 2)) * 100}%` }} />
          </div>
          <p>{modeCopy[mode].description}</p>
        </div>

        <section className={`drill-card ${feedbackView.className}`}>
          <div className="drill-topline">
            <span>{mode === "substitution" ? `替换: ${selectedSet.substitutionSlot}` : "转换提示"}</span>
          </div>

          {appSettings.showBaseSentence && (
            <div className="base-sentence">
              <div className="base-sentence-copy">
                <span>Base</span>
                <strong>{selectedSet.baseSentence}</strong>
              </div>
              <button
                aria-label="朗读基础句型"
                className="icon-button base-speak-button"
                onClick={() => {
                  speech.stop();
                  speak(selectedSet.baseSentence);
                }}
                title="朗读基础句型"
                type="button"
              >
                <Volume2 size={18} aria-hidden="true" />
              </button>
            </div>
          )}

          {ttsMessage && <div className="tts-status">{ttsMessage}</div>}

          <div className="cue-area">
            <div className="cue-label">Cue</div>
            <div className="cue-text">{currentCue.cue}</div>
            {mode === "substitution" && "hint" in currentCue && currentCue.hint && (
              <p>{currentCue.hint}</p>
            )}
          </div>

          <div className="answer-area">
            <label htmlFor="answer">
              <Keyboard size={16} aria-hidden="true" />
              你的回答
            </label>
            <textarea
              id="answer"
              onChange={(event) => setAnswer(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                  submitAnswer();
                }
              }}
              placeholder="点击麦克风后说出完整英文句子，或直接输入..."
              rows={3}
              value={answer}
            />
            {speech.error && <div className="speech-error">{speech.error}</div>}
            {!speech.isSupported && (
              <div className="speech-error">当前浏览器不支持内置语音识别，建议使用 Chrome 或 Edge。</div>
            )}
          </div>

          <div className="feedback-row">
            <div className="feedback-copy">
              {feedbackView.icon}
              <div>
                <strong>{feedbackView.title}</strong>
                <span>{feedbackView.body}</span>
              </div>
            </div>
            {feedback !== "idle" && (
              <div className="score-pill">{Math.round(lastScore * 100)}%</div>
            )}
          </div>

          {(feedback === "almost" || feedback === "retry" || feedback === "revealed") && (
            <div className="target-answer">
              <span>Target</span>
              <strong>{currentTarget}</strong>
            </div>
          )}
        </section>

        <div className="control-bar">
          {!sessionStarted ? (
            <button className="primary-button" onClick={startSession} type="button">
              <Play size={18} aria-hidden="true" />
              {sessionComplete ? "重新开始本组" : "开始训练"}
            </button>
          ) : (
            <button className="secondary-button" onClick={pauseSession} type="button">
              <Pause size={18} aria-hidden="true" />
              暂停
            </button>
          )}

          <button
            className={`mic-button ${speech.isListening ? "listening" : ""}`}
            disabled={!sessionStarted || !speech.isSupported}
            onClick={speech.isListening ? speech.stop : speech.start}
            type="button"
          >
            {speech.isListening ? <MicOff size={18} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
            {speech.isListening ? "停止录音" : "语音作答"}
          </button>

          <button
            className="secondary-button"
            disabled={!sessionStarted || !answer.trim()}
            onClick={() => submitAnswer()}
            type="button"
          >
            <CheckCircle2 size={18} aria-hidden="true" />
            检查
          </button>

          <button
            aria-label="显示答案"
            className="icon-action"
            disabled={!sessionStarted}
            onClick={revealAnswer}
            title="显示答案"
            type="button"
          >
            <Eye size={18} aria-hidden="true" />
          </button>

          <button
            aria-label="重试本题"
            className="icon-action"
            disabled={!sessionStarted}
            onClick={retryCurrent}
            title="重试本题"
            type="button"
          >
            <RotateCcw size={18} aria-hidden="true" />
          </button>

          <button
            className="secondary-button"
            disabled={!sessionStarted && !hasPassedCurrent}
            onClick={() => goNext()}
            type="button"
          >
            <ArrowRight size={18} aria-hidden="true" />
            下一题
          </button>

          <button
            aria-label="跳过"
            className="icon-action"
            disabled={!sessionStarted}
            onClick={skipCurrent}
            title="跳过"
            type="button"
          >
            <SkipForward size={18} aria-hidden="true" />
          </button>
        </div>
      </section>

      <aside className="review">
        <section className="summary-card">
          <div className="summary-icon">
            <Trophy size={22} aria-hidden="true" />
          </div>
          <div>
            <span>本轮正确率</span>
            <strong>{runAccuracy}%</strong>
            <small>{runAttempts.length} / 40 已作答</small>
          </div>
        </section>

        <section className="review-panel">
          <div className="panel-title">当前句型历史</div>
          <div className="metric-grid">
            <div>
              <span>累计题数</span>
              <strong>{currentSetAttempts.length}</strong>
            </div>
            <div>
              <span>历史正确率</span>
              <strong>{overallAccuracy}%</strong>
            </div>
          </div>
        </section>

        <section className="review-panel">
          <div className="panel-title">本轮状态</div>
          <div className="phase-list">
            <PhaseRow
              active={mode === "substitution" && !sessionComplete}
              done={mode === "transformation" || sessionComplete}
              label="20 次替换"
            />
            <PhaseRow
              active={mode === "transformation" && !sessionComplete}
              done={sessionComplete}
              label="20 次转换"
            />
            <PhaseRow active={sessionComplete} done={sessionComplete} label="复盘" />
          </div>
        </section>

        <section className="review-panel">
          <div className="panel-title">最近错题</div>
          {weakAttempts.length === 0 ? (
            <p className="empty-note">本轮还没有需要复练的题。</p>
          ) : (
            <div className="weak-list">
              {weakAttempts.map((attempt) => (
                <div className="weak-item" key={`${attempt.createdAt}-${attempt.prompt}`}>
                  <span>{attempt.mode === "substitution" ? "替换" : "转换"} · {attempt.prompt}</span>
                  <strong>{attempt.target}</strong>
                  <small>你的回答：{attempt.answer || "未识别"}</small>
                </div>
              ))}
            </div>
          )}
        </section>

        {sessionComplete && (
          <section className="complete-panel">
            <h3>本组完成</h3>
            <p>已完成 20 次 Substitution Drill 和 20 次 Transformation Drill。</p>
            <button className="primary-button full" onClick={startSession} type="button">
              <RotateCcw size={18} aria-hidden="true" />
              再练一轮
            </button>
          </section>
        )}
      </aside>
    </main>
  );
}

function PhaseRow({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  return (
    <div className={`phase-row ${active ? "active" : ""} ${done ? "done" : ""}`}>
      <span>{done ? <CheckCircle2 size={16} aria-hidden="true" /> : active ? <Play size={16} aria-hidden="true" /> : null}</span>
      <strong>{label}</strong>
    </div>
  );
}

function getFeedbackView(status: FeedbackStatus, score: number) {
  switch (status) {
    case "correct":
      return {
        className: "correct",
        icon: <CheckCircle2 size={22} aria-hidden="true" />,
        title: "正确",
        body: "句型和关键成分匹配。继续保持速度。"
      };
    case "almost":
      return {
        className: "almost",
        icon: <CheckCircle2 size={22} aria-hidden="true" />,
        title: "接近正确",
        body: `整体接近，建议对照目标答案复述一次。匹配度 ${Math.round(score * 100)}%。`
      };
    case "retry":
      return {
        className: "retry",
        icon: <XCircle size={22} aria-hidden="true" />,
        title: "需要重试",
        body: "句型差异较大。先看提示词，再说完整句子。"
      };
    case "revealed":
      return {
        className: "revealed",
        icon: <Eye size={22} aria-hidden="true" />,
        title: "已显示答案",
        body: "跟读目标句后进入下一题。"
      };
    default:
      return {
        className: "",
        icon: <Mic size={22} aria-hidden="true" />,
        title: "等待作答",
        body: "说出完整英文句子，然后检查。"
      };
  }
}
