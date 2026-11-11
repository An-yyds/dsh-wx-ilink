/**
 * 构建表情包素材：手绘 SVG → PNG（160×160，透明背景）。
 *
 * 只在需要更新图库时手动运行（构建期），产物 `stickers/*.png` 随仓库提交；
 * 运行时插件只读这些 PNG，不依赖 sharp。
 *
 *   node scripts/build-stickers.mjs
 *
 * 图形全部为本项目自绘，MIT 授权，不含任何第三方表情包。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, 'stickers');
const SIZE = 160;

const BODY = '#3B82F6';
const BODY_DARK = '#2563EB';
const BELLY = '#DBEAFE';
const INK = '#0F172A';
const ACCENT = '#F59E0B';
const ROSE = '#FB7185';

/** 鲸鱼身体（共用底座）。 */
function whaleBase({ belly = true } = {}) {
  return `
    <ellipse cx="80" cy="90" rx="52" ry="40" fill="${BODY}"/>
    <path d="M124 76 q20 -16 28 -6 q-6 18 -22 20 z" fill="${BODY_DARK}"/>
    <path d="M30 96 q-12 10 -4 20 q12 -2 16 -12 z" fill="${BODY_DARK}"/>
    ${belly ? `<ellipse cx="82" cy="102" rx="38" ry="24" fill="${BELLY}" opacity="0.5"/>` : ''}
  `;
}

function eyes({ x1 = 60, x2 = 96, y = 78, closed = false } = {}) {
  if (closed) {
    return `
      <path d="M${x1 - 7} ${y} q7 6 14 0" stroke="${INK}" stroke-width="3.4" fill="none" stroke-linecap="round"/>
      <path d="M${x2 - 7} ${y} q7 6 14 0" stroke="${INK}" stroke-width="3.4" fill="none" stroke-linecap="round"/>
    `;
  }
  return `
    <circle cx="${x1}" cy="${y}" r="5.2" fill="${INK}"/>
    <circle cx="${x2}" cy="${y}" r="5.2" fill="${INK}"/>
    <circle cx="${x1 + 1.8}" cy="${y - 2}" r="1.7" fill="#fff"/>
    <circle cx="${x2 + 1.8}" cy="${y - 2}" r="1.7" fill="#fff"/>
  `;
}

function smile(y = 98, width = 16) {
  return `<path d="M${80 - width / 2} ${y} q${width / 2} 8 ${width} 0" stroke="${INK}" stroke-width="3.2" fill="none" stroke-linecap="round"/>`;
}

function openMouth(y = 96) {
  return `<path d="M70 ${y} q10 14 20 0 q-10 5 -20 0 z" fill="${INK}"/>`;
}

function spout(x = 80, y = 46) {
  return `
    <path d="M${x} ${y + 8} q-3 -12 2 -18 q5 6 2 18 z" fill="#93C5FD"/>
    <circle cx="${x - 12}" cy="${y - 4}" r="4" fill="#BFDBFE"/>
    <circle cx="${x + 13}" cy="${y - 10}" r="5" fill="#BFDBFE"/>
    <circle cx="${x + 2}" cy="${y - 16}" r="3.4" fill="#BFDBFE"/>
  `;
}

function tear(x = 60, y = 88) {
  return `<path d="M${x} ${y} q-6 10 0 14 q6 -4 0 -14 z" fill="#60A5FA"/>`;
}

function sweat(x = 112, y = 70) {
  return `<path d="M${x} ${y} q-7 12 0 16 q7 -4 0 -16 z" fill="#93C5FD"/>`;
}

function mark(exclaim = true, x = 118, y = 40) {
  return exclaim
    ? `<rect x="${x - 3}" y="${y}" width="6" height="20" rx="3" fill="${ACCENT}"/>
       <circle cx="${x}" cy="${y + 30}" r="4" fill="${ACCENT}"/>`
    : `<circle cx="${x}" cy="${y + 14}" r="13" fill="none" stroke="${ACCENT}" stroke-width="5"/>
       <path d="M${x - 5} ${y + 17} l10 -6" stroke="${ACCENT}" stroke-width="0"/>`;
}

