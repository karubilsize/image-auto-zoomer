# image-auto-zoomer

Chrome extension for automatic image zoom and scrolling.

元画像の面積が最大の対象画像を選び、表示領域の高さに合わせてズームします。
既存の選択条件（読込済み・表示中・面積10000以上）とズーム計算式は維持しています。

## 開発・検証

ビルドとアプリ用依存パッケージは不要です。Python Playwright と Chromium を使ってコンテンツスクリプトを検証できます。

```sh
python3 -m pip install -r tests/requirements.txt
node --check content.js
python3 -m unittest discover -s tests -v
```

テストは `/usr/bin/chromium` を使用し、ネットワークへ接続せず合成ページに実際の `content.js` を注入します。
拡張としての読み込み・実サイト・実際のBFCache復元の検証とは異なります。
`pageshow` の回帰テストはイベントを合成して状態遷移を検証します。

`manifest.json` の `matches` は現状「指定のアドレス」という仮文字列です。
拡張を実際に使用するには意図したサイトの有効な Chrome match pattern が必要です。
この修正では対象サイトを推測して変更していません。
このクラウド環境の管理対象 Chromium は未パッケージ拡張を禁止しているため、実際の拡張読み込みテストには許可されたブラウザー環境が必要です。

## スクロールの診断ログ

対象サイトの DevTools Console で以下を実行し、ページを再読み込みしてください。
Console の Verbose（詳細）と Preserve log（ログを保持）を有効にし、`[Image Auto Zoomer]` で絞り込めます。

```js
localStorage.setItem('imageAutoZoomerDebug', '1');
location.reload();
```

無効化は `localStorage.removeItem('imageAutoZoomerDebug')` の実行後に再読み込みします。
設定はサイトのオリジン単位です。ストレージが使用不可の場合、ログは無効になります。

| ログ | 意味 |
| --- | --- |
| `navigation` | 遷移ID、状態、時刻、`history.scrollRestoration` を記録 |
| `no-candidate` / `candidate` | 対象画像がない、または候補の元画像サイズと面積が変わった |
| `scroll-scheduled` | スクロール処理を予約した。まだ命令の実行ではない |
| `scroll-command` | `scrollIntoView` を呼ぶ直前。`commands` は実際の呼出回数 |
| `scroll-result` | 命令直後の各スクロール領域の位置 |
| `position-observed` | その後の scroll イベント時点の位置。補正終了後もデバッグ時は記録 |
| `aligned-or-constrained` | 配置済み、またはスクロール可能範囲の端に達している |
| `user-cancelled` | ホイール・タッチ・スクロールキー・検知可能なスクロールバー操作により補正を停止 |
| `lifecycle-rearmed` | 遅いページ読み込みの `pageshow` を受け、手動操作がなければ一度だけ補正を再開 |
| `finished` | 補正期限に到達。以降の通常の scroll イベントでは再開しない |

`positions` の `container` は window または内部領域、`position` は現在位置、`max` は上限、`offset` は画像上端とその領域の目標位置の差です。
CSS の `scroll-margin-top`、`scroll-padding-top` とズーム倍率を考慮します。

命令ログがなければ候補待ち・予約・手動中止・期限などを確認してください。
`scroll-result` で配置できているのに後続の `position-observed` で位置が変われば、命令後に移動が発生しています。
scroll イベントだけで Chrome の復元、サイトのコード、レイアウト変動を断定することはできません。
実サイトで再発した場合は該当遷移のログを取得し、必要に応じて DevTools の Performance 記録と照合してください。

## 修正の考え方と限界

詳細は [調査メモ](docs/scroll-investigation.md) を参照してください。
補正は最初の処理から2秒の有限期間に限定し、競合サイトと無限に位置を奪い合いません。
その後の遅い `pageshow` は一度だけ再開できますが、手動操作で停止した補正は同じ遷移内で再開しません。
候補画像が最初から未読込の場合は load・DOM更新を待ちます。
補正終了後に別の最大画像が追加されてもズーム更新だけを行い、無期限にはスクロールを再開しません。
ネイティブのオーバーレイスクロールバーなど、ページへ入力イベントが届かない操作を完全には識別できません。
