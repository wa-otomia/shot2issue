# shot2issue

[English](README.md) | **简体中文** | [日本語](README.ja.md)

一个用于从截图创建 GitHub 或 YouTrack issue 的 Chrome 扩展（Manifest V3）。点击工具栏图标即可
截取当前标签页，对截图进行标注、填写标题和描述并提交。截图会附加到 issue 并内联显示。

本扩展使用 TypeScript 编写，为纯客户端实现，不与任何第三方服务器通信。提交到 GitHub 无需任何
Personal Access Token——复用你当前的 github.com 浏览器会话；提交到 YouTrack 则通过其 REST API、
使用你提供的永久 token。

<p align="center">
  <img src="src/icons/icon128.png" width="96" alt="shot2issue icon" />
</p>

## 截图

编辑页 —— 标注截图并提交：

![编辑页](docs/screenshots/editor.png)

设置页 —— 配置 GitHub 与 YouTrack 工作空间：

![设置页](docs/screenshots/options.png)

AI 助手 —— 使用 ChatGPT 订阅账号登录以生成标题：

![AI assistant](docs/screenshots/ai.png)

## 功能

- 一键截取当前标签页的可见区域。
- 一个 issue 可包含多张截图：每次截图都会新增一个缩略图；可分别标注、切换、删除，提交时一并附上。编辑器打开时再次点击扩展图标，会把新截图追加进当前编辑器。
- 基于 Canvas 的标注：矩形、编号框（自动递增徽标）、箭头、画笔、可调整大小并自动换行的文字框，以及用于遮挡敏感内容的马赛克。可用 Ctrl/Cmd+Z 撤销，连按两次 Esc 关闭编辑页。
- 标注后的图片可下载为 PNG，或直接复制到剪贴板。
- 可预配置默认标题与正文模板（占位符 {pageTitle}、{pageUrl}、{type}）。
- 可选的 AI 助手：使用 OpenAI Codex / ChatGPT 订阅账号登录，即可从描述生成 issue 标题，并查看可用模型及用量。
- 支持多个工作空间，每个工作空间对应一个 GitHub 仓库或一个 YouTrack 项目。
- 提交到 GitHub 在后台标签页中进行，不抢占焦点；编辑页可选择在提交后自动关闭并切回截图时所在的页面。
- 可选的快捷键截图（默认关闭）。
- 界面支持英文、简体中文和日文（默认英文）。
- 无后端、无统计追踪。设置仅保存在本地，并可导出。

## 运行要求

- 支持 Manifest V3 的 Google Chrome（或基于 Chromium 的浏览器）。
- GitHub 目标：同一浏览器中已登录 github.com，且所用账号对目标仓库（包括私有仓库）具有访问权限。
- YouTrack 目标：实例的 Base URL、项目，以及一个永久 token。

## 安装

本扩展用 TypeScript 编写，「加载已解压的扩展程序」前需先构建。

1. 克隆或下载本仓库。
2. 安装依赖并构建：`npm install` 然后 `npm run build`。这会将扩展编译到 **`build/`** 目录。
3. 打开 `chrome://extensions`。
4. 启用右上角的「开发者模式」。
5. 点击「加载已解压的扩展程序」，选择 **`build/`** 目录（即编译输出目录，而非 `src/` 或仓库根目录）。
6. 首次安装会自动打开设置页，请至少添加一个工作空间。

