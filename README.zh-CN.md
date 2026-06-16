# shot2issue

[English](README.md) | **简体中文** | [日本語](README.ja.md)

一个用于从截图创建 GitHub issue 的 Chrome 扩展（Manifest V3）。点击工具栏图标即可截取当前
标签页，对截图进行标注、填写标题和描述并提交。截图会作为 GitHub 原生附件
（`user-attachments`）上传，并以内联图片的形式呈现在 issue 正文中。

本扩展为纯客户端实现，仅与 `github.com` 通信，且无需任何 Personal Access Token：提交过程
复用你当前的 github.com 浏览器会话。

<p align="center">
  <img src="extension/icons/icon128.png" width="96" alt="shot2issue icon" />
</p>

## 功能

- 一键截取当前标签页的可见区域。
- 基于 Canvas 的标注：矩形、箭头、文字，以及马赛克（用于在提交前遮挡敏感内容）。
- 支持多个工作空间，每个工作空间对应一个仓库（public 或 private 均可）。
- 提交在后台标签页中进行，不抢占焦点；编辑页可选择在提交后自动关闭并切回截图时所在的页面。
- 界面支持英文、简体中文和日文（默认英文）。
- 无 Token、无后端、无统计追踪。设置仅保存在本地，并可导出。

## 运行要求

- 支持 Manifest V3 的 Google Chrome（或基于 Chromium 的浏览器）。
- 同一浏览器中已登录 github.com，且所用账号对目标仓库（包括私有仓库）具有访问权限。

## 安装

1. 克隆或下载本仓库。
2. 打开 `chrome://extensions`。
3. 启用右上角的「开发者模式」。
4. 点击「加载已解压的扩展程序」，选择 **`extension/`** 目录（是该子目录，而非仓库根目录）。
5. 首次安装会自动打开设置页，请至少添加一个工作空间。

构建产物（`dist/shot2issue-<version>.zip`，见 [构建](#构建)）可以同样方式加载，或上传至
Chrome Web Store。

拉取新代码后，在 `chrome://extensions` 中点击该扩展卡片上的「刷新」按钮即可更新。刷新会保留
设置；移除扩展则会清空设置。

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

- **工作空间** —— 每个工作空间对应一个目标仓库，由显示名称、owner（用户或组织）和仓库名构成。
- **类型** —— 显示在编辑页的「类型」下拉框中，并用作默认标题的后缀。默认值：Change、Bug、Feature。
- **语言** —— 英文、简体中文或日文。
- **行为** —— 是否在提交成功后关闭编辑页并切回截图时所在的页面。
- **备份 / 恢复** —— 将设置导出为 JSON 文件，之后可再导入。设置仅保存在本浏览器中
  （`chrome.storage.local`）。

## 提交的工作原理

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

## 权限

| 权限 | 用途 |
| --- | --- |
| `activeTab` | 点击图标时授予；用于截取可见标签页并读取其标题和 URL。 |
| `storage` | 在 `chrome.storage.local` 中保存设置，在 `chrome.storage.session` 中暂存待编辑的截图。 |
| `scripting` | 向后台的 github.com 标签页注入提交脚本。 |

主机权限仅限 `https://github.com/*`，这是本扩展唯一访问的来源。截图的字节由 GitHub 自己的
页面代码上传至其存储，因此扩展无需声明那些存储主机的权限。

## 隐私

- 仅使用截图、标题、描述和当前页面 URL。扩展不收集控制台输出、网络活动或设备信息，也不含
  任何统计追踪。
- 附件的可见性跟随仓库的可见性。私有仓库的附件需登录后才能查看（自 2023-05 起）；公开仓库
  的附件匿名即可查看。请据此选择目标仓库。
- 马赛克工具用于遮挡：在提交前覆盖敏感内容。它会对原始截图采样并将所选区域像素化。
- 不存储任何 Token 或密钥；扩展依赖你已登录的 github.com 会话。

## 项目结构

```
shot2issue/
├── extension/                   # 「加载已解压的扩展程序」指向此处
│   ├── manifest.json            # MV3 清单；主机权限仅限 github.com
│   ├── background.js            # service worker：点击图标即截图并打开编辑页
│   ├── editor.html / .js / .css # 主界面：选择、Canvas 标注、提交
│   ├── options.html / .js       # 设置：工作空间、类型、语言、备份
│   ├── lib/
│   │   ├── storage.js           # chrome.storage 读写（设置 + 暂存截图）
│   │   ├── i18n.js              # 界面文案（en / zh / ja）
│   │   ├── page-upload.js       # 通过 github.com 网页表单的页面内提交
│   │   └── github-attach.js     # github.com 登录态检测
│   └── icons/                   # 16 / 48 / 128 px 图标
├── scripts/build.sh             # 校验清单并打包 zip
├── Dockerfile                   # 用于产出发布包的 Docker 构建
├── .github/workflows/build.yml  # CI：Docker 构建、上传 artifact、关联到 release
├── LICENSE
└── README.md
```

## 构建

使用「加载已解压的扩展程序」进行开发无需构建。构建只是产出一个包含 `extension/` 内容的
发布包。

使用 Docker：

```bash
docker build --target export --output type=local,dest=dist .
```

或直接运行（需要 `bash` 和 `zip`；`jq` 可选）：

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
