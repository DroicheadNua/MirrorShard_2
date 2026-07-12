# Linux環境での運用について  

v0.3.0以降、MirrorShard 2のLinuxバイナリの配布を停止しておりましたが、v1.7.0より試験的（experimental）に配布を再開いたします。  

LinuxのGUI環境（特にTauriが依存するWebKitGTK）の仕様に起因する環境依存の不具合が多かったため配布を停止しておりましたが、WebKitGTKのハードウェアアクセラレーション
を無効化することによって、従来正常に起動しなかったNvidia製グラフィックボード搭載機、及びWayland環境でも動作するようになったため配布を再開しました。  

ただし、Linux版は一部の機能に制限があります（後述）。  

また、前作（Electron版）もLinux版を配布しています。  
https://github.com/DroicheadNua/MirrorShard

## 機能制限  

### 使用できないもの

Linux版では、以下の機能は使用できません。  

・マークダウン／HTMLプレビュー  
・タイプ音  
・スポットライトモード  

### 仕様の違うもの

v1.8.0で、SillyTavern（Ctrl+Shift+J）およびOpenCode（Ctrl+Shift+K）をショートカットキーから起動できるようになりました。  

ただし、独自ウィンドウ（WebView）で動作するWin/Macと違い、Linux版はいずれも標準のブラウザで起動します。  

## 既知の問題  

開発者によるテスト結果では以下の不具合が発生しています。  

共通：  
・背景が半透明のとき、文字の残像が残る場合がある（スクロールアウトなどで再描画すれば正常に戻る。また背景が不透明のときには発生しない）  
・設定画ウィンドウで文字列のコピーができない（ペーストはできる）  
・環境によってはチャットウィンドウの検索機能が使えないことがある（検索エンジンに弾かれる）  

MX Linux（X11/Xfce）：  
・インライン入力が機能しないため、Over-the-spot入力になる（変換中の未確定文字列はエディタ上ではなく、IMEの変換ウィンドウ内に表示される）  

Fedora（Wayland/GNOME、仮想環境）：  
・ウィンドウサイズを変更する際、ウィンドウの端にマウスカーソルを持っていってもカーソル形状が変化しない（そのため若干操作しづらいが、サイズ変更自体は可能）  

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

## 🎵 BGM機能とパフォーマンスについて  

本アプリケーションのBGM機能は、OSによって動作仕様とメモリ消費量が異なります。  

*   **Windows / macOS:**  
    *   設定画面から任意の音楽ファイル（mp3/wav/ogg）を指定して再生する場合、ストリーミング再生となるため**メモリ消費は最小限**に抑えられます。  
*   **Linux (Raspberry Pi含む):**  
    *   OSの制限により、音楽データをすべてメモリ上に展開して再生します。そのため、**BGM使用時はメモリ消費量が増加します。**  
    *   特にRaspberry Pi等の低スペック環境でメモリ不足を感じる場合は、BGMをオフにすることをお勧めします。

## NixOS 環境でのビルドと実行 (NixOS Support)

NixOS（およびWaylandデスクトップ環境）で MirrorShard 2 を開発・ビルド・実行するための詳細な手順と、NixOS特有の制限を回避するためのトラブルシューティングです。

### 1. 開発環境の起動 (nix-shell)

NixOSではシステム全体を汚すことなく、リポジトリルートに配置されている `shell.nix` を使って、必要な依存関係（Node.js, pnpm, Rust, WebKitGTK, GStreamer, glib-networking 等）がロードされた仮想開発環境を起動できます。

ターミナルでリポジトリのルートに入り、以下を実行します。

nix-shell

初回のみ、起動したシェル内で以下のコマンドを実行して Rust の stable ツールチェーンを有効化し、パスを通してください。

rustup default stable
export PATH="$HOME/.cargo/bin:$PATH"

環境が整ったら、通常通り依存パッケージのインストールとビルド（または開発起動）が行えます。

```
# 依存パッケージのインストール
pnpm install

# 開発モードでの起動（ライブプレビュー等）
pnpm tauri dev

# リリースバイナリのビルド
pnpm tauri build
```

2. トラブルシューティング（NixOS特有の不具合と回避策）
① AppImageビルド時に linuxdeploy が /usr/bin/xdg-open の不在でクラッシュする場合

NixOSには標準の /usr/bin などのFHSディレクトリ構造が存在しないため、TauriのAppImageビルダーがエラーを吐くことがあります。
これを回避するために、/etc/nixos/configuration.nix に以下を追記してシステムを再構築（rebuild）してください。

services.envfs.enable = true;

② アプリ内のAIチャットや各種通信が TypeError: Load failed で失敗する場合

NixOSのサンドボックス環境では、WebKitGTK（ブラウザエンジン）が暗号化通信に必要な glib-networking モジュールやSSL証明書を見失い、HTTPS接続（SSLハンドシェイク）が強制切断されるバグ（Tauri v2 Issue #11647）があります。

これをシステム全体（GUIセッション全体）で完全に解決するため、/etc/nixos/configuration.nix に以下の environment.extraInit の設定を追加し、システムを再構築したあとに一度再起動（またはログアウト・ログイン）してください。

```
# システム起動時（ログイン時）に環境変数を安全にマージしてエクスポートする設定
environment.extraInit = ''
  # GIOモジュール（dconf等）を維持したまま、末尾にglib-networkingのパスを追加する
  export GIO_EXTRA_MODULES=$GIO_EXTRA_MODULES:${pkgs.glib-networking}/lib/gio/modules

  # SSL/HTTPS接続の証明書の場所をシステム全体に教える
  export SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt
  export NIX_SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt

  # GStreamerの音声デコーダー（タイプ音・BGM用）をシステム全体で有効化
  export GST_PLUGIN_SYSTEM_PATH_1_0="${pkgs.gst_all_1.gstreamer.out}/lib/gstreamer-1.0:${pkgs.gst_all_1.gst-plugins-base}/lib/gstreamer-1.0:${pkgs.gst_all_1.gst-plugins-good}/lib/gstreamer-1.0:${pkgs.gst_all_1.gst-plugins-bad}/lib/gstreamer-1.0"
'';
```

③ 仮想環境下（VirtualBoxやUTM等）における描画の崩壊・リサイズ・ポップアップメニューの不具合

Wayland環境下の一部の仮想GPUドライバーにおいて、WebKitGTKの描画やウィンドウ配置に不整合が発生する場合は、X11互換レイヤー（Xwayland）を強制することで解決します。
src-tauri/src/lib.rs 内で、以下の設定のコメントアウトを解除して再ビルドを行ってください。

std::env::set_var("GDK_BACKEND", "x11");

※KDE Plasma 6などの成熟したWaylandデスクトップであれば、X11強制（Xwayland）の状態であっても、ウィンドウ端をつまんでのリサイズやポップアップメニューの表示は完全に正常動作します。