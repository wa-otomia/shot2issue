// The desktop annotation editor — the React port of the extension's editor.ts UI, over
// packages/core's canvas engine + AI + providers. It owns:
//   - the staged attachments (loaded via invoke('get_pending_shots') on mount; ops live in a ref
//     so the annotator mutates them synchronously, with a render counter to refresh thumbnails);
//   - the issue form (workspace / type / title / body, with template defaults) and submit through
//     getProvider(ws.kind).submit(...);
//   - the AI flows: "Summarize title" (ai.generateTitle) and "Smart dictation"
//     (DictationModal → ai.transcribeAudio → ai.generateComplaint), both streamed live into the
//     fields with the floating status bubble;
//   - clipboard paste-as-attachment (Ctrl/Cmd+V) and Ctrl/Cmd+C to copy the annotated canvas.
//
// Geometry/drawing is entirely in @shot2issue/core/canvas (via useAnnotator). This file is the
// orchestration layer; the toolbar / canvas / form / bubble / modal / strip are split out.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ai,
  accountFor,
  getAiAuth,
  getConfig,
  getEditorPrefs,
  getProvider,
  makeAttachmentId,
  patchAiAuth,
  patchConfig,
  patchEditorPrefs,
  rememberSelection,
  setLanguage,
  t as tr,
  DEFAULT_EDITOR_PREFS,
  type AiAuth,
  type Attachment,
  type Config,
  type EditorPrefs,
  type IssueResult,
  type Op,
  type Workspace,
} from "@shot2issue/core";
import { getPendingShots, onShotsUpdated } from "../lib/capture";
import { openExternalUrl } from "../lib/api";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAnnotator } from "./useAnnotator";
import Toolbar from "./Toolbar";
import AnnotationCanvas from "./AnnotationCanvas";
import IssueForm, { type FormState } from "./IssueForm";
import ThumbStrip from "./ThumbStrip";
import AiBubble, { EMPTY_BUBBLE, type BubbleState } from "./AiBubble";
import DictationModal from "./DictationModal";
import { aiImages, buildSubmitImages, errMsg, wasAborted } from "./aiHelpers";

const wsKind = (ws: Workspace): string => ws.kind || "github";

