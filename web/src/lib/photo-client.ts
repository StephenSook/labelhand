import type { PhotoReadResult } from "./photo-reading";

export const PHOTO_LONG_SIDE_PX = 1600;
export const PHOTO_JPEG_QUALITY = 0.85;

export class PhotoClientError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "PhotoClientError";
  }
}

export function fitWithinLongSide(width: number, height: number, maximum = PHOTO_LONG_SIDE_PX) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || maximum <= 0) {
    throw new TypeError("Photo dimensions must be positive finite numbers.");
  }
  const scale = Math.min(1, maximum / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export async function prepareLabelPhoto(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const size = fitWithinLongSide(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) throw new PhotoClientError("This browser cannot prepare the label photo.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new PhotoClientError("The label photo could not be encoded.")),
        "image/jpeg",
        PHOTO_JPEG_QUALITY,
      );
    });
  } finally {
    bitmap.close();
  }
}

export async function readLabelPhotoFromBrowser(
  file: Blob,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<PhotoReadResult> {
  const prepared = await prepareLabelPhoto(file);
  const form = new FormData();
  form.append("photo", prepared, "label.jpg");
  const response = await (options.fetchImpl ?? fetch)("/api/labels/photo", {
    method: "POST",
    body: form,
    signal: options.signal,
  });
  const payload = await response.json() as unknown;
  if (!response.ok) {
    const message = typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string"
      ? payload.error
      : `Label photo reading failed with HTTP ${response.status}.`;
    throw new PhotoClientError(message, response.status);
  }
  return payload as PhotoReadResult;
}
