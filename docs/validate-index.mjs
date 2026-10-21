#!/usr/bin/env node
// 校验 DSH 插件市场索引（format 1）的结构；可选加载官方校验器做严格校验。
// 用法：node docs/validate-index.mjs docs/index.json [--official <module-path-or-package>]
import { readFileSync } from 'node:fs';

const file = process.argv[2] || 'docs/index.json';
const officialArgIdx = process.argv.indexOf('--official');
const official = officialArgIdx > 0 ? process.argv[officialArgIdx + 1] : null;
const urlArgIdx = process.argv.indexOf('--index-url');
const indexUrl = urlArgIdx > 0 ? process.argv[urlArgIdx + 1] : 'https://example.invalid/dsh-session-memory/index.json';

const fail = (msg) => { console.error('FAIL: ' + msg); process.exit(1); };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.length > 0;
const isLocalized = (v) => isText(v) || (isObj(v) && isText(v.en));
const isSemver = (v) => typeof v === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(v);

const raw = readFileSync(file, 'utf8');
let index;
try { index = JSON.parse(raw); } catch (e) { fail('不是合法 JSON: ' + e.message); }
if (index.format !== 1) fail('format 必须是 1');
if (!isLocalized(index.title)) fail('title 缺失（LocalizedText，需含 en）');
if (!Array.isArray(index.plugins) || index.plugins.length === 0) fail('plugins 必须是非空数组');
const names = new Set();
for (const [i, plugin] of index.plugins.entries()) {
  const at = `plugins[${i}]`;
  if (!isObj(plugin)) fail(at + ' 不是对象');
  if (!isText(plugin.name)) fail(at + '.name 必填');
  if (names.has(plugin.name)) fail(at + '.name 重复: ' + plugin.name);
  names.add(plugin.name);
  if (plugin.title !== undefined && !isLocalized(plugin.title)) fail(at + '.title 必须是 LocalizedText');
  if (plugin.icon !== undefined && typeof plugin.icon !== 'string') fail(at + '.icon 必须是字符串');
  if (!Array.isArray(plugin.versions) || plugin.versions.length === 0) fail(at + '.versions 至少一个');
  const vset = new Set();
  for (const [j, version] of plugin.versions.entries()) {
    const vat = `${at}.versions[${j}]`;
    if (!isObj(version)) fail(vat + ' 不是对象');
    if (!isSemver(version.version)) fail(vat + '.version 不是 SemVer: ' + version.version);
    if (vset.has(version.version)) fail(vat + '.version 重复: ' + version.version);
    vset.add(version.version);
    if (!Number.isInteger(version.publishTimestamp) || version.publishTimestamp < 0) fail(vat + '.publishTimestamp 必须是非负整数（Unix 秒）');
    const source = version.source;
    if (!isObj(source)) fail(vat + '.source 必填');
    if (source.type === 'npm') {
      if (source.registry !== undefined && typeof source.registry !== 'string') fail(vat + '.source.registry 必须是字符串');
    } else if (source.type === 'git') {
      if (!/^https:\/\//.test(String(source.url ?? ''))) fail(vat + '.source.url 必须是 https URL');
      if (!/^[0-9a-f]{40}$/i.test(String(source.commit ?? ''))) fail(vat + '.source.commit 必须是 40 位十六进制 SHA');
      if (source.path !== undefined && typeof source.path !== 'string') fail(vat + '.source.path 必须是字符串');
    } else {
      fail(vat + '.source.type 必须是 npm 或 git');
    }
    if (version.engines !== undefined) {
      if (!isObj(version.engines) || typeof version.engines.dsh !== 'string') fail(vat + '.engines.dsh 必须是 SemVer range 字符串');
    }
  }
}
console.log(`OK (structural): ${file}  ${index.plugins.length} plugin(s)`);

if (official) {
  try {
    const mod = await import(official);
    const parsed = mod.parseMarketIndex(index, indexUrl);
    console.log(`OK (official parser): ${parsed.plugins.length} plugin(s) validated`);
  } catch (e) {
    fail('官方校验器拒绝: ' + (e?.message || String(e)));
  }
}
