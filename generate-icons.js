// Generate Spilka PWA icons from spilkalogo.png.
// Source logo has its own beige background, but PWA maskable icons need a
// SOLID brand-color background filling the entire canvas — otherwise OS
// launchers paint the corners (white/beige) when applying a circular or
// squircle mask. We composite the source logo centered inside the safe
// zone (~78% of canvas) over a full-bleed brand-blue square.

const { createCanvas, loadImage } = require('canvas');
const fs = require('fs');
const path = require('path');

const BRAND = '#007AFF';
const SOURCE = path.join(__dirname, 'spilkalogo.png');

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

async function generateMaskableIcon(size, outputPath, source) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');

    // Full-bleed brand background (so corners survive any mask)
    ctx.fillStyle = BRAND;
    ctx.fillRect(0, 0, size, size);

    // Logo sized to safe zone (78% of canvas — slightly larger than 80% to
    // make the mark look strong, but within the maskable safe area).
    const logoSize = Math.round(size * 0.78);
    const offset = Math.round((size - logoSize) / 2);
    ctx.drawImage(source, offset, offset, logoSize, logoSize);

    fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
    console.log(`maskable: ${outputPath} (${size}x${size})`);
}

async function generateRoundedIcon(size, outputPath, source) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');

    // Brand-blue rounded square (Android squircle radius ≈ 22%)
    ctx.fillStyle = BRAND;
    roundRect(ctx, 0, 0, size, size, Math.round(size * 0.22));

    const logoSize = Math.round(size * 0.78);
    const offset = Math.round((size - logoSize) / 2);
    ctx.drawImage(source, offset, offset, logoSize, logoSize);

    fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
    console.log(`rounded:  ${outputPath} (${size}x${size})`);
}

async function generateFavicon(size, outputPath, source) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = BRAND;
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(source, Math.round(size * 0.1), Math.round(size * 0.1),
                  Math.round(size * 0.8), Math.round(size * 0.8));
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
