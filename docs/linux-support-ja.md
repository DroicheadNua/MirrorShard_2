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

ただし、デスクトップ環境がNiriまたはCOSMICの場合は制限が解除され、通常通り使用することができます（GPUコンポジットが可能なため）。  

### 仕様の違うもの

v1.8.0で、SillyTavern（Ctrl+Shift+J）およびOpenCode（Ctrl+Shift+K）をショートカットキーから起動できるようになりました。  

ただし、独自ウィンドウ（WebView）で動作するWin/Macと違い、Linux版はいずれも標準のブラウザで起動します。  

またLinux版の場合、縦書きプレビュー（ライトモード時）の背景は標準の背景画像ではなく、セピアカラーの単色になります（環境によって正常に読み込めないことがあるため）。  

## 既知の問題 (Known Issues on Linux)

Linux環境においては、OSやデスクトップ環境（Wayland / X11）、アーキテクチャの仕様差異により、以下の挙動や不具合が確認されています。

### 🖋 日本語入力（IME）に関する制限
* **Over-the-spot入力への移行**: IMEやデスクトップ環境にもよりますが、多くの環境においてはテキストのインライン入力（直接入力）が機能せず、変換中の文字列がIME側の独立した小ウィンドウに表示される「Over-the-spot」入力になります。  
※ ただしGNOME + IBus 環境においては、比較的安定したインライン変換動作が確認されています。  
* **表示の重複**: 一部環境では、インライン入力とOver-the-spot入力が同時に描画されてしまう場合があります。

### 🪟 ウィンドウ制御と操作の制限
* **リサイズカーソルの無変化 (Wayland)**: GNOMEやKDEなどのWayland環境において、ウィンドウの境界にカーソルを合わせても「リサイズ用の矢印カーソル」に変化しない場合があります。（※カーソルは変わりませんが、境界をドラッグしてのサイズ変更自体は可能です。KDEでは `Super` + 右ドラッグでのリサイズも有効です）。
* **ウィンドウの移動方法**: 一部の環境でタイトルバーのドラッグ移動が効かない場合は、Linux標準のショートカットである `Alt` + 左ドラッグ（または `Super` + 左ドラッグ）を使用して移動させてください。
* **ドラッグでの範囲選択不可**: 一部の環境（特に仮想環境やWayland環境）において、マウスドラッグによるテキストの範囲選択が機能しない場合があります（`始点をクリック` ➔ `Shiftを押しながら終点をクリック` する方法での範囲選択は正常に行えます）。
* **スクロール方向の反転**: 稀に、スクロールバーをドラッグした際の移動方向が逆になる現象が確認されています。

### 🎨 描画およびその他の問題
* **半透明背景時の残像**: アプリの背景を半透明に設定している場合、文字の残像が残ることがあります。スクロール等で再描画させると元に戻ります（背景を不透明にしている場合は発生しません）。
* **設定画面のコピー制限**: マルチウィンドウの制約により、設定画面（サブウィンドウ）内で文字列のコピーができない場合があります（ペーストは可能です）。
* **チャットウィンドウの検索エラー**: ご利用の環境や検索エンジン側の制限により、AIチャットウィンドウ内でのWeb検索機能が弾かれる（使用できない）場合があります。



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

* **GPUコンポジットの自動有効化**:  
  今まで、Linux（特にWayland環境やNvidia製グラフィックボード使用時）ではGPUコンポジットを無効化しないと画面描画が正常に行われないことが多かったのですが、NixOS + Niri / COSMIC Desktop + GTX 1050Ti環境でGPU描画が正常に動作することが確認されました。  
  それに伴い、Smithay系コンポジターである Niri（`NIRI_SOCKET`）または COSMIC Desktop の起動を自動検知し、WebKitGTKのGPUコンポジット描画を有効化する仕様に変更しました。これによりCPU負荷が大幅に低下し、半透明ウィンドウやエフェクトがフリッカーなしに正常に動作します。  
  万が一描画に不具合が発生した場合は、ターミナルやランチャーから `MIRRORSHARD_DISABLE_COMPOSITING=1 mirrorshard2` とオプション付きで実行することで、手動でGPUコンポジットを強制オフにして起動できます。
