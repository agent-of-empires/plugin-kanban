import { useEffect, useRef, useState } from "react";
import { type Config, parseConfigJson } from "../shared/board-config";

interface Props {
  config: Config;
  // Absent shows the config to copy; present lets the user replace it.
  onImport?: (config: Config) => void;
  onClose: () => void;
}

// Export is text to copy, not a file: the page's sandbox blocks downloads and
// the Clipboard API. A file picker still works, so import takes either.
export function ConfigDialog({ config, onImport, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState(onImport ? "" : JSON.stringify(config, null, 2));
  // Guarded because StrictMode runs effects twice.
  useEffect(() => {
    if (!ref.current?.open) ref.current?.showModal();
  }, []);

  const parsed = onImport && text.trim() ? parseConfigJson(text) : undefined;
  const loadFile = (file: File | undefined) =>
    file?.text().then(setText, (e: Error) => console.error(`[kanban] reading ${file.name} failed: ${e.message}`));
  const title = onImport ? "Import Board" : "Export Board";
  return (
    <dialog ref={ref} className="column-dialog wide" aria-label={title} onClose={onClose}>
      <h3>{title}</h3>
      {onImport ? (
        <>
          <p className="hint">Paste a Board exported from another dashboard, or pick its file.</p>
          <input type="file" accept=".json,application/json" aria-label="Board file" onChange={(e) => loadFile(e.target.files?.[0])} />
        </>
      ) : (
        <p className="hint">Copy this JSON and paste it into Import on another dashboard.</p>
      )}
      <textarea
        className="config-text"
        aria-label="Board JSON"
        spellCheck={false}
        autoFocus
        readOnly={!onImport}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => !onImport && e.currentTarget.select()}
      />
      {parsed && !parsed.ok && (
        <p className="error" role="alert">
          {parsed.error}
        </p>
      )}
      {parsed?.ok && (
        <p className="hint">
          Replaces this Board's {config.columns.length} Columns with these {parsed.config.columns.length}. A Session whose
          Stage column is not among them goes to the leftmost Stage column.
        </p>
      )}
      <div className="actions">
        <span className="spacer" />
        <button type="button" onClick={onClose}>
          {onImport ? "Cancel" : "Close"}
        </button>
        {onImport && (
          <button type="button" className="primary" disabled={!parsed?.ok} onClick={() => parsed?.ok && onImport(parsed.config)}>
            Replace Board
          </button>
        )}
      </div>
    </dialog>
  );
}
