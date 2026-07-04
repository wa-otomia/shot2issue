import { useEffect, useState } from "react";
import { t } from "@shot2issue/core";
import { getHotkey, macScreenRecordingAuthorized } from "../lib/api";
import { formatAccelerator } from "../lib/accelerator";

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
        {t("statusHotkey")}: <b>{formatAccelerator(hotkey) || "—"}</b>
      </span>
      {tcc !== null && (
        <span>
          <span className={`dot ${tcc ? "ok" : "warn"}`} />
          {tcc ? t("screenRecOn") : t("screenRecOff")}
        </span>
      )}
    </div>
  );
}
