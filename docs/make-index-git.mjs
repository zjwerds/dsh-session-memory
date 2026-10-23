#!/usr/bin/env node
// 生成「Git 源」的 DSH 插件市场索引（不依赖 npm / 2FA）。
// 用法：node docs/make-index-git.mjs
// 输出：docs/index-git.json（可作为市场索引源；仓库 push 后 commit SHA 才对应远端）
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8' }).trim();

let commit;
try { commit = run('git', ['rev-parse', 'HEAD']); } catch { console.error('需要在 git 仓库里运行'); process.exit(1); }
if (!/^[0-9a-f]{40}$/i.test(commit)) { console.error('无法取得 40 位 commit SHA:', commit); process.exit(1); }

let repoUrl = 'https://github.com/zjwerds/dsh-session-memory';
try {
  const remote = run('git', ['remote', 'get-url', 'origin']);
  const normalized = remote
    .replace(/^git@github\.com:/i, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//i, 'https://github.com/')
    .replace(/\.git$/i, '');
  if (/^https:\/\//i.test(normalized)) repoUrl = normalized;
} catch { /* 没有 remote 时用默认仓库地址 */ }

const index = {
  format: 1,
  title: { en: 'Session Memory plugins', zh: '会话记忆插件市场' },
  description: {
    en: 'Plugins that give DeepSeek Harness bounded per-session project memory and an on-demand long-term user/credential vault.',
    zh: '给 DeepSeek Harness 提供「有界的会话项目记忆 + 按需读取的长期用户/凭据记忆」的插件索引。',
  },
  plugins: [{
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
    versions: [{
      version: pkg.version,
      publishTimestamp: Math.floor(Date.now() / 1000),
      source: { type: 'git', url: repoUrl, commit },
      ...(pkg.engines?.dsh ? { engines: { dsh: pkg.engines.dsh } } : {}),
    }],
  }],
};
writeFileSync(join(here, 'index-git.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');
console.log(`[make-index-git] wrote docs/index-git.json version=${pkg.version} commit=${commit.slice(0, 12)}… repo=${repoUrl}`);
