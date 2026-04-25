// Generate Spilka PWA icons from spilkalogo.png.
// Source logo has its own beige background, but PWA maskable icons need a
// SOLID brand-color background filling the entire canvas — otherwise OS
// launchers paint the corners (white/beige) when applying a circular or
// squircle mask. We composite the source logo centered inside the safe
// zone (~78% of canvas) over a full-bleed brand-blue square.

const { createCanvas, loadImage } = require('canvas');
const fs = require('fs');
const path = require('path');

// PWA icons use the app's neutral light-gray surface as background (matches
// the in-app feel) instead of brand blue — keeps the logo's own colors
// visible without a dominant blue square. Transparent corners would show
// white on iOS / launcher color on Android, so we still fill the canvas.
const BG = '#f5f5f7';
const SOURCE = path.join(__dirname, 'spilkalogotransperent.png');
// Crop just the stack mark (top ~58%) — dark-navy text is illegible at icon sizes.
const CROP = { x: 0.05, y: 0.04, w: 0.90, h: 0.58 };

const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir);

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x, y + r);
    ctx.closePath();
    ctx.fill();
}

function srcRect(source) {
    return [
        Math.round(source.width * CROP.x),
        Math.round(source.height * CROP.y),
        Math.round(source.width * CROP.w),
        Math.round(source.height * CROP.h)
    ];
}

async function generateMaskableIcon(size, outputPath, source) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, size, size);

    const logoSize = Math.round(size * 0.72);
    const offset = Math.round((size - logoSize) / 2);
    const [sx, sy, sw, sh] = srcRect(source);
    ctx.drawImage(source, sx, sy, sw, sh, offset, offset, logoSize, logoSize);

    fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
    console.log(`maskable: ${outputPath} (${size}x${size})`);
}

async function generateRoundedIcon(size, outputPath, source) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = BG;
    roundRect(ctx, 0, 0, size, size, Math.round(size * 0.22));

    const logoSize = Math.round(size * 0.72);
    const offset = Math.round((size - logoSize) / 2);
    const [sx, sy, sw, sh] = srcRect(source);
    ctx.drawImage(source, sx, sy, sw, sh, offset, offset, logoSize, logoSize);

    fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
    console.log(`rounded:  ${outputPath} (${size}x${size})`);
}

async function generateFavicon(size, outputPath, source) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, size, size);
    const logoSize = Math.round(size * 0.78);
    const offset = Math.round((size - logoSize) / 2);
    const [sx, sy, sw, sh] = srcRect(source);
    ctx.drawImage(source, sx, sy, sw, sh, offset, offset, logoSize, logoSize);
    fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
    console.log(`favicon:  ${outputPath} (${size}x${size})`);
}

(async () => {
    const source = await loadImage(SOURCE);
    await generateMaskableIcon(192, path.join(iconsDir, 'icon-192.png'), source);
    await generateMaskableIcon(512, path.join(iconsDir, 'icon-512.png'), source);
    await generateRoundedIcon(180, path.join(iconsDir, 'apple-touch-icon.png'), source);
    await generateFavicon(64, path.join(iconsDir, 'favicon-64.png'), source);
    console.log('Icons generated successfully!');
})();
