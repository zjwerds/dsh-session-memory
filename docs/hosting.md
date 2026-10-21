# GitHub Pages / 静态主机用：这个目录就是「插件市场索引源」。

把 **`docs/` 整个目录**放到任意静态 HTTPS 主机即可（推荐同仓库 GitHub Pages 的 `/docs`）：

- GitHub Pages：仓库 → Settings → Pages → Source 选 **Deploy from a branch** → 分支 `main`，目录 **`/docs`** → Save。
- 得到的索引 URL：`https://<你的GitHub用户名>.github.io/dsh-session-memory/index.json`
- 图标 `icon.svg` 用相对路径引用，会自动指向同目录。

## 重新生成索引（发新版本后）

```sh
# 在仓库根目录执行；会读取 package.json，并从 npm registry 拉取已发布版本与时间
GITHUB_OWNER=你的GitHub用户名 node docs/make-index.mjs
```

如果 npm 包还没发布 / 网络不可用，脚本会退回「只列本地 package.json 当前版本」。

## 校验索引

```sh
node docs/validate-index.mjs docs/index.json
```

## 在 DSH 里使用

设置 → 插件 → 实验性插件「更多」→ 打开 **自定义插件市场** → 插件页出现 **发现** 标签 → **添加索引源** → 粘贴上面的 `index.json` URL → 搜索 `dsh-session-memory` → 安装。
