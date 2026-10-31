/**
 * Google フォーム → GitHub（chemVR-3Dscan の incoming/）
 * フォームの回答が来たら、スキャンのファイル（または KIRI Engine の共有リンク）と題名を GitHub に送る。
 * GitHub 側の scan-intake（GitHub Actions）が点群PNGにして、空いているスロットに入れる。
 *
 * 置き場所: フォームの回答のスプレッドシート → 拡張機能 → Apps Script に、このファイルの中身を全部貼る
 * 設定: プロジェクトの設定 → スクリプト プロパティ に GITHUB_TOKEN（chemVR-3Dscan だけ・Contents: Read and write のトークン）
 * トリガー: 「トリガー」→ 追加 → 関数 onFormSubmit・イベントのソース「スプレッドシートから」・イベントの種類「フォーム送信時」
 * 手順の説明は chemiVR_1 の Tools/README.md「フォームから自動でスロットに入れる」
 */
const REPO = 'mazarin-l9/chemVR-3Dscan';
const MAX_BYTES = 35 * 1024 * 1024; // Apps Script から一度に送れる大きさの上限（base64 にすると 50MB 弱）

function onFormSubmit(e) {
  const answers = e.namedValues; // { 質問の文: [答え] }
  const title = answerOf(answers, /タイトル|題名/);
  const data = answerOf(answers, /スキャン|データ|リンク|ファイル|3d/i);
  const now = new Date();
  const stamp = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyyMMdd-HHmmss') + '-' + Math.floor(Math.random() * 1e6);
  const job = { title: title.slice(0, 40), time: Utilities.formatDate(now, 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ssXXX") };

  try {
    const driveId = (data.match(/[?&]id=([\w-]{20,})/) || data.match(/\/d\/([\w-]{20,})/) || [])[1];
    if (driveId) {
      // フォームでアップロードされたファイル（このアカウントのドライブにある）
      const file = DriveApp.getFileById(driveId);
      const blob = file.getBlob();
      if (blob.getBytes().length > MAX_BYTES) throw new Error('ファイルが大きすぎます（35MB まで）: ' + file.getName());
      const path = 'incoming/' + stamp + '-' + safeName(file.getName());
      putFile(path, Utilities.base64Encode(blob.getBytes()), 'Form upload: ' + (title || file.getName()));
      job.file = path;
    } else if (/^https?:\/\//.test(data)) {
      job.link = data; // KIRI Engine の共有リンクなど
    } else {
      throw new Error('スキャンのファイルもリンクもありません');
    }
    // 最後に JSON を置く（これで GitHub 側の変換が始まる）
    putFile('incoming/' + stamp + '.json', Utilities.base64Encode(JSON.stringify(job, null, 2), Utilities.Charset.UTF_8), 'Form submission: ' + (title || stamp));
  } catch (err) {
    MailApp.sendEmail(Session.getEffectiveUser().getEmail(), '【3Dスキャン】フォームの回答を GitHub に送れませんでした',
      '題名: ' + title + '\nデータ: ' + data + '\n理由: ' + err.message);
    throw err;
  }
}

// 質問の文に pattern を含む最初の答え
function answerOf(answers, pattern) {
  for (const q in answers) if (pattern.test(q)) return String(answers[q][0] || '').trim();
  return '';
}

function safeName(name) {
  return name.replace(/[^\w.\-]+/g, '_').slice(-80);
}

function putFile(path, base64, message) {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) throw new Error('スクリプト プロパティに GITHUB_TOKEN がありません');
  const res = UrlFetchApp.fetch('https://api.github.com/repos/' + REPO + '/contents/' + encodeURI(path), {
    method: 'put',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' },
    payload: JSON.stringify({ message: message, content: base64 }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) throw new Error('GitHub に送れませんでした（' + res.getResponseCode() + '）: ' + res.getContentText().slice(0, 300));
}

// 動作確認用：Apps Script の画面でこの関数を選んで「実行」すると、回答シートのいちばん下の行をもう一度送る
function resendLastRow() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const row = sheet.getRange(sheet.getLastRow(), 1, 1, sheet.getLastColumn()).getValues()[0];
  const namedValues = {};
  header.forEach((q, i) => namedValues[q] = [String(row[i])]);
  onFormSubmit({ namedValues: namedValues });
}