const MOODS = {
  happy: () => `
    ${whaleBase()}
    ${eyes({ closed: false })}
    ${smile()}
    ${spout()}
  `,
  thumbsUp: () => `
    ${whaleBase()}
    ${eyes({})}
    ${smile(96, 18)}
    <path d="M122 78 q22 -26 34 -16 q-8 22 -26 24 z" fill="${ACCENT}"/>
    <circle cx="140" cy="40" r="3.6" fill="${ACCENT}"/>
    <circle cx="124" cy="32" r="2.8" fill="${ACCENT}"/>
    <circle cx="150" cy="56" r="2.4" fill="${ACCENT}"/>
  `,
  thinking: () => `
    ${whaleBase()}
    ${eyes({ x1: 58, x2: 94, y: 74 })}
    <path d="M72 100 q8 5 16 0" stroke="${INK}" stroke-width="3" fill="none" stroke-linecap="round"/>
    <g transform="translate(108 34)">
      <circle cx="14" cy="14" r="15" fill="#FEF3C7" stroke="${ACCENT}" stroke-width="4"/>
      <path d="M8 10 q6 -7 12 0 q0 6 -6 8 v3" stroke="${ACCENT}" stroke-width="4" fill="none" stroke-linecap="round"/>
      <circle cx="14" cy="27" r="2.6" fill="${ACCENT}"/>
    </g>
  `,
  sad: () => `
    ${whaleBase()}
    ${eyes({ closed: true })}
    <path d="M72 104 q8 -6 16 0" stroke="${INK}" stroke-width="3.2" fill="none" stroke-linecap="round"/>
    ${tear()}
  `,
  celebrate: () => `
    ${whaleBase()}
    ${eyes({})}
    ${openMouth()}
    ${spout()}
    <path d="M52 52 l12 -22 l12 22 z" fill="${ROSE}"/>
    <circle cx="34" cy="46" r="4" fill="${ACCENT}"/>
    <circle cx="126" cy="40" r="5" fill="#34D399"/>
    <circle cx="118" cy="58" r="3.4" fill="${ROSE}"/>
    <rect x="40" y="60" width="6" height="10" rx="2" fill="#34D399" transform="rotate(-20 43 65)"/>
    <rect x="130" y="62" width="6" height="10" rx="2" fill="${ACCENT}" transform="rotate(18 133 67)"/>
  `,
  oops: () => `
    ${whaleBase()}
    ${eyes({ x1: 58, x2: 94, y: 76 })}
    <ellipse cx="80" cy="104" rx="8" ry="9" fill="${INK}"/>
    ${sweat()}
    ${mark(true)}
  `,
  cheer: () => `
    ${whaleBase()}
    ${eyes({})}
    ${openMouth(96)}
    <path d="M36 80 q-20 -22 -8 -32 q13 11 12 30 z" fill="${BODY_DARK}"/>
    <path d="M124 80 q20 -22 8 -32 q-13 11 -12 30 z" fill="${BODY_DARK}"/>
    <path d="M22 40 q7 7 5 16" stroke="${ACCENT}" stroke-width="4" fill="none" stroke-linecap="round"/>
    <path d="M138 40 q-7 7 -5 16" stroke="${ACCENT}" stroke-width="4" fill="none" stroke-linecap="round"/>
  `,
  question: () => `
    ${whaleBase()}
    ${eyes({ x1: 58, x2: 94, y: 74 })}
    <path d="M74 102 q6 4 12 0" stroke="${INK}" stroke-width="3" fill="none" stroke-linecap="round"/>
    <g transform="translate(108 36)">
      <circle cx="14" cy="14" r="15" fill="#FEF3C7" stroke="${ACCENT}" stroke-width="4"/>
      <path d="M8 10 q6 -7 12 0 q0 6 -6 8 v3" stroke="${ACCENT}" stroke-width="4" fill="none" stroke-linecap="round"/>
      <circle cx="14" cy="27" r="2.6" fill="${ACCENT}"/>
    </g>
  `,
};

function svgFor(mood) {
  const paint = MOODS[mood];
  if (!paint) throw new Error(`unknown mood: ${mood}`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 160 160">${paint()}</svg>`;
}

/** 情绪 → 关键词，供工具按 mood 精确匹配，也供索引展示。 */
const INDEX = {
  happy: { file: 'happy.png', label: '开心', keywords: ['开心', '高兴', '哈哈', '好耶'] },
  thumbsUp: { file: 'thumbs-up.png', label: '点赞', keywords: ['赞', '不错', '可以', '支持'] },
  thinking: { file: 'thinking.png', label: '思考', keywords: ['想想', '分析', '让我看看'] },
  sad: { file: 'sad.png', label: '难过', keywords: ['可惜', '遗憾', '没找到'] },
  celebrate: { file: 'celebrate.png', label: '庆祝', keywords: ['完成', '成功', '搞定', '通过'] },
  oops: { file: 'oops.png', label: '抱歉', keywords: ['抱歉', '出错', '失败', '超时'] },
  cheer: { file: 'cheer.png', label: '加油', keywords: ['加油', '继续', '努力'] },
  question: { file: 'question.png', label: '疑问', keywords: ['疑问', '不确定', '确认'] },
};

async function main() {
  const sharpPath = process.argv[2];
  const sharp = (await import(sharpPath)).default;
  mkdirSync(outDir, { recursive: true });

  for (const mood of Object.keys(MOODS)) {
    const svg = Buffer.from(svgFor(mood));
    const png = await sharp(svg).png({ compressionLevel: 9, palette: true }).toBuffer();
    const file = join(outDir, INDEX[mood].file);
    writeFileSync(file, png);
    console.log(`${mood.padEnd(10)} ${INDEX[mood].file.padEnd(16)} ${png.length} bytes`);
  }

  writeFileSync(join(outDir, 'index.json'), `${JSON.stringify(INDEX, null, 2)}\n`);
  console.log(`\n${Object.keys(MOODS).length} 张表情已生成到 ${outDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});