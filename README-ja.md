**日本語** | [English](README.md)

<details>
<summary><b>⚠️ [Windows] 重要なお知らせ：IME入力の不具合と回避策 (Click to expand)</b></summary>

**【Windowsをお使いの方へ】IME入力時の不具合と解決策**
Windows環境において、日本語などIMEを使用して全角スペース等を入力する際、1回目の打鍵が無効化される（消える）不具合が発生する場合があります。
これは直近のWindows Update（WebView2）と、PCのグラフィックドライバ（特にNVIDIA）の相性によるOS側のレンダリング不具合です。

以下の手順で解決してください：

**解決策1：グラフィックドライバの更新（推奨）**
NVIDIA等のグラフィックドライバを最新バージョン（またはStudioドライバ等）にアップデートし、PCを再起動してください。多くの場合、これだけで正常に動作するようになります。

**解決策2：古いWebView2ランタイムの一時的な適用（ドライバ更新で直らない場合）**
ドライバの更新ができない、または直らない場合は、以下の手順でバグのない少し古いランタイムを適用してください。
1. このリリースに添付されている `MirrorShard_2.bat` をダウンロードします。
2. [Microsoft公式ページ](https://developer.microsoft.com/ja-jp/microsoft-edge/webview2/)の一番下「修正バージョン」から、`148.0.3967.96` をダウンロードします（一般的なPCは「x64」、Surface等は「ARM64」）。
3. ダウンロードした `.cab` ファイルを解凍し、フォルダ名を `webview2_fixed` に変更します。
4. `MirrorShard_2.bat` と `webview2_fixed` フォルダを、本アプリの `.exe` と同じ場所に配置します。
5. 今後は `MirrorShard_2.bat` から起動してください。

</details>
<br>

# MirrorShard 2

![MirrorShard_2 Key Visual](screenshots/ScreenShot01.jpg)

アイデアを、そのまま文章にできたら――と思ったことはありませんか？

MirrorShard 2は、発想から構造化、そして執筆までを一つの流れとして扱うためのエディタです。
思いついた断片を広げ、つなぎ、そのまま文章へと展開できます。

また、Gemini・Mistralなど豊富な無料枠を持つ複数のAIに対応し、Stable Diffusionと連携した画像生成機能とあわせて、無課金でも強力なAI機能の支援を受けることができます。

---

## ✨ 特徴

- 🧠 AIによる文章作成、編集、アイデア生成
- 🌐 複数のAIプロバイダーに対応（Gemini、Groq、Mistral、Cohere）
- 🖼️ テキストから画像を生成（Stable Diffusion対応）
- 💬 AIチャット（画像生成オプション付き：SD Link / Mistral Agents）
- ✍️ テキストを自動で画像プロンプトに変換
- 📂 クラウドAIとローカルAIの両方に対応
- 💡 完全無料でAI機能を利用可能（サブスクリプション不要）

### 🖼️ AI画像生成

普通の言葉でAIに注文するだけ。プロンプトはAIが自動生成します。

- 選択したテキストから画像を生成
- AIチャット内で直接画像をリクエスト
- Stable Diffusion（ローカル）またはMistral Agents（クラウド）に対応
----------------


## 🎬 デモ

### Idea Expansion

https://github.com/user-attachments/assets/2d22c7e3-ff4d-4958-a1e6-ae4c5e4361b5

### Send to Editor

https://github.com/user-attachments/assets/291d7852-6d6e-4040-899c-efd4a500f360

### 🖼️ AI Image Generation(Stable Diffusion / SD-Link)

https://github.com/user-attachments/assets/d8be1190-e2af-4fd4-aa27-73a6fd11a349

---

## ✨ できること

1. アイデアを広げる
2. アイデア同士をつなげる
3. そのまま文章にする

---

## 🧠 アイデアを広げる

アイデアプロセッサ上で、思いついた断片を自由に展開できます。

* AIによる発想支援（自由連想）
* ノード同士の関係を視覚的に整理
* 物語テンプレートによる構造化

---

## 🔗 アイデアをつなげる

* ノード間の「抜け」をAIが補完（Missing Link）
* 複数の要素を統合して新しい発想を生成（Node Alchemy）

---

## ✍️ 文章にする

```md
* **Send to Editor**
  アイデアプロセッサから生成された構造を、そのまま文章として展開できます。
```

* 構造化されたアイデアを即座に本文へ
* カーソル位置からAIが続きを生成
* 欠けている部分の補完

---

## 🧰 その他の主な機能

* Markdownベースのアウトライナー（大規模ファイル対応）
* ZENモード / スポットライトモード
* Markdown / HTMLプレビュー
* PDF / DOCX / HTML / EPUB出力
* 縦書きプレビュー（ルビ対応）
* AIチャット（Gemini / Groq / ローカルLLM）
* SillyTavern連携
* コードエディタ & ターミナル

👉 詳細な機能一覧：
[docs/features-ja.md](docs/features-ja.md)

---

## 📰 メディア掲載

「窓の杜」にて紹介されました  
https://forest.watch.impress.co.jp/docs/news/2091824.html

---

## 🌐 公式サイト

https://droicheadnua.github.io/MirrorShard-Official/

---

## 💾 ダウンロード

[Releasesページ](https://github.com/DroicheadNua/MirrorShard_2/releases/latest) からダウンロードできます。

※「Assets」を展開してインストーラを選択してください。

---

## 🚀 使い方

最初に、下記のクイックガイドをご覧ください。

👉 [docs/quick_guide-ja.md](docs/quick_guide-ja.md)

---

## ⚠️ 注意事項

- テキストファイルは **UTF-8（BOMなし）推奨** です  
- 一部の文字コードでは文字化けやデータ破損の可能性があります  

👉 注意事項・使用素材等の詳細はこちら： [docs/notes-ja.md](docs/notes-ja.md)

---

## 📝 ライセンス

MIT License

---

　Copyright (c) 2025-2026 [DroicheadNua]  
　mirrorshard.dev@gmail.com  
 X: @mirrorshard_dev  
　https://github.com/DroicheadNua/MirrorShard_2
