import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export function useSpeechRecognition(onFinalTranscript?: (value: string) => void) {
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const onFinalTranscriptRef = useRef(onFinalTranscript);
  const sessionIdRef = useRef(0);
  const [transcript, setTranscript] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState("");

  const Recognition = useMemo(
    () => window.SpeechRecognition ?? window.webkitSpeechRecognition,
    []
  );

  const isSupported = Boolean(Recognition);

  useEffect(() => {
    onFinalTranscriptRef.current = onFinalTranscript;
  }, [onFinalTranscript]);

  const stop = useCallback(() => {
    sessionIdRef.current += 1;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setIsListening(false);
  }, []);

  const start = useCallback(() => {
    if (!Recognition) {
      setError("当前浏览器不支持语音识别，请使用键盘输入。");
      return;
    }

    sessionIdRef.current += 1;
    const sessionId = sessionIdRef.current;
    recognitionRef.current?.abort();
    const recognition = new Recognition();
    recognitionRef.current = recognition;

    setTranscript("");
    setError("");
    setIsListening(true);

    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      if (sessionIdRef.current !== sessionId) return;

      let nextTranscript = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        nextTranscript += event.results[i][0].transcript;
      }

      const cleaned = nextTranscript.trim();
      setTranscript(cleaned);

      const lastResult = event.results[event.results.length - 1];
      if (lastResult?.isFinal && cleaned) {
        onFinalTranscriptRef.current?.(cleaned);
      }
    };

    recognition.onerror = (event) => {
      if (sessionIdRef.current !== sessionId) return;

      if (event.error === "aborted" || event.error === "no-speech") {
        setIsListening(false);
        return;
      }

      setError(event.message || event.error || "语音识别失败，请重试。");
      setIsListening(false);
    };

    recognition.onend = () => {
      if (sessionIdRef.current !== sessionId) return;

      setIsListening(false);
    };

    try {
      recognition.start();
    } catch {
      setError("语音识别已经在运行，请稍后再试。");
      setIsListening(false);
    }
  }, [Recognition]);

  const resetTranscript = useCallback(() => {
    setTranscript("");
    setError("");
  }, []);

  return {
    error,
    isListening,
    isSupported,
    resetTranscript,
    start,
    stop,
    transcript
  };
}
