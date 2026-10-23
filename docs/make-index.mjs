#!/usr/bin/env node
// 生成 DSH 插件市场索引（format 1）。
// 用法（在仓库根目录）：
//   GITHUB_OWNER=你的GitHub用户名 node docs/make-index.mjs
// 说明：优先从 npm registry 读取已发布版本与发布时间；网络/包不存在时退回本地 package.json 的当前版本。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(here, '..', 'package.json');
const outPath = join(here, 'index.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

const owner = process.env.GITHUB_OWNER || (pkg.repository?.url?.includes('GITHUB_OWNER') ? 'GITHUB_OWNER' : 'GITHUB_OWNER');
const repoUrl = `https://github.com/${owner}/${pkg.name}`;
const enginesDsh = pkg.engines?.dsh;

/** @type {Array<{version:string,publishTimestamp:number,source:{type:'npm'},engines?:{dsh:string}}>} */
let versions = [];
try {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (res.ok) {
    const meta = await res.json();
    const all = meta.versions ?? {};
    const times = meta.time ?? {};
    for (const [version, manifest] of Object.entries(all)) {
      if (!manifest?.dsh?.bundle) continue; // 只收真正的组合包
      const iso = times[version];
      const ts = iso ? Math.floor(new Date(iso).getTime() / 1000) : Math.floor(Date.now() / 1000);
      versions.push({
        version,
        publishTimestamp: ts,
        source: { type: 'npm' },
        ...(manifest.engines?.dsh || enginesDsh ? { engines: { dsh: manifest.engines?.dsh || enginesDsh } } : {}),
      });
    }
  }
} catch {
  // 忽略网络错误，走本地回退。
}
if (versions.length === 0) {
  console.warn('[make-index] 未从 npm 读到已发布版本，回退为本地 package.json 版本（发布后请重跑）。');
  versions = [{
    version: pkg.version,
    publishTimestamp: Math.floor(Date.now() / 1000),
    source: { type: 'npm' },
    ...(enginesDsh ? { engines: { dsh: enginesDsh } } : {}),
  }];
}
versions.sort((a, b) => b.publishTimestamp - a.publishTimestamp);

const index = {
  format: 1,
  title: { en: 'Session Memory plugins', zh: '会话记忆插件市场' },
  description: {
    en: 'Plugins that give DeepSeek Harness bounded per-session project memory and an on-demand long-term user/credential vault.',
    zh: '给 DeepSeek Harness 提供「有界的会话项目记忆 + 按需读取的长期用户/凭据记忆」的插件索引。',
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: 'Session Memory', zh: '会话记忆' },
      description: {
        en: 'Per-turn project memory (<=600 chars, auto-injected per session) + long-term identity/credentials vault ($DSH_HOME, on-demand skill + vault_read, tiered outbound-only leak guard). Zero dependencies, host-only.',
        zh: '每回合后台整理项目记忆（单条≤40、同对话≤600 字，自动注入当前会话）+ 长期身份/账号密码（$DSH_HOME，skill 按需读取、分级外发护栏）。零依赖、host-only。',
      },
      icon: 'icon.svg',
      author: pkg.author || '',
      homepage: repoUrl + '#readme',
      repository: { url: repoUrl },
      versions,
    },
  ],
};
writeFileSync(outPath, JSON.stringify(index, null, 2) + '\n', 'utf8');
console.log(`[make-index] wrote ${outPath} (${versions.length} version(s): ${versions.map((v) => v.version).join(', ')})`);
if (owner === 'GITHUB_OWNER') console.log('[make-index] 提示：记得设置 GITHUB_OWNER 或改 package.json 里的仓库地址。');