构建产物（`dist/shot2issue-<version>.zip`，见 [构建](#构建)）可以同样方式加载，或上传至
Chrome Web Store。

开发时可运行 `npm run watch` 自动重新编译；改动源码后，在 `chrome://extensions` 的扩展卡片上点击
「刷新」按钮即可加载最新代码。刷新会保留设置；移除扩展则会清空设置。

## 使用

1. 打开要截取的页面，点击 shot2issue 工具栏图标。扩展会截取可见区域并在新标签页打开编辑页。
2. 在编辑页中选择工作空间和类型，对截图进行标注，并编辑标题和描述。标题默认为「页面标题 +
   所选类型」，正文默认填入页面 URL。
3. 点击「提交 issue」。扩展会在后台标签页打开目标仓库的新建 issue 页面，上传截图、填写表单
   并提交。成功后会显示 issue 链接（若已启用，还会切回截图时所在的页面）。

若提交失败，可使用「下载 PNG」保存标注后的图片并手动添加，或使用「不含截图提交」在不附带
图片的情况下创建 issue。

## 配置

可从 `chrome://extensions`（详情 → 扩展程序选项）或编辑页中的「设置」链接打开设置页。

- **工作空间** —— 每个工作空间对应一个提交目标。GitHub：显示名称、owner（用户或组织）和仓库名。
  YouTrack：显示名称、Base URL、项目（短名称或 id），以及永久 token（在 YouTrack → 个人资料 →
  Account Security → Tokens 创建）。token 仅保存在本浏览器。
- **类型** —— 显示在编辑页的「类型」下拉框中，并用于默认标题。默认值：Change、Bug、Feature。
- **语言** —— 英文、简体中文或日文。
- **默认标题与正文** —— 用于预填新建 issue 的模板，占位符：`{pageTitle}`、`{pageUrl}`、`{type}`。
- **AI 助手** —— 可选用 OpenAI Codex / ChatGPT 账号登录以生成标题。详见下文 [AI 助手](#ai-助手)。
- **行为** —— 是否在提交成功后关闭编辑页并切回截图时所在的页面。
- **快捷键** —— 可选用快捷键触发截图。默认关闭；在此启用后，于 Chrome 的快捷键页面
  （`chrome://extensions/shortcuts`，可由「设置快捷键」按钮打开）分配按键组合。
- **备份 / 恢复** —— 将设置导出为 JSON 文件，之后可再导入。设置仅保存在本浏览器中
  （`chrome.storage.local`）。

## 提交的工作原理

### GitHub

GitHub 的 issue 附件（`user-attachments/assets`）没有任何官方 API：Personal Access Token、
OAuth、GitHub App 都无法上传，只有 github.com 网页会话可以。因此本扩展在目标仓库的新建
issue 页面上复刻「人工操作」：

1. 在后台标签页打开 `https://github.com/<owner>/<repo>/issues/new`。
2. 通过 `chrome.scripting.executeScript`（在页面的 main world 中）注入脚本，填写标题和描述，
   并将截图粘贴进正文。上传由 GitHub 自己的页面代码完成，因此天然是同源（same-origin）请求，
   可通过其 verified-fetch 校验，并插入 `![](url)` markdown。
3. 等待上传完成后点击「Create」。
4. 读取生成的 issue URL 并关闭后台标签页。

之所以只能采用这种方式，有两个限制：

- 从扩展向 GitHub 上传端点发起的跨源请求无法伪造同源上下文，会被拒绝（HTTP 422）。
- 附件只有在「上传它的那个 composer 被提交」时才会被正确关联。在一处上传、却从另一处
  （例如通过 REST API 创建的 issue）引用该 URL，会导致私有仓库中的图片返回 404。

截图的 data URL 使用 `atob` 解码，而非 `fetch`，因为 github.com 的内容安全策略（CSP）会拦截
对 `data:` URL 的 `fetch`。

该流程依赖 GitHub 网页界面的结构，若该界面发生变化可能需要更新。代码中使用了多个选择器、
「先粘贴后拖放」的回退方案以及明确的超时。「下载 PNG」和「不含截图提交」始终可作为回退手段。

### YouTrack

YouTrack 为 issue 创建和附件都提供了文档化的 REST API，因此这条路径直接使用你的永久 token
调用 API：先创建 issue（`POST /api/issues`），再上传截图（`POST /api/issues/{id}/attachments`）
并按文件名内联嵌入。由于实例 URL 无法预先确定，首次提交到某个实例时会请求访问该来源的权限。

## 新增 issue 后端

新增一个提交后端只需实现单一接口，无需改动编辑页或设置页。

1. 实现 `src/lib/providers/types.ts` 中定义的 `Provider` 接口。
2. 在 `src/lib/providers/` 下新建对应模块（可参考 `github.ts` 与 `youtrack.ts`）。
3. 在 `src/lib/providers/index.ts` 中注册该 provider。

完成后，新后端即可出现在工作空间配置中并参与提交流程。

## AI 助手

可选的 AI 助手会使用 OpenAI Codex / ChatGPT 订阅账号登录（OAuth、PKCE），从而能够根据你的描述生成 issue 标题，并显示可用的模型和用量。它使用的是你的订阅，而非按量计费的 API key。

Codex 标准的 OAuth 使用 http://localhost:1455 回调，而浏览器扩展无法在该地址上监听，因此提供了两种登录方式：

1. **自动** —— 使用 chrome.identity.launchWebAuthFlow，配合扩展自身的 https://<id>.chromiumapp.org/ 重定向。仅当 OpenAI 为公共 Codex client 接受该重定向 URI 时才有效。
2. **手动（粘贴链接）** —— 作为回退方式使用。扩展会打开授权页面并使用 Codex 的 localhost 重定向；登录后，浏览器会停留在一个「无法访问 localhost」的页面，其地址中包含 ?code=…。复制该完整地址并粘贴回来，扩展便会自行完成 PKCE token 交换。

点击「使用 ChatGPT 登录」会先尝试自动方式，并在失败时自动回退到手动方式。随后在编辑页中，「AI 标题」会根据当前的类型、页面标题、页面 URL、描述以及截图生成标题。模型列表从 Codex models 接口动态获取（并提供内置兜底列表）。生成所用的系统提示词可在设置中编辑，并提供「恢复默认提示词」按钮，将其重置为当前界面语言的默认提示词。

> 注意：该助手会与未公开文档的 chatgpt.com 端点通信，这些端点可能发生变化，并受 OpenAI 针对你账号的条款约束。token 仅保存在 chrome.storage.local 中，绝不会包含在设置备份里。

## 权限

| 权限 | 用途 |
| --- | --- |
| `activeTab` | 点击图标时授予；用于截取可见标签页并读取其标题和 URL。 |
| `storage` | 在 `chrome.storage.local` 中保存设置，在 `chrome.storage.session` 中暂存待编辑的截图。 |
| `scripting` | 向后台的 github.com 标签页注入提交脚本。 |
| `identity` | 运行 AI 助手的 OAuth 登录（`launchWebAuthFlow`）。仅在你连接该助手时使用。 |

默认主机权限仅限 `https://github.com/*`，即 GitHub 提交时唯一访问的来源。截图的字节由 GitHub
自己的页面代码上传至其存储，因此扩展无需声明那些存储主机的权限。

YouTrack 实例 URL 无法预先确定，因此以 `optional_host_permissions` 声明并在运行时请求：首次
保存或提交到某个实例时，Chrome 会请求访问该来源的权限。当你连接 AI 助手时，它同样会请求访问 `https://auth.openai.com/*` 和 `https://chatgpt.com/*`。

## 隐私

- 仅使用截图、标题、描述和当前页面 URL。扩展不收集控制台输出、网络活动或设备信息，也不含
  任何统计追踪。
- AI 助手在你连接之前处于关闭状态。当你使用「AI 标题」时，类型、描述、页面 URL 以及当前（带标注的）
  截图会被发送给 OpenAI 以生成标题。其 token 仅保存在 `chrome.storage.local` 中，并被排除在
  设置备份之外。
- 附件的可见性跟随仓库的可见性。私有仓库的附件需登录后才能查看（自 2023-05 起）；公开仓库
  的附件匿名即可查看。请据此选择目标仓库。
- 马赛克工具用于遮挡：在提交前覆盖敏感内容。它会对原始截图采样并将所选区域像素化。
- GitHub 提交不存储任何 Token，依赖你已登录的 github.com 会话；YouTrack 的永久 token 仅保存在
  本浏览器（`chrome.storage.local`）。

## 项目结构

源码（TypeScript 与静态资源）位于 `src/`。`npm run build` 会将 TypeScript 编译到 `build/`，并把
manifest、HTML/CSS 和图标一并复制过去；「加载已解压的扩展程序」指向 `build/`。发布用的 zip 包
则输出到 `dist/`。

```
shot2issue/
├── src/                          # TypeScript 源码与静态资源
│   ├── manifest.json            # MV3 清单；github.com 主机权限 + 可选 YouTrack 来源
│   ├── background.ts            # service worker：点击图标/快捷键即截图并打开编辑页
│   ├── editor.ts / .html / .css # 主界面：选择、Canvas 标注、提交
│   ├── options.ts / .html       # 设置：工作空间、类型、语言、快捷键、备份
│   ├── lib/
│   │   ├── storage.ts           # chrome.storage 读写（设置 + 暂存截图）
│   │   ├── i18n.ts              # 界面文案（en / zh / ja）
│   │   ├── github-attach.ts     # github.com 登录态检测
│   │   ├── page-upload.ts       # GitHub：通过 github.com 网页表单的页面内提交
│   │   ├── youtrack.ts          # YouTrack：通过 REST API 创建 issue 和上传附件
│   │   └── providers/
│   │       ├── index.ts         # provider 注册表
│   │       ├── types.ts         # Provider 接口与共享 provider 类型
│   │       ├── github.ts        # GitHub provider
│   │       └── youtrack.ts      # YouTrack provider
│   └── icons/                   # 16 / 48 / 128 px 图标
├── scripts/copy-assets.mjs      # 编译后将静态资源从 src/ 复制到 build/
├── scripts/build.sh             # 校验清单并打包 zip
├── package.json                 # 脚本（build / watch / typecheck）与开发依赖
├── tsconfig.json                # 严格的 TypeScript 配置（NodeNext）
├── Dockerfile                   # 用于产出发布包的 Docker 构建
├── .github/workflows/build.yml  # CI：Docker 构建、上传 artifact、关联到 release
├── LICENSE
└── README.md
```

## 构建

本地构建：

```bash
npm install && npm run build
# 输出：build/（可用「加载已解压的扩展程序」加载）
```

使用 Docker：

```bash
docker build --target export --output type=local,dest=dist .
```

或直接运行 `scripts/build.sh` 打包发布 zip（需要 `bash` 和 `zip`；`jq` 可选）：

```bash
bash scripts/build.sh
# 产物：dist/shot2issue-<version>.zip
```

持续集成（[`.github/workflows/build.yml`](.github/workflows/build.yml)）会在每次推送到
`main`、提交 Pull Request 以及手动触发时执行 Docker 构建，并将发布包作为 workflow artifact
上传。推送 `v*` tag 时还会将发布包关联到 GitHub release：

```bash
git tag v1.0.0 && git push origin v1.0.0
```

## 已知限制

- 仅截取可见区域；不支持整页或滚动截图。
- 无法截取 `chrome://`、Chrome Web Store 等受限页面；编辑页会作出提示。
- 不会自动设置标签（labels）。
- 提交流程依赖 GitHub 当前的网页界面，该界面变化时可能需要更新。

## 许可证

[MIT](LICENSE)
