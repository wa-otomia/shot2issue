// The home / landing screen. Capture is Rust-driven: the global hotkey OR the
// "Capture now" button calls trigger_capture, which grabs the monitor under the cursor and opens
// the crop overlay (or, on native Wayland, an in-app crop window). A captured + cropped shot
// opens the dedicated `editor` window. This view shows the bound hotkey, a primary capture
// action, and a short how-it-works hint.

import { useEffect, useState } from "react";
import { t } from "@shot2issue/core";
import { getHotkey, onNeedsScreenRecording, triggerCapture } from "../lib/api";
import { formatAccelerator } from "../lib/accelerator";

export default function HomeView() {
  const [busy, setBusy] = useState(false);
  const [hotkey, setHotkey] = useState("");
  const [needsScreenRec, setNeedsScreenRec] = useState(false);

  useEffect(() => {
    getHotkey().then(setHotkey).catch(() => {});
  }, []);

  // macOS: Rust emits this when a capture came back black (Screen Recording denied).
  useEffect(() => {
    const p = onNeedsScreenRecording(() => setNeedsScreenRec(true));
    return () => {
      void p.then((f) => f());
    };
  }, []);

  const captureNow = async (): Promise<void> => {
    setBusy(true);
    try {
      await triggerCapture();
    } catch {
      /* surfaced in the status bar */
    } finally {
      setBusy(false);
    }
  };

  // The hint reads "Press <pill> from anywhere…"; splitting the translated template on {0} keeps
  // the styled hotkey pill inline while letting each language place it in its own word order.
  const [hintBefore, hintAfter = ""] = t("homeHint").split("{0}");

  return (
    <>
      <h2>{t("homeHeading")}</h2>
      <div className="card s2i-home-hero">
        <div className="s2i-home-copy">
          <p>{t("homeIntro")}</p>
          <p className="empty" style={{ textAlign: "left", padding: 0 }}>
            {hintBefore}
            <span className="hotkey-pill">{formatAccelerator(hotkey) || t("hotkeyNotSet")}</span>
            {hintAfter}
          </p>
        </div>
        <div className="row">
          <button className="primary" disabled={busy} onClick={() => void captureNow()}>
            {busy ? t("homeCapturing") : t("homeCaptureNow")}
          </button>
        </div>
      </div>

      {needsScreenRec && (
        <div className="card">
          <p className="s2i-set-error" role="alert">
            {t("homeScreenRecNeeded")}
          </p>
        </div>
      )}
    </>
  );
}
