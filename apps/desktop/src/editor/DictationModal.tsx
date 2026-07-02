// The Smart-dictation modal: type or dictate a complaint, transcribe it (MediaRecorder →
// core transcribeAudio), then hand the text to EditorView's runComplaint which streams the AI
// title + body. Ported from the extension's complaint modal; the floating/draggable behavior is
// simplified to a centered modal (the desktop editor has its own window, so it never needs to
// avoid covering a host page). The record button shows a transcribing state via the shared bubble.

import { useEffect, useRef, useState } from "react";

export default function DictationModal({
  open,
  t,
  autoDictate,
  onClose,
  onTranscribe,
  onGenerate,
  onMicDenied,
}: {
  open: boolean;
  t: (k: string) => string;
  autoDictate: boolean;
  onClose: () => void;
  /** Transcribe a recorded blob; returns the transcript text (or throws). */
  onTranscribe: (blob: Blob) => Promise<string>;
  /** Generate the issue title + body from the box text (closes the modal first). */
  onGenerate: (text: string) => void;
  onMicDenied: () => void;
}) {
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  // Distinct from `status` so the "grant mic access in System Settings" guidance stays visible
  // (a later transcribe error would otherwise overwrite `status`) and can be styled as a hint.
  const [micDenied, setMicDenied] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const insertAtCursor = (insert: string): void => {
    const ta = taRef.current;
    if (!ta) {
      setText((v) => (v ? v + " " + insert : insert));
      return;
    }
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);
    const sep = before && !/\s$/.test(before) ? " " : "";
    const next = before + sep + insert + after;
    setText(next);
    const pos = (before + sep + insert).length;
    setTimeout(() => {
      ta.focus();
      ta.setSelectionRange(pos, pos);
    }, 0);
  };

  const transcribeInto = async (blob: Blob): Promise<void> => {
    setBusy(true);
    setStatus("");
    try {
      const transcript = (await onTranscribe(blob)).trim();
      if (transcript) insertAtCursor(transcript);
    } catch (e) {
      setStatus(t("complaintFailed").replace("{0}", e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  const stopRecording = (): void => {
    setRecording(false);
    try {
      recorderRef.current?.stop();
    } catch {
      /* ignore */
    }
  };

  const startDictation = async (): Promise<void> => {
    if (recording) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // Surface the actionable "grant Microphone in System Settings › Privacy & Security" hint.
      setMicDenied(true);
      onMicDenied();
      return;
    }
    setMicDenied(false);
    streamRef.current = stream;
    chunksRef.current = [];
    const rec = new MediaRecorder(stream);
    recorderRef.current = rec;
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      stream.getTracks().forEach((tr) => tr.stop());
      if (streamRef.current === stream) streamRef.current = null;
      // onstop fires as an async task, so on an abrupt unmount every cleanup has already run
      // and mountedRef is false by now: release the mic but don't fire a pointless transcription.
      if (!mountedRef.current) return;
      void transcribeInto(new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" }));
    };
    rec.start();
    setRecording(true);
  };

  // Focus on open; optionally auto-start dictation (config.autoDictate).
  useEffect(() => {
    if (!open) {
      if (recording) stopRecording();
      return;
    }
    setStatus("");
    setMicDenied(false);
    setTimeout(() => taRef.current?.focus(), 0);
    if (autoDictate && !recording) void startDictation();
    // Belt-and-suspenders for abrupt unmount (OS titlebar close / Cmd+W), which never re-runs
    // this effect with open=false: stop the recorder and release the mic stream directly so it
    // doesn't stay hot. Also fires (harmlessly) on the normal open->close path since stopRecording()
    // above already stopped the recorder/tracks by then - .stop() on an inactive recorder/track is a no-op.
    return () => {
      try {
        recorderRef.current?.stop();
      } catch {
        /* ignore */
      }
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Esc closes (handled here so it doesn't reach the editor's esc-to-close).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="s2i-modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="s2i-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="s2i-modal-head">
          <span>{t("complaintModalTitle")}</span>
          <button className="s2i-modal-close" title="Esc" onClick={onClose}>
            ✕
          </button>
        </div>
        <textarea
          ref={taRef}
          value={text}
          placeholder={t("complaintPlaceholder")}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="s2i-modal-actions">
          <button
            className={`ghost${recording ? " recording" : ""}`}
            disabled={busy}
            onClick={() => (recording ? stopRecording() : void startDictation())}
          >
            {busy ? t("aiStateTranscribing") : recording ? t("complaintRecordStop") : t("complaintRecordStart")}
          </button>
          <button className="ghost" onClick={() => setText("")}>
            {t("complaintClear")}
          </button>
          <span className="s2i-spacer" />
          <button
            className="primary"
            disabled={!text.trim() || busy}
            onClick={() => onGenerate(text.trim())}
          >
            {t("complaintGenerate")}
          </button>
        </div>
        {micDenied && (
          <div className="s2i-modal-status error" role="alert">
            {t("complaintMicDenied")}
          </div>
        )}
        {status && (
          <div className="s2i-modal-status error" role="alert">
            {status}
          </div>
        )}
      </div>
    </div>
  );
}