export default function EditorView() {
  const t = tr;
  // ---- config + prefs + auth -------------------------------------------------
  const [config, setConfig] = useState<Config | null>(null);
  const [prefs, setPrefs] = useState<EditorPrefs>(DEFAULT_EDITOR_PREFS);
  const prefsRef = useRef<EditorPrefs>(DEFAULT_EDITOR_PREFS);
  const [auth, setAuth] = useState<AiAuth | null>(null);

  // ---- attachments (ops mutate in place; bump `rev` to refresh the strip/canvas) ----
  const attachmentsRef = useRef<Attachment[]>([]);
  const [rev, setRev] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const bump = useCallback(() => setRev((r) => r + 1), []);

  // ---- canvas refs + interaction state surfaced to the view -----------------
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [tool, setTool] = useState("rect");
  const [cropActive, setCropActive] = useState(false);

  // ---- form ------------------------------------------------------------------
  const [form, setFormState] = useState<FormState>({ workspaceId: "", type: "", title: "", body: "" });
  const titleDirtyRef = useRef(false);
  const formRef = useRef(form);
  formRef.current = form;
  const onForm = useCallback((patch: Partial<FormState>) => {
    if (patch.title !== undefined) titleDirtyRef.current = true;
    setFormState((f) => ({ ...f, ...patch }));
  }, []);

  // ---- status / result / toast / bubble -------------------------------------
  const [status, setStatus] = useState<{ text: string; kind: "info" | "error" | "ok" }>({ text: "", kind: "info" });
  const [result, setResult] = useState<IssueResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState("");
  const [bubble, setBubble] = useState<BubbleState>(EMPTY_BUBBLE);
  const [loginHint, setLoginHint] = useState<{ text: string; ok: boolean }>({ text: "", ok: true });
  const [dictateOpen, setDictateOpen] = useState(false);

  // ---- AI generation control -------------------------------------------------
  const titleAbort = useRef<AbortController | null>(null);
  const complaintAbort = useRef<AbortController | null>(null);
  const [titleBusy, setTitleBusy] = useState(false);
  const [complaintBusy, setComplaintBusy] = useState(false);
  const aiBusyRef = useRef(false);
  const aiBusy = titleBusy || complaintBusy;
  aiBusyRef.current = aiBusy;

  const showToast = useCallback((key: string) => {
    // The annotator passes "copyFailed:<msg>"; everything else is a plain i18n key.
    const [k, ...rest] = key.split(":");
    setToast(rest.length ? t(k, [rest.join(":")]) : t(k));
  }, [t]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 1600);
    return () => clearTimeout(id);
  }, [toast]);

  // ---- persistence of ops back to the active attachment ---------------------
  const persist = useCallback(() => {
    bump(); // ops are mutated in place; re-render the thumbnail of the active shot
  }, [bump]);

  // ---- annotator hook --------------------------------------------------------
  const annot = useAnnotator({
    canvasRef,
    textRef,
    wrapRef,
    prefsRef,
    onPersist: persist,
    onCropApplied: (dataUrl, ops) => {
      const a = attachmentsRef.current[activeIndex];
      if (!a) return;
      a.dataUrl = dataUrl;
      a.ops = ops;
      annot.loadImage(dataUrl, a.ops);
      bump();
    },
    onToast: showToast,
    isAiBusy: () => aiBusyRef.current,
    onCropChange: setCropActive,
    onToolChange: setTool,
    patchPrefs: (patch) => void patchEditorPrefs(patch),
  });

  // ---- load the active attachment onto the canvas ---------------------------
  const loadActive = useCallback(
    (i: number) => {
      const a = attachmentsRef.current[i];
      if (!a) return;
      annot.loadImage(a.dataUrl, a.ops);
    },
    [annot],
  );

  const selectAttachment = useCallback(
    (i: number) => {
      if (i < 0 || i >= attachmentsRef.current.length) return;
      annot.commitText();
      setActiveIndex(i);
      loadActive(i);
      bump();
    },
    [annot, bump, loadActive],
  );

  const deleteAttachment = useCallback(
    (i: number) => {
      annot.commitText();
      attachmentsRef.current.splice(i, 1);
      const next = activeIndex >= attachmentsRef.current.length ? Math.max(0, attachmentsRef.current.length - 1) : activeIndex;
      setActiveIndex(next);
      if (attachmentsRef.current.length) loadActive(next);
      bump();
    },
    [activeIndex, annot, bump, loadActive],
  );

  // ---- init: config, prefs, auth, pending shots -----------------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const cfg = await getConfig().catch(() => null);
      if (cancelled) return;
      if (cfg) {
        setLanguage(cfg.lang);
        setConfig(cfg);
        setFormState((f) => ({ ...f, workspaceId: cfg.lastWorkspaceId || cfg.workspaces[0]?.id || "", type: cfg.lastType && cfg.types.includes(cfg.lastType) ? cfg.lastType : cfg.types[0] || "" }));
      }
      const p = await getEditorPrefs().catch(() => DEFAULT_EDITOR_PREFS);
      if (cancelled) return;
      setPrefs(p);
      prefsRef.current = p;
      annot.setTool(annot.isDrawingTool(p.tool) ? p.tool : "rect", false);
      const a = await getAiAuth().catch(() => null);
      if (!cancelled) setAuth(a);

      const shots = await getPendingShots().catch(() => null);
      if (cancelled) return;
      const atts: Attachment[] = (shots?.attachments ?? []).map((s) => ({
        id: s.id,
        dataUrl: s.dataUrl,
        ops: (s.ops as Op[]) ?? [],
        sourceId: s.sourceId,
        createdAt: s.createdAt,
      }));
      attachmentsRef.current = atts;
      setActiveIndex(0);
      bump();
      if (atts.length) loadActive(0);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- live-append shots captured while the editor is open ------------------
  useEffect(() => {
    const un = onShotsUpdated(async () => {
      const shots = await getPendingShots().catch(() => null);
      if (!shots) return;
      const known = new Set(attachmentsRef.current.map((a) => a.id));
      const added = shots.attachments
        .filter((s) => s.id && s.dataUrl && !known.has(s.id))
        .map((s) => ({ id: s.id, dataUrl: s.dataUrl, ops: (s.ops as Op[]) ?? [], sourceId: s.sourceId, createdAt: s.createdAt }));
      if (!added.length) return;
      annot.commitText();
      attachmentsRef.current.push(...added);
      const idx = attachmentsRef.current.length - 1;
      setActiveIndex(idx);
      loadActive(idx);
      bump();
    });
    return () => {
      void un.then((f) => f());
    };
  }, [annot, bump, loadActive]);

  // ---- form defaults (title/body templates) when config or active shot loads -
  const appliedDefaults = useRef(false);
  useEffect(() => {
    if (!config || appliedDefaults.current) return;
    appliedDefaults.current = true;
    const apply = (tpl: string): string =>
      tpl.replace(/\{(\w+)\}/g, (m, k) => (k === "type" ? formRef.current.type : k === "pageTitle" || k === "pageUrl" ? "" : m));
    setFormState((f) => ({ ...f, title: apply(config.titleTemplate).replace(/[ \t]+/g, " ").trim(), body: apply(config.bodyTemplate) }));
  }, [config]);

  // ---- login hint for the selected workspace --------------------------------
  const workspaces = config?.workspaces ?? [];
  const selectedWs = useMemo(() => workspaces.find((w) => w.id === form.workspaceId) || null, [workspaces, form.workspaceId]);
  const mergedWs = useCallback(
    (ws: Workspace): Workspace => {
      if (!config) return ws;
      const acct = accountFor(config, ws);
      return acct ? { ...ws, baseUrl: acct.baseUrl, token: acct.token } : ws;
    },
    [config],
  );
  useEffect(() => {
    if (!selectedWs) {
      setLoginHint({ text: "", ok: true });
      return;
    }
    let cancelled = false;
    void getProvider(wsKind(selectedWs))
      .hint(mergedWs(selectedWs), t)
      .then((h) => !cancelled && setLoginHint(h))
      .catch((e) => !cancelled && setLoginHint({ text: t("loginUnknown", [errMsg(e)]), ok: false }));
    return () => {
      cancelled = true;
    };
  }, [selectedWs, mergedWs, t]);

  const wsLabel = useCallback(
    (ws: Workspace): string => {
      const provider = getProvider(wsKind(ws));
      const base = ws.name || provider.describe(ws) || wsKind(ws);
      return `${base} (${provider.label})`;
    },
    [],
  );

  // ---- toolbar actions -------------------------------------------------------
  const onPref = useCallback(
    (patch: Partial<EditorPrefs>) => {
      const next = { ...prefsRef.current, ...patch };
      prefsRef.current = next;
      setPrefs(next);
      void patchEditorPrefs(patch);
      annot.applyPrefToSelected(patch as Partial<Op>);
    },
    [annot],
  );
  const onAction = useCallback(
    (id: string) => {
      if (id === "undo") annot.undo();
      else if (id === "clear") annot.clear();
      else if (id === "download") annot.download();
      else if (id === "copy") void annot.copy();
      else if (id === "paste") void pasteFromClipboard();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [annot],
  );

  // ---- clipboard paste-as-attachment ----------------------------------------
  const blobToDataUrl = (blob: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error || new Error("read failed"));
      r.readAsDataURL(blob);
    });

  const addImageAttachment = useCallback(
    async (dataUrl: string) => {
      annot.commitText();
      const att: Attachment = { id: makeAttachmentId(), dataUrl, pageTitle: t("clipboardImage"), ops: [], createdAt: Date.now() };
      attachmentsRef.current.push(att);
      const idx = attachmentsRef.current.length - 1;
      setActiveIndex(idx);
      loadActive(idx);
      bump();
      showToast("pasteAdded");
    },
    [annot, bump, loadActive, showToast, t],
  );

  const pasteFromClipboard = useCallback(async () => {
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const type = it.types.find((ty) => ty.startsWith("image/"));
        if (type) {
          await addImageAttachment(await blobToDataUrl(await it.getType(type)));
          return;
        }
      }
      showToast("pasteNoImage");
    } catch (e) {
      showToast("pasteFailed:" + errMsg(e));
    }
  }, [addImageAttachment, showToast]);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of Array.from(items)) {
        if (it.kind === "file" && it.type.startsWith("image/")) {
          const blob = it.getAsFile();
          if (!blob) continue;
          e.preventDefault();
          void blobToDataUrl(blob)
            .then(addImageAttachment)
            .catch((err) => showToast("pasteFailed:" + errMsg(err)));
          return;
        }
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [addImageAttachment, showToast]);

  // ---- global keyboard: undo / copy (canvas-level; text fields keep native) -
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const ae = document.activeElement;
      const inField = !!ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA");
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
        if (inField) return;
        e.preventDefault();
        annot.undo();
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "c" || e.key === "C")) {
        if (inField || (window.getSelection()?.toString() || "").trim()) return;
        if (!attachmentsRef.current.length) return;
        e.preventDefault();
        void annot.copy();
      }
      if (e.key === "Escape") {
        if (cropActive) annot.cancelCrop();
        else if (!inField) void getCurrentWindow().close(); // Esc closes the editor window
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [annot, cropActive]);

  // ---- AI bubble helpers -----------------------------------------------------
  const openBubble = (anchor: HTMLElement | null, statusKey: string) =>
    setBubble({ visible: true, phase: "busy", status: t(statusKey), think: "", anchor });
  const bubbleStatus = (statusKey: string) => setBubble((b) => ({ ...b, status: t(statusKey) }));
  const bubbleThink = (full: string) =>
    setBubble((b) => ({ ...b, status: b.status === t("aiStateRequesting") ? t("aiThinking") : b.status, think: full }));
  const bubbleDone = () => {
    setBubble((b) => ({ ...b, phase: "done", status: t("aiStateDone") }));
    setTimeout(() => setBubble(EMPTY_BUBBLE), 1500);
  };
  const bubbleFail = (msg: string) => {
    setBubble((b) => ({ ...b, phase: "error", status: msg }));
    setTimeout(() => setBubble(EMPTY_BUBBLE), 3000);
  };
  const closeBubble = () => setBubble(EMPTY_BUBBLE);

  // ---- Summarize title -------------------------------------------------------
  const onSummarize = useCallback(async () => {
    if (titleAbort.current) {
      titleAbort.current.abort();
      return;
    }
    if (!formRef.current.body.trim()) {
      setStatus({ text: t("aiTitleNeedBody"), kind: "error" });
      return;
    }
    const ctrl = new AbortController();
    titleAbort.current = ctrl;
    const titleBefore = formRef.current.title;
    const dirtyBefore = titleDirtyRef.current;
    setTitleBusy(true);
    openBubble(titleRef.current, "aiStateRequesting");
    try {
      annot.commitText();
      const images = await aiImages(attachmentsRef.current);
      const { title } = await ai.generateTitle(
        { type: formRef.current.type, body: formRef.current.body, images: images.length ? images : undefined },
        {
          instructions: config?.aiTitlePrompt || t("aiTitlePromptDefault"),
          signal: ctrl.signal,
          reasoningEffort: config?.aiReasoning,
          onText: (_d, full) => {
            titleDirtyRef.current = true;
            setFormState((f) => ({ ...f, title: (full.split("\n")[0] || "").slice(0, 120) }));
            bubbleStatus("aiStateWriting");
          },
          onReasoning: (_d, full) => bubbleThink(full),
        },
      );
      titleDirtyRef.current = true;
      setFormState((f) => ({ ...f, title }));
      bubbleDone();
      setStatus({ text: "", kind: "info" });
    } catch (e) {
      if (wasAborted(ctrl, e)) {
        setFormState((f) => ({ ...f, title: titleBefore }));
        titleDirtyRef.current = dirtyBefore;
        bubbleStatus("aiStopped");
        closeBubble();
      } else {
        bubbleFail(t("aiTitleFailed", [errMsg(e)]));
      }
    } finally {
      titleAbort.current = null;
      setTitleBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annot, config, t]);

  // ---- Smart dictation: generate from the modal's text ----------------------
  const runComplaint = useCallback(
    async (text: string) => {
      const ctrl = new AbortController();
      complaintAbort.current = ctrl;
      setComplaintBusy(true);
      openBubble(bodyRef.current, "aiStateRequesting");
      try {
        annot.commitText();
        const images = await aiImages(attachmentsRef.current);
        const { title, body } = await ai.generateComplaint(
          { transcript: text, type: formRef.current.type, images: images.length ? images : undefined },
          {
            instructions: config?.aiComplaintPrompt || t("aiComplaintPromptDefault"),
            signal: ctrl.signal,
            reasoningEffort: config?.aiReasoning,
            onReasoning: (_d, full) => bubbleThink(full),
            onText: (_d, full) => {
              const r = ai.partialComplaintFields(full);
              setFormState((f) => ({
                ...f,
                title: r.title != null ? r.title.slice(0, 200) : f.title,
                body: r.body != null ? r.body : f.body,
              }));
              if (r.title != null) titleDirtyRef.current = true;
              bubbleStatus("aiStateWriting");
            },
          },
        );
        setFormState((f) => ({ ...f, title: title || f.title, body: body || f.body }));
        if (title) titleDirtyRef.current = true;
        bubbleDone();
        showToast("complaintDone");
      } catch (e) {
        if (wasAborted(ctrl, e)) {
          bubbleStatus("aiStopped");
          closeBubble();
        } else {
          bubbleFail(t("complaintFailed", [errMsg(e)]));
        }
      } finally {
        complaintAbort.current = null;
        setComplaintBusy(false);
      }
    },
    [annot, config, showToast, t],
  );

  const onDictate = useCallback(() => {
    if (complaintAbort.current) {
      complaintAbort.current.abort();
      return;
    }
    setDictateOpen(true);
  }, []);

  // ---- AI settings (model / reasoning / auto-dictate) -----------------------
  const onModel = useCallback((m: string) => {
    setAuth((a) => (a ? { ...a, model: m } : a));
    void patchAiAuth({ model: m });
  }, []);
  const onReasoning = useCallback((r: string) => {
    setConfig((c) => (c ? { ...c, aiReasoning: r } : c));
    void patchConfig({ aiReasoning: r });
  }, []);
  const onAutoDictate = useCallback((v: boolean) => {
    setConfig((c) => (c ? { ...c, autoDictate: v } : c));
    void patchConfig({ autoDictate: v });
  }, []);

  // ---- form change side effects (remember selection, refresh default title) -
  useEffect(() => {
    if (!config) return;
    void rememberSelection({ workspaceId: form.workspaceId, type: form.type });
    if (!titleDirtyRef.current) {
      const apply = (tpl: string): string => tpl.replace(/\{(\w+)\}/g, (m, k) => (k === "type" ? form.type : k === "pageTitle" || k === "pageUrl" ? "" : m));
      setFormState((f) => ({ ...f, title: apply(config.titleTemplate).replace(/[ \t]+/g, " ").trim() }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.type, form.workspaceId]);

  // ---- submit ----------------------------------------------------------------
  const onSubmit = useCallback(
    async (withImage: boolean) => {
      if (!config) return;
      annot.commitText();
      setResult(null);
      const raw = selectedWs;
      if (!raw) {
        setStatus({ text: t("errSelectWorkspace"), kind: "error" });
        return;
      }
      const ws = mergedWs(raw);
      const errKey = getProvider(wsKind(ws)).validate(ws);
      if (errKey) {
        setStatus({ text: t(errKey), kind: "error" });
        return;
      }
      if (!formRef.current.title.trim()) {
        setStatus({ text: t("errTitleEmpty"), kind: "error" });
        return;
      }
      setSubmitting(true);
      try {
        const images = withImage ? await buildSubmitImages(attachmentsRef.current) : [];
        const acct = accountFor(config, ws);
        const issue = await getProvider(wsKind(ws)).submit(ws, {
          title: formRef.current.title.trim(),
          body: formRef.current.body,
          images,
          withImage: withImage && images.length > 0,
          dataUrl: images[0]?.dataUrl || "",
          filename: images[0]?.filename || `shot-${Date.now()}.png`,
          account: acct ? { id: acct.id, kind: acct.kind, baseUrl: acct.baseUrl, token: acct.token } : undefined,
          t,
          busy: (key: string) => setStatus({ text: t(key), kind: "info" }),
        });
        setResult(issue);
        setStatus({ text: issue.number ? t("statusCreated", [issue.number]) : t("statusCreatedNoNumber"), kind: "ok" });
      } catch (err) {
        setStatus({ text: t("statusSubmitFailed", [errMsg(err)]), kind: "error" });
      } finally {
        setSubmitting(false);
      }
    },
    [annot, config, mergedWs, selectedWs, t],
  );

  // ---- render ----------------------------------------------------------------
  const empty = attachmentsRef.current.length === 0;
  void rev; // touch so the strip/canvas re-render on ops/attachment mutation
  return (
    <div className="s2i-editor">
      <header className="s2i-editor-head" data-tauri-drag-region>
        <h1>
          <span className="dot" /> shot2issue
          <span className="s2i-sub">{t("editorSubtitle")}</span>
        </h1>
      </header>
      <div className="s2i-editor-layout">
        <div className="s2i-canvas-col">
          <Toolbar tool={tool} prefs={prefs} disabled={aiBusy} t={t} onTool={(id) => annot.setTool(id)} onPref={onPref} onAction={onAction} />
          <ThumbStrip attachments={attachmentsRef.current} activeIndex={activeIndex} t={t} onSelect={selectAttachment} onDelete={deleteAttachment} />
          <AnnotationCanvas
            canvasRef={canvasRef}
            textRef={textRef}
            wrapRef={wrapRef}
            empty={empty}
            emptyText={t("canvasEmpty")}
            cropActive={cropActive}
            onCropApply={() => annot.applyCrop()}
            onCropCancel={() => annot.cancelCrop()}
            cropApplyLabel={t("cropApply")}
            cropCancelLabel={t("cropCancel")}
          />
        </div>
        <IssueForm
          t={t}
          workspaces={workspaces}
          types={config?.types ?? []}
          wsLabel={wsLabel}
          form={form}
          onForm={onForm}
          titleRef={titleRef}
          bodyRef={bodyRef}
          loginHint={loginHint.text}
          loginOk={loginHint.ok}
          aiConnected={!!auth}
          models={auth?.models ?? []}
          model={auth?.model || (auth?.models ?? [])[0] || ""}
          reasoning={config?.aiReasoning || "off"}
          autoDictate={!!config?.autoDictate}
          titleBusy={titleBusy}
          complaintBusy={complaintBusy}
          aiLocked={aiBusy}
          submitting={submitting}
          status={status.text}
          statusKind={status.kind}
          result={result}
          onModel={onModel}
          onReasoning={onReasoning}
          onAutoDictate={onAutoDictate}
          onSummarize={() => void onSummarize()}
          onDictate={onDictate}
          onSubmit={(w) => void onSubmit(w)}
          onOpenIssue={(url) => void openExternalUrl(url)}
        />
      </div>
      <AiBubble state={bubble} />
      <DictationModal
        open={dictateOpen}
        t={t}
        autoDictate={!!config?.autoDictate}
        onClose={() => setDictateOpen(false)}
        onTranscribe={(blob) => ai.transcribeAudio(blob, { prompt: (config?.aiVocabulary || []).join(", "), language: config?.dictationLang })}
        onGenerate={(text) => {
          setDictateOpen(false);
          void runComplaint(text);
        }}
        onMicDenied={() => {}}
      />
      {toast && <div className="s2i-toast show">{toast}</div>}
    </div>
  );
}
