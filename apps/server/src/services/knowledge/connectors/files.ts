import { createHash } from "node:crypto";
import { ConnectorError, type ConnectorDoc, htmlTitle, htmlToText } from "./util.ts";

export const ACCEPTED_FILES = [".md", ".markdown", ".txt", ".html", ".htm", ".pdf"];
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Parse an uploaded file into a knowledge document (markdown, text, HTML, PDF). */
export async function parseFile(name: string, data: Uint8Array): Promise<ConnectorDoc> {
  const lower = name.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf("."));
  if (!ACCEPTED_FILES.includes(ext))
    throw new ConnectorError(`${name}: unsupported file type (use ${ACCEPTED_FILES.join(", ")})`);
  if (data.byteLength > MAX_FILE_BYTES) throw new ConnectorError(`${name}: larger than 20 MB`);
  const digest = createHash("sha256").update(data).digest("hex").slice(0, 12);
  const baseTitle = name
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  let title = baseTitle;
  let content: string;
  let metadata: Record<string, unknown> = { fileName: name, bytes: data.byteLength, sha256: digest };

  if (ext === ".pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    try {
      const pdf = await getDocumentProxy(new Uint8Array(data));
      const { totalPages, text } = await extractText(pdf, { mergePages: false });
      content = (Array.isArray(text) ? text : [text])
        .map(
          (t, i) =>
            `## Page ${i + 1}\n\n${t
              .replace(/[ \t]+/g, " ")
              .replace(/\n{3,}/g, "\n\n")
              .trim()}`,
        )
        .join("\n\n");
      metadata = { ...metadata, pages: totalPages };
    } catch (err) {
      throw new ConnectorError(`${name}: could not read PDF (${err instanceof Error ? err.message : String(err)})`);
    }
  } else {
    const text = new TextDecoder("utf-8").decode(data);
    if (ext === ".html" || ext === ".htm") {
      title = htmlTitle(text) || baseTitle;
      content = htmlToText(text);
    } else {
      content = text.replace(/\r\n/g, "\n");
      const h1 = content.match(/^#\s+(.+)$/m)?.[1];
      if (h1) title = h1.trim();
    }
  }
  if (!content.replace(/## Page \d+/g, "").trim())
    throw new ConnectorError(`${name}: no extractable text (scanned PDFs need OCR first)`);
  // Keyed by file name: re-uploading a file replaces the previous version.
  return { externalId: name, title, url: null, content, metadata };
}
