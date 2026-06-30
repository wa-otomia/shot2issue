// The multi-attachment thumbnail strip: one tile per staged/pasted screenshot, with a delete
// button and an active-highlight. Clicking a tile switches the canvas to that attachment. Hidden
// when there are no attachments.

import type { Attachment } from "@shot2issue/core";

export default function ThumbStrip({
  attachments,
  activeIndex,
  t,
  onSelect,
  onDelete,
}: {
  attachments: Attachment[];
  activeIndex: number;
  t: (k: string) => string;
  onSelect: (i: number) => void;
  onDelete: (i: number) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="s2i-thumb-strip">
      {attachments.map((a, i) => (
        <div
          key={a.id}
          className={`s2i-thumb${i === activeIndex ? " active" : ""}`}
          title={a.pageTitle || ""}
          onClick={() => onSelect(i)}
        >
          <img src={a.dataUrl} alt="" />
          <button
            className="s2i-thumb-del"
            title={t("attDelete")}
            onClick={(e) => {
              e.stopPropagation();
              onDelete(i);
            }}
          >
            ✕
          </button>
        </div>
      ))}
      <div className="s2i-thumb-hint">{t("attAddHint")}</div>
    </div>
  );
}
