# shot2issue

[English](README.md) | **简体中文** | [日本語](README.ja.md)

截图 → 标注 → 直接提交成 GitHub / GitLab / YouTrack issue，图片内联嵌入正文。整个过程都在浏览器里完成，提交到 GitHub 还**不需要任何 Personal Access Token**。

一款 TypeScript 编写的 Chrome 扩展（Manifest V3），纯客户端运行——没有后端、没有统计追踪，所有数据都留在你的浏览器里。

<p align="center">
  <img src="src/icons/icon128.png" width="96" alt="shot2issue icon" />
</p>

## 截图

工具栏弹出菜单 —— 选择截图来源（绑定快捷键后会一并显示）：

![弹出菜单](docs/screenshots/popup.png)

编辑页 —— 标注截图并提交：

![编辑页](docs/screenshots/editor.png)

设置页 —— 账号与工作空间，分标签整理：

![设置页](docs/screenshots/options.png)

AI 助手 —— 用 ChatGPT 订阅账号登录即可生成标题：

![AI assistant](docs/screenshots/ai.png)

## 为什么用它

报 bug 时最烦的就是「截图、找地方存、拿链接、再贴回 issue」这套来回切换的流程。shot2issue 把它压缩成一步：截图、画几笔标注、写两句、提交，issue 就建好了，图片直接嵌在正文里。

- **GitHub 零 token。** 复用你当前已登录的 github.com 会话提交，无需创建、也无需保存任何 Personal Access Token。
- **截哪都行。** 当前标签页、整个屏幕、某个窗口、其他应用，或者直接从剪贴板粘贴图片。
- **一个 issue 多张图。** 每张都能单独标注、切换、删除，提交时一并附上。
- **标注够用。** 矩形、自动编号框、箭头、画笔、可换行文字框，还有给敏感信息打码的马赛克。
- **本地优先。** 没有后端、没有 analytics、没有 telemetry，凭证只存在 `chrome.storage.local`。

## 功能

- **多来源截图。** 既能截当前标签页，也能通过工具栏弹出菜单截取**整个屏幕、某个窗口或其他应用**（`chrome.desktopCapture`）；还能**从剪贴板粘贴图片**（弹出菜单里的「从剪贴板粘贴」，或在编辑页按 Ctrl/Cmd+V）。每种来源都能绑定各自的快捷键，绑定后显示在弹出菜单中。
- **一个 issue 多张截图。** 每次截图都会新增一个缩略图；可分别标注、自由切换、随时删除，提交时全部附上。编辑页打开时再次点击扩展图标（或继续粘贴），新截图会追加进当前 issue。
- **Canvas 标注。** 矩形、**编号框**（徽标自动递增）、箭头、画笔、可调整大小并自动换行的文字框，以及用于遮挡敏感内容的**马赛克**。Ctrl/Cmd+Z 撤销，连按两次 Esc 关闭编辑页。标注后的图片可下载为 PNG，或直接复制到剪贴板。
- **三种 issue 目标。** **GitHub**（免 token，用你已登录的 github.com 会话）、**GitLab**（REST API + 带 `api` 范围的 PAT，支持自建实例）、**YouTrack**（REST API + 永久 token）。可配置多个**工作空间**，每个指向一个仓库 / 项目。YouTrack 与 GitLab 的凭证放在可复用的**账号**里、由多个工作空间共享（GitHub 无需账号）。设置分标签整理：工作空间 / 账号 / AI / 通用 / 语言。
- **可选的 AI 助手。** 用 OpenAI Codex / ChatGPT **订阅账号**登录（OAuth，无需按量计费的 API key）。「**总结标题**」根据你的描述和截图自动写出 issue 标题；「**智能口述**」让你打字或语音口述（语音通过你的订阅转写），由模型据此撰写标题与 Markdown 正文，并能**引用截图里的编号框**。提示词可编辑，并可一键恢复默认；模型列表实时拉取。
- **模板与占位符。** 默认标题与正文模板支持 `{pageTitle}`、`{pageUrl}`、`{type}` 占位符。
- **多语言界面。** 英文、简体中文、日文，首次运行按系统语言自动选择，可在设置中切换。
- **设置可携带。** 一键导出 / 导入为 JSON。无后端、无 analytics / telemetry——一切都在本地。

