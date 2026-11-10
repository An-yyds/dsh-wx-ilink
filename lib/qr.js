/** 把二维码文本渲染成 SVG（用于本机登录页）。 */

import qrcode from '../vendor/qrcode.mjs';

export function qrSvg(text, size = 320) {
  const qr = qrcode(0, 'M');
  qr.addData(String(text ?? ''));
  qr.make();
  const count = qr.getModuleCount();
  const margin = 4;
  const total = count + margin * 2;
  const cells = [];
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) {
        cells.push(`<rect x="${col + margin}" y="${row + margin}" width="1" height="1"/>`);
      }
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="微信登录二维码">`,
    `<rect width="${total}" height="${total}" fill="#ffffff"/>`,
    `<g fill="#111111">${cells.join('')}</g>`,
    '</svg>',
  ].join('');
}

/** 二维码 → GIF data URL（用于工具返回图片附件）。 */
export function qrDataUrl(text, cellSize = 6, margin = 2) {
  const qr = qrcode(0, 'M');
  qr.addData(String(text ?? ''));
  qr.make();
  return qr.createDataURL(cellSize, margin);
}

/** data URL → 原始字节。 */
export function dataUrlBytes(dataUrl) {
  const comma = String(dataUrl).indexOf(',');
  return Buffer.from(String(dataUrl).slice(comma + 1), 'base64');
}
