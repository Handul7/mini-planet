import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(resolve(root, file), 'utf8');
const write = (file, value) => writeFileSync(resolve(root, file), value);
const config = JSON.parse(read('config/site.json'));

function publicUrl(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('config/site.json publicUrl은 인증·쿼리·해시가 없는 공개 HTTPS URL이어야 합니다.');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

function escapeAttribute(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function replaceTagValue(source, id, attribute, value) {
  const pattern = new RegExp(`(<[^>]+id=["']${id}["'][^>]+${attribute}=["'])[^"']*(["'][^>]*>)`);
  if (!pattern.test(source)) throw new Error(`index.html에서 #${id} ${attribute}를 찾지 못했습니다.`);
  return source.replace(pattern, `$1${escapeAttribute(value)}$2`);
}

const url = publicUrl(config.publicUrl);
const title = String(config.title || 'Handul Mini Planet').trim();
const description = String(config.metaDescription || config.description || '').trim();
let index = read('index.html');
index = index.replace(/<title>[^<]*<\/title>/, `<title>${escapeAttribute(title)} — AI Agent Dashboard</title>`);
index = replaceTagValue(index, 'siteDescription', 'content', description);
index = replaceTagValue(index, 'ogSiteName', 'content', title);
index = replaceTagValue(index, 'ogTitle', 'content', title);
index = replaceTagValue(index, 'ogDescription', 'content', description);
index = replaceTagValue(index, 'ogUrl', 'content', url);
index = replaceTagValue(index, 'twitterTitle', 'content', title);
index = replaceTagValue(index, 'twitterDescription', 'content', description);
index = replaceTagValue(index, 'canonicalUrl', 'href', url);
write('index.html', index);

const manifest = JSON.parse(read('manifest.json'));
manifest.name = title;
manifest.description = description;
write('manifest.json', JSON.stringify(manifest, null, 2) + '\n');

const sitemapUrl = new URL('sitemap.xml', url).href;
write('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${sitemapUrl}\n`);
write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>${escapeAttribute(url)}</loc>\n  </url>\n</urlset>\n`);

console.log(`사이트 메타데이터 동기화: ${url}`);
