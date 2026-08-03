# Linux環境での運用について  

MirrorShard 2 は Linux (x86_64 / ARM64) にネイティブ対応しています。本ドキュメントでは、Linux環境固有の仕様、最適化、および注意事項について解説します。  

以前のバージョンではTauriとWebkitGTKの相性問題などによって一部の機能に制限がかかっていましたが、実装の改善によりそのほとんどは解消されました。  
ただし、一部の環境では依然としていくつかの機能に制限があります。  

---

## ⚡️ GPUコンポジットとパフォーマンス

Linux環境において、システム構成（GPUドライバ・コンポジター）に応じて自動的に描画パフォーマンスの最適化が行われます。

* **GPUコンポジットの自動有効化 (高速描画)**  
  Intel / AMD のグラフィックボード（Mesaドライバ）、または Smithay系コンポジター（Niri / COSMIC / DriftWM）環境では、GPUコンポジット描画が自動的に有効化されます。これによりCPU負荷が大幅に低下し、半透明ウィンドウやエフェクトがフリッカー（チラつき）なく快適に動作します。

* **安全性優先の自動フォールバック**  
  NVIDIA製グラフィックボード使用時（Niri/COSMIC/DriftWM以外）や仮想環境（UTM / VirtualBox / QEMU）では、Waylandプロトコルエラーや描画崩れを防ぐため、自動的にコンポジットモードが無効化（`WEBKIT_DISABLE_COMPOSITING_MODE=1`）されます。

* **手動オーバーライド**  
  描画に不具合が発生した場合は、ターミナルから `MIRRORSHARD_DISABLE_COMPOSITING=1 mirrorshard2` と実行することで、手動でGPUコンポジットを強制オフにして起動できます。

### 機能制限

GPUコンポジットが無効化されている場合、以下の機能は使用できなくなります。

・マークダウン／HTMLプレビュー  
・タイプ音  
・スポットライトモード  

### 🎨 描画およびその他の問題

GPUコンポジット無効時などに、以下のような不具合が生じる場合があります。

* **半透明背景時の残像**: アプリの背景を半透明に設定している場合、文字の残像が残ることがあります。スクロール等で再描画させると元に戻ります（背景を不透明にしている場合は発生しません）。

* **設定画面のコピー制限**: マルチウィンドウの制約により、設定画面（サブウィンドウ）内で文字列のコピーができない場合があります（ペーストは可能です）。

* **チャットウィンドウの検索エラー**: ご利用の環境や検索エンジン側の制限により、AIチャットウィンドウ内でのWeb検索機能が弾かれる（使用できない）場合があります。

* **リサイズカーソルの無変化 (Wayland)**: GNOMEやKDEなどのWayland環境において、ウィンドウの境界にカーソルを合わせても「リサイズ用の矢印カーソル」に変化しない場合があります。（※カーソルは変わりませんが、境界をドラッグしてのサイズ変更自体は可能です。KDEでは `Super` + 右ドラッグでのリサイズも有効です）。

* **ウィンドウの移動方法**: 一部の環境でタイトルバーのドラッグ移動が効かない場合は、Linux標準のショートカットである `Alt` + 左ドラッグ（または `Super` + 左ドラッグ）を使用して移動させてください。

* **ドラッグでの範囲選択不可**: 一部の環境（特に仮想環境やWayland環境）において、マウスドラッグによるテキストの範囲選択が機能しない場合があります（`始点をクリック` ➔ `Shiftを押しながら終点をクリック` する方法での範囲選択は正常に行えます）。

* **スクロール方向の反転**: 稀に、スクロールバーをドラッグした際の移動方向が逆になる現象が確認されています。

---

## 仕様の違うもの

* v1.8.0で、SillyTavern（Ctrl+Shift+J）およびOpenCode（Ctrl+Shift+K）を起動する際、独自ウィンドウ（WebView）で動作するWin/Macと違い、Linux版はいずれも標準のブラウザで起動します。  

* 縦書きプレビュー（ライトモード時）の背景は標準の背景画像ではなく、セピアカラーの単色になります（環境によって正常に読み込めないことがあるため）。  


---

## 🖋 日本語入力（IME）の仕様

* **Wayland環境でのインライン変換**  
  Wayland環境（Niri / GNOME / COSMIC等）では、自動的に `GTK_IM_MODULE=wayland` が適用され、エディタ上でのスムーズな直接インライン日本語変換（Fcitx5 / IBus）が機能します。
