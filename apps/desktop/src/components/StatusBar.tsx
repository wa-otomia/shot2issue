import { useEffect, useState } from "react";
import { getHotkey, macScreenRecordingAuthorized } from "../lib/api";

export default function StatusBar() {
  const [hotkey, setHotkey] = useState("");
  const [tcc, setTcc] = useState<boolean | null>(null);

  useEffect(() => {
    getHotkey()
      .then(setHotkey)
      .catch(() => {});
    if (navigator.platform.toLowerCase().includes("mac")) {
      macScreenRecordingAuthorized()
        .then(setTcc)
        .catch(() => {});
    }
  }, []);

  return (
    <div className="statusbar">
      <span>
        Hotkey: <b>{hotkey || "—"}</b>
      </span>
      {tcc !== null && (
        <span>
          <span className={`dot ${tcc ? "ok" : "warn"}`} />
          {tcc
            ? "Screen Recording granted"
            : "Grant Screen Recording in System Settings"}
        </span>
      )}
    </div>
  );
}