## 运行要求

- 支持 Manifest V3 的 Google Chrome（或基于 Chromium 的浏览器）。
- **GitHub 目标：** 同一浏览器中已登录 github.com，且该账号对目标仓库（含私有仓库）有访问权限。
- **GitLab 目标：** 实例 Base URL、项目，以及一个带 `api` 范围的 Personal Access Token。
- **YouTrack 目标：** 实例 Base URL、项目，以及一个永久 token。

## 快速开始

扩展用 TypeScript 编写，「加载已解压的扩展程序」前需先构建。

1. 克隆或下载本仓库。
2. 安装依赖并构建：

   ```bash
   npm install
   npm run build
   ```

   这会把扩展编译并打包到 **`build/`** 目录。
3. 打开 `chrome://extensions`。
4. 打开右上角的「**开发者模式**」。
5. 点击「**加载已解压的扩展程序**」，选择 **`build/`** 目录（编译输出目录，**不是** `src/`，也不是仓库根目录）。
6. 首次安装会自动打开设置页，请至少添加一个工作空间。

打包产物（`dist/shot2issue-<version>.zip`，见 [构建](#构建)）可以同样方式加载，或上传到 Chrome Web Store。

开发时运行 `npm run watch` 自动重新编译；改动源码后，在 `chrome://extensions` 的扩展卡片上点击「**刷新**」即可加载最新代码。刷新会保留设置，移除扩展则会清空设置。

## 使用

1. 打开要截取的页面，点击 shot2issue 工具栏图标（或用绑定的快捷键 / 「从剪贴板粘贴」）。扩展会截取可见区域并在新标签页打开编辑页。
2. 选择工作空间和类型，对截图进行标注，编辑标题和描述。标题默认为「页面标题 + 所选类型」，正文默认填入页面 URL。
3. 点击「**提交 issue**」。GitHub 会在后台标签页打开新建 issue 页面、上传截图、填表并提交，全程不抢占焦点；GitLab / YouTrack 则直接走 REST API。成功后显示 issue 链接（若已启用，还会切回截图时所在的页面）。

万一提交失败，可用「**下载 PNG**」保存标注后的图片手动添加，或用「**不含截图提交**」先把 issue 建出来。

## 工作原理

issue 目标各自走最稳妥的路径：

- **GitHub** —— 用你已登录的 github.com 会话提交，无需创建或保存 Personal Access Token。扩展在后台标签页打开新建 issue 页面，借助 GitHub 自己的页面代码上传截图（天然同源、内联嵌入），填表后提交，再读回 issue 链接。该流程依赖 GitHub 的网页界面，若界面变化可能需要更新；「下载 PNG」和「不含截图提交」始终可作为兜底。
- **YouTrack** —— 用你的永久 token 调用文档化的 REST API：先创建 issue（`POST /api/issues`），再上传附件（`POST /api/issues/{id}/attachments`）并按文件名内联嵌入。
- **GitLab** —— 用账号里的 PAT（`PRIVATE-TOKEN` 头、`api` 范围）调用 REST API：先把每张截图上传到项目（`POST /api/v4/projects/:id/uploads`），再创建 issue（`POST /api/v4/projects/:id/issues`）并把返回的 markdown 嵌入正文。

YouTrack / GitLab 的实例 URL 无法预先确定，因此首次提交到某个实例时，Chrome 会请求访问该来源的权限。

## 配置

从 `chrome://extensions`（详情 → 扩展程序选项）或编辑页中的「设置」链接打开设置页。设置分为这些标签：**工作空间**、**账号**、**AI**、**通用**、**语言**。

- **工作空间** —— 每个工作空间对应一个提交目标。GitHub：显示名称、owner（用户或组织）、仓库名。YouTrack / GitLab：显示名称、账号（在「账号」标签里选）、项目（YouTrack 短名称 / id，或 GitLab 数字 id / `group/project` 路径）。旧版内联保存凭证的 YouTrack 工作空间会自动迁移成账号。
- **账号** —— YouTrack / GitLab 实例的可复用凭证：显示名称、Base URL，以及 token（YouTrack 永久 token，或带 `api` 范围的 GitLab PAT）。同一实例上的多个工作空间共用一个账号。GitHub 无需账号（用 github.com 网页会话）。账号保存在本地，并包含在设置备份中。
- **AI 助手** —— 可选用 OpenAI Codex / ChatGPT 账号登录以生成标题与正文。详见下文 [AI 助手](#ai-助手)。
- **类型** —— 显示在编辑页的「类型」下拉框中，并用于默认标题。默认值：Change、Bug、Feature。
- **默认标题与正文** —— 预填新建 issue 的模板，占位符：`{pageTitle}`、`{pageUrl}`、`{type}`。
- **行为** —— 提交成功后是否关闭编辑页并切回截图时所在的页面。
- **语言** —— 英文、简体中文或日文。
- **备份 / 恢复** —— 把设置导出为 JSON，之后可再导入。设置仅保存在本浏览器（`chrome.storage.local`）。

## AI 助手

AI 助手是可选的，**默认关闭**。用 OpenAI Codex / ChatGPT **订阅账号**登录（OAuth、PKCE）后即可启用——用的是你的订阅，而非按量计费的 API key。

- **总结标题** —— 根据当前类型、页面标题、页面 URL、描述以及截图，生成一个 issue 标题。
- **智能口述** —— 弹出对话框，你可以**打字**或**点录音口述**（录音用你的 ChatGPT 订阅转写）。模型据此结合截图与页面元数据撰写标题和 Markdown 正文（结构化 JSON 输出），并会**引用截图里的编号框**。对话框内容在多次打开间保留，可重复生成。

模型列表从 Codex 接口实时获取（并附内置兜底列表）。两套系统提示词（标题、口述）都可在设置中编辑，各自带有「**恢复默认提示词**」按钮，重置为当前界面语言的默认值。

> 说明：语音转写用的是 Codex 桌面版的未公开接口、仅接受 ChatGPT 会话令牌（不接受 API key），因此口述转写是尽力而为、可能变动（打字始终可用）。该助手会与未公开文档的 chatgpt.com 端点通信，这些端点可能发生变化，并受 OpenAI 针对你账号的条款约束。AI token 仅保存在 `chrome.storage.local` 中，**绝不会包含在设置备份里**。

## 权限

| 权限 | 用途 |
| --- | --- |
| `activeTab` | 点击图标时授予；用于截取可见标签页并读取其标题和 URL。 |
| `storage` | 在 `chrome.storage.local` 中保存设置以及待编辑的截图。 |
| `unlimitedStorage` | 让整屏 / 多图截图能够暂存而不触及 `storage.session` 的小配额。暂存的图片在提交后及编辑页关闭时清除。 |
| `scripting` | 向 github.com 标签页注入提交脚本，并在屏幕 / 窗口截图时向当前标签页注入抓帧脚本。 |
| `desktopCapture` | 选择「屏幕或窗口」时弹出选择器。仅用于该截图来源。 |
| `clipboardRead` | 为「从剪贴板粘贴」及编辑页的粘贴功能读取剪贴板中的图片。 |
| `notifications` | 截图失败（含屏幕截图）时以系统通知提示。 |

默认主机权限仅限 `https://github.com/*`，即 GitHub 提交时唯一访问的来源。截图的字节由 GitHub 自己的页面代码上传至其存储，因此扩展无需声明那些存储主机的权限。

YouTrack / GitLab 的实例 URL 无法预先确定，因此以 `optional_host_permissions` 声明并在运行时请求：首次保存或提交到某个实例时，Chrome 会请求访问该来源的权限。连接 AI 助手时，它同样会请求访问 `https://auth.openai.com/*`、`https://chatgpt.com/*` 和 `http://localhost:1455/*`（用于自动读取登录回调）。

## 隐私

- 仅使用截图、标题、描述和当前页面 URL。扩展不收集控制台输出、网络活动或设备信息，也不含任何统计追踪。
- **GitHub 提交不存储任何 token**，依赖你已登录的 github.com 会话。YouTrack 永久 token 与 GitLab PAT 仅保存在本浏览器（`chrome.storage.local`），并包含在设置备份中。
- **AI token 仅保存在 `chrome.storage.local`，并被排除在设置导出之外。** AI 助手在你连接之前处于关闭状态；使用「总结标题」时，类型、描述、页面 URL 以及当前（带标注的）截图会被发送给 OpenAI，「智能口述」还会额外发送录制的音频用于转写。
- **附件的可见性跟随仓库的可见性。** 私有仓库的附件需登录后才能查看（自 2023-05 起），公开仓库的附件匿名即可查看，请据此选择目标仓库。
- 马赛克工具用于遮挡：在提交前覆盖敏感内容。它会对原始截图采样并将所选区域像素化。

## 项目结构

源码（TypeScript 与静态资源）位于 `src/`。`npm run build` 会把 TypeScript 编译到 `build/`，并将 manifest、HTML / CSS 和图标一并复制过去；「加载已解压的扩展程序」指向 `build/`。发布用的 zip 包输出到 `dist/`。

```
shot2issue/
├── src/                          # TypeScript 源码与静态资源
│   ├── manifest.json            # MV3 清单；github.com 主机权限 + 可选 YouTrack 来源
│   ├── background.ts            # service worker：点击图标 / 快捷键即截图并打开编辑页
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
│   │       ├── types.ts         # Provider 接口与共享类型
│   │       ├── github.ts        # GitHub provider
│   │       └── youtrack.ts      # YouTrack provider
│   └── icons/                   # 16 / 48 / 128 px 图标
├── scripts/copy-assets.mjs      # 编译后将静态资源从 src/ 复制到 build/
├── package.json                 # npm 脚本：build / watch / typecheck
├── tsconfig.json                # 严格的 TypeScript 配置（NodeNext）
├── Dockerfile                   # 用于产出发布包的 Docker 构建
├── .github/workflows/build.yml  # CI：Docker 构建、上传 artifact、关联 release
├── LICENSE
└── README.md
```

## 构建

本地构建：

```bash
npm install && npm run build
# 输出：build/（可用「加载已解压的扩展程序」加载）
```

用 Docker 构建发布包（无需本地工具链）：

```bash
docker build --target export --output type=local,dest=dist .
# 输出：dist/shot2issue-<version>.zip
```

持续集成（[`.github/workflows/build.yml`](.github/workflows/build.yml)）会在每次推送到 `main`、提交 Pull Request 以及手动触发时执行 Docker 构建，并将发布包作为 workflow artifact 上传。推送 `v*` tag 时还会把发布包关联到 GitHub release：

```bash
git tag v1.0.0 && git push origin v1.0.0
```

## 测试

Playwright 冒烟测试（[`tests/smoke.mjs`](tests/smoke.mjs)）会加载构建好的扩展，检查扩展内的各个界面——设置页的 provider 字段切换与 i18n，以及编辑页的标注工具（矩形、画笔、透明文字）、撤销和 Esc 关闭。它不会真正向 GitHub 或 YouTrack 提交（那需要真实账号与会话）。

```bash
npm run build
npx playwright install chromium   # 仅首次需要
xvfb-run -a npm test              # Linux 无显示环境；否则直接 npm test
```

README 中的截图用 `npm run screenshots` 以同样方式生成。

## 新增 issue 后端

每个 issue 追踪器都是一个 provider。新增一个只需：实现 [`src/lib/providers/types.ts`](src/lib/providers/types.ts) 中的 `Provider` 接口、在 `src/lib/providers/` 下新建模块，再到 [`src/lib/providers/index.ts`](src/lib/providers/index.ts) 注册。provider 自行声明配置字段、校验工作空间、申请所需的主机权限并实现 `submit()`；编辑页与设置页会从注册表里自动识别它，无需改动。

## 已知限制

- 仅截取可见区域；不支持整页或滚动截图。
- 无法截取 `chrome://`、Chrome Web Store 等受限页面；编辑页会作出提示。
- 不会自动设置标签（labels）。
- GitHub 提交流程依赖其当前网页界面，该界面变化时可能需要更新。

## 许可证

[MIT](LICENSE)
