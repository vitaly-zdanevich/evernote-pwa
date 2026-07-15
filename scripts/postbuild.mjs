// Post-build: minify dist/index.html and generate dist/sw.js with the precache list.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { minify } from 'html-minifier-terser';

const dist = new URL('../dist/', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const html = readFileSync(join(dist, 'index.html'), 'utf8');
const minified = await minify(html, {
	collapseWhitespace: true,
	removeComments: true,
	minifyCSS: true,
	minifyJS: true,
});
writeFileSync(join(dist, 'index.html'), minified);

function walk(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...walk(p));
		else out.push(p);
	}
	return out;
}

const assets = ['./'].concat(
	walk(dist)
		.map((p) => './' + relative(dist, p).split('\\').join('/'))
		// splash screens are read only by iOS at add-to-home-screen time
		.filter((p) => p !== './sw.js' && !p.includes('/splash-')),
);

const template = readFileSync(new URL('../src/sw-template.js', import.meta.url), 'utf8');
const sw = template
	.replace('__PRECACHE__', JSON.stringify(assets))
	.replace('__VERSION__', pkg.version);
writeFileSync(join(dist, 'sw.js'), sw);

console.log(`postbuild: index.html minified, sw.js generated (${assets.length} precached files, v${pkg.version})`);
