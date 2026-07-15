// Renders public/icons/icon.svg into the PNG set and favicon.ico. Run: npm run icons
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const dir = fileURLToPath(new URL('../public/icons/', import.meta.url));
const svg = readFileSync(dir + 'icon.svg');

// render large once, downscale for quality
const master = await sharp(svg, { density: 288 }).resize(1024, 1024).png().toBuffer();

async function png(size, out, pad = 0) {
	let buf = await sharp(master).resize(size - pad * 2, size - pad * 2).png().toBuffer();
	if (pad) {
		buf = await sharp({ create: { width: size, height: size, channels: 4, background: '#00a82d' } })
			.composite([{ input: buf }])
			.png()
			.toBuffer();
	}
	writeFileSync(dir + out, buf);
	console.log('wrote icons/' + out);
	return buf;
}

await png(192, 'icon-192.png');
await png(512, 'icon-512.png');
await png(180, 'apple-touch-icon.png');
// maskable: same art inside the safe zone
await png(512, 'icon-maskable-512.png', 60);

// iOS launch screens: black with the icon centered; sizes are captured when the
// app is added to the home screen, so re-add after changing these.
// [pixelW, pixelH]
const SPLASH = [
	[640, 1136], // SE 1
	[750, 1334], // 6/7/8/SE 2-3
	[1242, 2208], // 6+/7+/8+
	[1125, 2436], // X/XS/11 Pro/12-13 mini
	[828, 1792], // XR/11
	[1242, 2688], // XS Max/11 Pro Max
	[1170, 2532], // 12/13/14
	[1284, 2778], // 12-13 Pro Max/14 Plus
	[1179, 2556], // 14 Pro/15/16
	[1290, 2796], // 14 Pro Max/15-16 Plus
	[1536, 2048], // iPad 9.7"
	[1620, 2160], // iPad 10.2"
	[1668, 2388], // iPad Pro 11"
	[2048, 2732], // iPad Pro 12.9"
];

for (const [w, h] of SPLASH) {
	const logoSize = Math.round(Math.min(w, h) * 0.3);
	const logo = await sharp(master).resize(logoSize, logoSize).png().toBuffer();
	const buf = await sharp({ create: { width: w, height: h, channels: 4, background: '#000000' } })
		.composite([{ input: logo }])
		.png()
		.toBuffer();
	writeFileSync(dir + `splash-${w}x${h}.png`, buf);
	console.log(`wrote icons/splash-${w}x${h}.png`);
}

// favicon.ico: ICO container holding PNG-encoded 16px and 32px images
const sizes = [16, 32];
const images = [];
for (const s of sizes) images.push(await sharp(master).resize(s, s).png().toBuffer());

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
const entries = [];
let offset = 6 + 16 * images.length;
images.forEach((buf, i) => {
	const e = Buffer.alloc(16);
	e.writeUInt8(sizes[i], 0);
	e.writeUInt8(sizes[i], 1);
	e.writeUInt16LE(1, 4); // color planes
	e.writeUInt16LE(32, 6); // bits per pixel
	e.writeUInt32LE(buf.length, 8);
	e.writeUInt32LE(offset, 12);
	offset += buf.length;
	entries.push(e);
});
writeFileSync(
	fileURLToPath(new URL('../public/favicon.ico', import.meta.url)),
	Buffer.concat([header, ...entries, ...images]),
);
console.log('wrote favicon.ico');
