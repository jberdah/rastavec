// Browser backend: VTracer 1 WebAssembly for tracing and Canvas for rendering.
// The same backend serves the website and Tauri WebViews; only filesystem access differs.
import type { RGBAImage } from './core'
import { validateImageBytes, validateImageDimensions } from './image-limits.js'
export { vtracer1Backend as browserBackend } from './vtracer1-backend'

/** Read dimensions before allocating our own bitmap and canvas. The browser may decode internally. */
async function checkFileDimensions(file: File): Promise<void> {
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('The source image could not be decoded.'))
      image.src = url
    })
    validateImageDimensions(image.naturalWidth, image.naturalHeight)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Decode a file to RGBA, applying EXIF orientation. */
export async function decodeFile(file: File): Promise<RGBAImage> {
  validateImageBytes(file.size)
  await checkFileDimensions(file)
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
  try {
    // Defend against differences between the dimensions reported by the image element and decoder.
    validateImageDimensions(bmp.width, bmp.height)
    const canvas = document.createElement('canvas')
    canvas.width = bmp.width
    canvas.height = bmp.height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Could not allocate a canvas to decode the source image.')
    context.drawImage(bmp, 0, 0)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
    return { data: pixels.data, width: canvas.width, height: canvas.height }
  } finally {
    bmp.close()
  }
}

/** Encode an RGBA image as a PNG File. */
export async function toPngFile(img: RGBAImage, name: string): Promise<File> {
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not allocate a canvas to encode PNG output.')
  context.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0)
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('PNG encoding failed'))), 'image/png'))
  return new File([blob], name, { type: 'image/png' })
}

export function toDataUrl(img: RGBAImage): string {
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not allocate a canvas to encode a preview.')
  context.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0)
  return canvas.toDataURL('image/png')
}
