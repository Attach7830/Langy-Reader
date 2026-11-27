export const maxPdfBoxes = 16;
export const pdfBoxDpi = 400;
export const maxPdfBoxSide = 4_800;
export const maxPdfBoxPixels = 16_000_000;
export const maxPdfBoxImageBytes = 4 * 1024 ** 2;
export const maxPdfBoxUpload = 24 * 1024 ** 2;

export function validPdfBoxes(boxes) {
  return Array.isArray(boxes) && boxes.length <= maxPdfBoxes && boxes.every((box) =>
    Array.isArray(box) && box.length === 4 && box.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)
      && box[0] < box[2] && box[1] < box[3]);
}
