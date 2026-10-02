import { useEffect, useRef, useState } from "react";
import type { PreparedImage } from "../lib/image";
import { IconImage, IconUpload } from "./Icons";

interface Props {
  prepared: PreparedImage | null;
  error: string | null;
  onFile: (file: File) => void;
  onClear: () => void;
  disabled: boolean;
}

export function Uploader({ prepared, error, onFile, onClear, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  // Paste a screenshot straight from the clipboard, anywhere on the page.
  useEffect(() => {
    if (disabled) return;
    const onPaste = (event: ClipboardEvent) => {
      const file = Array.from(event.clipboardData?.files ?? []).find((item) =>
        item.type.startsWith("image/"),
      );
      if (!file) return;
      event.preventDefault();
      onFile(file);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [onFile, disabled]);

  function pick(files: FileList | null): void {
    const file = files?.[0];
    if (file) onFile(file);
  }

  return (
    <div className="uploader">
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="visually-hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          pick(event.target.files);
          event.target.value = "";
        }}
      />

      {prepared ? (
        <div className="upload-review">
          <img src={prepared.previewUrl} alt="The dress screenshot you uploaded" />
          <div className="upload-review-foot">
            <p className="upload-ready">
              <IconImage width={17} height={17} />
              Screenshot ready — {prepared.width}×{prepared.height}
            </p>
            <div className="upload-review-actions">
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => inputRef.current?.click()}
                disabled={disabled}
              >
                Replace
              </button>
              <button type="button" className="btn btn-quiet" onClick={onClear} disabled={disabled}>
                Remove
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div
          className={`dropzone${dragOver ? " is-dragging" : ""}`}
          role="button"
          tabIndex={0}
          aria-label="Add a dress screenshot: click to browse, drag and drop, or paste"
          onClick={() => inputRef.current?.click()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              inputRef.current?.click();
            }
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
            pick(event.dataTransfer.files);
          }}
        >
          <span className="dropzone-mark" aria-hidden="true">
            <IconUpload width={26} height={26} />
          </span>
          <p className="dropzone-title">Drop a screenshot here</p>
          <p className="dropzone-sub">
            click to browse, drag and drop, or paste with Ctrl/Cmd&nbsp;+&nbsp;V
          </p>
          <p className="dropzone-sub dropzone-sub-dim">JPEG, PNG or WebP · up to 4 MB</p>
        </div>
      )}

      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
