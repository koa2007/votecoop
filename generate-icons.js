// Generate VoteCoop PWA icons.
// IMPORTANT: maskable icons must have a SOLID background filling the entire
// canvas (no transparent corners) — otherwise OS launchers paint the corners
// white. The visible content (the "V") must sit inside the inner ~80% safe
// zone so it isn't clipped when the platform applies a circular/squircle mask.

const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

const BRAND = '#007AFF';
const FG = '#FFFFFF';

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
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fill();
}

function generateMaskableIcon(size, outputPath) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');

    // Fill ENTIRE canvas with brand color so masks have no transparency to
    // expose. The platform will round the corners; we keep them brand-blue.
    ctx.fillStyle = BRAND;
    ctx.fillRect(0, 0, size, size);

    // White "V" sized to fit inside the maskable safe zone (80% center).
    ctx.fillStyle = FG;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${Math.round(size * 0.46)}px Arial, "Segoe UI", sans-serif`;
    ctx.fillText('V', size / 2, size / 2 + size * 0.02);

    fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
    console.log(`maskable: ${outputPath} (${size}x${size})`);
}

// Optional: a rounded-square variant for browsers that prefer "any" purpose.
// Same content, with built-in 18% corner radius (Android-style squircle).
function generateRoundedIcon(size, outputPath) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = BRAND;
    roundRect(ctx, 0, 0, size, size, Math.round(size * 0.22));

    ctx.fillStyle = FG;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${Math.round(size * 0.46)}px Arial, "Segoe UI", sans-serif`;
    ctx.fillText('V', size / 2, size / 2 + size * 0.02);

    fs.writeFileSync(outputPath, canvas.toBuffer('image/png'));
    console.log(`rounded:  ${outputPath} (${size}x${size})`);
}

// Re-use the same maskable PNG for the main icons since they fill edges
// (works for both "any" and "maskable" purposes).
generateMaskableIcon(192, path.join(iconsDir, 'icon-192.png'));
generateMaskableIcon(512, path.join(iconsDir, 'icon-512.png'));

// Apple touch icon needs a non-transparent rounded look (iOS doesn't apply
// a maskable mask).
generateRoundedIcon(180, path.join(iconsDir, 'apple-touch-icon.png'));

console.log('Icons generated successfully!');
