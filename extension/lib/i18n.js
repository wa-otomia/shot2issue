// Lightweight internationalization for the extension UI.
//
// Chrome's built-in chrome.i18n selects a locale at load time and cannot switch
// at runtime, so a small custom dictionary is used instead. This lets the user
// pick a language explicitly in Settings. English is the source language and the
// default; Simplified Chinese and Japanese are provided as translations.

const MESSAGES = {
  en: {
    appName: 'shot2issue',

    // Editor
    editorSubtitle: 'Annotate & submit',
    settings: 'Settings',
    toolRect: 'Rectangle',
    toolArrow: 'Arrow',
    toolText: 'Text',
    toolMosaic: 'Mosaic',
    toolRectTitle: 'Rectangle',
    toolArrowTitle: 'Arrow',
    toolTextTitle: 'Text',
    toolMosaicTitle: 'Mosaic / redact sensitive content',
    color: 'Color',
    thickness: 'Width',
    undo: 'Undo',
    undoTitle: 'Undo last step',
    clear: 'Clear',
    clearTitle: 'Clear all annotations',
    downloadPng: 'Download PNG',
    downloadPngTitle: 'Download the annotated PNG',
    canvasEmpty: 'No screenshot to edit. Open any web page and click the extension icon to capture.',
    fieldWorkspace: 'Workspace (target repository)',
    fieldType: 'Type',
    fieldTitle: 'Title',
    titlePlaceholder: 'Title',
    fieldBody: 'Description',
    bodyHint: '(Markdown; the screenshot is appended to the body on submit)',
    bodyPlaceholder: 'Describe the issue…',
    bodyDefaultPage: 'Page: {0}',
    submit: 'Submit issue',
    submitNoImage: 'Submit without screenshot',
    submitNoImageTitle: 'Create the issue without attaching the screenshot',
    openIssue: 'Open issue',

    statusNoShot: 'No screenshot to edit. Open any web page and click the extension icon to capture.',
    statusNeedWorkspace: 'No workspace configured. Click “Settings” (top right) to add one before submitting.',
    statusImageLoadFailed: 'Failed to load the screenshot (the data may have expired; capture again).',
    statusCheckingLogin: 'Checking github.com sign-in…',
    statusSubmitting: 'Submitting in the background: uploading the screenshot and creating the issue…',
    statusSubmittingNoImage: 'Submitting in the background: creating the issue…',
    statusCreated: 'Created issue #{0}',
    statusCreatedNoNumber: 'Issue created',
    statusReturning: 'Created issue #{0}. Returning to the original page…',
    statusSubmitFailed: 'Submission failed: {0}',
    retryHint: 'Options: 1) save with “Download PNG” and drag it into the issue manually; 2) use “Submit without screenshot”.',

    loginChecking: 'Checking github.com sign-in…',
    loginSignedInAs: 'github.com: signed in as {0}',
    loginNotSignedIn: 'Not signed in to github.com (required to upload attachments)',
    loginUnknown: 'Sign-in status unknown: {0}',

    errNoShot: 'No screenshot to submit.',
    errSelectWorkspace: 'Add a workspace in Settings, then select it above.',
    errWorkspaceIncomplete: 'The selected workspace is missing owner/repo. Fix it in Settings.',
    errTitleEmpty: 'Title cannot be empty.',
    errNotSignedIn: 'Not signed in to github.com. Sign in to github.com in this browser and try again, or use “Download PNG”.',

    // Options
    optionsHeading: 'shot2issue settings',
    optionsIntro: 'Settings are stored only in this browser (chrome.storage.local) and are never sent to any server.',
    workspacesHeading: 'Workspaces (target repositories)',
    workspacesHint: 'Each workspace is one repository. Public or private; attachment visibility follows repository visibility.',
    addWorkspace: 'Add workspace',
    noWorkspaces: 'No workspaces yet. Use “Add workspace” below.',
    wsName: 'Name (for display)',
    wsNamePlaceholder: 'e.g. Frontend bug tracker',
    wsOwner: 'Owner (user or organization)',
    wsRepo: 'Repository name',
    wsRemove: 'Remove this workspace',
    typesHeading: 'Types',
    typesHint: 'Shown in the Type dropdown in the editor and used as the default title suffix. Defaults: Change / Bug / Feature.',
    newTypePlaceholder: 'New type, press Enter to add',
    addType: 'Add',
    languageHeading: 'Language',
    languageHint: 'Language for the extension interface.',
    behaviorHeading: 'Behavior',
    closeAfterSubmit: 'After a successful submit, close the editor and switch back to the captured page',
    submissionHeading: 'How submission works',
    submissionHint: 'No token is required. As long as you are signed in to github.com in this browser, the extension opens the target repository’s new-issue page in the background, uploads the screenshot, fills in the form and clicks Create — all in one session, so the attachment renders correctly. The signed-in account must have access to the target repository (especially for private repositories).',
    backupHeading: 'Backup / restore',
    backupHint: 'Settings live only in this browser and are cleared if the extension is removed. To update the code, use the “Reload” button on the extension card (settings are kept). Export a backup to be safe.',
    exportConfig: 'Export settings',
    importConfig: 'Import settings',
    save: 'Save settings',
    saved: 'Saved',
    errWorkspaceNeedsOwnerRepo: 'Every workspace must have an owner and a repository.',
    errKeepOneType: 'Keep at least one type.',
    exported: 'Settings exported',
    importFailed: 'Import failed: {0}',
    imported: 'Imported and saved',
    importInvalid: 'Not a valid settings file',

    // Background
    captureFailed: 'Screenshot failed: {0} (restricted pages such as chrome:// cannot be captured)',
  },

  zh: {
    appName: 'shot2issue',

    editorSubtitle: '标注并提交',
    settings: '设置',
    toolRect: '矩形',
    toolArrow: '箭头',
    toolText: '文字',
    toolMosaic: '马赛克',
    toolRectTitle: '矩形框',
    toolArrowTitle: '箭头',
    toolTextTitle: '文字',
    toolMosaicTitle: '马赛克 / 遮挡敏感内容',
    color: '颜色',
    thickness: '粗细',
    undo: '撤销',
    undoTitle: '撤销上一步',
    clear: '清除',
    clearTitle: '清除全部标注',
    downloadPng: '下载 PNG',
    downloadPngTitle: '下载标注后的 PNG',
    canvasEmpty: '没有待编辑的截图。打开任意网页后点扩展图标即可截图。',
    fieldWorkspace: '工作空间（目标仓库）',
    fieldType: '类型',
    fieldTitle: '标题',
    titlePlaceholder: '标题',
    fieldBody: '内容',
    bodyHint: '（Markdown；提交时截图会附加到正文末尾）',
    bodyPlaceholder: '描述问题…',
    bodyDefaultPage: '页面：{0}',
    submit: '提交 issue',
    submitNoImage: '不含截图提交',
    submitNoImageTitle: '不附带截图直接创建 issue',
    openIssue: '打开 issue',

    statusNoShot: '没有待编辑的截图。打开任意网页后点扩展图标即可截图。',
    statusNeedWorkspace: '尚未配置工作空间。请点右上角「设置」添加后再提交。',
    statusImageLoadFailed: '截图加载失败（数据可能已失效，请重新截图）。',
    statusCheckingLogin: '正在检测 github.com 登录态…',
    statusSubmitting: '后台提交中：上传截图并创建 issue…',
    statusSubmittingNoImage: '后台提交中：创建 issue…',
    statusCreated: '已创建 issue #{0}',
    statusCreatedNoNumber: 'issue 已创建',
    statusReturning: '已创建 issue #{0}，正在返回原页面…',
    statusSubmitFailed: '提交失败：{0}',
    retryHint: '可尝试：①「下载 PNG」保存后手动拖入 issue；②「不含截图提交」。',

    loginChecking: '正在检测 github.com 登录态…',
    loginSignedInAs: 'github.com：已登录 {0}',
    loginNotSignedIn: '未登录 github.com（上传附件需要登录）',
    loginUnknown: '登录态未知：{0}',

    errNoShot: '没有截图可提交。',
    errSelectWorkspace: '请先在设置里添加工作空间，并在上方选中。',
    errWorkspaceIncomplete: '当前工作空间缺少 owner/repo，请到设置里修正。',
    errTitleEmpty: '标题不能为空。',
    errNotSignedIn: '未登录 github.com。请在本浏览器登录 github.com 后重试，或使用「下载 PNG」。',

    optionsHeading: 'shot2issue 设置',
    optionsIntro: '设置仅保存在本浏览器（chrome.storage.local），不会发送到任何服务器。',
    workspacesHeading: '工作空间（目标仓库）',
    workspacesHint: '每个工作空间对应一个仓库。public / private 均可；附件可见性跟随仓库可见性。',
    addWorkspace: '添加工作空间',
    noWorkspaces: '还没有工作空间。点下方「添加工作空间」。',
    wsName: '名称（显示用）',
    wsNamePlaceholder: '例如：前端 Bug 看板',
    wsOwner: 'Owner（用户或组织）',
    wsRepo: '仓库名',
    wsRemove: '删除该工作空间',
    typesHeading: '类型',
    typesHint: '出现在编辑页的「类型」下拉里，并作为默认标题后缀。默认：Change / Bug / Feature。',
    newTypePlaceholder: '新增类型，回车添加',
    addType: '添加',
    languageHeading: '语言',
    languageHint: '扩展界面的显示语言。',
    behaviorHeading: '行为',
    closeAfterSubmit: '提交成功后，关闭编辑页并切回截图时所在的页面',
    submissionHeading: '提交方式说明',
    submissionHint: '无需任何 token。只要本浏览器登录着 github.com，扩展就会在后台打开目标仓库的新建 issue 页，上传截图、填好表单并点 Create——整个过程在同一会话内完成，附件才会正常渲染。所用账号需对目标仓库有访问权（私有库尤其）。',
    backupHeading: '备份 / 恢复',
    backupHint: '设置仅存在本机；移除扩展会一并清空。更新代码只需在扩展卡片上点「刷新」（设置会保留）。建议导出一份备份。',
    exportConfig: '导出设置',
    importConfig: '导入设置',
    save: '保存设置',
    saved: '已保存',
    errWorkspaceNeedsOwnerRepo: '每个工作空间都需要填 owner 和仓库名。',
    errKeepOneType: '至少保留一个类型。',
    exported: '已导出设置',
    importFailed: '导入失败：{0}',
    imported: '已导入并保存',
    importInvalid: '不是有效的设置文件',

    captureFailed: '截图失败：{0}（chrome:// 等受限页面无法截图）',
  },

  ja: {
    appName: 'shot2issue',

    editorSubtitle: '注釈と送信',
    settings: '設定',
    toolRect: '矩形',
    toolArrow: '矢印',
    toolText: 'テキスト',
    toolMosaic: 'モザイク',
    toolRectTitle: '矩形',
    toolArrowTitle: '矢印',
    toolTextTitle: 'テキスト',
    toolMosaicTitle: 'モザイク / 機密情報の伏せ字',
    color: '色',
    thickness: '太さ',
    undo: '元に戻す',
    undoTitle: '直前の操作を元に戻す',
    clear: 'クリア',
    clearTitle: 'すべての注釈を消去',
    downloadPng: 'PNG をダウンロード',
    downloadPngTitle: '注釈付き PNG をダウンロード',
    canvasEmpty: '編集対象のスクリーンショットがありません。任意のページで拡張機能アイコンをクリックして撮影してください。',
    fieldWorkspace: 'ワークスペース（対象リポジトリ）',
    fieldType: '種類',
    fieldTitle: 'タイトル',
    titlePlaceholder: 'タイトル',
    fieldBody: '内容',
    bodyHint: '（Markdown。送信時にスクリーンショットが本文末尾に追加されます）',
    bodyPlaceholder: '問題を記述…',
    bodyDefaultPage: 'ページ：{0}',
    submit: 'issue を送信',
    submitNoImage: 'スクリーンショットなしで送信',
    submitNoImageTitle: 'スクリーンショットを添付せずに issue を作成',
    openIssue: 'issue を開く',

    statusNoShot: '編集対象のスクリーンショットがありません。任意のページで拡張機能アイコンをクリックして撮影してください。',
    statusNeedWorkspace: 'ワークスペースが未設定です。右上の「設定」から追加してから送信してください。',
    statusImageLoadFailed: 'スクリーンショットの読み込みに失敗しました（データが失効した可能性があります。再撮影してください）。',
    statusCheckingLogin: 'github.com のサインインを確認中…',
    statusSubmitting: 'バックグラウンドで送信中：スクリーンショットをアップロードして issue を作成…',
    statusSubmittingNoImage: 'バックグラウンドで送信中：issue を作成…',
    statusCreated: 'issue #{0} を作成しました',
    statusCreatedNoNumber: 'issue を作成しました',
    statusReturning: 'issue #{0} を作成しました。元のページに戻ります…',
    statusSubmitFailed: '送信に失敗しました：{0}',
    retryHint: '対処：①「PNG をダウンロード」して issue に手動でドラッグ、②「スクリーンショットなしで送信」。',

    loginChecking: 'github.com のサインインを確認中…',
    loginSignedInAs: 'github.com：{0} でサインイン中',
    loginNotSignedIn: 'github.com に未サインイン（添付のアップロードに必要）',
    loginUnknown: 'サインイン状態が不明：{0}',

    errNoShot: '送信できるスクリーンショットがありません。',
    errSelectWorkspace: '先に設定でワークスペースを追加し、上で選択してください。',
    errWorkspaceIncomplete: '選択中のワークスペースに owner/repo がありません。設定で修正してください。',
    errTitleEmpty: 'タイトルは必須です。',
    errNotSignedIn: 'github.com に未サインインです。このブラウザで github.com にサインインして再試行するか、「PNG をダウンロード」を使用してください。',

    optionsHeading: 'shot2issue 設定',
    optionsIntro: '設定はこのブラウザ内（chrome.storage.local）にのみ保存され、サーバーには一切送信されません。',
    workspacesHeading: 'ワークスペース（対象リポジトリ）',
    workspacesHint: '各ワークスペースは 1 つのリポジトリに対応します。public / private いずれも可。添付の公開範囲はリポジトリの公開範囲に従います。',
    addWorkspace: 'ワークスペースを追加',
    noWorkspaces: 'ワークスペースがありません。下の「ワークスペースを追加」をクリックしてください。',
    wsName: '名称（表示用）',
    wsNamePlaceholder: '例：フロントエンド不具合ボード',
    wsOwner: 'Owner（ユーザーまたは組織）',
    wsRepo: 'リポジトリ名',
    wsRemove: 'このワークスペースを削除',
    typesHeading: '種類',
    typesHint: 'エディタの「種類」ドロップダウンに表示され、既定タイトルの接尾辞に使われます。既定：Change / Bug / Feature。',
    newTypePlaceholder: '新しい種類、Enter で追加',
    addType: '追加',
    languageHeading: '言語',
    languageHint: '拡張機能インターフェースの表示言語。',
    behaviorHeading: '動作',
    closeAfterSubmit: '送信成功後、エディタを閉じて撮影元のページに戻る',
    submissionHeading: '送信の仕組み',
    submissionHint: 'トークンは不要です。このブラウザで github.com にサインインしていれば、拡張機能が対象リポジトリの新規 issue ページをバックグラウンドで開き、スクリーンショットをアップロードし、フォームを入力して Create をクリックします。すべて同一セッション内で行うため添付が正しく表示されます。サインイン中のアカウントが対象リポジトリ（特に非公開）にアクセスできる必要があります。',
    backupHeading: 'バックアップ / 復元',
    backupHint: '設定はこのブラウザ内にのみ存在し、拡張機能を削除すると消えます。コードを更新するには拡張機能カードの「再読み込み」を使用してください（設定は保持されます）。念のためバックアップの書き出しを推奨します。',
    exportConfig: '設定を書き出し',
    importConfig: '設定を読み込み',
    save: '設定を保存',
    saved: '保存しました',
    errWorkspaceNeedsOwnerRepo: '各ワークスペースには owner とリポジトリ名が必要です。',
    errKeepOneType: '種類は少なくとも 1 つ残してください。',
    exported: '設定を書き出しました',
    importFailed: '読み込みに失敗しました：{0}',
    imported: '読み込んで保存しました',
    importInvalid: '有効な設定ファイルではありません',

    captureFailed: 'スクリーンショットに失敗しました：{0}（chrome:// などの制限付きページは撮影できません）',
  },
};

export const SUPPORTED_LANGS = ['en', 'zh', 'ja'];
export const DEFAULT_LANG = 'en';

let current = DEFAULT_LANG;

/** Set the active language. Falls back to English for unknown values. */
export function setLanguage(lang) {
  current = MESSAGES[lang] ? lang : DEFAULT_LANG;
}

/**
 * Translate a key with optional positional substitutions ({0}, {1}, …).
 * Falls back to English, then to the key itself.
 */
export function t(key, subs) {
  const table = MESSAGES[current] || MESSAGES.en;
  let s = table[key];
  if (s == null) s = MESSAGES.en[key];
  if (s == null) return key;
  if (subs != null) {
    const arr = Array.isArray(subs) ? subs : [subs];
    s = s.replace(/\{(\d+)\}/g, (m, i) => (arr[i] != null ? String(arr[i]) : m));
  }
  return s;
}

/**
 * Localize a DOM subtree. Reads attributes:
 *   data-i18n             → textContent
 *   data-i18n-placeholder → placeholder
 *   data-i18n-title       → title
 */
export function localizeDom(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
  });
}
