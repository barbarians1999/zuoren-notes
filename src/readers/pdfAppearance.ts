// PDF.js records raster images as three normalized parallelogram corners.
// Never mutate the source raster: light mode must always return to the original.
export type PdfRaster = { source: HTMLCanvasElement; images: ArrayLike<number> };

// PDF.js 6.3's image tracker omits optimized repeated/inline image groups.
// Supplement only those groups through its public operator list; ordinary
// images retain the renderer's clipped coordinates. These remain normalized
// so cached geometry also works after zoom and device-pixel-ratio changes.
export function groupedPdfImages(list: { fnArray: number[]; argsArray: any[] }, viewport: { transform: number[]; width: number; height: number }, ops: Record<string, number>): number[] {
  const multiply = (a: number[], b: number[]) => [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
  let matrix = [...viewport.transform];
  const stack: number[][] = [], images: number[] = [];
  const record = (local: number[]) => {
    const m = multiply(matrix, local);
    images.push(m[4]/viewport.width, m[5]/viewport.height, (m[2]+m[4])/viewport.width, (m[3]+m[5])/viewport.height, (m[0]+m[4])/viewport.width, (m[1]+m[5])/viewport.height);
  };
  list.fnArray.forEach((op, i) => {
    const args = list.argsArray[i];
    if (op === ops.save) stack.push([...matrix]);
    else if (op === ops.restore || op === ops.paintFormXObjectEnd || op === ops.endGroup) matrix = stack.pop() || matrix;
    else if (op === ops.transform) matrix = multiply(matrix, args);
    else if (op === ops.paintFormXObjectBegin || op === ops.beginGroup) {
      stack.push([...matrix]);
      const transform = op === ops.beginGroup ? args[0]?.matrix : args[0];
      if (transform) matrix = multiply(matrix, transform);
    } else if (op === ops.paintImageXObjectRepeat) {
      const [, sx, sy, positions] = args;
      for (let n = 0; n + 1 < positions.length; n += 2) record([sx, 0, 0, sy, positions[n], positions[n+1]]);
    } else if (op === ops.paintInlineImageXObjectGroup) {
      for (const entry of args[1]) record(entry.transform);
    }
  });
  return images;
}

export function pdfImagePolygons(coordinates: ArrayLike<number>): number[][] {
  const polygons: number[][] = [];
  for (let i = 0; i + 5 < coordinates.length; i += 6) {
    const [ax, ay, bx, by, cx, cy] = Array.from({ length: 6 }, (_, n) => coordinates[i + n]);
    if (![ax, ay, bx, by, cx, cy].every(Number.isFinite)) continue;
    if (Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) < 1e-10) continue;
    const dx = bx + cx - ax, dy = by + cy - ay;
    // All subpaths have one winding direction, even for mirrored images.
    polygons.push((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) > 0
      ? [ax, ay, bx, by, dx, dy, cx, cy] : [ax, ay, cx, cy, dx, dy, bx, by]);
  }
  return polygons;
}

export function paintPdfAppearance(canvas: HTMLCanvasElement, raster: PdfRaster, dark: boolean) {
  const context = canvas.getContext('2d');
  if (!context) return;
  const { source, images } = raster;
  context.save();
  try {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.filter = dark ? 'invert(1) hue-rotate(180deg) brightness(0.85)' : 'none';
    context.drawImage(source, 0, 0);
    if (!dark) return;
    const polygons = pdfImagePolygons(images);
    if (!polygons.length) return;
    // Clip their union, then draw once; repeated images cannot get dimmed twice.
    context.beginPath();
    for (const polygon of polygons) {
      context.moveTo(polygon[0] * canvas.width, polygon[1] * canvas.height);
      for (let i = 2; i < 8; i += 2) context.lineTo(polygon[i] * canvas.width, polygon[i + 1] * canvas.height);
      context.closePath();
    }
    context.clip();
    context.filter = 'brightness(0.65)';
    context.drawImage(source, 0, 0);
  } finally { context.restore(); }
}
