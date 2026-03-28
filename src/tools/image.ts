/**
 * Shared image utilities for the read tool.
 *
 * Centralised here so the two code paths that implement image reading
 * (core.ts for channel plugins, api.ts for the TUI HTTP proxy) stay in sync.
 */

/** Maps lowercase file extensions to their MIME types. */
export const IMAGE_MIME: Record<string, string> = {
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".webp": "image/webp",
};

/**
 * Return the MIME type for a file path, or undefined if it is not a
 * recognised image extension.
 */
export function imageExtension(filePath: string): string | undefined {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return IMAGE_MIME[ext];
}

/**
 * Build the error message returned when an agent tries to read an image
 * with a model that does not support vision input.
 */
export function buildVisionUnsupportedError(filePath: string, modelLabel: string): string {
  return (
    `Cannot read image: ${filePath}\n\n` +
    `${modelLabel} does not support image (vision) input. ` +
    `You cannot view or analyse image files with this model. ` +
    `If you need to inspect an image, ask the user to switch to a ` +
    `vision-capable model (e.g. claude-sonnet, gpt-4o, gemini-1.5-pro) ` +
    `and try again.`
  );
}
