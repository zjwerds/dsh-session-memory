# 发布说明（dsh-session-memory）

这个目录是 **干净的可发布副本**，与 本机项目目录（与本仓库无关）（本机项目）以及运行时记忆数据（~/.dsh/memory/）完全分离。

## 发布前

1. 改 package.json：epository/homepage/bugs 里的 GITHUB_OWNER 换成你的 GitHub 用户名；如需改包名/版本一并改。
2. 
ode docs/make-index.mjs（需要 GITHUB_OWNER 环境变量）重新生成 docs/index.json。
3. 
ode docs/validate-index.mjs docs/index.json 校验。

## npm

`powershell
npm login
npm publish --access public
`

## GitHub

公开仓库 dsh-session-memory；Settings → Pages → 分支 main、目录 /docs，索引 URL：
https://<你>.github.io/dsh-session-memory/index.json

## DSH 市场

设置 → 插件 → 实验性插件 → 更多 → 自定义插件市场 → 发现 → 添加索引源 → 粘贴索引 URL。

## 注意

- **不要**把 ~/.dsh/memory/（你的项目记忆/凭据数据）复制进本目录或提交到 Git。
- 本插件在用户机器上运行后，数据只落在用户自己的 $DSH_HOME/memory/。

