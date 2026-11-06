export const MAX_IMAGE_BYTES = 64 * 1024 * 1024
export const MAX_IMAGE_PIXELS = 40_000_000
export const MAX_IMAGE_SIDE = 16_384

/** @param {number} bytes */
export function validateImageBytes(bytes) {
  if (bytes > MAX_IMAGE_BYTES) throw new Error('Image file exceeds the 64 MiB limit. Use a smaller file.')
}

/** @param {number} width @param {number} height */
export function validateImageDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    throw new Error('Image dimensions are invalid or unavailable.')
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_PIXELS)
    throw new Error(`Image ${width} × ${height} exceeds the limit of 40 megapixels or 16,384 pixels per side. Resize the image and try again.`)
}