* **Over-the-spot入力 (X11環境等)**  
  X11環境や一部の旧式デスクトップでは、変換中の文字列がIME側の独立した小ウィンドウに表示される「Over-the-spot」入力になります。

---

## 🎵 BGM機能について

* Windows / MacOS ではストリーミング再生の制御をフロントエンドで行っていますが、Linux版ではrodioクレートによってバックエンドで処理しています。  

---

## 📦 Vivliostyle DTP組版・PDF出力について

* 本機能を利用するには、PCに **Node.js (npm / npx)** および **Google Chrome (または Chromium)** がインストールされている必要があります。
* NixOS等の特殊なディストリビューションでは、`PUPPETEER_EXECUTABLE_PATH` 環境変数や `pkgs.chromium` の導入が必要になる場合があります。（詳細は `flake.nix` を参照してください）


## 配布形式  

deb・rpm・deb(arm64)のみの配布となっております。それ以外の形式でお使いの場合は、下記の手順でビルドしてください。  

## 利用方法 （ビルド）  

上記の制約を理解した上で、ご自身の環境でMirrorShard 2を利用したい場合は、GitHubのリポジトリからソースコードを取得してビルドを行ってください。  

**必要なもの:**  
*   Rust (Cargo)  
*   Node.js & pnpm  
*   WebKitGTK 開発ライブラリ (Debian系なら `libwebkit2gtk-4.0-dev` 等)  

必要なTauriパッケージ及びRustのインストールにつきましては、下記（Tauri公式）をご参照ください。  
https://v2.tauri.app/ja/start/prerequisites/  

```bash
# リポジトリのクローン  
git clone https://github.com/DroicheadNua/MirrorShard_2.git  
cd MirrorShard_2  

# 依存関係インストール  
pnpm install  

# ビルド (releaseモード)  
pnpm tauri build
```

ビルドに成功すると、 src-tauri/target/release/bundle/以下にインストーラが生成されます。これをインストールしてご利用ください。  


## NixOS 環境でのビルドと実行 (NixOS Support)

NixOS（およびWaylandデスクトップ環境）で MirrorShard 2 を開発・ビルド・実行するための詳細な手順と、NixOS特有の制限を回避するためのトラブルシューティングです。

### 1. 開発およびビルド環境の起動 (nix develop)

NixOSではシステム設定を一切変更することなく、リポジトリルートに配置されている `flake.nix` を使って、必要な依存関係（Node.js, pnpm, Rust, WebKitGTK, GStreamer, glib-networking, GTK/GSettingsスキーマ 等）がすべてロードされた仮想開発環境を起動できます。

ターミナルでリポジトリのルートに入り、以下を実行します。

```bash
# flake.nix をGitの追跡対象にしたうえで、開発シェルを起動します
git add flake.nix
nix develop
```

初回のみ、起動したシェル内で以下のコマンドを実行して Rust の stable ツールチェーンを有効化し、パスを通してください。

```bash
rustup default stable
export PATH="$HOME/.cargo/bin:$PATH"
```

環境が整ったら、このシェル内で通常通り依存パッケージのインストールとビルドが行えます。

```bash
# 依存パッケージのインストール
pnpm install

# 開発モードでの起動（ライブプレビュー等）
pnpm tauri dev

# リリースバイナリのビルド
pnpm tauri build
```

---

### 2. システムへのクリーンな導入 (nix build)

NixOS上でビルドした生バイナリを、開発シェルの外（デスクトップランチャー、ショートカットキー、あるいは素のターミナル）からそのまま起動すると、NixOSのファイルシステム隔離仕様により、GTKテーマやシステムフォントの情報（GSettingsスキーマ）、および必要な暗号化ライブラリがアプリに引き渡されず、レイアウト崩壊やAPI接続エラーの原因になります。

これを解決するため、NixOS環境向けに全ての必要な依存パスを安全に埋め込んだ**「ラッパー実行ファイル」**を、以下の手順でビルドして利用します。

```bash
# 1. 開発シェル内で「pnpm tauri build」を完了させておく
# 2. 開発シェルを出た通常のターミナルで、実体パスを指定してビルドを実行する
nix build path:.
```

