// The editor toolbar: SVG-icon tool buttons (rect / numrect / arrow / pen / text / mosaic /
// crop) + color / outline / width / font-size controls + undo / clear / download / copy / paste.
// SVG paths lifted verbatim from the extension's editor.html. Controlled by EditorView: the
// active tool, the current prefs, and the action callbacks are all passed in.

import type { EditorPrefs } from "@shot2issue/core";

const ICON: Record<string, React.ReactNode> = {
  rect: <rect x="4" y="6" width="16" height="12" rx="1.5" />,
  numrect: (
    <>
      <rect x="6" y="9" width="14" height="10" rx="1.5" />
      <circle cx="7" cy="7" r="3.4" fill="currentColor" stroke="none" />
    </>
  ),
  arrow: (
    <>
      <line x1="5" y1="19" x2="18" y2="6" />
      <polyline points="10 6 18 6 18 14" />
    </>
  ),
  pen: (
    <>
      <path d="M5 19l1.6 -4.6 9 -9 3 3 -9 9z" />
      <path d="M14 7.5l3 3" />
    </>
  ),
  text: (
    <>
      <path d="M5 6h14" />
      <path d="M12 6v13" />
    </>
  ),
  mosaic: (
    <g fill="currentColor" stroke="none">
      <rect x="4" y="4" width="5" height="5" rx="0.5" />
      <rect x="14" y="4" width="5" height="5" rx="0.5" />
      <rect x="9" y="9.5" width="5" height="5" rx="0.5" />
      <rect x="4" y="15" width="5" height="5" rx="0.5" />
      <rect x="14" y="15" width="5" height="5" rx="0.5" />
    </g>
  ),
  crop: (
    <>
      <path d="M7 3v13a1 1 0 0 0 1 1h13" />
      <path d="M3 7h13a1 1 0 0 1 1 1v13" />
    </>
  ),
  undo: (
    <>
      <path d="M9 5l-5 5 5 5" />
      <path d="M4 10h9a5 5 0 0 1 0 10h-2" />
    </>
  ),
  redo: (
    <>
      <path d="M15 5l5 5 -5 5" />
      <path d="M20 10h-9a5 5 0 0 0 0 10h2" />
    </>
  ),
  clear: (
    <>
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="M6 7l1 13h10l1 -13" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v11" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 20h14" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="1.5" />
      <path d="M5 15V6a1 1 0 0 1 1-1h9" />
    </>
  ),
  paste: (
    <>
      <rect x="6" y="5" width="12" height="16" rx="1.5" />
      <path d="M9 5V3.5h6V5" />
    </>
  ),
};

function Svg({ name }: { name: string }) {
  const filled = name === "mosaic" || name === "numrect";
  return (
    <svg
      viewBox="0 0 24 24"
      fill={name === "mosaic" ? "currentColor" : "none"}
      stroke={filled && name === "mosaic" ? "none" : "currentColor"}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICON[name]}
    </svg>
  );
}

const TOOLS: Array<{ id: string; tipKey: string }> = [
  { id: "rect", tipKey: "toolRectTitle" },
  { id: "numrect", tipKey: "toolNumRectTitle" },
  { id: "arrow", tipKey: "toolArrowTitle" },
  { id: "pen", tipKey: "toolPenTitle" },
  { id: "text", tipKey: "toolTextTitle" },
  { id: "mosaic", tipKey: "toolMosaicTitle" },
  { id: "crop", tipKey: "toolCropTitle" },
];

const ACTIONS: Array<{ id: string; tipKey: string }> = [
  { id: "undo", tipKey: "undoTitle" },
  { id: "redo", tipKey: "redoTitle" },
  { id: "clear", tipKey: "clearTitle" },
  { id: "download", tipKey: "downloadPngTitle" },
  { id: "copy", tipKey: "copyPngTitle" },
  { id: "paste", tipKey: "pasteImageTitle" },
];

export default function Toolbar({
  tool,
  prefs,
  disabled,
  t,
  onTool,
  onPref,
  onAction,
}: {
  tool: string;
  prefs: EditorPrefs;
  disabled: boolean;
  t: (k: string) => string;
  onTool: (id: string) => void;
  onPref: (patch: Partial<EditorPrefs>) => void;
  onAction: (id: string) => void;
}) {
  const isText = tool === "text";
  return (
    <div className={`s2i-toolbar${disabled ? " disabled" : ""}`}>
      <div className="s2i-tool-group">
        {TOOLS.map((tl) => (
          <button
            key={tl.id}
            className={`s2i-tool${tool === tl.id ? " active" : ""}`}
            title={t(tl.tipKey)}
            onClick={() => onTool(tl.id)}
          >
            <Svg name={tl.id} />
          </button>
        ))}
      </div>
      <span className="s2i-sep" />
      <div className="s2i-ctl-group">
        <label className="s2i-swatch" title={t("color")}>
          <input type="color" value={prefs.color} onChange={(e) => onPref({ color: e.target.value })} />
          <span>{t("color")}</span>
        </label>
        <label className="s2i-swatch" title={t("strokeColorTitle")}>
          <input type="color" value={prefs.strokeColor} onChange={(e) => onPref({ strokeColor: e.target.value })} />
          <span>{t("strokeColor")}</span>
        </label>
        <label className="s2i-slider" title={t("strokeWidth")}>
          <span>{t("strokeWidth")}</span>
          <input type="range" min={0} max={12} value={prefs.strokeWidth} onChange={(e) => onPref({ strokeWidth: Number(e.target.value) })} />
        </label>
        {isText ? (
          <label className="s2i-slider">
            <span>{t("fontSize")}</span>
            <input type="range" min={12} max={96} value={prefs.fontSize} onChange={(e) => onPref({ fontSize: Number(e.target.value) })} />
          </label>
        ) : (
          <label className="s2i-slider">
            <span>{t("thickness")}</span>
            <input type="range" min={2} max={14} value={prefs.width} onChange={(e) => onPref({ width: Number(e.target.value) })} />
          </label>
        )}
      </div>
      <span className="s2i-sep" />
      <div className="s2i-tool-group">
        {ACTIONS.map((a) => (
          <button key={a.id} className="s2i-act" title={t(a.tipKey)} onClick={() => onAction(a.id)}>
            <Svg name={a.id} />
          </button>
        ))}
      </div>
    </div>
  );
}