ビルドが完了すると、プロジェクトルートに `./result` というディレクトリ（シンボリックリンク）が出現します。この中のバイナリは、システム環境に依存せず、**遅延ゼロで瞬時に、かつ崩れずに起動する完全な自律パッケージ**です。

システム上のランチャー（`.desktop`）からシームレスに起動できるようにするため、`~/.local/share/applications/mirrorshard2.desktop` を以下の記述で作成・編集してください。

```desktop
[Desktop Entry]
Type=Application
Name=MirrorShard 2
# nix build で生成されたラッピング済みのバイナリへの絶対パスを指定します
Exec=/absolute/path/to/MirrorShard_2/result/bin/mirrorshard2 %F
Icon=/absolute/path/to/MirrorShard_2/src-tauri/icons/128x128.png
Terminal=false
Categories=Utility;
MimeType=text/plain;
```
*Note: `/absolute/path/to/...` の部分は、ご自身の環境における実際の絶対パスに置き換えてください。*

---

### 3. トラブルシューティング（NixOS特有の不具合と回避策）

#### ① AppImageビルド時に linuxdeploy が `/usr/bin/xdg-open` の不在でクラッシュする場合

NixOSには標準の `/usr/bin` などのFHSディレクトリ構造が存在しないため、TauriのAppImageビルダー（linuxdeploy）がエラーを吐くことがあります。
これを回避するために、`/etc/nixos/configuration.nix` に以下を追記してシステムを再構築（rebuild）してください。

```nix
services.envfs.enable = true;
```

#### ② 仮想環境下（VirtualBoxやUTM等）や一部のNvidia+Wayland環境におけるウィンドウの不整合・描画崩れ

Wayland環境下の一部の仮想GPUや、Nvidia環境におけるWebKitGTKの描画やウィンドウ配置に不整合が発生する場合は、X11互換レイヤー（Xwayland）を強制することで完全に解決します。

`src-tauri/src/lib.rs` 内で、以下の設定のコメントアウトを解除して再ビルドを行ってください。

```rust
std::env::set_var("GDK_BACKEND", "x11");
```

※X11強制（Xwayland）の状態で起動しても、現代のWaylandデスクトップ環境下（KDE PlasmaやNiriなど）であればリサイズやポップアップメニューを含め、完全に正常動作します。

#### ③ NixOS環境における標準背景・標準BGMの読み込み制限について

NixOSのような隔離されたファイルシステム環境（Nixストア）においては、アプリ起動時に「標準」の背景画像やBGMファイルのパス解決に失敗することがあります。

* **縦書きプレビューについて**: 
  Linux環境では表示の不具合を防ぐため、縦書きプレビューのデフォルト背景は自動的に目に優しい「セピアカラー（#eae3d2）」に固定されます。  
  また、NixOSでは縦書きプレビュー画面からのエクスポート（縦書きEPUB・HTML出力）はできません（書き出しに失敗します）。  
* **標準BGM・背景をどうしても使用したい場合**:
  設定画面のファイル選択から、Nixストア内の該当するリソースディレクトリ（`/nix/store/...-mirrorshard2/bin/resources/` 等）にある実体ファイルを手動で選択して読み込ませることで、正常にご利用いただけます。


## Niri (Wayland Tile Window Manager) での利用について

Niriのようなタイル型ウィンドウマネージャ環境では、縦書きプレビューやAIチャット等のサブウィンドウもデフォルトでタイル（カラム）として自動配置されます。

プレビューの表示幅を固定したい場合や、サブウィンドウを自動でフローティング（浮遊）表示させたい場合は、`~/.config/niri/config.kdl` に以下のウィンドウルール（`window-rule`）を追加してご使用ください。

```kdl
// ~/.config/niri/config.kdl に追加する設定例

// 1. 縦書きプレビューの幅を固定してタイル配置する
window-rule {
    // 日本語UIの場合: title="^プレビュー" / 英語UIの場合: title="^Preview"
    match app-id="com.DroicheadNua.mirrorshard2" title="^Preview"
    default-column-width 600
}

// 2. AIチャット画面を最初からフローティング（浮遊）表示にする
window-rule {
    // 日本語UIの場合: title="^AIチャット" / 英語UIの場合: title="^AI Chat"
    match app-id="com.DroicheadNua.mirrorshard2" title="^AI Chat"
    open-floating true
    default-floating-width 640
    default-floating-height 800
}
```
